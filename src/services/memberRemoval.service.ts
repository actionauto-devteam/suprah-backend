import mongoose from 'mongoose';
import Load from '../models/Load.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { invalidateUserCache } from '../utils/cache.util';
import { disconnectUserSockets, getSocketIO } from '../utils/socketEmitter';
import { DRIVER_ACTIVE_LOAD_STATUSES } from './driverReviewAccess.service';
import { announceReopenedQuotes, reopenQuotesOfDeletedLoads } from './quoteReopen.service';

/**
 * Takes a member out of a dealership (moved unchanged from
 * organization.controller removeMember on 2026-11-12, so approving a staff
 * account deletion runs exactly the same steps as Remove member).
 *
 * Refuses with a plain 409 while a load they created is in progress. Their
 * unfinished, unassigned loads are removed (quotes go back to Pending), and
 * active loads they dispatch move to `actingUserId`. The caller checks who
 * may do this and that the member belongs to the dealership.
 */
export async function removeMemberFromOrganization(input: {
    orgId: string;
    userId: string;
    actingUserId: unknown;
}): Promise<{ transferredLoads: any[]; deletedLoads: any[] }> {
    const { orgId: id, userId, actingUserId } = input;

    // Remove only unfinished, unassigned work created by this member.
    // Active assignments are protected because deleting them would break the
    // driver's operational lifecycle, GPS/dispatch relationship, and chat
    // ownership. Completed/cancelled records remain as organization history.
    //
    // The load cleanup and member detach are one MongoDB transaction so a
    // concurrent assignment cannot leave a partially-removed member or delete
    // only part of their unfinished work.
    const activeStatusSet = new Set<string>(DRIVER_ACTIVE_LOAD_STATUSES);
    const deletableStatuses = ['Draft', 'Posted'];
    let deletedLoads: any[] = [];
    let transferredLoads: any[] = [];
    let reopenedQuoteIds: string[] = [];

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const ownedLoads: any[] = await Load.find({
                organizationId: id,
                createdBy: userId,
            })
                .select('_id loadNumber status assignedDriverId driverRequests quoteId')
                .session(session)
                .lean();

            const protectedLoad = ownedLoads.find((load) => {
                const status = String(load.status ?? '');
                return activeStatusSet.has(status) ||
                    (deletableStatuses.includes(status) && Boolean(load.assignedDriverId));
            });

            if (protectedLoad) {
                throw new ApiError(
                    409,
                    `This member can't be removed yet because they created load ${protectedLoad.loadNumber || '(no load number)'}, which is ${protectedLoad.status}${protectedLoad.assignedDriverId ? ' with a driver assigned' : ''}. Complete the load, or remove its driver in Driver Tracker, then try again.`,
                );
            }

            const deletableLoads = ownedLoads.filter((load) =>
                deletableStatuses.includes(String(load.status ?? '')) &&
                !load.assignedDriverId,
            );

            if (deletableLoads.length > 0) {
                await Load.deleteMany({
                    _id: { $in: deletableLoads.map((load) => load._id) },
                    organizationId: id,
                    createdBy: userId,
                    status: { $in: deletableStatuses },
                    $or: [
                        { assignedDriverId: null },
                        { assignedDriverId: { $exists: false } },
                    ],
                }).session(session);
            }

            // Quotes converted into the deleted loads go back to Pending, the
            // same as when Dispatch deletes a load.
            reopenedQuoteIds = await reopenQuotesOfDeletedLoads(
                id,
                deletableLoads.map((load) => load.quoteId),
                session,
            );

            // Active loads this member is responsible for (as dispatcher)
            // but didn't create: the admin removing them takes over, so the
            // driver's GPS oversight and alerts never stop.
            const responsibleLoads: any[] = await Load.find({
                organizationId: id,
                dispatchOwnerId: userId,
                assignedDriverId: { $ne: null },
                status: { $in: DRIVER_ACTIVE_LOAD_STATUSES },
            })
                .select('_id loadNumber')
                .session(session)
                .lean();
            if (responsibleLoads.length > 0) {
                await Load.updateMany(
                    { _id: { $in: responsibleLoads.map((load) => load._id) }, dispatchOwnerId: userId },
                    { $set: { dispatchOwnerId: actingUserId } },
                    // Ownership bookkeeping only; must not look like a change
                    // to the load's terms.
                    { session, timestamps: false },
                );
            }
            transferredLoads = responsibleLoads;

            const detachedUser = await User.findOneAndUpdate(
                { _id: userId, organizationId: id },
                {
                    $unset: { organizationId: 1, organizationRole: 1 },
                    $pull: { dispatcherOrganizationIds: id },
                },
                { new: true, session },
            );

            if (!detachedUser) {
                throw new ApiError(
                    409,
                    'Organization membership changed while removing this member. Refresh and try again.',
                );
            }

            deletedLoads = deletableLoads;
        });
    } finally {
        await session.endSession();
    }

    invalidateUserCache(userId);
    // Stop organization events reaching the removed member right away.
    disconnectUserSockets(userId);

    try {
        await announceReopenedQuotes(id, reopenedQuoteIds);
    } catch (err) {
        logger.error({ err, orgId: id, quoteIds: reopenedQuoteIds }, 'Non-fatal: failed to refresh quotes reopened by a member removal');
    }

    // Keep Driver Page, Driver Tracker, Transportation and pending-request
    // views synchronized without requiring a manual refresh.
    if (deletedLoads.length > 0) {
        const io = getSocketIO();
        if (io) {
            const affectedDriverIds = new Set<string>();
            for (const load of deletedLoads) {
                const requests = Array.isArray(load.driverRequests)
                    ? load.driverRequests
                    : [];
                for (const request of requests) {
                    const driverId = String(request?.driverId ?? '').trim();
                    if (driverId) affectedDriverIds.add(driverId);
                }

                io.to(`org:${id}`).emit('load:change', {
                    action: 'deleted',
                    loadId: String(load._id),
                });
            }

            for (const driverId of affectedDriverIds) {
                io.to(`user:${driverId}`).emit('driver:loads_updated', {
                    reason: 'load_deleted',
                });
                io.to(`user:${driverId}`).emit('driver:load_request_updated', {
                    reason: 'load_deleted',
                });
            }
        }
    }

    return { transferredLoads, deletedLoads };
}
