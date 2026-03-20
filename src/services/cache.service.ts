import Redis from 'ioredis';
import config from '../config';

const LOG_PREFIX = '[CacheService]';

// ── Redis Client ─────────────────────────────────────────────────────────────
// Lazily created once and reused across the entire process.
let redisClient: Redis | null = null;

function getRedisClient(): Redis | null {
    if (!config.redis.enabled) return null;
    if (redisClient) return redisClient;

    redisClient = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        // Reconnect automatically with exponential backoff
        retryStrategy: (times) => {
            const delay = Math.min(times * 100, 3000);
            console.warn(`${LOG_PREFIX} Reconnecting to Redis (attempt ${times})...`);
            return delay;
        },
        // Don't crash the process if Redis is down at startup
        lazyConnect: true,
        enableReadyCheck: true,
        maxRetriesPerRequest: 3,
    });

    redisClient.on('connect', () => console.log(`${LOG_PREFIX} ✅ Connected to Redis`));
    redisClient.on('error', (err) => console.error(`${LOG_PREFIX} ❌ Redis error:`, err.message));
    redisClient.on('close', () => console.warn(`${LOG_PREFIX} Redis connection closed.`));

    return redisClient;
}

// ── CacheService ─────────────────────────────────────────────────────────────
class CacheService {
    /**
     * Get a cached value. Returns null on cache miss or Redis error.
     */
    async get<T = any>(key: string): Promise<T | null> {
        if (!config.redis.enabled) return null;
        try {
            const client = getRedisClient();
            if (!client) return null;
            const value = await client.get(key);
            if (!value) {
                console.log(`${LOG_PREFIX} MISS → ${key}`);
                return null;
            }
            console.log(`${LOG_PREFIX} HIT  → ${key}`);
            return JSON.parse(value) as T;
        } catch (err: any) {
            console.error(`${LOG_PREFIX} get() failed for key "${key}":`, err.message);
            return null; // Degrade gracefully — fall through to DB
        }
    }

    /**
     * Set a value in cache with a TTL in seconds.
     */
    async set(key: string, value: any, ttlSeconds: number): Promise<void> {
        if (!config.redis.enabled) return;
        try {
            const client = getRedisClient();
            if (!client) return;
            await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
            console.log(`${LOG_PREFIX} SET  → ${key} (TTL: ${ttlSeconds}s)`);
        } catch (err: any) {
            console.error(`${LOG_PREFIX} set() failed for key "${key}":`, err.message);
        }
    }

    /**
     * Delete a specific key.
     */
    async del(key: string): Promise<void> {
        if (!config.redis.enabled) return;
        try {
            const client = getRedisClient();
            if (!client) return;
            const deleted = await client.del(key);
            if (deleted > 0) {
                console.log(`${LOG_PREFIX} DEL  → ${key}`);
            }
        } catch (err: any) {
            console.error(`${LOG_PREFIX} del() failed for key "${key}":`, err.message);
        }
    }

    /**
     * Delete all keys matching a prefix pattern (e.g. "veh:*").
     * Uses SCAN to avoid blocking Redis in production.
     */
    async invalidateByPrefix(prefix: string): Promise<void> {
        if (!config.redis.enabled) return;
        try {
            const client = getRedisClient();
            if (!client) return;
            const pattern = prefix.endsWith('*') ? prefix : `${prefix}*`;
            let cursor = '0';
            let totalDeleted = 0;

            do {
                const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = nextCursor;

                if (keys.length > 0) {
                    await client.del(...keys);
                    totalDeleted += keys.length;
                }
            } while (cursor !== '0');

            console.log(`${LOG_PREFIX} INVALIDATED ${totalDeleted} keys matching "${pattern}"`);
        } catch (err: any) {
            console.error(`${LOG_PREFIX} invalidateByPrefix() failed for "${prefix}":`, err.message);
        }
    }

    /**
     * Delete multiple specific keys at once.
     */
    async delMany(keys: string[]): Promise<void> {
        if (keys.length === 0 || !config.redis.enabled) return;
        try {
            const client = getRedisClient();
            if (!client) return;
            await client.del(...keys);
            console.log(`${LOG_PREFIX} DEL  → [${keys.join(', ')}]`);
        } catch (err: any) {
            console.error(`${LOG_PREFIX} delMany() failed:`, err.message);
        }
    }

    /**
     * Ping Redis to check connectivity.
     */
    async ping(): Promise<boolean> {
        if (!config.redis.enabled) return false;
        try {
            const client = getRedisClient();
            if (!client) return false;
            const result = await client.ping();
            return result === 'PONG';
        } catch {
            return false;
        }
    }

    /**
     * Gracefully close the Redis connection (call on app shutdown).
     */
    async disconnect(): Promise<void> {
        if (redisClient) {
            await redisClient.quit();
            redisClient = null;
            console.log(`${LOG_PREFIX} Disconnected from Redis.`);
        }
    }
}

export const cacheService = new CacheService();
export default cacheService;
