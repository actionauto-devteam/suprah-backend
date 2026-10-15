/**
 * One pending driver account application per driver.
 *
 * Two devices submitting at the same moment could create two pending
 * applications. The app now finds-or-creates in one step, and this script adds
 * the database rule that makes a second pending application impossible.
 *
 * Existing duplicates must go first (the rule can't be added while they
 * exist): for each driver, the newest pending application is kept (it's the
 * one the Driver Portal and approval already read) and the older pending
 * copies are removed. They hold nothing else: only the driver, the status and
 * timestamps. Approved and rejected applications are never touched.
 *
 * Dry run (default):  npx ts-node --transpile-only src/scripts/migrate-driver-request-one-pending.ts
 * Apply:              npx ts-node --transpile-only src/scripts/migrate-driver-request-one-pending.ts --apply
 */
import dns from 'node:dns';
import mongoose from 'mongoose';
import config from '../config';

// Same DNS setup as server.ts: some networks refuse the database address
// lookup (querySrv ECONNREFUSED) unless public DNS servers are used.
dns.setServers(['8.8.8.8', '1.1.1.1']);
dns.setDefaultResultOrder('ipv4first');

const APPLY = process.argv.includes('--apply');
const INDEX_NAME = 'driverUserId_1_one_pending';

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to change data and indexes)'}`);

  const requests = mongoose.connection.collection('driverrequests');

  const duplicates = await requests
    .aggregate<{ _id: unknown; ids: unknown[]; createdAts: Date[]; count: number }>([
      { $match: { status: 'pending' } },
      { $sort: { createdAt: -1, _id: -1 } },
      { $group: { _id: '$driverUserId', ids: { $push: '$_id' }, createdAts: { $push: '$createdAt' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  const extraIds = duplicates.flatMap((group) => group.ids.slice(1));
  console.log(`Drivers with more than one pending application: ${duplicates.length}`);
  for (const group of duplicates.slice(0, 50)) {
    console.log(
      `  driver ${String(group._id)}: ${group.count} pending, keeping ${String(group.ids[0])} ` +
        `(created ${group.createdAts[0]?.toISOString?.() ?? 'unknown'}), removing ${group.count - 1}`,
    );
  }
  if (duplicates.length > 50) console.log(`  … and ${duplicates.length - 50} more`);

  const indexes = await requests.indexes();
  const existing = indexes.find((index) => index.name === INDEX_NAME);
  console.log(`One-pending rule (${INDEX_NAME}): ${existing ? 'present' : 'MISSING'}`);

  if (!APPLY) {
    console.log('Dry run complete. Planned actions:');
    if (extraIds.length) console.log(`  - remove ${extraIds.length} extra pending application(s)`);
    if (!existing) console.log(`  - create unique partial index ${INDEX_NAME}`);
    if (!extraIds.length && existing) console.log('  - nothing to do');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (extraIds.length) {
    const result = await requests.deleteMany({ _id: { $in: extraIds as any[] }, status: 'pending' });
    console.log(`Removed ${result.deletedCount} extra pending application(s).`);
  }

  if (!existing) {
    await requests.createIndex(
      { driverUserId: 1 },
      { unique: true, name: INDEX_NAME, partialFilterExpression: { status: 'pending' } },
    );
    console.log(`Created ${INDEX_NAME}.`);
  }

  await mongoose.disconnect();
  console.log('Done.');
  process.exit(0);
};

run().catch(async (error) => {
  console.error('Migration failed:', error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
