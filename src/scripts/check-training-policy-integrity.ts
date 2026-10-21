import mongoose from 'mongoose';
import { applyIntegrityRepair, scanTrainingPolicyIntegrity } from '../services/aiTrainingIntegrity.service';

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
  const organizationId = argValue('org');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const { host, name } = mongoose.connection;
  console.log(`Connected to host=${host} db=${name}${organizationId ? ` org=${organizationId}` : ''}`);

  const rows = await scanTrainingPolicyIntegrity({ organizationId });
  const critical = rows.filter((row) => !row.integrity.ok);
  console.log(`Proposals with findings: ${rows.length} (critical: ${critical.length})`);
  for (const row of rows) {
    console.log(JSON.stringify({
      policyId: row.policyId,
      organizationId: row.organizationId,
      status: row.status,
      currentVersion: row.currentVersion,
      versions: row.integrity.versions,
      issues: row.integrity.issues.map((issue) => `${issue.severity}:${issue.code}`),
      plannedRepair: row.plan ? { toStatus: row.plan.toStatus, set: row.plan.set, unset: row.plan.unset, steps: row.plan.summary } : null,
    }));
  }

  if (!apply) {
    console.log('Dry run only. Nothing was changed. Re-run with --apply --confirm-db=<database name> to apply the planned repairs.');
  } else if (argValue('confirm-db') !== name) {
    console.error(`Refusing to repair: --confirm-db must equal the connected database name (${name}).`);
    process.exitCode = 1;
  } else {
    for (const row of rows.filter((candidate) => candidate.plan)) {
      const result = await applyIntegrityRepair(row);
      console.log(`${row.policyId}: ${result}`);
    }
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error('Training integrity check failed:', err?.message || err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
