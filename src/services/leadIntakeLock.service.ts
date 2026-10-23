import { randomUUID } from 'crypto';
import LeadIntakeLock from '../models/LeadIntakeLock.model';
import { normalizeIdentityEmail, normalizeIdentityPhone } from '../utils/contactIdentity';

export interface LeadIntakeLockHandle {
  organizationId: string;
  keys: string[];
  owner: string;
  leaseMs: number;
}

export interface LeadIntakeLockOptions {
  owner?: string;
  leaseMs?: number;
  waitMs?: number;
  retryMs?: number;
}

export class LeadIntakeLockBusyError extends Error {
  constructor() {
    super('Another intake for this customer is in progress');
    this.name = 'LeadIntakeLockBusyError';
  }
}

export class LeadIntakeLockLostError extends Error {
  constructor() {
    super('The intake lock expired or was taken over');
    this.name = 'LeadIntakeLockLostError';
  }
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_RETRY_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function leadIntakeLockKeys(input: { customerId?: unknown; phone?: unknown; email?: unknown }): string[] {
  const keys: string[] = [];
  const customerId = input.customerId ? String(input.customerId).trim() : '';
  if (customerId) keys.push(`customer:${customerId}`);
  const phone = normalizeIdentityPhone(input.phone);
  if (phone) keys.push(`phone:${phone}`);
  const email = normalizeIdentityEmail(input.email);
  if (email) keys.push(`email:${email}`);
  return [...new Set(keys)].sort();
}

async function tryAcquireKey(organizationId: string, key: string, owner: string, leaseMs: number): Promise<boolean> {
  const now = new Date();
  try {
    const lock = await LeadIntakeLock.findOneAndUpdate(
      { organizationId, key, $or: [{ expiresAt: { $lte: now } }, { owner }] },
      { $set: { owner, expiresAt: new Date(now.getTime() + leaseMs), acquiredAt: now } },
      { upsert: true, new: true },
    ).lean();
    return lock?.owner === owner;
  } catch (err: any) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function releaseKeys(organizationId: string, keys: string[], owner: string): Promise<void> {
  if (!keys.length) return;
  await LeadIntakeLock.deleteMany({ organizationId, key: { $in: keys }, owner });
}

export async function acquireLeadIntakeLock(
  organizationId: string,
  keys: string[],
  options: LeadIntakeLockOptions = {},
): Promise<LeadIntakeLockHandle | null> {
  const sortedKeys = [...new Set(keys.filter(Boolean))].sort();
  if (!organizationId || !sortedKeys.length) throw new Error('Organization and at least one key are required');
  const owner = options.owner || randomUUID();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  const held: string[] = [];
  for (const key of sortedKeys) {
    while (!(await tryAcquireKey(organizationId, key, owner, leaseMs))) {
      if (Date.now() >= deadline) {
        await releaseKeys(organizationId, held, owner);
        return null;
      }
      await sleep(retryMs);
    }
    held.push(key);
  }
  return { organizationId, keys: sortedKeys, owner, leaseMs };
}

export async function renewLeadIntakeLock(handle: LeadIntakeLockHandle): Promise<boolean> {
  const now = new Date();
  const result = await LeadIntakeLock.updateMany(
    { organizationId: handle.organizationId, key: { $in: handle.keys }, owner: handle.owner, expiresAt: { $gt: now } },
    { $set: { expiresAt: new Date(now.getTime() + handle.leaseMs) } },
  );
  return result.matchedCount === handle.keys.length;
}

export async function releaseLeadIntakeLock(handle: LeadIntakeLockHandle): Promise<void> {
  await releaseKeys(handle.organizationId, handle.keys, handle.owner);
}

export async function withLeadIntakeLock<T>(
  organizationId: string,
  keys: string[],
  operation: (lock: { handle: LeadIntakeLockHandle; confirmHeld: () => Promise<void> }) => Promise<T>,
  options: LeadIntakeLockOptions = {},
): Promise<T> {
  const handle = await acquireLeadIntakeLock(organizationId, keys, options);
  if (!handle) throw new LeadIntakeLockBusyError();
  const confirmHeld = async () => {
    if (!(await renewLeadIntakeLock(handle))) throw new LeadIntakeLockLostError();
  };
  try {
    return await operation({ handle, confirmHeld });
  } finally {
    await releaseLeadIntakeLock(handle).catch(() => undefined);
  }
}
