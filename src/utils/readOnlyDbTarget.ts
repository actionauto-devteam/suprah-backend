export const TARGET_ENVIRONMENTS = ['local', 'staging', 'production'] as const;
export type TargetEnvironment = typeof TARGET_ENVIRONMENTS[number];

export type CredentialAccess = 'no_auth' | 'read_only' | 'write_capable' | 'unknown';

export interface CredentialSummary {
  access: CredentialAccess;
  roles: string[];
}

export interface ResolvedTarget {
  uri: string;
  environment: TargetEnvironment;
  database: string;
  hosts: string[];
  organizationId: string | null;
  flags: string[];
  values: Record<string, string>;
}

export interface TargetSpec {
  uriVariable: string;
  flags?: string[];
  values?: string[];
}

const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const BASE_OPTIONS = ['--env', '--db', '--org', '--help'];
const WRITE_ACTIONS = new Set([
  'anyAction', 'insert', 'update', 'remove', 'createCollection', 'dropCollection', 'dropDatabase', 'renameCollectionSameDB',
  'collMod', 'createIndex', 'dropIndex', 'convertToCapped', 'compact', 'bypassDocumentValidation',
]);
const READ_COMMANDS = new Set([
  'find', 'getMore', 'killCursors', 'count', 'aggregate', 'listCollections', 'listIndexes', 'connectionStatus',
  'ping', 'hello', 'ismaster', 'isMaster', 'buildInfo', 'endSessions',
]);

export const CREDENTIAL_LABELS: Record<CredentialAccess, string> = {
  read_only: 'read-only',
  write_capable: 'can change data',
  no_auth: 'not signed in (no database user)',
  unknown: 'could not be checked',
};

export function uriHosts(uri: string): string[] {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?#]+)/i.exec(String(uri || '').trim());
  if (!match) return [];
  return match[1].split(',').map((host) => host.trim()).filter(Boolean).map((host) =>
    host.startsWith('[') ? host.slice(1, Math.max(1, host.indexOf(']'))).toLowerCase() : host.split(':')[0].toLowerCase());
}

export function uriDatabase(uri: string): string | null {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?[^/?#]+\/([^?#]*)/i.exec(String(uri || '').trim());
  if (!match || !match[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export const isLoopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

export function resolveTarget(argv: string[], uri: string | undefined, spec: TargetSpec): { target?: ResolvedTarget; error?: string; help?: boolean } {
  const flagOptions = spec.flags || [];
  const valueOptions = spec.values || [];
  const known = new Set([...BASE_OPTIONS, ...flagOptions, ...valueOptions]);
  const names = argv.map((arg) => arg.split('=')[0]);
  const unknown = names.find((name) => !known.has(name));
  if (unknown) return { error: `Unknown option ${unknown.slice(0, 40)}.` };
  if (names.includes('--help')) return { help: true };
  const value = (name: string) => {
    const found = argv.find((arg) => arg.startsWith(`${name}=`));
    return found === undefined ? undefined : found.slice(name.length + 1).trim();
  };

  if (!uri || !uri.trim()) return { error: `Set ${spec.uriVariable} for this run. It never uses MONGODB_URI or .env files.` };
  const environment = value('--env');
  if (!environment || !(TARGET_ENVIRONMENTS as readonly string[]).includes(environment)) {
    return { error: 'Pass --env=local, --env=staging or --env=production to say which environment this is.' };
  }
  const database = value('--db');
  if (!database || !SAFE_NAME.test(database)) return { error: 'Pass --db=<database name> with the exact database name.' };
  const hosts = uriHosts(uri);
  if (!hosts.length) return { error: `${spec.uriVariable} is not a mongodb:// or mongodb+srv:// connection string.` };
  const uriDb = uriDatabase(uri);
  if (uriDb && uriDb !== database) return { error: `The connection string names database "${uriDb.slice(0, 64)}" but --db is "${database}". They must match.` };
  if (environment === 'local' && !hosts.every(isLoopbackHost)) {
    return { error: '--env=local only works with a database on this computer (localhost or 127.0.0.1).' };
  }
  const organizationId = value('--org');
  if (organizationId !== undefined && !SAFE_NAME.test(organizationId)) return { error: 'Pass --org=<organization id> with a valid id, or leave it out to include every organization.' };
  const values: Record<string, string> = {};
  for (const name of valueOptions) {
    const found = value(name);
    if (found === undefined) continue;
    if (!SAFE_NAME.test(found)) return { error: `Pass ${name}=<value> with letters, numbers, dashes or underscores only.` };
    values[name] = found;
  }

  return {
    target: {
      uri: uri.trim(),
      environment: environment as TargetEnvironment,
      database,
      hosts,
      organizationId: organizationId || null,
      flags: flagOptions.filter((flag) => names.includes(flag)),
      values,
    },
  };
}

export function describeCredentials(status: any, database: string): CredentialSummary {
  const info = status?.authInfo;
  if (!info) return { access: 'unknown', roles: [] };
  const roles = Array.isArray(info.authenticatedUserRoles)
    ? info.authenticatedUserRoles.map((role: any) => `${role?.role}@${role?.db}`)
    : [];
  const users = Array.isArray(info.authenticatedUsers) ? info.authenticatedUsers : [];
  if (!users.length) return { access: 'no_auth', roles };
  const privileges = info.authenticatedUserPrivileges;
  if (!Array.isArray(privileges)) return { access: 'unknown', roles };
  const canWrite = privileges.some((privilege: any) => {
    const resource = privilege?.resource || {};
    const coversDatabase = resource.anyResource === true || (typeof resource.db === 'string' && (resource.db === '' || resource.db === database));
    return coversDatabase && Array.isArray(privilege?.actions) && privilege.actions.some((action: string) => WRITE_ACTIONS.has(action));
  });
  return { access: canWrite ? 'write_capable' : 'read_only', roles };
}

export function credentialRefusal(target: { environment: TargetEnvironment }, credentials: CredentialSummary): string | null {
  if (target.environment === 'local' || credentials.access === 'read_only') return null;
  const reason = credentials.access === 'write_capable'
    ? 'These database credentials are allowed to change data.'
    : credentials.access === 'no_auth'
      ? 'This connection is not signed in as a database user.'
      : 'The permissions of these database credentials could not be checked.';
  return `${reason} For ${target.environment}, use a read-only database user.`;
}

export async function withSilentAppLogger<T>(load: () => Promise<T>): Promise<T> {
  const nodeEnvBeforeImport = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    return await load();
  } finally {
    if (nodeEnvBeforeImport === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnvBeforeImport;
  }
}

export function isReadOnlyCommand(commandName: string, command?: any): boolean {
  if (!READ_COMMANDS.has(commandName)) return false;
  if (commandName !== 'aggregate') return true;
  const pipeline = Array.isArray(command?.pipeline) ? command.pipeline : [];
  return !pipeline.some((stage: any) => stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage));
}

export function createCommandRecorder() {
  const sent = new Map<string, number>();
  const unexpected = new Map<string, number>();
  const bump = (map: Map<string, number>, name: string) => map.set(name, (map.get(name) || 0) + 1);
  const sortedObject = (map: Map<string, number>) =>
    Object.fromEntries(Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])));
  return {
    observe(event: { commandName?: string; command?: any }): void {
      const name = String(event?.commandName || 'unknown');
      bump(sent, name);
      if (!isReadOnlyCommand(name, event?.command)) bump(unexpected, name);
    },
    summary(): { sent: Record<string, number>; unexpected: Record<string, number> } {
      return { sent: sortedObject(sent), unexpected: sortedObject(unexpected) };
    },
  };
}

export const describeCommands = (counts: Record<string, number>): string =>
  Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(', ') || 'none';

export const redactConnectionStrings = (text: string): string =>
  String(text || '').replace(/mongodb(\+srv)?:\/\/[^\s"']+/gi, '<connection string>');
