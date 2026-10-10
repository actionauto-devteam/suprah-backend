import mongoose from 'mongoose';
import { reconcileHistoricalLeads } from '../services/customerIdentity.service';
import { assertLocalIdentityDatabase } from '../services/customerIdentityMaintenance.service';

async function main() {
  const args = process.argv.slice(2);
  const organizationId = args.find(arg => arg.startsWith('--organization='))?.split('=')[1];
  const after = args.find(arg => arg.startsWith('--after='))?.split('=')[1];
  const apply = args.includes('--apply');
  if (args.includes('--prepare-indexes')) throw new Error('Use prepare-local-customer-identity-indexes.ts separately before reconciliation');
  if (!organizationId || !mongoose.isValidObjectId(organizationId)) throw new Error('--organization=<ObjectId> is required');
  await mongoose.connect('mongodb://127.0.0.1:27018/suprah_dev', { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
  try {
    assertLocalIdentityDatabase();
    console.log(JSON.stringify(await reconcileHistoricalLeads(organizationId, { apply, after, limit: 100 }), null, 2));
  } finally { await mongoose.disconnect(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
