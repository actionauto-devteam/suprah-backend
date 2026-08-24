/**
 * One-off diagnostic: prints every AuditLog entry touching a given CrmUser's
 * TimeLog/Screenshot records within a date range, to rule out (or confirm)
 * whether any admin action (delete/exclude screenshot, time override) is
 * responsible for an apparent data loss.
 *
 * Usage: npx ts-node src/scripts/check-user-auditlog.ts "RJ Turingan" [daysBack=2]
 */
import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import AuditLog from '../models/AuditLog.model';

const run = async () => {
  const nameQuery = process.argv[2];
  const daysBack = parseInt(process.argv[3] || '2', 10);
  if (!nameQuery) {
    console.error('Usage: npx ts-node src/scripts/check-user-auditlog.ts "<full name or email>" [daysBack]');
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
    const userIdStr = user._id.toString();
    const logs = await AuditLog.find({
      entityType: { $in: ['TimeLog', 'Screenshot'] },
      createdAt: { $gte: since },
      $or: [
        { 'changes.userId': userIdStr },
        { 'changes.targetUserId': userIdStr },
      ],
    }).sort({ createdAt: 1 }).lean();

    if (logs.length === 0) {
      console.log(`  No TimeLog/Screenshot AuditLog entries referencing this user in the last ${daysBack} day(s).`);
      continue;
    }

    for (const log of logs) {
      console.log(`  [${new Date(log.createdAt).toISOString()}] ${log.action} (${log.entityType}) by ${log.performedBy} — reason: ${log.reason || '(none)'}`);
      console.log(`    changes: ${JSON.stringify(log.changes)}`);
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
