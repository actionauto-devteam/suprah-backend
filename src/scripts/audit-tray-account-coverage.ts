import mongoose from 'mongoose';
import config from '../config';
import { buildCoverageReport } from '../utils/trayAccountCoverage.util';
import type { CrmRow, HeartbeatRow, MainRow } from '../utils/trayAccountCoverage.util';

const WINDOWS = [7, 30, 90];

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database handle after connect.');
  console.log(`Connected to database "${mongoose.connection.name}" (read-only audit: find queries only, nothing is written or created).`);

  const now = new Date();
  const since = new Date(now.getTime() - Math.max(...WINDOWS) * 24 * 60 * 60 * 1000);

  const beats = await db
    .collection('agentheartbeats')
    .find({ lastSeenAt: { $gte: since } }, { projection: { userId: 1, lastSeenAt: 1, appVersion: 1, platform: 1 } })
    .toArray();
  const heartbeats: HeartbeatRow[] = beats.map((beat: any) => ({
    userId: String(beat.userId),
    lastSeenAt: beat.lastSeenAt,
    appVersion: beat.appVersion ?? null,
    platform: beat.platform ?? null,
  }));
  const ids = Array.from(new Set(beats.map((beat: any) => beat.userId)));

  const crmRows: CrmRow[] = [];
  for (const part of chunk(ids, 500)) {
    const rows = await db
      .collection('crmusers')
      .find({ _id: { $in: part } }, { projection: { isActive: 1, isOffboarded: 1, organizationId: 1 } })
      .toArray();
    for (const row of rows as any[]) {
      crmRows.push({ id: String(row._id), isActive: row.isActive, isOffboarded: row.isOffboarded, organizationId: row.organizationId });
    }
  }

  const crmIdSet = new Set(crmRows.map((row) => row.id));
  const remaining = ids.filter((id: any) => !crmIdSet.has(String(id)));

  const mainRows: MainRow[] = [];
  for (const part of chunk(remaining, 500)) {
    const rows = await db.collection('users').find({ _id: { $in: part } }, { projection: { email: 1 } }).toArray();
    for (const row of rows as any[]) mainRows.push({ id: String(row._id), email: row.email ?? null });
  }

  const emails = Array.from(new Set(mainRows.map((row) => (row.email ?? '').trim().toLowerCase()).filter(Boolean)));
  const crmEmails = new Set<string>();
  for (const part of chunk(emails, 500)) {
    const rows = await db.collection('crmusers').find({ email: { $in: part } }, { projection: { email: 1 } }).toArray();
    for (const row of rows as any[]) crmEmails.add(String(row.email).trim().toLowerCase());
  }

  await mongoose.disconnect();

  const report = buildCoverageReport({ heartbeats, crmRows, mainRows, crmEmails, now, windowDays: WINDOWS });
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
};

run().catch(async (err) => {
  console.error('Tray account coverage audit failed:', err?.message ?? err);
  try {
    await mongoose.disconnect();
  } catch {
    process.exit(1);
  }
  process.exit(1);
});
