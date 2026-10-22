import fs from 'fs';
import net from 'net';
import path from 'path';
import { execFile } from 'child_process';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import AiTrainingPolicy from '../src/models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion from '../src/models/AiTrainingPolicyVersion.model';
import AiTrainingAuditLog from '../src/models/AiTrainingAuditLog.model';
import { SystemLog } from '../src/models/SystemLog.model';
import { scanTrainingPolicyIntegrity } from '../src/services/aiTrainingIntegrity.service';
import { isReadOnlyCommand } from '../src/utils/readOnlyDbTarget';

const TEST_URI = String(process.env.MONGODB_URI || '');
const BACKEND = path.resolve(__dirname, '..');
const SCRIPT = path.join(BACKEND, 'src', 'scripts', 'check-training-policy-integrity.ts');
const PROBE = path.join(BACKEND, 'tests', 'appImportProbe.ts');
const MARKER = 'FICTIONAL-ZEBRA-7731';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const ids: Record<string, mongoose.Types.ObjectId> = {};
const actor = { userId: 'fictional-rep', name: 'Fictional Rep Person', role: 'rep' };

let trapPort = 0;
let trapHits = 0;
const trap = net.createServer((socket) => {
  trapHits += 1;
  socket.destroy();
});

async function seedPolicy(key: string, fields: Record<string, unknown>, versions: number[]) {
  ids[key] = new mongoose.Types.ObjectId();
  await AiTrainingPolicy.collection.insertOne({
    _id: ids[key], organizationId: ORG, title: `Fictional secret title ${MARKER} ${key}`, category: 'behavior', channels: ['sms'],
    source: 'coaching_submission', createdBy: actor, createdAt: new Date(), updatedAt: new Date(), ...fields,
  } as any);
  for (const version of versions) {
    await AiTrainingPolicyVersion.collection.insertOne({
      organizationId: ORG, policyId: ids[key], version, spec: { instruction: `Fictional rule text ${MARKER} quote $25,999 v${version}` }, createdBy: actor, createdAt: new Date(),
    } as any);
  }
}

async function fingerprint() {
  const db = mongoose.connection.db!;
  const hash = await db.command({ dbHash: 1 });
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c: any) => c.name).sort();
  const databases = (await db.admin().listDatabases({ nameOnly: true })).databases.map((d: any) => d.name).sort();
  return { md5: hash.md5, collections: hash.collections, names, databases };
}

const trapUri = () => `mongodb://127.0.0.1:${trapPort}/integrity_trap_db`;

function spawnTs(file: string, args: string[], env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv: Record<string, string | undefined> = { ...process.env, MONGODB_URI: trapUri(), TRAINING_INTEGRITY_MONGODB_URI: TEST_URI, ...env };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  return new Promise((resolve) => {
    execFile(process.execPath, ['-r', 'ts-node/register/transpile-only', file, ...args], { cwd: BACKEND, env: childEnv as NodeJS.ProcessEnv, timeout: 240000, maxBuffer: 8 * 1024 * 1024 }, (error: any, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const runScript = (args: string[], env: Record<string, string | undefined> = {}) => spawnTs(SCRIPT, args, env);

const assertNoSensitiveText = (output: string) => {
  for (const fragment of [MARKER, 'Fictional secret title', 'Fictional rule text', '$25,999', 'Fictional Rep Person', 's3cretPass']) {
    expect(output).not.toContain(fragment);
  }
  expect(output).not.toMatch(/mongodb(\+srv)?:\/\//);
};

const rowLines = (stdout: string) => stdout.split('\n').filter((line) => line.startsWith('{"policyId"')).map((line) => JSON.parse(line));
const commandsLine = (stdout: string) => {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith('Database commands sent: '));
  expect(line).toBeDefined();
  return Object.fromEntries(line!.slice('Database commands sent: '.length).split(', ').map((entry) => {
    const [name, count] = entry.split(' ');
    return [name, Number(count)];
  }));
};

describe('Real-DB proof: P1d.3 training integrity script safety (local MongoDB only)', () => {
  let database = '';
  let before: Awaited<ReturnType<typeof fingerprint>>;
  let expected: Awaited<ReturnType<typeof scanTrainingPolicyIntegrity>>;

  beforeAll(async () => {
    database = mongoose.connection.name;
    expect(TEST_URI).toMatch(/^mongodb:\/\/127\.0\.0\.1:/);
    await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', () => resolve()));
    trapPort = (trap.address() as net.AddressInfo).port;
    await Organization.collection.insertOne({ _id: orgId, name: 'Fictional Integrity Motors', slug: `fictional-integrity-${orgId}`, status: 'active' } as any);
    await seedPolicy('missingVersion', { status: 'in_review', currentVersion: 3, submittedVersion: 3, submittedAt: new Date() }, [1, 2]);
    await seedPolicy('unauditedApproval', { status: 'approved', currentVersion: 1, submittedVersion: 1, approvedAt: new Date(), approvedBy: actor }, [1]);
    await seedPolicy('stalePending', { status: 'in_review', currentVersion: 1, adoptedVersions: [1], pendingAudit: [{
      _id: new mongoose.Types.ObjectId(), action: 'proposal_submitted', actor, version: 1, toStatus: 'in_review', createdAt: new Date(Date.now() - 60 * 60 * 1000),
    }] }, [1]);
    await seedPolicy('healthy', { status: 'in_review', currentVersion: 1, adoptedVersions: [1] }, [1]);
    expected = await scanTrainingPolicyIntegrity({ organizationId: ORG });
    before = await fingerprint();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => trap.close(() => resolve()));
    await AiTrainingAuditLog.collection.deleteMany({ organizationId: ORG });
    await AiTrainingPolicyVersion.collection.deleteMany({ organizationId: ORG });
    await AiTrainingPolicy.collection.deleteMany({ organizationId: ORG });
    await SystemLog.collection.deleteMany({ message: { $regex: MARKER } });
    await Organization.collection.deleteOne({ _id: orgId });
  });

  it('the in-process integrity check still finds the seeded problems', () => {
    expect(expected.map((row) => [row.policyId, row.integrity.ok, row.integrity.issues.map((issue) => issue.code).sort()])).toEqual([
      [String(ids.missingVersion), false, ['missing_current_version', 'missing_submitted_version']],
      [String(ids.unauditedApproval), false, ['missing_approval_audit']],
      [String(ids.stalePending), true, ['stale_pending_audit']],
    ]);
  });

  it.each([
    ['development', undefined],
    ['production', 'production'],
  ])('a %s-mode dry run reports the same findings, sends only read commands, never touches MONGODB_URI, and changes nothing', async (_mode, nodeEnv) => {
    const result = await runScript(['--env=local', `--db=${database}`, `--org=${ORG}`], { NODE_ENV: nodeEnv });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/Refusing|failed/);
    const lines = result.stdout.split('\n');
    expect(lines.slice(0, 8)).toEqual([
      'Training integrity check (read-only)',
      'Environment: local',
      `Database: ${database}`,
      'Hosts: 127.0.0.1',
      'Credentials: not signed in (no database user)',
      `Scope: organization ${ORG}`,
      'Training collections: aitrainingpolicies, aitrainingpolicyversions, aitrainingauditlogs',
      'Proposals with findings: 3 (critical: 2)',
    ]);
    const rows = rowLines(result.stdout);
    expect(rows).toEqual(expected.map((row) => ({
      policyId: row.policyId,
      organizationId: row.organizationId,
      status: row.status,
      currentVersion: row.currentVersion,
      versions: row.integrity.versions,
      issues: row.integrity.issues.map((issue) => `${issue.severity}:${issue.code}`),
      plannedRepair: row.plan ? { toStatus: row.plan.toStatus, set: row.plan.set, unset: row.plan.unset, steps: row.plan.summary } : null,
    })));
    expect(result.stdout).toContain(`Dry run only. Nothing was changed. To apply the planned repairs to this local database, re-run with --apply --confirm-db=${database}.`);
    const commands = commandsLine(result.stdout);
    expect(commands).toMatchObject({ connectionStatus: 1, listCollections: 1 });
    expect(commands.find).toBeGreaterThan(0);
    for (const name of Object.keys(commands)) expect(isReadOnlyCommand(name)).toBe(true);
    assertNoSensitiveText(result.stdout + result.stderr);
    expect(trapHits).toBe(0);
    expect(await fingerprint()).toEqual(before);
  }, 300000);

  it('refuses without explicit, matching, safe targeting, before reading anything and without touching MONGODB_URI', async () => {
    const cases: Array<[string[], Record<string, string | undefined>, RegExp]> = [
      [['--env=local', `--db=${database}`], { TRAINING_INTEGRITY_MONGODB_URI: undefined }, /Set TRAINING_INTEGRITY_MONGODB_URI for this run/],
      [[`--db=${database}`], {}, /Pass --env=local/],
      [['--env=local', '--db=some_other_db'], {}, /They must match/],
      [['--env=local', `--db=${database}`, '--uri=mongodb://u:s3cretPass@host/db'], {}, /Unknown option --uri\./],
      [['--env=local', `--db=${database}`, '--allow-unrestricted-credentials'], {}, /Unknown option --allow-unrestricted-credentials\./],
      [['--env=production', `--db=${database}`], {}, /not signed in as a database user\. For production, use a read-only database user\./],
      [['--env=staging', `--db=${database}`], {}, /not signed in as a database user\. For staging, use a read-only database user\./],
      [['--env=production', `--db=${database}`, '--apply', `--confirm-db=${database}`], {}, /repairs only run against a local database/],
      [['--env=local', `--db=${database}`, '--apply'], {}, new RegExp(`--apply needs --confirm-db=${database}`)],
      [['--env=local', `--db=${database}`, '--apply', '--confirm-db=wrong_db'], {}, /--apply needs --confirm-db=/],
      [['--env=local', `--db=${database}`, `--confirm-db=${database}`], {}, /--confirm-db only goes with --apply/],
      [['--env=local', '--db=integrity_missing_db'], { TRAINING_INTEGRITY_MONGODB_URI: TEST_URI.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, '$1/') }, /has no organizations collection, so it doesn't look like a Suprah database/],
    ];
    for (const [args, env, pattern] of cases) {
      const result = await runScript(args, env);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(pattern);
      expect(result.stdout).not.toContain('Proposals with findings');
      assertNoSensitiveText(result.stdout + result.stderr);
    }
    expect(trapHits).toBe(0);
    const after = await fingerprint();
    expect(after).toEqual(before);
    expect(after.databases).not.toContain('integrity_missing_db');
    expect(after.databases).not.toContain('integrity_trap_db');
  }, 900000);

  it('without the silenced import, loading the app fills MONGODB_URI from .env and its logger writes into the connected database', async () => {
    const envFile = path.join(BACKEND, '.env');
    const envFileSetsUri = fs.existsSync(envFile) && /^MONGODB_URI=/m.test(fs.readFileSync(envFile, 'utf8'));
    const marker = `${MARKER}-unsilenced`;
    const result = await spawnTs(PROBE, ['unsilenced', TEST_URI, marker], { NODE_ENV: undefined, MONGODB_URI: undefined });
    expect(result.code).toBe(0);
    const probe = JSON.parse(result.stdout.split('\n').find((line) => line.startsWith('{"result":"probe"'))!);
    expect(probe).toMatchObject({ loggerLevel: 'debug', mongodbUriFilledBefore: false, mongodbUriFilledAfter: envFileSetsUri, openAfterImport: 0 });
    expect(await SystemLog.collection.countDocuments({ message: marker })).toBe(1);
  }, 300000);

  it.each([
    ['development', undefined],
    ['production', 'production'],
  ])('with the silenced import (%s mode), the logger is silent, NODE_ENV is restored, and nothing is written', async (_mode, nodeEnv) => {
    const marker = `${MARKER}-silenced-${_mode}`;
    const result = await spawnTs(PROBE, ['silenced', TEST_URI, marker], { NODE_ENV: nodeEnv, MONGODB_URI: trapUri() });
    expect(result.code).toBe(0);
    const probe = JSON.parse(result.stdout.split('\n').find((line) => line.startsWith('{"result":"probe"'))!);
    expect(probe).toMatchObject({ loggerLevel: 'silent', nodeEnv: nodeEnv ?? null, mongodbUriFilledBefore: true, openAfterImport: 0 });
    expect(await SystemLog.collection.countDocuments({ message: marker })).toBe(0);
    expect(trapHits).toBe(0);
  }, 300000);

  it('existing local repairs still work with --apply and --confirm-db, and only on the local database', async () => {
    const result = await runScript(['--env=local', `--db=${database}`, `--org=${ORG}`, '--apply', `--confirm-db=${database}`], { NODE_ENV: undefined });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Training integrity check (repair mode, local database only)');
    expect(result.stdout).toContain(`${ids.missingVersion}: repaired`);
    expect(result.stdout).toContain(`${ids.unauditedApproval}: repaired`);
    expect(result.stdout).toContain(`${ids.stalePending}: repaired`);
    expect(result.stdout).not.toContain('Dry run only');
    assertNoSensitiveText(result.stdout + result.stderr);
    expect(await AiTrainingPolicy.collection.findOne({ _id: ids.missingVersion })).toMatchObject({ status: 'changes_requested', currentVersion: 2 });
    expect(await AiTrainingPolicy.collection.findOne({ _id: ids.unauditedApproval })).toMatchObject({ status: 'in_review' });
    expect(await AiTrainingAuditLog.collection.countDocuments({ organizationId: ORG, action: 'integrity_repaired' })).toBe(2);
    expect((await scanTrainingPolicyIntegrity({ organizationId: ORG })).filter((row) => !row.integrity.ok)).toEqual([]);
    expect(trapHits).toBe(0);
  }, 300000);
});
