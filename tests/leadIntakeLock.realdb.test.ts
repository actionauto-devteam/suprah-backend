import mongoose from 'mongoose';
import LeadIntakeLock from '../src/models/LeadIntakeLock.model';
import {
  LeadIntakeLockBusyError,
  LeadIntakeLockLostError,
  acquireLeadIntakeLock,
  leadIntakeLockKeys,
  releaseLeadIntakeLock,
  renewLeadIntakeLock,
  withLeadIntakeLock,
} from '../src/services/leadIntakeLock.service';

const orgA = String(new mongoose.Types.ObjectId());
const orgB = String(new mongoose.Types.ObjectId());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Real-DB L1: per-customer intake lock', () => {
  beforeAll(async () => {
    jest.setTimeout(60000);
    await LeadIntakeLock.createIndexes();
  });

  afterAll(async () => {
    await LeadIntakeLock.deleteMany({ organizationId: { $in: [orgA, orgB] } });
  });

  it('builds sorted keys from normalized contact details', () => {
    expect(leadIntakeLockKeys({ phone: '(385) 503-5869', email: 'Pat@Example.com', customerId: 'c1' })).toEqual([
      'customer:c1',
      'email:pat@example.com',
      'phone:+13855035869',
    ]);
    expect(leadIntakeLockKeys({ phone: '+1 385 503 5869' })).toEqual(leadIntakeLockKeys({ phone: '385.503.5869' }));
    expect(leadIntakeLockKeys({})).toEqual([]);
  });

  it('lets only one worker hold a customer at a time', async () => {
    const keys = leadIntakeLockKeys({ phone: '385-503-5869' });
    const attempts = await Promise.all(
      ['w1', 'w2', 'w3'].map((owner) => acquireLeadIntakeLock(orgA, keys, { owner, waitMs: 0 })),
    );
    const holders = attempts.filter(Boolean);
    expect(holders).toHaveLength(1);
    await releaseLeadIntakeLock(holders[0]!);
  });

  it('hands the lock to a waiting worker after release', async () => {
    const keys = leadIntakeLockKeys({ email: 'wait@example.com' });
    const first = await acquireLeadIntakeLock(orgA, keys, { owner: 'first' });
    const waiting = acquireLeadIntakeLock(orgA, keys, { owner: 'second', waitMs: 3000, retryMs: 20 });
    await sleep(100);
    await releaseLeadIntakeLock(first!);
    const second = await waiting;
    expect(second?.owner).toBe('second');
    await releaseLeadIntakeLock(second!);
  });

  it('lets a new worker take an expired lock and stops the stale owner', async () => {
    const keys = leadIntakeLockKeys({ phone: '801-555-0142' });
    const stale = await acquireLeadIntakeLock(orgA, keys, { owner: 'stale', leaseMs: 40 });
    await sleep(80);
    const fresh = await acquireLeadIntakeLock(orgA, keys, { owner: 'fresh', waitMs: 0 });
    expect(fresh?.owner).toBe('fresh');
    expect(await renewLeadIntakeLock(stale!)).toBe(false);
    await releaseLeadIntakeLock(stale!);
    const still: any = await LeadIntakeLock.findOne({ organizationId: orgA, key: keys[0] }).lean();
    expect(still.owner).toBe('fresh');
    expect(await renewLeadIntakeLock(fresh!)).toBe(true);
    await releaseLeadIntakeLock(fresh!);
  });

  it('avoids deadlock when two workers need overlapping keys in different orders', async () => {
    const one = leadIntakeLockKeys({ phone: '385-555-0101', email: 'overlap@example.com' });
    const two = [...one].reverse();
    const results = await Promise.all([
      withLeadIntakeLock(orgA, one, async () => { await sleep(50); return 'one'; }, { owner: 'o1', waitMs: 3000, retryMs: 10 }),
      withLeadIntakeLock(orgA, two, async () => { await sleep(50); return 'two'; }, { owner: 'o2', waitMs: 3000, retryMs: 10 }),
    ]);
    expect(results.sort()).toEqual(['one', 'two']);
    expect(await LeadIntakeLock.countDocuments({ organizationId: orgA, key: { $in: one } })).toBe(0);
  });

  it('keeps organizations independent', async () => {
    const keys = leadIntakeLockKeys({ phone: '385-555-0102' });
    const a = await acquireLeadIntakeLock(orgA, keys, { owner: 'a', waitMs: 0 });
    const b = await acquireLeadIntakeLock(orgB, keys, { owner: 'b', waitMs: 0 });
    expect(a && b).toBeTruthy();
    await releaseLeadIntakeLock(a!);
    await releaseLeadIntakeLock(b!);
  });

  it('reports a busy customer and a lost lease to the caller and always releases', async () => {
    const keys = leadIntakeLockKeys({ email: 'busy@example.com' });
    const holder = await acquireLeadIntakeLock(orgA, keys, { owner: 'holder' });
    await expect(withLeadIntakeLock(orgA, keys, async () => 'never', { owner: 'other', waitMs: 50, retryMs: 10 })).rejects.toBeInstanceOf(
      LeadIntakeLockBusyError,
    );
    await releaseLeadIntakeLock(holder!);

    await expect(
      withLeadIntakeLock(orgA, keys, async ({ confirmHeld }) => {
        await sleep(80);
        await confirmHeld();
      }, { owner: 'slow', leaseMs: 40 }),
    ).rejects.toBeInstanceOf(LeadIntakeLockLostError);
    expect(await LeadIntakeLock.countDocuments({ organizationId: orgA, key: keys[0], owner: 'slow' })).toBe(0);
  });
});
