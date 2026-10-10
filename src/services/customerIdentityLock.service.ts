import { randomUUID } from 'crypto';
import CustomerIdentityLock from '../models/CustomerIdentityLock.model';
import { assertCustomerIdentityIndexesReady } from './customerIdentityIndexes.service';

export async function withCustomerIdentityLock<T>(organizationId: string, operation: (renew: () => Promise<void>) => Promise<T>): Promise<T> {
  await assertCustomerIdentityIndexesReady();
  const owner = randomUUID();
  const deadline = Date.now() + 15000;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    try {
      acquired = Boolean(await CustomerIdentityLock.findOneAndUpdate(
        { organizationId, expiresAt: { $lte: new Date() } },
        { $set: { owner, expiresAt: new Date(Date.now() + 60000) } },
        { upsert: true, new: true, maxTimeMS: 5000 },
      ));
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
    if (!acquired) await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!acquired) throw new Error('Customer identity synchronization is busy; retry required');
  const renew = async () => {
    const lease = await CustomerIdentityLock.updateOne(
      { organizationId, owner, expiresAt: { $gt: new Date() } },
      { $set: { expiresAt: new Date(Date.now() + 60000) } },
      { maxTimeMS: 5000 },
    );
    if (!lease.matchedCount) throw new Error('Customer identity lease expired; retry required');
  };
  try {
    return await operation(renew);
  } finally {
    await CustomerIdentityLock.updateOne({ organizationId, owner }, { $set: { expiresAt: new Date(0) } }).catch(() => undefined);
  }
}
