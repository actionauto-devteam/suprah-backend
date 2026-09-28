import mongoose from 'mongoose';
import Organization from '../models/Organization.model';

/**
 * Organizations whose loads may appear on the shared, platform-wide Available
 * Loads board. Loads from suspended, archived or deleted organizations must
 * not be requested, because nobody there can approve or dispatch them.
 *
 * The list is small and read on every board request, so it is cached briefly.
 */
const CACHE_MS = 60_000;
let cache: { ids: Set<string>; at: number } | null = null;

async function load(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.ids;
  const ids = await Organization.find({ status: 'active' }).distinct('_id');
  cache = { ids: new Set(ids.map((id: unknown) => String(id))), at: Date.now() };
  return cache.ids;
}

export async function activeOrganizationObjectIds(): Promise<mongoose.Types.ObjectId[]> {
  return [...(await load())].map((id) => new mongoose.Types.ObjectId(id));
}

export async function isOrganizationActive(organizationId: unknown): Promise<boolean> {
  const id = String(organizationId ?? '').trim();
  return Boolean(id) && (await load()).has(id);
}

/** Call after an organization is deleted or its status changes. */
export function invalidateActiveOrganizations(): void {
  cache = null;
}
