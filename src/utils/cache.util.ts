export interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

export class SimpleCache<T> {
    private cache = new Map<string, CacheEntry<T>>();
    
    constructor(
        private maxSize: number = 5000, 
        private ttlMs: number = 60000
    ) {}

    set(key: string, data: T): void {
        // Simple FIFO eviction if limit reached
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                this.cache.delete(oldestKey);
            }
        }
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    get(key: string): T | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        // Check if expired
        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.cache.delete(key);
            return undefined;
        }

        return entry.data;
    }

    delete(key: string): void {
        this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }
}

// Global instances for auth
export const userAuthCache = new SimpleCache<any>(5000, 60000); // 1 min TTL, max 5000 users
export const orgStatusCache = new SimpleCache<{ status: string }>(1000, 60000); // 1 min TTL, max 1000 orgs

/**
 * Invalidate the cached user when they change organization.
 * Call this after updating user.organizationId.
 * 
 * This ensures the next request fetches fresh user data from the database
 * rather than serving stale cache with the old organizationId.
 */
export const invalidateUserCache = (userId: string) => {
    userAuthCache.delete(userId);
};

/**
 * Invalidate org status cache when org state changes.
 * 
 * Use this when organization status is updated (suspended, active, etc.)
 */
export const invalidateOrgCache = (orgId: string) => {
    orgStatusCache.delete(orgId);
};