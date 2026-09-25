export interface ProductionTarget {
  contains: string;
  databases: string[] | null;
}

export interface MongoTarget {
  hosts: string[];
  database: string;
}

export const DEFAULT_PRODUCTION_DB_TARGETS: ProductionTarget[] = [{ contains: 'supra-ai-prod', databases: ['test'] }];

const DEFAULT_DATABASE_NAME = 'test';

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const parseMongoTarget = (uri: unknown): MongoTarget | null => {
  if (typeof uri !== 'string') return null;
  const match = /^mongodb(?:\+srv)?:\/\/(.*)$/is.exec(uri.trim());
  if (!match) return null;
  const rest = match[1];
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const hostList = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const hosts = hostList
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter(Boolean);
  if (hosts.length === 0) return null;
  let database = '';
  if (authorityEnd !== -1 && rest[authorityEnd] === '/') {
    const afterSlash = rest.slice(authorityEnd + 1);
    const queryStart = afterSlash.indexOf('?');
    database = safeDecode(queryStart === -1 ? afterSlash : afterSlash.slice(0, queryStart));
  }
  return { hosts, database: database || DEFAULT_DATABASE_NAME };
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export const isLocalMongoTarget = (uri: unknown): boolean => {
  const target = parseMongoTarget(uri);
  return !!target && target.hosts.every((host) => LOCAL_HOSTS.has(host.replace(/^\[|\]$/g, '')));
};

export const describeMongoTarget =(target: MongoTarget): string => `host=${target.hosts.join(',')} db=${target.database}`;

export const parseProductionTargets = (extra?: string): ProductionTarget[] => {
  const extras = (extra ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/^["']+|["']+$/g, '').trim().toLowerCase())
    .filter(Boolean)
    .map((entry): ProductionTarget => {
      const slash = entry.indexOf('/');
      return slash === -1
        ? { contains: entry, databases: null }
        : { contains: entry.slice(0, slash), databases: [entry.slice(slash + 1)].filter(Boolean) };
    })
    .filter((entry) => entry.contains.length > 0);
  return [...DEFAULT_PRODUCTION_DB_TARGETS, ...extras];
};

export const isProductionTarget = (target: MongoTarget, targets: ProductionTarget[]): boolean =>
  targets.some(
    (entry) =>
      target.hosts.some((host) => host.includes(entry.contains.toLowerCase())) &&
      (entry.databases === null || entry.databases.map((db) => db.toLowerCase()).includes(target.database.toLowerCase())),
  );

export interface GuardInput {
  uri: unknown;
  nodeEnv: string | undefined;
  override?: string;
  overrideDefinedInEnvFile?: boolean;
  extraTargets?: string;
}

export type GuardDecision =
  | { allowed: true; reason: 'unclassified' | 'not_production_target' | 'production_runtime' | 'explicit_override'; target: string }
  | {
      allowed: false;
      reason: 'production_target_outside_production' | 'override_in_env_file' | 'override_mismatch';
      target: string;
      message: string;
    };

export const evaluateProductionDbGuard = (input: GuardInput): GuardDecision => {
  const target = parseMongoTarget(input.uri);
  if (!target) return { allowed: true, reason: 'unclassified', target: 'unparsed' };
  const description = describeMongoTarget(target);
  if (!isProductionTarget(target, parseProductionTargets(input.extraTargets))) {
    return { allowed: true, reason: 'not_production_target', target: description };
  }
  if (input.nodeEnv === 'production') return { allowed: true, reason: 'production_runtime', target: description };

  const runtime = `NODE_ENV=${input.nodeEnv ?? 'unset'}`;
  const override = (input.override ?? '').trim().toLowerCase();
  if (override) {
    if (input.overrideDefinedInEnvFile) {
      return {
        allowed: false,
        reason: 'override_in_env_file',
        target: description,
        message:
          `Refusing to connect to a production database (${description}) with ${runtime}: ALLOW_PRODUCTION_DB is defined in a .env file, ` +
          'which is not accepted. Pass it inline in the environment of the single command that needs it.',
      };
    }
    if (target.hosts.includes(override)) return { allowed: true, reason: 'explicit_override', target: description };
    return {
      allowed: false,
      reason: 'override_mismatch',
      target: description,
      message:
        `Refusing to connect to a production database (${description}) with ${runtime}: ALLOW_PRODUCTION_DB does not equal the database host. ` +
        'It must be the exact host of the database you mean to use.',
    };
  }
  return {
    allowed: false,
    reason: 'production_target_outside_production',
    target: description,
    message:
      `Refusing to connect: this process is running with ${runtime} but the database target (${description}) is a production database. ` +
      'Point MONGODB_URI at a development database, for example in suprah-backend/.env.local. ' +
      'To run an administrative script against production on purpose, run that one command with ALLOW_PRODUCTION_DB=<database host> in its environment (not in a .env file).',
  };
};
