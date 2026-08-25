/**
 * One-off diagnostic: reproduces the exact inputs runStaleShiftAutoClockout would see
 * for a given user's currently-open shift, to explain why it did/didn't auto-close.
 * Usage: npx ts-node src/scripts/check-stale-shift-diag.ts "<email or name>"
 */
import mongoose from 'mongoose';
import config from '../config';
import CrmUser from '../models/CrmUser.model';
import TimeLog from '../models/TimeLog.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import ActivityInterval from '../models/ActivityInterval.model';

const run = async () => {
  const nameQuery = process.argv[2];
  if (!nameQuery) { console.error('Usage: npx ts-node src/scripts/check-stale-shift-diag.ts "<email or name>"'); process.exit(1); }

  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) { console.error('ERROR: Database URI not found.'); process.exit(1); }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');

  const user = await CrmUser.findOne({
    $or: [{ fullName: { $regex: nameQuery, $options: 'i' } }, { email: { $regex: nameQuery, $options: 'i' } }],
  }).select('fullName email').lean();
  if (!user) { console.log(`No CrmUser matched "${nameQuery}".`); process.exit(0); }

  console.log(`\n=== ${user.fullName} <${user.email}> (${user._id}) ===`);

  const logs = await TimeLog.find({ userId: user._id }).sort({ timestamp: 1 }).lean();
  let isOnShift = false;
  let shiftStartedAt: Date | null = null;
  let openBreakStartedAt: Date | null = null;
  for (const log of logs) {
    if (log.type === 'time-in') { isOnShift = true; shiftStartedAt = log.timestamp; openBreakStartedAt = null; }
    else if (log.type === 'time-out') { isOnShift = false; shiftStartedAt = null; openBreakStartedAt = null; }
    else if (log.type === 'break-in') { openBreakStartedAt = log.timestamp; }
    else if (log.type === 'break-out') { openBreakStartedAt = null; }
  }

  console.log(`isOnShift: ${isOnShift}`);
  console.log(`shiftStartedAt: ${shiftStartedAt?.toISOString()}`);
  console.log(`openBreakStartedAt: ${openBreakStartedAt?.toISOString() ?? 'null'}`);

  if (!isOnShift || !shiftStartedAt) { console.log('No open shift — nothing more to check.'); process.exit(0); }

  const now = new Date();
  const heartbeat = await AgentHeartbeat.findOne({ userId: user._id }).lean();
  console.log(`\nheartbeat doc exists: ${!!heartbeat}`);
  console.log(`heartbeat.lastSeenAt: ${heartbeat?.lastSeenAt ? new Date(heartbeat.lastSeenAt).toISOString() : 'N/A'}`);
  const silentMs = heartbeat ? now.getTime() - new Date(heartbeat.lastSeenAt).getTime() : Infinity;
  console.log(`silentMs: ${silentMs} (${(silentMs / 60000).toFixed(1)} min)`);

  const intervals = await ActivityInterval.find({ userId: user._id, startAt: { $gte: shiftStartedAt } })
    .select('startAt endAt durationSeconds').lean();
  console.log(`\nActivityInterval count since shiftStartedAt: ${intervals.length}`);
  for (const i of intervals) {
    console.log(`  ${new Date(i.startAt).toISOString()} -> ${new Date(i.endAt).toISOString()} (${i.durationSeconds}s)`);
  }
  const renderedSeconds = intervals.reduce((sum, i) => sum + i.durationSeconds, 0);
  console.log(`renderedSeconds: ${renderedSeconds}`);

  const openHours = (now.getTime() - shiftStartedAt.getTime()) / 3_600_000;
  console.log(`\nopenHours: ${openHours.toFixed(2)}`);
  const hasNoDataEver = intervals.length === 0 && !heartbeat;
  console.log(`hasNoDataEver (intervals.length===0 && !heartbeat): ${hasNoDataEver}`);

  console.log('\n--- Branch evaluation ---');
  console.log(`Branch 1 (8h+ rendered, 1h+ silent): ${renderedSeconds >= 28800 && silentMs >= 3600000}`);
  console.log(`Branch 2 (under 8h, intervals>0, 30+min silent): ${renderedSeconds < 28800 && intervals.length > 0 && silentMs >= 1800000}`);
  console.log(`Branch 3 (no data ever, open>16h): ${hasNoDataEver && openHours > 16}`);

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => { console.error('Script failed:', err); process.exit(1); });
