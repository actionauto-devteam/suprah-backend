import mongoose from 'mongoose';
import { verifyAiAgentDraftReportingIndexes, createAiAgentDraftReportingIndexes } from '../services/aiAgentDraftIndexes.service';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

const run = async () => {
  const uri = process.env.MONGODB_URI || '';
  if (!uri) {
    console.error('Set MONGODB_URI explicitly for this run. The script does not read .env files.');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const { host, name } = mongoose.connection;
  console.log(`Connected to host=${host} db=${name}`);

  const report = await verifyAiAgentDraftReportingIndexes();
  console.log(JSON.stringify(report, null, 2));

  if (!apply) {
    console.log('Dry run only. Re-run with --apply --confirm-db=<database name> to build missing indexes.');
  } else if (argValue('confirm-db') !== name) {
    console.error(`Refusing to build: --confirm-db must equal the connected database name (${name}).`);
    process.exitCode = 1;
  } else if (report.ready) {
    console.log('All reporting indexes are already present. Nothing to do.');
  } else {
    const result = await createAiAgentDraftReportingIndexes();
    console.log(`Created: ${result.created.join(', ') || 'none'}`);
    console.log(JSON.stringify(result.after, null, 2));
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Index migration failed:', err?.message || err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
