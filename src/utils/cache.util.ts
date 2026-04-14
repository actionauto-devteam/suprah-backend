/**
 * Simple in-memory cache with size limits and TTL
 * Used to replace unbounded Maps and prevent memory leaks.
 */
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
export const userAuthCache = new SimpleCache<any>(5000, 60000); // 1 min TTL
export const orgStatusCache = new SimpleCache<{ status: string }>(1000, 60000);
