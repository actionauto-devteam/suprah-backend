import mongoose from 'mongoose';
import AccountDeletionRequest from '../models/AccountDeletionRequest.model';
import User from '../models/User.model';
import Organization from '../models/Organization.model';
import CrmUser from '../models/CrmUser.model';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import emailService from './email.service';
import activityService from './activity.service';
import { removeMemberFromOrganization } from './memberRemoval.service';
import { eraseAccount, RETENTION_ACKNOWLEDGEMENT_REQUIRED } from './accountDeletion.service';
import { revokeTrayDevicesForEmail } from './trayDevice.service';
import { notifyOrgAdmins, safeCreateNotification } from '../utils/safeNotification';
import { SUPPORT_EMAIL } from '../utils/userMessages';
import { staffDeletionApprovedEmail, staffDeletionRejectedEmail } from '../utils/staffDeletionEmails';

/*
 * Staff account deletion requests (decided 2026-11-12). Staff can't delete
 * their own account straight away like drivers and customers: they send a
 * request (ticking that Suprah AI keeps some records), and an admin of their
 * dealership approves it or rejects it with a reason they see.
 *
 * Approving runs the same steps as Remove member (their unfinished loads are
 * removed, loads they dispatch move to the approving admin, and it's refused
 * while a load they created is in progress), turns off their CRM sign-in, and
 * erases the account like a driver's or customer's ("Former staff member").
 * The dealership keeps its business and employee records.
 */

export const STAFF_DELETION_MESSAGES = {
    notStaff: 'Only staff accounts send a deletion request. Drivers and customers can delete their account from their profile.',
    suprahTeam: `Suprah AI team accounts can't be deleted here. Email ${SUPPORT_EMAIL} for help.`,
    noDealership: `Your account isn't part of a dealership, so there's no admin to approve a request. Email Suprah AI support at ${SUPPORT_EMAIL} and they'll remove it.`,
    ownerRequest: (dealership: string) =>
        `You own ${dealership}, so your account can't be deleted while you're the owner. Email Suprah AI support at ${SUPPORT_EMAIL} to hand the dealership to someone else first.`,
    ownerApprove: `This person owns the dealership, so their account can't be deleted. Ask them to email Suprah AI support at ${SUPPORT_EMAIL} to hand the dealership to someone else first.`,
    notOpen: "This request isn't open any more. Refresh the list.",
    nothingToCancel: "There's no open request to cancel.",
    notReviewer: 'Only an admin of this dealership can approve or reject this request.',
    ownRequest: "You can't approve or reject your own request. Another admin of your dealership, or the Suprah AI team, needs to do it.",
    reasonNeeded: 'Write why you are rejecting the request (5 to 500 characters), so they know what to do next.',
    noLongerMember: "This person isn't on your team any more, so the request was closed.",
} as const;

const STAFF_ROLES = new Set(['employee', 'admin']);
export const NOTE_MAX_LENGTH = 500;
export const REASON_MIN_LENGTH = 5;
export const REASON_MAX_LENGTH = 500;

type Problem = { status: number; message: string };
const sameId = (a: unknown, b: unknown) => Boolean(a) && Boolean(b) && String(a) === String(b);

/** Why this account can't send a request, or null when it can. */
export function staffDeletionRequestProblem(input: {
    userId: unknown;
    role: unknown;
    organizationId: unknown;
    organization: { ownerId?: unknown; name?: unknown } | null;
}): Problem | null {
    if (input.role === 'super_admin') return { status: 403, message: STAFF_DELETION_MESSAGES.suprahTeam };
    if (!STAFF_ROLES.has(String(input.role))) return { status: 403, message: STAFF_DELETION_MESSAGES.notStaff };
    if (!input.organizationId || !input.organization) return { status: 409, message: STAFF_DELETION_MESSAGES.noDealership };
    if (sameId(input.organization.ownerId, input.userId)) {
        return { status: 409, message: STAFF_DELETION_MESSAGES.ownerRequest(String(input.organization.name ?? '').trim() || 'this dealership') };
    }
    return null;
}

/** Whether this person may approve or reject the request, or why not. */
export function staffDeletionReviewProblem(input: {
    reviewerId: unknown;
    reviewerRole: unknown;
    reviewerOrgId: unknown;
    reviewerOrgRole: unknown;
    requestUserId: unknown;
    requestOrgId: unknown;
}): Problem | null {
    if (sameId(input.reviewerId, input.requestUserId)) return { status: 403, message: STAFF_DELETION_MESSAGES.ownRequest };
    if (input.reviewerRole === 'super_admin') return null;
    if (!sameId(input.reviewerOrgId, input.requestOrgId) || input.reviewerOrgRole !== 'admin') {
        return { status: 403, message: STAFF_DELETION_MESSAGES.notReviewer };
    }
    return null;
}

/** The admin's reason, trimmed, or null when it's missing, too short or too long. */
export function cleanRejectionReason(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const reason = value.trim();
    return reason.length >= REASON_MIN_LENGTH && reason.length <= REASON_MAX_LENGTH ? reason : null;
}

/** The staff member's optional note, trimmed and cut to length. */
export function cleanNote(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const note = value.trim().slice(0, NOTE_MAX_LENGTH);
    return note || undefined;
}

export type Reviewer = {
    _id: unknown;
    role?: unknown;
    name?: unknown;
    orgId?: unknown;
    orgRole?: unknown;
};

type StaffUser = { _id: unknown; role?: unknown; organizationId?: unknown; name?: unknown };

export type MyDeletionRequest = {
    id: string;
    status: 'pending' | 'rejected';
    createdAt: Date;
    decidedAt?: Date;
    rejectionReason?: string;
};

function toObjectId(value: unknown, notFoundMessage: string): mongoose.Types.ObjectId {
    const id = String(value ?? '');
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(404, notFoundMessage);
    return new mongoose.Types.ObjectId(id);
}

/** The staff member's open request, or their last declined one. */
export async function myStaffDeletionRequest(userId: unknown): Promise<MyDeletionRequest | null> {
    const latest: any = await AccountDeletionRequest.findOne({ userId: toObjectId(userId, 'Account not found') })
        .sort({ createdAt: -1 })
        .lean();
    if (!latest || (latest.status !== 'pending' && latest.status !== 'rejected')) return null;
    return {
        id: String(latest._id),
        status: latest.status,
        createdAt: latest.createdAt,
        decidedAt: latest.decidedAt,
        rejectionReason: latest.rejectionReason,
    };
}

/** Sends the request to the dealership's admins (or returns the one already open). */
export async function requestStaffDeletion(
    user: StaffUser,
    input: { acknowledgedRetention?: unknown; note?: unknown },
): Promise<MyDeletionRequest> {
    const organization: any = user.organizationId
        ? await Organization.findById(user.organizationId).select('ownerId name').lean()
        : null;
    const problem = staffDeletionRequestProblem({ userId: user._id, role: user.role, organizationId: user.organizationId, organization });
    if (problem) throw new ApiError(problem.status, problem.message);
    if (input.acknowledgedRetention !== true) throw new ApiError(400, RETENTION_ACKNOWLEDGEMENT_REQUIRED);

    const open = await myStaffDeletionRequest(user._id);
    if (open?.status === 'pending') return open;

    let created: any;
    try {
        created = await AccountDeletionRequest.create({
            userId: user._id,
            organizationId: user.organizationId,
            status: 'pending',
            note: cleanNote(input.note),
            acknowledgedRetention: true,
        });
    } catch (error: any) {
        // Two taps at once: the other one already opened the request.
        if (error?.code === 11000) {
            const existing = await myStaffDeletionRequest(user._id);
            if (existing) return existing;
        }
        throw error;
    }

    const who = String(user.name ?? '').trim() || 'A team member';
    await notifyOrgAdmins(
        String(user.organizationId),
        'general',
        'Account deletion request',
        `${who} asked to delete their account. Review it in Settings, Organization.`,
        { route: '/settings?tab=dealership', requestId: String(created._id) },
        String(user._id),
    );
    logger.info({ userId: String(user._id), orgId: String(user.organizationId), requestId: String(created._id) }, 'Staff account deletion requested');

    return { id: String(created._id), status: 'pending', createdAt: created.createdAt };
}

export async function cancelMyStaffDeletionRequest(userId: unknown): Promise<void> {
    const cancelled = await AccountDeletionRequest.findOneAndUpdate(
        { userId: toObjectId(userId, 'Account not found'), status: 'pending' },
        { $set: { status: 'cancelled', decidedAt: new Date() }, $unset: { note: '' } },
    );
    if (!cancelled) throw new ApiError(404, STAFF_DELETION_MESSAGES.nothingToCancel);
}

export type ReviewListItem = {
    id: string;
    status: 'pending' | 'approved' | 'rejected';
    createdAt: Date;
    decidedAt?: Date;
    note?: string;
    rejectionReason?: string;
    person: { id: string; name: string; email: string; role: string };
};

/** Open requests for the reviewer's dealership, plus the ones decided in the last 30 days. */
export async function listStaffDeletionRequests(reviewer: Reviewer): Promise<ReviewListItem[]> {
    if (!reviewer.orgId) throw new ApiError(403, STAFF_DELETION_MESSAGES.notReviewer);
    if (reviewer.role !== 'super_admin' && reviewer.orgRole !== 'admin') throw new ApiError(403, STAFF_DELETION_MESSAGES.notReviewer);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows: any[] = await AccountDeletionRequest.find({
        organizationId: toObjectId(reviewer.orgId, 'Dealership not found'),
        $or: [{ status: 'pending' }, { status: { $in: ['approved', 'rejected'] }, decidedAt: { $gte: since } }],
    })
        .sort({ status: 1, createdAt: -1 })
        .limit(50)
        .populate('userId', 'name email role organizationRole')
        .lean();

    return rows
        .map((row) => {
            const person = row.userId && typeof row.userId === 'object' ? row.userId : null;
            return {
                id: String(row._id),
                status: row.status,
                createdAt: row.createdAt,
                decidedAt: row.decidedAt,
                note: row.note,
                rejectionReason: row.rejectionReason,
                person: {
                    id: String(person?._id ?? row.userId ?? ''),
                    name: String(person?.name ?? '').trim() || 'Former staff member',
                    email: row.status === 'approved' ? '' : String(person?.email ?? ''),
                    role: person?.organizationRole === 'admin' || person?.role === 'admin' ? 'Admin' : 'Member',
                },
            } as ReviewListItem;
        })
        // Open requests first, newest first within each group.
        .sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || +new Date(b.createdAt) - +new Date(a.createdAt));
}

async function openRequestFor(reviewer: Reviewer, requestId: unknown): Promise<any> {
    const request: any = await AccountDeletionRequest.findById(toObjectId(requestId, STAFF_DELETION_MESSAGES.notOpen)).lean();
    if (!request || request.status !== 'pending') throw new ApiError(409, STAFF_DELETION_MESSAGES.notOpen);
    const problem = staffDeletionReviewProblem({
        reviewerId: reviewer._id,
        reviewerRole: reviewer.role,
        reviewerOrgId: reviewer.orgId,
        reviewerOrgRole: reviewer.orgRole,
        requestUserId: request.userId,
        requestOrgId: request.organizationId,
    });
    if (problem) throw new ApiError(problem.status, problem.message);
    return request;
}

/** Declines the request; the staff member sees the reason in the app and by email. */
export async function rejectStaffDeletion(reviewer: Reviewer, requestId: unknown, reasonInput: unknown): Promise<void> {
    const reason = cleanRejectionReason(reasonInput);
    if (!reason) throw new ApiError(400, STAFF_DELETION_MESSAGES.reasonNeeded);
    const request = await openRequestFor(reviewer, requestId);

    const updated = await AccountDeletionRequest.findOneAndUpdate(
        { _id: request._id, status: 'pending' },
        { $set: { status: 'rejected', rejectionReason: reason, decidedBy: reviewer._id, decidedAt: new Date() }, $unset: { note: '' } },
    );
    if (!updated) throw new ApiError(409, STAFF_DELETION_MESSAGES.notOpen);

    const [person, organization]: any[] = await Promise.all([
        User.findById(request.userId).select('email').lean(),
        Organization.findById(request.organizationId).select('name').lean(),
    ]);
    await safeCreateNotification({
        userId: String(request.userId),
        organizationId: String(request.organizationId),
        type: 'general',
        title: 'Account deletion request declined',
        message: `An admin declined your request to delete your account. Their reason: ${reason}`,
        metadata: { route: '/profile', requestId: String(request._id) },
    });
    if (person?.email) {
        try {
            await emailService.sendEmail({ to: person.email, ...staffDeletionRejectedEmail({ organizationName: organization?.name, reason }) });
        } catch (error) {
            logger.warn({ err: error, requestId: String(request._id) }, 'Could not email a declined account deletion request');
        }
    }
    logger.info({ requestId: String(request._id), decidedBy: String(reviewer._id) }, 'Staff account deletion request declined');
}

/**
 * Approves the request: takes the person out of the dealership (the same
 * steps as Remove member), turns off their CRM sign-in and erases the account.
 */
export async function approveStaffDeletion(reviewer: Reviewer, requestId: unknown): Promise<{ transferredLoadNumbers: string[] }> {
    const request = await openRequestFor(reviewer, requestId);
    const orgId = String(request.organizationId);
    const userId = String(request.userId);

    const [person, organization]: any[] = await Promise.all([
        User.findById(request.userId).select('email name role organizationId').lean(),
        Organization.findById(request.organizationId).select('ownerId name').lean(),
    ]);

    if (!person || !sameId(person.organizationId, orgId) || !STAFF_ROLES.has(String(person.role))) {
        await AccountDeletionRequest.updateOne(
            { _id: request._id, status: 'pending' },
            { $set: { status: 'cancelled', decidedBy: reviewer._id, decidedAt: new Date() }, $unset: { note: '' } },
        );
        throw new ApiError(409, STAFF_DELETION_MESSAGES.noLongerMember);
    }
    if (sameId(organization?.ownerId, userId)) throw new ApiError(409, STAFF_DELETION_MESSAGES.ownerApprove);

    // Refused (409, plain words) while a load they created is in progress.
    const { transferredLoads } = await removeMemberFromOrganization({ orgId, userId, actingUserId: reviewer._id });

    const email = String(person.email ?? '').toLowerCase();
    const name = String(person.name ?? '').trim() || 'A team member';

    if (email) {
        try {
            await emailService.sendEmail({ to: email, ...staffDeletionApprovedEmail({ organizationName: organization?.name }) });
        } catch (error) {
            logger.warn({ err: error, requestId: String(request._id) }, 'Could not email an approved account deletion');
        }
        revokeTrayDevicesForEmail(email, orgId, 'account_deleted').catch(() => {});
        // Their CRM sign-in stops working; the dealership keeps its employee records.
        await CrmUser.updateMany({ email, organizationId: orgId, isActive: true }, { $set: { isActive: false } }).catch((error: unknown) =>
            logger.error({ err: error, requestId: String(request._id) }, 'Could not turn off the CRM sign-in of a deleted staff account'),
        );
    }

    await eraseAccount(userId, 'staff');

    await AccountDeletionRequest.updateOne(
        { _id: request._id },
        { $set: { status: 'approved', decidedBy: reviewer._id, decidedAt: new Date() }, $unset: { note: '' } },
    );

    await activityService.createActivity({
        userId: String(reviewer._id),
        organizationId: orgId,
        type: 'other',
        title: 'Account Deletion Approved',
        description: "A team member's account was deleted at their request",
        metadata: { removedUserId: userId, requestId: String(request._id) },
    });
    await notifyOrgAdmins(
        orgId,
        'team_member_left',
        'Account deleted',
        `${name}'s account was deleted at their request.`,
        { removedUserId: userId, route: '/settings?tab=dealership' },
        String(reviewer._id),
    );
    logger.info({ orgId, userId, requestId: String(request._id), approvedBy: String(reviewer._id), retentionNoticeAcknowledged: true }, 'Staff account deleted after an approved request');

    return { transferredLoadNumbers: transferredLoads.map((load: any) => load.loadNumber).filter(Boolean) };
}
