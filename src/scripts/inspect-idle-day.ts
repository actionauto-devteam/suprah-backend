import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import CrmUser from '../models/CrmUser.model';
import TimeLog from '../models/TimeLog.model';
import ActivityInterval from '../models/ActivityInterval.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import { SystemLog } from '../models/SystemLog.model';
import TrayDevice from '../models/TrayDevice.model';
import { buildIdleLog } from '../utils/timeLogEngine';
import { isIdleDetectionExemptDept } from '../config/departmentMonitoring';

const TZ_OFFSET_MIN = -360;
const args = process.argv.slice(2);
const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const search = args.filter((a) => a !== dateArg).join(' ').trim();

const denverToday = () => new Date(Date.now() + TZ_OFFSET_MIN * 60_000).toISOString().split('T')[0];
const t = (d?: Date | string | null) =>
  d ? new Date(d).toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }) : '-';
const mins = (ms: number) => `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function run() {
  if (!search) {
    console.log('Usage: npx ts-node src/scripts/inspect-idle-day.ts <name or email> [YYYY-MM-DD]');
    process.exit(1);
  }
  const day = dateArg ?? denverToday();
  const start = new Date(new Date(`${day}T00:00:00.000Z`).getTime() - TZ_OFFSET_MIN * 60_000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log(`Connected (read-only). ${day} (Denver) for "${search}"`);

  const rx = new RegExp(escapeRegex(search), 'i');
  const users = await CrmUser.find({ $or: [{ email: rx }, { fullName: rx }] })
    .select('fullName email department organizationId screenshotExempt')
    .lean();
  if (users.length === 0) console.log('No CRM account found.');

  for (const u of users) {
    const id = u._id as mongoose.Types.ObjectId;
    const exempt = await isIdleDetectionExemptDept(u.organizationId?.toString(), u.department);
    console.log(`\n==================== ${u.fullName} (${u.email}) ====================`);
    console.log(`Dept ${u.department ?? '-'} | idle-detection exempt: ${exempt} | screenshot exempt: ${!!u.screenshotExempt}`);

    const hb = await AgentHeartbeat.findOne({ userId: id }).lean();
    if (hb) {
      console.log(`Tray: ${hb.platform ?? '-'} v${hb.appVersion ?? '-'} | last seen ${t(hb.lastSeenAt)} | isIdle ${hb.isIdle} | idleSince ${t(hb.idleSince)} | idleStage ${hb.idleStage ?? '-'} | idleBrokenAt ${t(hb.idleBrokenAt)} | onBreak ${hb.isOnBreak}`);
    } else {
      console.log('Tray: never connected');
    }

    const devices = await TrayDevice.find({ userId: id }).select('label platform appVersion lastSeenAt revokedAt createdAt').sort({ lastSeenAt: -1 }).lean();
    console.log(`Registered tray devices: ${devices.length}`);
    devices.forEach((d) => console.log(`  "${d.label || '-'}" ${d.platform || '-'} v${d.appVersion || '-'} | last seen ${new Date(d.lastSeenAt).toLocaleString('en-US', { timeZone: 'America/Denver' })}${d.revokedAt ? ' | REVOKED' : ''}`));

    const logs = await TimeLog.find({ userId: id, timestamp: { $gte: start, $lt: end } }).sort({ timestamp: 1 }).lean();
    console.log(`\nTime logs: ${logs.length}`);
    logs.forEach((l) => console.log(`  ${t(l.timestamp)}  ${l.type}${l.note ? `  note: "${l.note}"` : ''}`));

    const intervals = await ActivityInterval.find({ userId: id, endAt: { $gt: start }, startAt: { $lt: end } }).sort({ startAt: 1 }).lean();
    console.log(`\nActive intervals sent by the tray: ${intervals.length}`);
    let prevEnd: number | null = logs.find((l) => l.type === 'time-in') ? new Date(logs.find((l) => l.type === 'time-in')!.timestamp).getTime() : null;
    for (const iv of intervals) {
      const s = new Date(iv.startAt).getTime();
      const e = new Date(iv.endAt).getTime();
      const gap = prevEnd !== null ? s - prevEnd : 0;
      const gapNote = gap >= 60_000 ? `   <-- gap ${mins(gap)} before this` : '';
      console.log(`  ${t(iv.startAt)} → ${t(iv.endAt)}  (${mins(e - s)})${gapNote}`);
      prevEnd = Math.max(prevEnd ?? 0, e);
    }
    if (prevEnd !== null) console.log(`  last covered until ${t(new Date(prevEnd))}; now ${t(new Date())} (${mins(Date.now() - prevEnd)} not yet covered)`);

    const idleLog = buildIdleLog(
      logs.map((l) => ({ type: l.type, timestamp: l.timestamp })) as never,
      intervals.map((i) => ({ startAt: i.startAt, endAt: i.endAt })) as never,
      TZ_OFFSET_MIN,
    );
    console.log(`\nIdle periods the system computes (gaps over 10 min): ${idleLog.length}`);
    idleLog.forEach((p) => console.log(`  ${t(p.idleStart)} → ${p.idleEnd ? t(p.idleEnd) : 'ongoing'}  (${mins(p.durationSeconds * 1000)})`));

    const diags = await SystemLog.find({ 'req.userId': id.toString(), timestamp: { $gte: start, $lt: end } })
      .sort({ timestamp: 1 })
      .select('timestamp event message meta')
      .lean();
    console.log(`\nTray diagnostics: ${diags.length}`);
    for (const d of diags as unknown as Array<{ timestamp: Date; event?: string; message?: string; meta?: Record<string, unknown> }>) {
      const m = d.meta ?? {};
      const brief = ['idleSeconds', 'idleDetectionExempt', 'isOnShift', 'isOnBreak', 'appVersion', 'requestedEndAt', 'activityStartMs', 'status', 'screenshotCaptured', 'wasTracking']
        .filter((k) => k in m)
        .map((k) => `${k}=${JSON.stringify(m[k])}`)
        .join(' ');
      console.log(`  ${t(d.timestamp)}  ${d.event ?? '-'}  ${d.message ?? ''}${brief ? `  [${brief}]` : ''}`);
    }
  }

  await mongoose.disconnect();
}

run().catch(async (err) => { console.error(err instanceof Error ? err.message : err); await mongoose.disconnect().catch(() => {}); process.exit(1); });
