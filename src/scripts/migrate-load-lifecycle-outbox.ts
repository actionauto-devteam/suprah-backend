/**
 * DT-02 / DT-16: clean up the Load lifecycle outbox after the type-allowlist
 * and dead-letter fixes.
 *
 *  1. Retire (dead-letter) undelivered events older than --older-than-hours
 *     (default 24) without delivering them, so admins are not flooded with
 *     stale Picked Up / In Transit / Delivered notifications.
 *  2. Set lifecycleOutboxPending on Loads that still hold deliverable events,
 *     and clear it where nothing is pending.
 *  3. Create the partial index the worker uses to find pending Loads.
 *
 * Dry run (default):  npx ts-node --transpile-only src/scripts/migrate-load-lifecycle-outbox.ts
 * Apply:              npx ts-node --transpile-only src/scripts/migrate-load-lifecycle-outbox.ts --apply [--older-than-hours=24]
 *
 * Uses the native driver, so Load.updatedAt is not touched.
 */
import mongoose from 'mongoose';
import config from '../config';

const APPLY = process.argv.includes('--apply');
const hoursArg = process.argv.find((arg) => arg.startsWith('--older-than-hours='));
const OLDER_THAN_HOURS = hoursArg ? Number(hoursArg.split('=')[1]) : 24;
const PENDING_INDEX_NAME = 'lifecycleOutboxPending_1';

const PENDING = { processedAt: { $exists: false }, deadLetteredAt: { $exists: false } };

const run = async () => {
  if (!Number.isFinite(OLDER_THAN_HOURS) || OLDER_THAN_HOURS < 1) {
    console.error('ERROR: --older-than-hours must be a number >= 1');
    process.exit(1);
  }

  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to change data)'}`);

  const loads = mongoose.connection.collection('loads');
  const cutoff = new Date(Date.now() - OLDER_THAN_HOURS * 60 * 60 * 1000);

  // Summary by kind. Payloads are never printed (they contain recipients/text).
  const summary = await loads
    .aggregate([
      { $match: { lifecycleOutbox: { $elemMatch: PENDING } } },
      { $unwind: '$lifecycleOutbox' },
      {
        $match: {
          'lifecycleOutbox.processedAt': { $exists: false },
          'lifecycleOutbox.deadLetteredAt': { $exists: false },
        },
      },
      {
        $group: {
          _id: {
            kind: '$lifecycleOutbox.kind',
            stale: { $lt: ['$lifecycleOutbox.createdAt', cutoff] },
          },
          count: { $sum: 1 },
          sampleError: { $first: '$lifecycleOutbox.lastError' },
        },
      },
      { $sort: { '_id.kind': 1 } },
    ])
    .toArray();

  let staleCount = 0;
  let recentCount = 0;
  console.log(`Undelivered events (stale = created before ${cutoff.toISOString()}):`);
  for (const row of summary) {
    const label = row._id.stale ? 'stale ' : 'recent';
    if (row._id.stale) staleCount += row.count;
    else recentCount += row.count;
    console.log(`  ${label} ${String(row._id.kind).padEnd(28)} ${row.count}${row.sampleError ? `  e.g. "${String(row.sampleError).slice(0, 120)}"` : ''}`);
  }
  console.log(`Totals: ${staleCount} stale to retire, ${recentCount} recent left to deliver.`);

  if (!APPLY) {
    console.log('Dry run complete. No data changed.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const now = new Date();
  const retired = await loads.updateMany(
    { lifecycleOutbox: { $elemMatch: { ...PENDING, createdAt: { $lt: cutoff } } } },
    {
      $set: {
        'lifecycleOutbox.$[event].deadLetteredAt': now,
        'lifecycleOutbox.$[event].lastError': `Retired by migration: undelivered for more than ${OLDER_THAN_HOURS}h before the outbox fix`,
      },
      $unset: {
        'lifecycleOutbox.$[event].lockToken': '',
        'lifecycleOutbox.$[event].lockedUntil': '',
      },
    },
    {
      arrayFilters: [
        {
          'event.processedAt': { $exists: false },
          'event.deadLetteredAt': { $exists: false },
          'event.createdAt': { $lt: cutoff },
        },
      ],
    },
  );
  console.log(`Retired stale events on ${retired.modifiedCount} loads.`);

  const flagged = await loads.updateMany(
    { lifecycleOutbox: { $elemMatch: PENDING } },
    { $set: { lifecycleOutboxPending: true } },
  );
  console.log(`Flagged ${flagged.modifiedCount} loads with deliverable events.`);

  const unflagged = await loads.updateMany(
    { lifecycleOutboxPending: true, lifecycleOutbox: { $not: { $elemMatch: PENDING } } },
    { $unset: { lifecycleOutboxPending: '' } },
  );
  console.log(`Cleared the flag on ${unflagged.modifiedCount} loads with nothing pending.`);

  const indexes = await loads.indexes();
  if (!indexes.some((index) => index.name === PENDING_INDEX_NAME)) {
    await loads.createIndex(
      { lifecycleOutboxPending: 1 },
      { name: PENDING_INDEX_NAME, partialFilterExpression: { lifecycleOutboxPending: true } },
    );
    console.log(`Created ${PENDING_INDEX_NAME}.`);
  }

  console.log('Lifecycle outbox migration complete.');
  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
