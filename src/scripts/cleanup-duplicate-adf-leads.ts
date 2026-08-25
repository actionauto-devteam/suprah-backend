// One-off cleanup: ADF webhook redeliveries (Cars.com, dealer.com, etc.) used
// to create a brand-new Lead record every time, with no dedup guard — see the
// fix in lead.controller.ts's receiveADF. This finds leads that are almost
// certainly redelivery duplicates (same org + email + vehicle, created within
// 15 minutes of an earlier one) and removes them, but ONLY when the duplicate
// is still untouched (status New, unread, no notes/status history) — if a rep
// already worked a "duplicate" copy, it's left alone for manual review instead
// of being auto-deleted.
//
// Defaults to a DRY RUN that just prints what it would delete. Pass --confirm
// to actually delete.

import mongoose from 'mongoose';
import config from '../config';
import Lead from '../models/lead.model';

const DEDUP_WINDOW_MS = 15 * 60 * 1000;
const CONFIRM = process.argv.includes('--confirm');

const isUntouched = (lead: any) =>
  lead.status === 'New' &&
  !lead.isRead &&
  (!lead.notes || lead.notes.length === 0) &&
  (!lead.statusHistory || lead.statusHistory.length === 0);

const run = async () => {
  const databaseUri = config.mongoose?.url || process.env.MONGODB_URI || '';
  if (!databaseUri) {
    console.error('ERROR: Database URI not found in config or environment variables.');
    process.exit(1);
  }

  await mongoose.connect(databaseUri);
  console.log('Connected to database.');
  console.log(CONFIRM ? 'Mode: LIVE — matching duplicates will be deleted.' : 'Mode: DRY RUN — nothing will be deleted (pass --confirm to actually delete).');

  const leads = await Lead.find({ channel: 'adf' })
    .select('organizationId email vehicle status isRead notes statusHistory createdAt firstName lastName')
    .sort({ organizationId: 1, email: 1, createdAt: 1 })
    .lean();

  console.log(`Scanning ${leads.length} ADF lead(s)...\n`);

  const groups = new Map<string, typeof leads>();
  for (const lead of leads) {
    const key = [
      String(lead.organizationId),
      (lead.email || '').toLowerCase().trim(),
      lead.vehicle?.year || '',
      (lead.vehicle?.make || '').toLowerCase().trim(),
      (lead.vehicle?.model || '').toLowerCase().trim(),
    ].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(lead);
  }

  const toDelete: string[] = [];
  const needsReview: string[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // group is already sorted by createdAt ascending (survives from the query sort)
    let anchor = group[0];
    for (let i = 1; i < group.length; i++) {
      const candidate = group[i];
      const gapMs = new Date(candidate.createdAt).getTime() - new Date(anchor.createdAt).getTime();
      if (gapMs > DEDUP_WINDOW_MS) {
        anchor = candidate; // too far apart — treat as a separate, later inquiry
        continue;
      }

      const name = `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim();
      if (isUntouched(candidate)) {
        toDelete.push(String(candidate._id));
        console.log(`✓  DELETE  ${name} (${candidate.email}) — ${candidate.vehicle?.year} ${candidate.vehicle?.make} ${candidate.vehicle?.model} — dup of ${anchor._id}, ${Math.round(gapMs / 1000)}s apart`);
      } else {
        needsReview.push(String(candidate._id));
        console.log(`?  REVIEW  ${name} (${candidate.email}) — ${candidate.vehicle?.year} ${candidate.vehicle?.make} ${candidate.vehicle?.model} — looks like a dup of ${anchor._id} but has activity, skipping`);
      }
      // anchor stays the same so a 3rd+ redelivery still clusters to the original
    }
  }

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Untouched duplicates found : ${toDelete.length}`);
  console.log(`Needs manual review        : ${needsReview.length}`);
  console.log(`─────────────────────────────────────────\n`);

  if (CONFIRM && toDelete.length > 0) {
    const result = await Lead.deleteMany({ _id: { $in: toDelete } });
    console.log(`Deleted ${result.deletedCount} duplicate lead(s).`);
  } else if (toDelete.length > 0) {
    console.log('Dry run only — re-run with --confirm to actually delete the leads listed above.');
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
