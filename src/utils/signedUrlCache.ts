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

// Generic version of the above for callers with their own namespace/TTL —
// e.g. SupraSpace re-signs every message attachment + conversation avatar on
// EVERY fetch with no caching at all, which adds real (if individually
// cheap) work on a path that's already called far more often than it needs
// to be. Caching just under the URL's own expiry means repeat fetches within
// that window skip re-signing entirely.
export async function getCachedSignedUrl(
  namespace: string,
  key: string,
  urlTtlSeconds: number = URL_TTL,
  // Cache slightly shorter than the signed URL's own expiry (safety margin
  // so a served-from-cache URL is never already-expired) — derived from
  // whatever urlTtlSeconds the caller passes rather than a fixed constant,
  // so a custom TTL (e.g. the 7-day avatar TTL) doesn't outlive its cache.
  cacheTtlSeconds: number = Math.floor(urlTtlSeconds * 0.9),
): Promise<string | null> {
  if (!key || key.startsWith("http")) return key || null;
  const cacheKey = `signed:${namespace}:${key}`;
  const cached = await cacheService.get<string>(cacheKey);
  if (cached) return cached;
  const signed = await storageService.getSignedUrl(key, urlTtlSeconds);
  if (signed) await cacheService.set(cacheKey, signed, cacheTtlSeconds);
  return signed ?? null;
}
