import CrmLocation from '../models/CrmLocation.model';
import { normalizeLocationKey } from './locationKey';
import { resolveVehicleContextForLead, type LeadVehicleDescriptor, type ResolvedVehicleContext } from '../services/leadLocation.service';

export interface LeadStore {
  name: string;
  keys: string[];
  stockPrefixes?: string[];
}

export async function activeLeadStores(organizationId: unknown): Promise<LeadStore[]> {
  const rows = await CrmLocation.find({ organizationId: String(organizationId), status: 'active' })
    .select('name aliasKeys stockPrefixes')
    .sort({ name: 1, _id: 1 })
    .lean()
    .catch(() => []);
  return (rows as any[])
    .map((row) => ({
      name: String(row.name || '').trim(),
      keys: Array.from(new Set([normalizeLocationKey(row.name), ...((row.aliasKeys || []) as string[])].filter(Boolean))),
      stockPrefixes: ((row.stockPrefixes || []) as string[]).map((prefix) => String(prefix).trim().toUpperCase()).filter(Boolean),
    }))
    .filter((row) => row.name);
}

export function storeForLabel(stores: LeadStore[], raw: unknown): string | null {
  const key = normalizeLocationKey(raw);
  if (!key) return null;
  const exact = stores.find((store) => store.keys.includes(key));
  if (exact) return exact.name;
  const words = key.split(' ');
  const contained = stores.filter((store) => store.keys.some((storeKey) => {
    const storeWords = storeKey.split(' ');
    return words.every((word) => storeWords.includes(word));
  }));
  return contained.length === 1 ? contained[0].name : null;
}

export function labelsForStore(stores: LeadStore[], storeName: string, labels: unknown[]): string[] {
  return labels
    .filter((label): label is string => typeof label === 'string' && label.trim() !== '')
    .filter((label) => storeForLabel(stores, label) === storeName);
}

export function storeForStock(stores: LeadStore[], stock: unknown): string | null {
  const value = typeof stock === 'string' ? stock.trim().toUpperCase() : '';
  if (!value) return null;
  let best: { name: string; length: number } | null = null;
  for (const store of stores) {
    for (const prefix of store.stockPrefixes || []) {
      if (value.startsWith(prefix) && (!best || prefix.length > best.length)) best = { name: store.name, length: prefix.length };
    }
  }
  return best?.name || null;
}

export async function resolveLeadStore(organizationId: unknown, descriptor: LeadVehicleDescriptor): Promise<ResolvedVehicleContext | null> {
  const context = await resolveVehicleContextForLead(organizationId, descriptor).catch(() => null);
  const stock = String(descriptor?.stock || '').trim() || context?.stockNumber;
  if (!stock) return context;
  const store = storeForStock(await activeLeadStores(organizationId), stock);
  if (!store) return context;
  return { ...(context || {}), location: store };
}
