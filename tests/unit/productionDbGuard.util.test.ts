import {
  evaluateProductionDbGuard,
  isLocalMongoTarget,
  isProductionTarget,
  parseMongoTarget,
  parseProductionTargets,
} from '../../src/utils/productionDbGuard.util';

const PROD_SRV = 'mongodb+srv://appuser:s3cr3t%40pw@supra-ai-prod.ha7pe5c.mongodb.net/test?retryWrites=true&w=majority';
const PROD_SRV_NO_DB = 'mongodb+srv://appuser:s3cr3t@supra-ai-prod.ha7pe5c.mongodb.net/?retryWrites=true';
const PROD_SRV_NO_SLASH = 'mongodb+srv://appuser:s3cr3t@supra-ai-prod.ha7pe5c.mongodb.net?retryWrites=true';
const PROD_STANDARD =
  'mongodb://appuser:s3cr3t@supra-ai-prod-shard-00-00.ha7pe5c.mongodb.net:27017,supra-ai-prod-shard-00-01.ha7pe5c.mongodb.net:27017,supra-ai-prod-shard-00-02.ha7pe5c.mongodb.net:27017/test?ssl=true&replicaSet=atlas-x-shard-0';
const PROD_HOST = 'supra-ai-prod.ha7pe5c.mongodb.net';

describe('parseMongoTarget', () => {
  it('reads host and database from an SRV string with an encoded password', () => {
    expect(parseMongoTarget(PROD_SRV)).toEqual({ hosts: [PROD_HOST], database: 'test' });
  });

  it('treats a missing database as the driver default, test', () => {
    expect(parseMongoTarget(PROD_SRV_NO_DB)).toEqual({ hosts: [PROD_HOST], database: 'test' });
    expect(parseMongoTarget(PROD_SRV_NO_SLASH)).toEqual({ hosts: [PROD_HOST], database: 'test' });
  });

  it('reads every host of a standard multi-host string and drops the ports', () => {
    const target = parseMongoTarget(PROD_STANDARD)!;
    expect(target.hosts).toHaveLength(3);
    expect(target.hosts[0]).toBe('supra-ai-prod-shard-00-00.ha7pe5c.mongodb.net');
    expect(target.database).toBe('test');
  });

  it('parses a local database and never confuses the password for the host', () => {
    expect(parseMongoTarget('mongodb://localhost:27017/suprah_dev')).toEqual({ hosts: ['localhost'], database: 'suprah_dev' });
    expect(parseMongoTarget('mongodb://u:p%2Fw@127.0.0.1/dev?x=1')).toEqual({ hosts: ['127.0.0.1'], database: 'dev' });
  });

  it('returns null for anything that is not a mongodb uri', () => {
    expect(parseMongoTarget(undefined)).toBeNull();
    expect(parseMongoTarget('')).toBeNull();
    expect(parseMongoTarget('postgres://x/y')).toBeNull();
    expect(parseMongoTarget(42)).toBeNull();
  });
});

describe('isLocalMongoTarget', () => {
  it('is true only when every host is on this computer', () => {
    expect(isLocalMongoTarget('mongodb://127.0.0.1:27018/suprah_dev')).toBe(true);
    expect(isLocalMongoTarget('mongodb://localhost:27017/x')).toBe(true);
    expect(isLocalMongoTarget('mongodb://[::1]:27017/x')).toBe(true);
    expect(isLocalMongoTarget('mongodb://127.0.0.1:27017,10.0.0.5:27017/x')).toBe(false);
  });

  it('is false for atlas, for the production cluster, for lookalike hosts and for garbage', () => {
    expect(isLocalMongoTarget(PROD_SRV)).toBe(false);
    expect(isLocalMongoTarget('mongodb+srv://u:p@dev-cluster.abc.mongodb.net/dev')).toBe(false);
    expect(isLocalMongoTarget('mongodb://localhost.evil.example/x')).toBe(false);
    expect(isLocalMongoTarget('mongodb://127.0.0.1.evil.example/x')).toBe(false);
    expect(isLocalMongoTarget('not-a-uri')).toBe(false);
    expect(isLocalMongoTarget(undefined)).toBe(false);
  });
});

describe('isProductionTarget', () => {
  const targets = parseProductionTargets();

  it('matches the production cluster in both the SRV and the shard host forms, on the production database', () => {
    expect(isProductionTarget(parseMongoTarget(PROD_SRV)!, targets)).toBe(true);
    expect(isProductionTarget(parseMongoTarget(PROD_SRV_NO_DB)!, targets)).toBe(true);
    expect(isProductionTarget(parseMongoTarget(PROD_STANDARD)!, targets)).toBe(true);
  });

  it('does not match a separate database on the same cluster, a local database or another cluster', () => {
    expect(isProductionTarget(parseMongoTarget('mongodb+srv://u:p@supra-ai-prod.ha7pe5c.mongodb.net/suprah_dev')!, targets)).toBe(false);
    expect(isProductionTarget(parseMongoTarget('mongodb://localhost:27017/test')!, targets)).toBe(false);
    expect(isProductionTarget(parseMongoTarget('mongodb+srv://u:p@supra-ai-dev.zzzz.mongodb.net/test')!, targets)).toBe(false);
  });

  it('is case-insensitive on the host and the database', () => {
    expect(isProductionTarget(parseMongoTarget('mongodb+srv://u:p@SUPRA-AI-PROD.HA7PE5C.MONGODB.NET/TEST')!, targets)).toBe(true);
  });

  it('accepts extra production targets from the environment, with or without a database', () => {
    const extended = parseProductionTargets(' "other-prod.abc.mongodb.net" , edge-prod/live ');
    expect(isProductionTarget(parseMongoTarget('mongodb+srv://u:p@other-prod.abc.mongodb.net/anything')!, extended)).toBe(true);
    expect(isProductionTarget(parseMongoTarget('mongodb://edge-prod:27017/live')!, extended)).toBe(true);
    expect(isProductionTarget(parseMongoTarget('mongodb://edge-prod:27017/scratch')!, extended)).toBe(false);
    expect(extended[0]).toEqual({ contains: 'supra-ai-prod', databases: ['test'] });
  });
});

describe('evaluateProductionDbGuard', () => {
  it('lets the production runtime use the production database (the VPS: NODE_ENV=production)', () => {
    for (const uri of [PROD_SRV, PROD_SRV_NO_DB, PROD_STANDARD]) {
      expect(evaluateProductionDbGuard({ uri, nodeEnv: 'production' })).toMatchObject({ allowed: true, reason: 'production_runtime' });
    }
  });

  it.each(['development', 'test', undefined, '', 'staging', 'Production'])('refuses the production database when NODE_ENV is %p', (nodeEnv) => {
    const decision = evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv });
    expect(decision).toMatchObject({ allowed: false, reason: 'production_target_outside_production' });
  });

  it('allows development databases everywhere', () => {
    for (const nodeEnv of ['development', 'test', 'production', undefined]) {
      expect(evaluateProductionDbGuard({ uri: 'mongodb://localhost:27017/suprah_dev', nodeEnv })).toMatchObject({ allowed: true, reason: 'not_production_target' });
    }
  });

  it('cannot classify a string that is not a mongodb uri, so it stays out of the way', () => {
    expect(evaluateProductionDbGuard({ uri: 'not-a-uri', nodeEnv: 'development' })).toMatchObject({ allowed: true, reason: 'unclassified' });
  });

  it('accepts an inline override only when it equals the exact database host', () => {
    expect(evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv: 'development', override: PROD_HOST })).toMatchObject({ allowed: true, reason: 'explicit_override' });
    expect(evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv: 'development', override: `  ${PROD_HOST.toUpperCase()} ` })).toMatchObject({ allowed: true, reason: 'explicit_override' });
    for (const override of ['true', 'yes', '1', 'supra-ai-prod', 'other.mongodb.net']) {
      expect(evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv: 'development', override })).toMatchObject({ allowed: false, reason: 'override_mismatch' });
    }
  });

  it('accepts any one host of a multi-host string as the override', () => {
    expect(
      evaluateProductionDbGuard({ uri: PROD_STANDARD, nodeEnv: 'development', override: 'supra-ai-prod-shard-00-01.ha7pe5c.mongodb.net' }),
    ).toMatchObject({ allowed: true, reason: 'explicit_override' });
  });

  it('rejects an override that lives in a .env file, even when it is correct', () => {
    expect(
      evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv: 'development', override: PROD_HOST, overrideDefinedInEnvFile: true }),
    ).toMatchObject({ allowed: false, reason: 'override_in_env_file' });
  });

  it('the override is irrelevant, and harmless, for a non-production target or the production runtime', () => {
    expect(evaluateProductionDbGuard({ uri: 'mongodb://localhost/dev', nodeEnv: 'development', override: PROD_HOST })).toMatchObject({ allowed: true, reason: 'not_production_target' });
    expect(evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv: 'production', override: 'anything' })).toMatchObject({ allowed: true, reason: 'production_runtime' });
  });

  it('honours extra production targets from the environment', () => {
    const decision = evaluateProductionDbGuard({
      uri: 'mongodb+srv://u:p@other-prod.abc.mongodb.net/data',
      nodeEnv: 'development',
      extraTargets: 'other-prod.abc.mongodb.net',
    });
    expect(decision).toMatchObject({ allowed: false, reason: 'production_target_outside_production' });
  });

  it('never puts credentials or the raw uri in any message or description', () => {
    const decisions = [
      evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv: 'development' }),
      evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv: 'development', override: 'wrong' }),
      evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv: 'development', override: PROD_HOST, overrideDefinedInEnvFile: true }),
      evaluateProductionDbGuard({ uri: PROD_SRV, nodeEnv: 'development', override: PROD_HOST }),
      evaluateProductionDbGuard({ uri: PROD_STANDARD, nodeEnv: 'production' }),
    ];
    for (const decision of decisions) {
      const text = JSON.stringify(decision);
      expect(text).not.toContain('s3cr3t');
      expect(text).not.toContain('appuser');
      expect(text).not.toContain('retryWrites');
      expect(text).toContain('host=');
    }
  });
});
