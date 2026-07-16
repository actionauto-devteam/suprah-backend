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

export const userAuthCache = new SimpleCache<any>(5000, 60000);
export const orgStatusCache = new SimpleCache<{ status: string }>(1000, 60000);

export const invalidateUserCache = (userId: string) => {
    userAuthCache.delete(userId);
};

export const invalidateOrgCache = (orgId: string) => {
    orgStatusCache.delete(orgId);
};