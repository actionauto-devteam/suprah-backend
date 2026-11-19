import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import LeadMention from '../models/LeadMention.model';
import { MENTION_BACKFILL_NEW_DAYS, runLeadMentionBackfill } from '../services/leadMention.service';
import logger from '../utils/logger';

const apply = process.argv.includes('--apply');
const orgArgs = process.argv.slice(2).filter((arg) => arg.startsWith('--org'));
const orgArg = orgArgs.find((arg) => arg.startsWith('--org='));
const organizationId = orgArg ? orgArg.slice('--org='.length).trim() : undefined;

async function main() {
  logger.level = 'silent';
  if (orgArgs.length && (orgArgs.length > 1 || !organizationId || !mongoose.isValidObjectId(organizationId))) {
    throw new Error('Write the dealership as --org=<organization id>, with no space');
  }
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.MONGODB_URI as string, apply ? {} : { readPreference: 'secondaryPreferred' });
  console.log(apply ? 'APPLY: saving changes.' : 'PREVIEW ONLY: nothing will be saved. Add --apply to save.');
  console.log(organizationId ? `Dealership: ${organizationId}` : 'Dealership: all');

  if (apply) {
    const indexes: any[] = await LeadMention.collection.indexes().catch(() => []);
    if (!indexes.some((index) => index.name === 'lead_mention_note_user_unique')) {
      throw new Error('The Mentioned list is not set up on this database yet. Deploy the server first (it sets it up when it starts), then run this again.');
    }
  }

  const summary = await runLeadMentionBackfill({ apply, organizationId });

  console.log(`Leads with mentions in their notes: ${summary.leads}`);
  console.log(`Notes with mentions: ${summary.notes}`);
  console.log(`Automatic team tags left out: ${summary.skippedTeamTags}`);
  console.log(`Mentions to add (one per person): ${summary.people}`);
  console.log(`  Start as New (last ${MENTION_BACKFILL_NEW_DAYS} days): ${summary.startNew}`);
  console.log(`  Start as Completed (older): ${summary.startCompleted}`);
  console.log(`Already in the list: ${summary.alreadySaved}`);
  if (apply) console.log(`Saved: ${summary.saved}.`);
  console.log(apply ? 'Done. Changes saved.' : 'Preview finished. Nothing was saved.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
