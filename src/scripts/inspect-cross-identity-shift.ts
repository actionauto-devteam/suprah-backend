import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import TimeLog from '../models/TimeLog.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';
import EmployeeLocation from '../models/EmployeeLocation.model';

const search = process.argv.slice(2).join(' ').trim();
const LOOKBACK_DAYS = 3;

const denver = (d?: Date | string | null) =>
  d
    ? new Date(d).toLocaleString('en-US', {
        timeZone: 'America/Denver',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      })
    : '-';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function describeIdentity(label: string, id: mongoose.Types.ObjectId) {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const logs = await TimeLog.find({ userId: id, timestamp: { $gte: since } }).sort({ timestamp: 1 }).lean();
  console.log(`\n  ${label} time logs (last ${LOOKBACK_DAYS} days): ${logs.length}`);
  for (const l of logs) {
    const extras = [
      l.startedVia ? `via ${l.startedVia}` : '',
      l.note ? `note: "${l.note}"` : '',
      l.ipAddress ? `ip ${l.ipAddress}` : '',
    ].filter(Boolean).join(' | ');
    console.log(`    ${denver(l.timestamp)}  ${l.type.padEnd(9)} ${extras}`);
  }

  const hb = await AgentHeartbeat.findOne({ userId: id }).lean();
  console.log(
    hb
      ? `  ${label} tray app: platform ${hb.platform ?? '-'}, version ${hb.appVersion ?? '-'}, last seen ${denver(hb.lastSeenAt)}`
      : `  ${label} tray app: never connected`,
  );

  const loc = await EmployeeLocation.findOne({ userId: id }).lean();
  console.log(
    loc
      ? `  ${label} location: device ${loc.deviceType ?? '-'}, state ${loc.sharingState ?? '-'}, last ping ${denver(loc.lastSeenAt)}`
      : `  ${label} location: none`,
  );
}

async function run() {
  if (!search) {
    console.log('Usage: npx ts-node src/scripts/inspect-cross-identity-shift.ts <name or email>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log(`Connected (read-only). Searching for "${search}"`);

  const rx = new RegExp(escapeRegex(search), 'i');
  const crmUsers = await CrmUser.find({ $or: [{ email: rx }, { fullName: rx }] })
    .select('fullName email username role department isActive isOffboarded organizationId')
    .lean();
  const emails = new Set<string>(crmUsers.map((u) => u.email.toLowerCase()));
  const mainByName = await User.find({ $or: [{ email: rx }, { name: rx }] }).select('email').lean();
  mainByName.forEach((u) => u.email && emails.add(u.email.toLowerCase()));

  if (emails.size === 0) {
    console.log('No matching account found.');
    await mongoose.disconnect();
    return;
  }

  for (const email of emails) {
    console.log(`\n==================== ${email} ====================`);
    const crm = await CrmUser.findOne({ email })
      .select('fullName username role department isActive isOffboarded')
      .lean();
    const main = await User.findOne({ email })
      .select('name role organizationRole isActive personalInfo')
      .lean();

    if (crm) {
      console.log(`CRM account: ${crm.fullName} (${crm.username}), role ${crm.role}, dept ${crm.department ?? '-'}, active ${crm.isActive}, offboarded ${!!crm.isOffboarded}`);
      await describeIdentity('CRM', crm._id as mongoose.Types.ObjectId);
    } else {
      console.log('CRM account: none');
    }

    if (main) {
      const dept = (main.personalInfo as { department?: string } | undefined)?.department;
      console.log(`\nSuprah AI account: ${main.name ?? '-'}, role ${main.role}${main.organizationRole ? ` / ${main.organizationRole}` : ''}, dept ${dept ?? '-'}, active ${main.isActive}`);
      await describeIdentity('Suprah AI', main._id as mongoose.Types.ObjectId);
    } else {
      console.log('\nSuprah AI account: none');
    }
  }

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
