/**
 * One-off diagnostic: reads the tray-client-diagnostic SystemLog entries for a given
 * CrmUser (by full name/email partial match) within a date range, so we can see
 * exactly what the tray app self-reported (watchdog restarts, capture exceptions,
 * zero-sources, diagnostic-attempt failures) without guessing from code alone.
 *
 * Usage: npx ts-node src/scripts/check-user-diagnostics.ts "RJ Turingan" [daysBack=2]
 */
import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import { SystemLog } from '../models/SystemLog.model';

const run = async () => {
  const nameQuery = process.argv[2];
  const daysBack = parseInt(process.argv[3] || '2', 10);
  if (!nameQuery) {
    console.error('Usage: npx ts-node src/scripts/check-user-diagnostics.ts "<full name or email>" [daysBack]');
    process.exit(1);
  }

  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const users = await CrmUser.find({
    $or: [
      { fullName: { $regex: nameQuery, $options: 'i' } },
      { email: { $regex: nameQuery, $options: 'i' } },
    ],
  }).select('fullName email').lean();

  if (users.length === 0) {
    console.log(`No CrmUser matched "${nameQuery}".`);
    process.exit(0);
  }

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

  for (const user of users) {
    console.log(`\n=== ${user.fullName} <${user.email}> (${user._id}) ===`);
    const logs = await SystemLog.find({
      context: 'tray-client-diagnostic',
      'req.userId': user._id.toString(),
      timestamp: { $gte: since },
    }).sort({ timestamp: 1 }).select('timestamp event message meta level').lean();

    if (logs.length === 0) {
      console.log(`  No tray-client-diagnostic entries in the last ${daysBack} day(s).`);
      console.log('  (This itself is meaningful: either nothing went wrong, or the tray never reached the backend to report it.)');
      continue;
    }

    for (const log of logs) {
      const ts = new Date(log.timestamp).toISOString();
      console.log(`  [${ts}] ${log.event ?? '(no event)'} — ${log.message}`);
      if (log.meta && Object.keys(log.meta).length > 0) {
        console.log(`    meta: ${JSON.stringify(log.meta)}`);
      }
    }
    console.log(`  Total: ${logs.length} entr(ies)`);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
