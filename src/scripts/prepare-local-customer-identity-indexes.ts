import mongoose from 'mongoose';
import { IdentityIndexPreparationError, prepareLocalCustomerIdentityIndexes } from '../services/customerIdentityMaintenance.service';

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Only --apply is supported; no argument means read-only preview');
  await mongoose.connect('mongodb://127.0.0.1:27018/suprah_dev', { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
  try {
    console.log(JSON.stringify(await prepareLocalCustomerIdentityIndexes(args.includes('--apply'), {
      onStep: step => console.log(JSON.stringify({ step })),
    }), null, 2));
  } finally { await mongoose.disconnect(); }
}

main().catch(error => {
  console.error(JSON.stringify(error instanceof IdentityIndexPreparationError ? { message: error.message, report: error.report } : { message: error.message }, null, 2));
  process.exitCode = 1;
});
