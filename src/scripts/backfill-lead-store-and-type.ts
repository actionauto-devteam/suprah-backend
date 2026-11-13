import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { runLeadStoreTypeBackfill } from '../services/leadStoreTypeBackfill.service';

const apply = process.argv.includes('--apply');
const orgArg = process.argv.find((arg) => arg.startsWith('--org='));
const organizationId = orgArg ? orgArg.slice('--org='.length).trim() : undefined;

async function main() {
  if (organizationId && !mongoose.isValidObjectId(organizationId)) throw new Error('--org must be an organization id');
  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGODB_URI as string);
  console.log(apply ? 'APPLY: saving changes.' : 'PREVIEW ONLY: nothing will be saved. Add --apply to save.');
  const summary = await runLeadStoreTypeBackfill({ apply, organizationId });
  console.log(`Leads checked: ${summary.scanned}`);
  console.log(`Leads to update: ${summary.updated}`);
  console.log(`Store filled: ${summary.locationFilled}, store corrected by stock number: ${summary.locationCorrected}`, summary.locationByStore);
  console.log(`Lead type filled: ${summary.leadTypeFilled}`, summary.leadTypeByKind);
  console.log(`Leads with campaign dates added: ${summary.campaignStamped}`, summary.campaignByKind);
  console.log(apply ? 'Done. Changes saved.' : 'Preview finished. Nothing was saved.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
