import fs from 'fs';
import path from 'path';

const SCRIPT = fs.readFileSync(path.resolve(__dirname, '../../src/scripts/check-training-policy-integrity.ts'), 'utf8').replace(/\r\n/g, '\n');
const at = (text: string) => {
  const index = SCRIPT.indexOf(text);
  expect(index).toBeGreaterThan(-1);
  return index;
};

describe('check-training-policy-integrity script safety', () => {
  it('reads its own connection variable before anything else and never uses MONGODB_URI', () => {
    expect(at('const TARGET_URI = process.env.TRAINING_INTEGRITY_MONGODB_URI;')).toBeLessThan(at('const run = async'));
    expect(SCRIPT).not.toMatch(/process\.env\.MONGODB_URI|process\.env\[['"]MONGODB_URI/);
    expect(SCRIPT.replace(/TRAINING_INTEGRITY_MONGODB_URI/g, '').replace('never uses MONGODB_URI or .env files', '')).not.toMatch(/MONGODB_URI/);
  });

  it('statically imports only mongoose and the import-free targeting helper', () => {
    const imports = Array.from(SCRIPT.matchAll(/^import [^;]*? from '([^']+)';/gms)).map((match) => match[1]);
    expect(imports).toEqual(['mongoose', '../utils/readOnlyDbTarget']);
    expect(SCRIPT).not.toMatch(/await import\(/);
    expect(SCRIPT.match(/import\('/g)).toHaveLength(2);
  });

  it('checks targeting and repair rules before loading app code, and loads app code with the logger silenced before connecting', () => {
    const resolve = at('const resolved = resolveTarget(');
    const repairGate = at("if (apply && target.environment !== 'local') {");
    const confirmGate = at("if (apply && target.values['--confirm-db'] !== target.database) {");
    const silencedLoad = at('await withSilentAppLogger(() => Promise.all([');
    const loggerCheck = at("if (logging.default.level !== 'silent') {");
    const connectionCheck = at('if (mongoose.connections.some((connection) => connection.readyState !== 0)) {');
    const connect = at('await mongoose.connect(target.uri, {');
    expect(resolve).toBeLessThan(repairGate);
    expect(repairGate).toBeLessThan(confirmGate);
    expect(confirmGate).toBeLessThan(silencedLoad);
    expect(silencedLoad).toBeLessThan(loggerCheck);
    expect(loggerCheck).toBeLessThan(connectionCheck);
    expect(connectionCheck).toBeLessThan(connect);
    expect(SCRIPT.slice(silencedLoad, loggerCheck)).toContain("import('../services/aiTrainingIntegrity.service')");
    expect(SCRIPT.slice(silencedLoad, loggerCheck)).toContain("import('../utils/logger')");
  });

  it('connects with index and collection creation off, records every command, and verifies credentials and the database before scanning', () => {
    const connect = at('await mongoose.connect(target.uri, {');
    const recorder = at("mongoose.connection.getClient().on('commandStarted', (event) => recorder.observe(event));");
    const credentials = at('const credentialProblem = apply ? null : credentialRefusal(target, credentials);');
    const database = at('if (!collections.has(REQUIRED_COLLECTION)) {');
    const scan = at('await integrity.scanTrainingPolicyIntegrity(');
    expect(SCRIPT.slice(connect, recorder)).toMatch(/dbName: target\.database,[\s\S]*autoIndex: false,\s*autoCreate: false,\s*readPreference: 'secondaryPreferred',[\s\S]*monitorCommands: true/);
    expect(connect).toBeLessThan(recorder);
    expect(recorder).toBeLessThan(credentials);
    expect(credentials).toBeLessThan(database);
    expect(database).toBeLessThan(scan);
    expect(SCRIPT).toMatch(/mongoose\.set\('autoIndex', false\);\s*mongoose\.set\('autoCreate', false\);/);
    expect(SCRIPT).not.toMatch(/allow-unrestricted|allowUnrestrictedCredentials/);
  });

  it('runs only connectionStatus as a command, writes nothing outside the local repair path, and fails a dry run that sent any write', () => {
    expect(SCRIPT.match(/\.command\(/g)).toHaveLength(1);
    expect(SCRIPT).toContain('db.command({ connectionStatus: 1, showPrivileges: true })');
    expect(SCRIPT).not.toMatch(/\.(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|bulkWrite|save|create|createIndex|createIndexes|syncIndexes|drop|dropDatabase|createCollection|aggregate)\s*\(/);
    expect(SCRIPT.match(/applyIntegrityRepair\(/g)).toHaveLength(1);
    const applyBranch = at('  if (apply) {\n    for (const row of rows.filter((candidate) => candidate.plan)) {');
    expect(at('integrity.applyIntegrityRepair(row)')).toBeGreaterThan(applyBranch);
    expect(SCRIPT).toContain("if (!apply && Object.keys(commands.unexpected).length) {");
  });

  it('prints ids, statuses, versions and issue codes only, never proposal titles or rule text', () => {
    const printed = SCRIPT.slice(at('for (const row of rows) {'), at('if (apply) {\n    for'));
    expect(printed).not.toMatch(/\.title|\.spec|instruction|message/);
    expect(printed).toMatch(/issues: row\.integrity\.issues\.map\(\(issue\) => `\$\{issue\.severity\}:\$\{issue\.code\}`\)/);
    expect(SCRIPT).toContain("redactConnectionStrings(String(err?.message || ''))");
  });
});
