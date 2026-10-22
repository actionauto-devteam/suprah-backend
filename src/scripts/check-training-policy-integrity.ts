import mongoose from 'mongoose';
import {
  CREDENTIAL_LABELS,
  createCommandRecorder,
  credentialRefusal,
  describeCommands,
  describeCredentials,
  redactConnectionStrings,
  resolveTarget,
  withSilentAppLogger,
} from '../utils/readOnlyDbTarget';

const TARGET_URI = process.env.TRAINING_INTEGRITY_MONGODB_URI;
const URI_VARIABLE = 'TRAINING_INTEGRITY_MONGODB_URI';
const REQUIRED_COLLECTION = 'organizations';
const TRAINING_COLLECTIONS = ['aitrainingpolicies', 'aitrainingpolicyversions', 'aitrainingauditlogs'];

const USAGE = [
  'Read-only integrity check of AI training proposals.',
  '',
  'Usage:',
  '  TRAINING_INTEGRITY_MONGODB_URI="<connection string>" npx ts-node --transpile-only src/scripts/check-training-policy-integrity.ts --env=<local|staging|production> --db=<database name> [--org=<organization id>]',
  '',
  'Options:',
  '  --env         Required. Which environment this database belongs to.',
  '  --db          Required. The exact database name to check.',
  '  --org         Optional. Check one organization only.',
  '  --apply --confirm-db=<database name>  Local databases only. Applies the planned repairs.',
  '',
  'Staging and production need a read-only database user. The check never uses MONGODB_URI or .env files and never prints training content.',
].join('\n');

const refuse = (reason: string) => {
  console.error(`Refusing to run: ${reason}`);
  process.exitCode = 1;
};

const run = async () => {
  const resolved = resolveTarget(process.argv.slice(2), TARGET_URI, { uriVariable: URI_VARIABLE, flags: ['--apply'], values: ['--confirm-db'] });
  if (resolved.help) {
    console.log(USAGE);
    return;
  }
  if (!resolved.target) {
    console.error(`${resolved.error}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const target = resolved.target;
  const apply = target.flags.includes('--apply');
  if (apply && target.environment !== 'local') {
    return refuse('repairs only run against a local database. On staging and production this script only reads; share the report so any repair can be approved separately.');
  }
  if (apply && target.values['--confirm-db'] !== target.database) {
    return refuse(`--apply needs --confirm-db=${target.database}, the database being repaired.`);
  }
  if (!apply && target.values['--confirm-db'] !== undefined) {
    return refuse('--confirm-db only goes with --apply.');
  }

  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  const [integrity, logging] = await withSilentAppLogger(() => Promise.all([
    import('../services/aiTrainingIntegrity.service'),
    import('../utils/logger'),
  ]));
  if (logging.default.level !== 'silent') {
    return refuse('the app logger could not be silenced, so log writes to a database cannot be ruled out.');
  }
  if (mongoose.connections.some((connection) => connection.readyState !== 0)) {
    return refuse('a database connection was opened while loading the app code.');
  }

  await mongoose.connect(target.uri, {
    dbName: target.database,
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
    autoCreate: false,
    readPreference: 'secondaryPreferred',
    appName: 'suprah-training-integrity-check',
    monitorCommands: true,
  });
  const recorder = createCommandRecorder();
  mongoose.connection.getClient().on('commandStarted', (event) => recorder.observe(event));
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.name !== target.database) {
    return refuse(`connected to "${mongoose.connection.name}" instead of "${target.database}".`);
  }

  const status = await db.command({ connectionStatus: 1, showPrivileges: true }).catch(() => null);
  const credentials = describeCredentials(status, target.database);
  const credentialProblem = apply ? null : credentialRefusal(target, credentials);
  if (credentialProblem) return refuse(credentialProblem);

  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name));
  if (!collections.has(REQUIRED_COLLECTION)) {
    return refuse(`database "${target.database}" has no ${REQUIRED_COLLECTION} collection, so it doesn't look like a Suprah database. Check --db.`);
  }
  const trainingCollections = TRAINING_COLLECTIONS.filter((name) => collections.has(name));

  const rows = collections.has('aitrainingpolicies')
    ? await integrity.scanTrainingPolicyIntegrity({ organizationId: target.organizationId || undefined })
    : [];
  const critical = rows.filter((row) => !row.integrity.ok);
  console.log(`Training integrity check (${apply ? 'repair mode, local database only' : 'read-only'})`);
  console.log(`Environment: ${target.environment}`);
  console.log(`Database: ${target.database}`);
  console.log(`Hosts: ${target.hosts.join(', ')}`);
  console.log(`Credentials: ${CREDENTIAL_LABELS[credentials.access]}${credentials.roles.length ? ` (roles: ${credentials.roles.join(', ')})` : ''}`);
  console.log(`Scope: ${target.organizationId ? `organization ${target.organizationId}` : 'all organizations'}`);
  console.log(`Training collections: ${trainingCollections.length ? trainingCollections.join(', ') : 'none yet (no training proposals have been saved)'}`);
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

  if (apply) {
    for (const row of rows.filter((candidate) => candidate.plan)) {
      const result = await integrity.applyIntegrityRepair(row);
      console.log(`${row.policyId}: ${result}`);
    }
  } else {
    const hint = target.environment === 'local' && rows.some((row) => row.plan)
      ? ` To apply the planned repairs to this local database, re-run with --apply --confirm-db=${target.database}.`
      : '';
    console.log(`Dry run only. Nothing was changed.${hint}`);
  }

  const commands = recorder.summary();
  console.log(`Database commands sent: ${describeCommands(commands.sent)}`);
  if (!apply && Object.keys(commands.unexpected).length) {
    console.error(`Read-only check failed: unexpected database commands were sent (${describeCommands(commands.unexpected)}).`);
    process.exitCode = 1;
  }
};

run()
  .catch((err) => {
    console.error('Training integrity check failed:', err?.codeName || err?.name || 'error', redactConnectionStrings(String(err?.message || '')));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  });
