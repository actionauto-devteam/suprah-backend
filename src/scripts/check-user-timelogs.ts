/**
 * One-off diagnostic: prints every TimeLog event for a given CrmUser within a
 * date range, in order — used to see the raw time-in/time-out/break pattern
 * directly (e.g. repeated time-ins in the same session = repeated tray
 * crashes/restarts requiring the user to Start Shift again).
 *
 * Usage: npx ts-node src/scripts/check-user-timelogs.ts "RJ Turingan" [daysBack=2]
 */
import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import TimeLog from '../models/TimeLog.model';

const run = async () => {
  const nameQuery = process.argv[2];
  const daysBack = parseInt(process.argv[3] || '2', 10);
  if (!nameQuery) {
    console.error('Usage: npx ts-node src/scripts/check-user-timelogs.ts "<full name or email>" [daysBack]');
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
    const logs = await TimeLog.find({
      userId: user._id,
      timestamp: { $gte: since },
    }).sort({ timestamp: 1 }).select('type timestamp note').lean();

    if (logs.length === 0) {
      console.log(`  No TimeLog entries in the last ${daysBack} day(s).`);
      continue;
    }

    for (const log of logs) {
      console.log(`  [${new Date(log.timestamp).toISOString()}] ${log.type}${log.note ? ` — ${log.note}` : ''}`);
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
