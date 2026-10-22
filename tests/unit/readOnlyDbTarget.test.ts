import fs from 'fs';
import path from 'path';
import {
  createCommandRecorder,
  credentialRefusal,
  describeCommands,
  isReadOnlyCommand,
  redactConnectionStrings,
  resolveTarget,
  withSilentAppLogger,
} from '../../src/utils/readOnlyDbTarget';

const SPEC = { uriVariable: 'TRAINING_INTEGRITY_MONGODB_URI', flags: ['--apply'], values: ['--confirm-db'] };
const LOCAL_URI = 'mongodb://127.0.0.1:27018/suprah_dev';

describe('resolveTarget', () => {
  it('requires the named variable and never falls back to MONGODB_URI', () => {
    const previous = process.env.MONGODB_URI;
    process.env.MONGODB_URI = LOCAL_URI;
    try {
      expect(resolveTarget(['--env=local', '--db=suprah_dev'], undefined, SPEC)).toEqual({
        error: 'Set TRAINING_INTEGRITY_MONGODB_URI for this run. It never uses MONGODB_URI or .env files.',
      });
    } finally {
      process.env.MONGODB_URI = previous;
    }
  });

  it('reads flags and value options declared by the script, and rejects everything else', () => {
    expect(resolveTarget(['--env=local', '--db=suprah_dev', '--apply', '--confirm-db=suprah_dev'], LOCAL_URI, SPEC)).toEqual({
      target: { uri: LOCAL_URI, environment: 'local', database: 'suprah_dev', hosts: ['127.0.0.1'], organizationId: null, flags: ['--apply'], values: { '--confirm-db': 'suprah_dev' } },
    });
    expect(resolveTarget(['--env=local', '--db=suprah_dev'], LOCAL_URI, SPEC).target).toMatchObject({ flags: [], values: {} });
    expect(resolveTarget(['--env=local', '--db=suprah_dev', '--json'], LOCAL_URI, SPEC).error).toBe('Unknown option --json.');
    expect(resolveTarget(['--env=local', '--db=suprah_dev', '--allow-unrestricted-credentials'], LOCAL_URI, SPEC).error).toBe('Unknown option --allow-unrestricted-credentials.');
    expect(resolveTarget(['--env=local', '--db=suprah_dev', '--confirm-db=bad name'], LOCAL_URI, SPEC).error).toMatch(/--confirm-db=<value>/);
  });

  it('never echoes option values or connection details in errors', () => {
    const secret = 'mongodb+srv://user:s3cretPass@cluster0.abcd.mongodb.net/test';
    const results = [
      resolveTarget(['--env=local', '--db=test', `--uri=${secret}`], LOCAL_URI, SPEC),
      resolveTarget(['--env=local', '--db=test'], secret, SPEC),
      resolveTarget(['--env=staging', '--db=other'], secret, SPEC),
    ];
    expect(results.map((result) => result.error)).toEqual([
      'Unknown option --uri.',
      '--env=local only works with a database on this computer (localhost or 127.0.0.1).',
      'The connection string names database "test" but --db is "other". They must match.',
    ]);
    expect(JSON.stringify(results)).not.toContain('s3cretPass');
  });
});

describe('credentialRefusal', () => {
  const prod = { environment: 'production' as const };
  it('requires read-only credentials outside local, with no override', () => {
    expect(credentialRefusal(prod, { access: 'read_only', roles: [] })).toBeNull();
    expect(credentialRefusal({ environment: 'local' }, { access: 'write_capable', roles: [] })).toBeNull();
    expect(credentialRefusal(prod, { access: 'write_capable', roles: [] })).toBe('These database credentials are allowed to change data. For production, use a read-only database user.');
    expect(credentialRefusal({ environment: 'staging' }, { access: 'unknown', roles: [] })).toBe('The permissions of these database credentials could not be checked. For staging, use a read-only database user.');
    expect(credentialRefusal(prod, { access: 'no_auth', roles: [] })).toBe('This connection is not signed in as a database user. For production, use a read-only database user.');
    expect(credentialRefusal({ environment: 'production', allowUnrestrictedCredentials: true } as any, { access: 'write_capable', roles: [] })).not.toBeNull();
  });
});

describe('withSilentAppLogger', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });

  it('loads app code with NODE_ENV=test and restores the previous value, even when loading fails', async () => {
    for (const before of [undefined, 'production', 'development']) {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
      const seen = await withSilentAppLogger(async () => process.env.NODE_ENV);
      expect(seen).toBe('test');
      expect(process.env.NODE_ENV).toBe(before);
      await expect(withSilentAppLogger(async () => { throw new Error('load failed'); })).rejects.toThrow('load failed');
      expect(process.env.NODE_ENV).toBe(before);
      expect(Object.prototype.hasOwnProperty.call(process.env, 'NODE_ENV')).toBe(before !== undefined);
    }
  });
});

describe('command recording', () => {
  it('treats only read commands as read-only, including aggregate without $out or $merge', () => {
    for (const name of ['find', 'getMore', 'killCursors', 'count', 'listCollections', 'connectionStatus', 'endSessions']) {
      expect(isReadOnlyCommand(name)).toBe(true);
    }
    expect(isReadOnlyCommand('aggregate', { pipeline: [{ $match: { a: 1 } }, { $group: { _id: null } }] })).toBe(true);
    expect(isReadOnlyCommand('aggregate', { pipeline: [{ $match: {} }, { $out: 'copy' }] })).toBe(false);
    expect(isReadOnlyCommand('aggregate', { pipeline: [{ $merge: { into: 'copy' } }] })).toBe(false);
    for (const name of ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'create', 'drop', 'dropDatabase', 'commitTransaction', 'applyOps', 'eval']) {
      expect(isReadOnlyCommand(name)).toBe(false);
    }
  });

  it('counts every command and lists unexpected ones without keeping command bodies', () => {
    const recorder = createCommandRecorder();
    for (const event of [
      { commandName: 'find', command: { filter: { title: 'Fictional secret title' } } },
      { commandName: 'find' },
      { commandName: 'connectionStatus' },
      { commandName: 'insert', command: { documents: [{ message: 'Fictional secret log' }] } },
      {},
    ]) recorder.observe(event as any);
    const summary = recorder.summary();
    expect(summary).toEqual({ sent: { connectionStatus: 1, find: 2, insert: 1, unknown: 1 }, unexpected: { insert: 1, unknown: 1 } });
    expect(JSON.stringify(summary)).not.toContain('Fictional secret');
    expect(describeCommands(summary.sent)).toBe('connectionStatus 1, find 2, insert 1, unknown 1');
    expect(describeCommands({})).toBe('none');
  });
});

describe('helpers', () => {
  it('redacts connection strings from error text', () => {
    expect(redactConnectionStrings('failed for mongodb+srv://u:p@cluster0.x.mongodb.net/test?retryWrites=true now'))
      .toBe('failed for <connection string> now');
    expect(redactConnectionStrings('connect mongodb://u:p@127.0.0.1:27018/db failed')).toBe('connect <connection string> failed');
  });

  it('imports nothing, so loading it can never pull in app config, .env files or the app logger', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/utils/readOnlyDbTarget.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/process\.env\.MONGODB_URI/);
  });
});
