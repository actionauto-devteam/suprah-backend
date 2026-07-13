import { cacheService } from "../services/cache.service";
import { storageService } from "../services/storage.service";

const URL_TTL = 3600;
const CACHE_TTL = 3300;

export async function getSignedProofUrl(key: string): Promise<string | null> {
  if (!key || key.startsWith("http")) return key || null;
  const cacheKey = `signed:proof:${key}`;
  const cached = await cacheService.get<string>(cacheKey);
  if (cached) return cached;
  const signed = await storageService.getSignedUrl(key, URL_TTL);
  if (signed) await cacheService.set(cacheKey, signed, CACHE_TTL);
  return signed ?? null;
}
