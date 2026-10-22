import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import TimeLog from '../models/TimeLog.model';
import AuditLog from '../models/AuditLog.model';

const args = process.argv.slice(2).filter((a) => a !== '--apply');
const APPLY = process.argv.includes('--apply');
const [targetEmail, performerEmail] = args.map((a) => a.trim().toLowerCase());

const denver = (d: Date) =>
  d.toLocaleString('en-US', { timeZone: 'America/Denver', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

async function run() {
  if (!targetEmail || !performerEmail) {
    console.log('Usage: npx ts-node src/scripts/force-clockout-main-identity.ts <employee email> <admin email> [--apply]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log(`Connected — ${APPLY ? 'APPLY mode' : 'DRY RUN (add --apply to clock out)'}`);

  const mainUser = await User.findOne({ email: targetEmail }).select('name organizationId').lean();
  if (!mainUser) throw new Error(`No Suprah AI account for ${targetEmail}`);
  const performer = await CrmUser.findOne({ email: performerEmail }).select('fullName role organizationId').lean();
  if (!performer || !['admin', 'manager'].includes(performer.role)) throw new Error(`${performerEmail} is not an admin/manager CRM account`);

  const userId = mainUser._id.toString();
  const logs = await TimeLog.find({ userId }).sort({ timestamp: 1 }).lean();
  let isOnShift = false;
  let openBreak = false;
  let shiftStartedAt: Date | null = null;
  for (const log of logs) {
    if (log.type === 'time-in') { isOnShift = true; openBreak = false; shiftStartedAt = log.timestamp; }
    else if (log.type === 'time-out') { isOnShift = false; openBreak = false; shiftStartedAt = null; }
    else if (log.type === 'break-in') { openBreak = true; }
    else if (log.type === 'break-out') { openBreak = false; }
  }

  console.log(`Suprah AI account: ${mainUser.name ?? targetEmail}`);
  if (!isOnShift || !shiftStartedAt) {
    console.log('Not clocked in on the Suprah AI account — nothing to do.');
    await mongoose.disconnect();
    return;
  }
  console.log(`Open shift since ${denver(shiftStartedAt)}${openBreak ? ' (currently on break)' : ''}`);

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to clock out now.');
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  let breakOutLogId: string | null = null;
  if (openBreak) {
    const created = await TimeLog.create({
      userId, userModel: 'User', type: 'break-out', timestamp: now,
      note: `Break closed alongside manual clock-out by ${performer.fullName}`,
    });
    breakOutLogId = created._id.toString();
  }

  const timeOutLog = await TimeLog.create({
    userId, userModel: 'User', type: 'time-out', timestamp: now,
    note: `Manually clocked out by ${performer.fullName} (admin action — open shift on Suprah AI account blocked clock-in on CRM account)`,
  });

  await AuditLog.create({
    entityType: 'TimeLog',
    entityId: timeOutLog._id.toString(),
    action: 'MANUAL_CLOCK_OUT',
    changes: { userId, userModel: 'User', breakOutLogId, clockedOutAt: now, shiftStartedAt },
    reason: 'Open shift on Suprah AI account blocked clock-in on CRM account',
    performedBy: performer._id,
    organizationId: (mainUser.organizationId ?? performer.organizationId)?.toString(),
  });

  console.log(`Clocked out at ${denver(now)}. Shift ${denver(shiftStartedAt)} → ${denver(now)} stays on the Suprah AI account.`);
  await mongoose.disconnect();
}

run().catch(async (err) => { console.error(err instanceof Error ? err.message : err); await mongoose.disconnect().catch(() => {}); process.exit(1); });
