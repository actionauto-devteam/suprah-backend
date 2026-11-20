import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { foldRepeatedInquiries, moveNoticeCardsToOthers, previewOpenDuplicateCards } from '../services/leadDuplicateCleanup.service';
import logger from '../utils/logger';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const orgArg = args.find((arg) => arg.startsWith('--org='));
const organizationId = orgArg ? orgArg.slice('--org='.length).trim() : undefined;
const unknownArgs = args.filter((arg) => arg !== '--apply' && !arg.startsWith('--org='));
const EXAMPLES = 8;

const denver = (value: unknown) => (value
  ? new Date(value as string).toLocaleString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  : '-');
const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

async function orgNames() {
  const rows = await mongoose.connection.db!.collection('organizations').find({}).project({ name: 1 }).toArray();
  return new Map(rows.map((row) => [String(row._id), String(row.name || row._id)]));
}

async function main() {
  logger.level = 'silent';
  if (unknownArgs.length || args.filter((arg) => arg.startsWith('--org=')).length > 1) {
    throw new Error(`Unknown option: ${unknownArgs.join(' ') || 'more than one --org='}. Use only --apply and --org=<organization id> (no space after =).`);
  }
  if (orgArg && (!organizationId || !mongoose.isValidObjectId(organizationId))) {
    throw new Error('Write the dealership as --org=<organization id>, with no space');
  }
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.MONGODB_URI as string, apply ? {} : { readPreference: 'secondaryPreferred' });
  console.log(apply ? 'APPLY: saving changes.' : 'PREVIEW ONLY: nothing will be saved. Add --apply to save.');
  console.log(organizationId ? `Dealership: ${organizationId}` : 'Dealership: all');
  const names = await orgNames();

  console.log('');
  console.log('1) DealersCloud notice emails that became "Unknown" cards');
  const notices = await moveNoticeCardsToOthers({ apply, organizationId });
  if (!notices.length) console.log('  None found.');
  for (const org of notices) {
    console.log(`  ${names.get(org.organizationId) || org.organizationId} (from ${org.sender}): ${plural(org.found, 'card')} found`);
    console.log(`    Move to Others (Not a Lead): ${org.movable.length}${apply ? `, moved: ${org.moved}` : ''}${org.changedMeanwhile ? `, changed during the run and skipped: ${org.changedMeanwhile}` : ''}`);
    for (const lead of org.movable.slice(0, EXAMPLES)) {
      console.log(`      - ${denver(lead.createdAt)} | ${lead.status} | ${lead.subject.slice(0, 70) || '(no subject)'}`);
    }
    if (org.movable.length > EXAMPLES) console.log(`      ... and ${org.movable.length - EXAMPLES} more`);
    if (org.forStaff.length) {
      console.log(`    Left alone because staff are working them (please look at them): ${org.forStaff.length}`);
      for (const lead of org.forStaff.slice(0, EXAMPLES)) {
        console.log(`      - ${lead.leadId} | ${denver(lead.createdAt)} | ${lead.status} | ${lead.subject.slice(0, 60) || '(no subject)'}`);
      }
    }
  }

  console.log('');
  console.log('2) The same request saved twice on one lead (within 2 hours)');
  const repeated = await foldRepeatedInquiries({ apply, organizationId });
  console.log(`  Leads with more than one inquiry: ${repeated.leadsChecked}`);
  console.log(`  Leads with a repeated copy: ${repeated.leadsFixed} (${plural(repeated.copies, 'copy', 'copies')} to fold into the first one)`);
  for (const lead of repeated.leads.slice(0, EXAMPLES)) {
    const name = `${lead.firstName || 'No name'}${lead.lastName ? ` ${lead.lastName.charAt(0)}.` : ''}`;
    console.log(`      - ${name}: ${lead.before} inquiries -> ${lead.after} (first copy ${denver(lead.firstCopyAt)})`);
  }
  if (repeated.leads.length > EXAMPLES) console.log(`      ... and ${repeated.leads.length - EXAMPLES} more`);
  if (apply) console.log(`  Folded: ${repeated.folded}${repeated.changedMeanwhile ? `, changed during the run and skipped: ${repeated.changedMeanwhile}` : ''}`);

  console.log('');
  console.log('3) Open lead cards that share a phone or email (read only; use Combine duplicates in Lead Intake settings)');
  const open = await previewOpenDuplicateCards(organizationId);
  if (!open.length) console.log('  None found.');
  for (const org of open) {
    console.log(`  ${names.get(org.organizationId) || org.organizationId}: ${plural(org.customers, 'customer')} with ${plural(org.leads, 'extra card')}${org.skippedGroups ? `, ${plural(org.skippedGroups, 'large group')} to check by hand` : ''}${org.complete ? '' : ' (partial scan)'}`);
  }

  console.log('');
  console.log(apply ? 'Done. Changes saved.' : 'Preview finished. Nothing was saved.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
