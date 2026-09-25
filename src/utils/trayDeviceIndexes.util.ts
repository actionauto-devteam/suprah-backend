export interface RequiredIndex {
  key: Record<string, 1 | -1>;
  unique?: boolean;
  expireAfterSeconds?: number;
}

export interface ActualIndex {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  expireAfterSeconds?: number;
}

export const REQUIRED_TRAY_DEVICE_INDEXES: RequiredIndex[] = [
  { key: { deviceId: 1 }, unique: true },
  { key: { userId: 1 } },
  { key: { userId: 1, revokedAt: 1 } },
];

export const REQUIRED_TRAY_BOOTSTRAP_INDEXES: RequiredIndex[] = [
  { key: { codeHash: 1 }, unique: true },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  { key: { userId: 1 } },
];

const sameKey = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const left = Object.entries(a);
  const right = Object.entries(b);
  return left.length === right.length && left.every(([field, order], position) => right[position]?.[0] === field && Number(right[position]?.[1]) === Number(order));
};

const describeKey = (key: Record<string, unknown>): string =>
  Object.entries(key).map(([field, order]) => `${field}:${order}`).join(',');

export const findIndexProblems = (required: RequiredIndex[], actual: ActualIndex[]): string[] => {
  const problems: string[] = [];
  for (const wanted of required) {
    const found = actual.find((index) => index.key && sameKey(index.key, wanted.key));
    const label = `{${describeKey(wanted.key)}}`;
    if (!found) {
      problems.push(`missing index ${label}${wanted.unique ? ' (unique)' : ''}${wanted.expireAfterSeconds !== undefined ? ' (TTL)' : ''}`);
      continue;
    }
    if (wanted.unique && found.unique !== true) problems.push(`index ${label} exists but is not unique`);
    if (wanted.expireAfterSeconds !== undefined && found.expireAfterSeconds !== wanted.expireAfterSeconds) {
      problems.push(`index ${label} exists but has no TTL of ${wanted.expireAfterSeconds}s`);
    }
  }
  return problems;
};
