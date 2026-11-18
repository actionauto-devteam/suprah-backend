import '../config/productionDbGuard';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { runLeadCustomerAreaBackfill } from '../services/leadCustomerAreaBackfill.service';
import logger from '../utils/logger';

const apply = process.argv.includes('--apply');
const orgArgs = process.argv.slice(2).filter((arg) => arg.startsWith('--org'));
const orgArg = orgArgs.find((arg) => arg.startsWith('--org='));
const organizationId = orgArg ? orgArg.slice('--org='.length).trim() : undefined;

const AREA_LABELS: Record<string, string> = {
  utah: 'Utah',
  utah_435: 'Utah (435)',
  southern_utah: 'Southern Utah',
  out_of_state: 'Out of state',
  canada: 'Canada',
  outside_us: 'Outside US',
};
const BASIS_LABELS: Record<string, string> = {
  zip: 'from the ZIP code in the address',
  state: 'from the state in the address',
  phone: 'from the phone area code',
};

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

  const summary = await runLeadCustomerAreaBackfill({ apply, organizationId });

  console.log(`Leads checked: ${summary.scanned}`);
  console.log('Customer area after the fill:');
  for (const [code, label] of Object.entries(AREA_LABELS)) console.log(`  ${label}: ${summary.byArea[code] || 0}`);
  console.log(`  No area info: ${summary.noArea}`);
  console.log('Where the area comes from:');
  for (const [basis, label] of Object.entries(BASIS_LABELS)) console.log(`  ${label}: ${summary.byBasis[basis] || 0}`);
  console.log(`Leads to update: ${summary.toUpdate}`);
  console.log(`  Address copied from the saved DealersCloud email: ${summary.addressFilled}`);
  console.log(`  Customer area saved: ${summary.areaSet}`);
  console.log(`  Customer area removed: ${summary.areaCleared}`);
  if (apply) {
    console.log(`Saved: ${summary.saved}.`);
    if (summary.changedMeanwhile) console.log(`Skipped because someone edited the lead in the meantime: ${summary.changedMeanwhile}. Run it again to pick them up.`);
  }
  console.log(apply ? 'Done. Changes saved.' : 'Preview finished. Nothing was saved.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
