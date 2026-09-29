/**
 * DT-41: fill in the responsible dispatcher (dispatchOwnerId) on active loads
 * that were assigned before that field existed.
 *
 * Uses the same evidence as the live recovery in Driver Tracking: the latest
 * dispatcher-written "load assigned" / "request approved" card in that
 * driver's private Dispatch Chat for this exact load. It never guesses from
 * organization membership. The dispatcher must still be active and allowed
 * to dispatch for the load's organization.
 *
 * Loads with no usable evidence are listed so Dispatch can reconfirm them in
 * Driver Tracker. Until then the GPS-silence monitor alerts the org admins.
 *
 * Dry run (default):  npx ts-node --transpile-only src/scripts/migrate-load-dispatch-owner.ts
 * Apply:              npx ts-node --transpile-only src/scripts/migrate-load-dispatch-owner.ts --apply
 *
 * Uses the native driver, so Load.updatedAt is not touched.
 */
import mongoose from 'mongoose';
import config from '../config';
import { ACTIVE_LOAD_STATUSES } from '../constants/loadStatus';

const APPLY = process.argv.includes('--apply');
const DISPATCH_ROLES = ['employee', 'admin', 'super_admin'];
const EVIDENCE_TYPES = ['driver_load_assigned', 'driver_load_request_approved'];

const missingOwner = { $or: [{ dispatchOwnerId: null }, { dispatchOwnerId: { $exists: false } }] };

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log(`Connected to ${mongoose.connection.host} / database "${mongoose.connection.name}".`);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to change data)'}`);

  // Raw collections, not the models: no casting, no timestamps, and no
  // index builds triggered by loading the models.
  const loadsCollection = mongoose.connection.collection('loads');
  const messages = mongoose.connection.collection('dispatchchatmessages');
  const users = mongoose.connection.collection('users');

  const loads = await loadsCollection
    .find(
      {
        status: { $in: [...ACTIVE_LOAD_STATUSES] },
        assignedDriverId: { $ne: null },
        ...missingOwner,
      },
      { projection: { _id: 1, loadNumber: 1, organizationId: 1, assignedDriverId: 1, status: 1 } },
    )
    .toArray();

  console.log(`Active loads without a responsible dispatcher: ${loads.length}`);

  let filled = 0;
  const unresolved: string[] = [];

  for (const load of loads) {
    const organizationId = String(load.organizationId ?? '');
    const label = `${load.loadNumber ?? load._id} (${load.status}, org ${organizationId})`;

    const evidence: any = await messages.findOne(
      {
        organizationId: load.organizationId,
        driverId: load.assignedDriverId,
        senderRole: 'dispatcher',
        messageType: 'system',
        'systemEvent.type': { $in: EVIDENCE_TYPES },
        'systemEvent.metadata.loadId': String(load._id),
      },
      { sort: { createdAt: -1 }, projection: { dispatcherId: 1, senderId: 1 } },
    );

    const candidateId = String(evidence?.dispatcherId ?? evidence?.senderId ?? '').trim();
    if (!candidateId || !mongoose.Types.ObjectId.isValid(candidateId)) {
      unresolved.push(`${label}: no assignment card in Dispatch Chat`);
      continue;
    }

    // Same rules as findActiveDispatcherForLoad in driverTracking.controller.
    const dispatcher: any = await users.findOne(
      { _id: new mongoose.Types.ObjectId(candidateId), role: { $in: DISPATCH_ROLES }, isActive: true },
      { projection: { _id: 1, role: 1, organizationId: 1, dispatcherOrganizationIds: 1 } },
    );
    const allowedForOrg =
      dispatcher &&
      (dispatcher.role === 'super_admin' ||
        String(dispatcher.organizationId ?? '') === organizationId ||
        (dispatcher.role === 'employee' &&
          Array.isArray(dispatcher.dispatcherOrganizationIds) &&
          dispatcher.dispatcherOrganizationIds.some((id: unknown) => String(id) === organizationId)));
    if (!allowedForOrg) {
      unresolved.push(`${label}: the dispatcher who assigned it is no longer active for this organization`);
      continue;
    }

    if (!APPLY) {
      console.log(`  would set ${label} -> dispatcher ${candidateId}`);
      filled += 1;
      continue;
    }

    // Only if the load is unchanged in the ways that matter: same driver, still
    // active, and no owner supplied in the meantime.
    const result = await loadsCollection.updateOne(
      {
        _id: load._id,
        assignedDriverId: load.assignedDriverId,
        status: { $in: [...ACTIVE_LOAD_STATUSES] },
        ...missingOwner,
      },
      { $set: { dispatchOwnerId: dispatcher._id } },
    );
    if (result.modifiedCount > 0) {
      filled += 1;
      console.log(`  set ${label} -> dispatcher ${candidateId}`);
    }
  }

  console.log(`${APPLY ? 'Filled' : 'Would fill'}: ${filled}`);
  if (unresolved.length) {
    console.log(`Needs Dispatch to reconfirm in Driver Tracker (${unresolved.length}):`);
    for (const line of unresolved) console.log(`  ${line}`);
  }

  if (!APPLY) console.log('Dry run complete. No data changed.');
  else console.log('Dispatch owner backfill complete.');
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
