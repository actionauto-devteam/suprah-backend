import mongoose from 'mongoose';
import type * as AuditService from '../services/aiCoachingAudit.service';

const TARGET_URI = process.env.COACHING_AUDIT_MONGODB_URI;

const USAGE = [
  'Read-only audit of legacy Alex coaching records.',
  '',
  'Usage:',
  '  COACHING_AUDIT_MONGODB_URI="<connection string>" npx ts-node --transpile-only src/scripts/audit-legacy-coaching.ts --env=<local|staging|production> --db=<database name> [--org=<organization id>] [--json]',
  '',
  'Options:',
  '  --env      Required. Which environment this database belongs to.',
  '  --db       Required. The exact database name to audit.',
  '  --org      Optional. Audit one organization only.',
  '  --json     Optional. Print the full report as JSON.',
  '',
  'Staging and production need a read-only database user. The audit never uses MONGODB_URI or .env files, never prints coaching text, and never changes any record.',
].join('\n');

async function importAuditWithSilentLogger(): Promise<typeof AuditService> {
  const nodeEnvBeforeImport = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    return await import('../services/aiCoachingAudit.service');
  } finally {
    if (nodeEnvBeforeImport === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnvBeforeImport;
  }
}

const run = async () => {
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  const audit = await importAuditWithSilentLogger();
  const resolved = audit.resolveAuditTarget(process.argv.slice(2), TARGET_URI);
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
  if (mongoose.connection.readyState !== 0) {
    console.error('Refusing to run: a database connection was already open before the audit started.');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(target.uri, {
    dbName: target.database,
    serverSelectionTimeoutMS: 10000,
    autoIndex: false,
    autoCreate: false,
    readPreference: 'secondaryPreferred',
    appName: 'suprah-legacy-coaching-audit',
  });
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.name !== target.database) {
    console.error(`Refusing to run: connected to "${mongoose.connection.name}" instead of "${target.database}".`);
    process.exitCode = 1;
    return;
  }

  const status = await db.command({ connectionStatus: 1, showPrivileges: true }).catch(() => null);
  const credentials = audit.describeCredentials(status, target.database);
  const refusal = audit.credentialRefusal(target, credentials);
  if (refusal) {
    console.error(`Refusing to run: ${refusal}`);
    process.exitCode = 1;
    return;
  }

  const collectionName = (await import('../models/AiAgentCoachingRule.model')).default.collection.collectionName;
  const found = await db.listCollections({ name: collectionName }, { nameOnly: true }).toArray();
  if (!found.length) {
    console.error(`Refusing to run: database "${target.database}" has no ${collectionName} collection. Check --db.`);
    process.exitCode = 1;
    return;
  }

  const report = await audit.runLegacyCoachingAudit({ organizationId: target.organizationId });
  if (target.json) {
    console.log(JSON.stringify({
      environment: target.environment,
      database: target.database,
      hosts: target.hosts,
      credentials,
      readOnly: true,
      report,
    }, null, 2));
  } else {
    console.log(audit.formatCoachingAuditReport(report, target, credentials));
  }
};

run()
  .catch((err) => {
    console.error('Legacy coaching audit failed:', err?.codeName || err?.name || 'error', String(err?.message || '').replace(/mongodb(\+srv)?:\/\/[^\s]+/gi, '<connection string>'));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
  });
