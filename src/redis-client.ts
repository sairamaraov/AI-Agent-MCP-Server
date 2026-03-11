import { Redis } from "ioredis";
import type { Config } from "./types.js";

export class RedisClient {
  private client: Redis;
  private subscriber: Redis;
  private config: Config["redis"];
  private subscriptionHandlers: Map<string, (message: string, channel: string) => void>;

  constructor(config: Config["redis"]) {
    this.config = config;
    this.subscriptionHandlers = new Map();

    // Main client for commands
    this.client = new Redis({
      host: config.host,
      port: config.port,
      password: config.password || undefined,
      db: config.db,
      keyPrefix: config.keyPrefix,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
    });

    // Separate client for subscriptions (required by Redis)
    this.subscriber = new Redis({
      host: config.host,
      port: config.port,
      password: config.password || undefined,
      db: config.db,
      retryStrategy: (times: number) => Math.min(times * 50, 2000),
    });

    this.setupSubscriber();
  }

  private setupSubscriber(): void {
    this.subscriber.on("message", (channel: string, message: string) => {
      // Remove prefix from channel name for handler lookup
      const cleanChannel = channel.replace(this.config.keyPrefix, "");
      const handler = this.subscriptionHandlers.get(cleanChannel);
      if (handler) {
        handler(message, cleanChannel);
      }
    });

    this.subscriber.on("pmessage", (pattern: string, channel: string, message: string) => {
      const cleanPattern = pattern.replace(this.config.keyPrefix, "");
      const handler = this.subscriptionHandlers.get(cleanPattern);
      if (handler) {
        handler(message, channel.replace(this.config.keyPrefix, ""));
      }
    });
  }

  // Key helpers
  key(parts: string[]): string {
    return parts.join(":");
  }

  // Basic operations
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (ttl) {
      await this.client.setex(key, ttl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async expire(key: string, ttl: number): Promise<void> {
    await this.client.expire(key, ttl);
  }

  // Hash operations
  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.client.hset(key, field, value);
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.client.hdel(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  async hkeys(key: string): Promise<string[]> {
    return this.client.hkeys(key);
  }

  // List operations
  async lpush(key: string, ...values: string[]): Promise<number> {
    return this.client.lpush(key, ...values);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return this.client.rpush(key, ...values);
  }

  async lpop(key: string): Promise<string | null> {
    return this.client.lpop(key);
  }

  async rpop(key: string): Promise<string | null> {
    return this.client.rpop(key);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async llen(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.client.ltrim(key, start, stop);
  }

  async blpop(key: string, timeout: number): Promise<[string, string] | null> {
    const result = await this.client.blpop(key, timeout);
    return result as [string, string] | null;
  }

  // Set operations
  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.client.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.client.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async sismember(key: string, member: string): Promise<boolean> {
    return (await this.client.sismember(key, member)) === 1;
  }

  async scard(key: string): Promise<number> {
    return this.client.scard(key);
  }

  // Pub/Sub operations
  async publish(channel: string, message: string): Promise<number> {
    // Use the non-prefixed client for publish since subscriber uses full channel name
    const fullChannel = this.config.keyPrefix + channel;
    return this.client.publish(fullChannel, message);
  }

  async subscribe(
    channel: string,
    handler: (message: string, channel: string) => void
  ): Promise<void> {
    this.subscriptionHandlers.set(channel, handler);
    const fullChannel = this.config.keyPrefix + channel;
    await this.subscriber.subscribe(fullChannel);
  }

  async psubscribe(
    pattern: string,
    handler: (message: string, channel: string) => void
  ): Promise<void> {
    this.subscriptionHandlers.set(pattern, handler);
    const fullPattern = this.config.keyPrefix + pattern;
    await this.subscriber.psubscribe(fullPattern);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscriptionHandlers.delete(channel);
    const fullChannel = this.config.keyPrefix + channel;
    await this.subscriber.unsubscribe(fullChannel);
  }

  // Utility
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.quit();
    await this.subscriber.quit();
  }

  // JSON helpers
  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async setJson<T>(key: string, value: T, ttl?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttl);
  }

  async hgetJson<T>(key: string, field: string): Promise<T | null> {
    const value = await this.hget(key, field);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async hsetJson<T>(key: string, field: string, value: T): Promise<void> {
    await this.hset(key, field, JSON.stringify(value));
  }

  // Transaction support for atomic operations
  /**
   * Execute multiple Redis commands atomically using MULTI/EXEC.
   * Returns null if the transaction was aborted (e.g., due to WATCH key change).
   */
  async transaction(
    commands: Array<{ cmd: string; args: (string | number)[] }>
  ): Promise<unknown[] | null> {
    const multi = this.client.multi();
    for (const { cmd, args } of commands) {
      (multi as unknown as Record<string, (...args: (string | number)[]) => void>)[cmd](...args);
    }
    try {
      const results = await multi.exec();
      if (results === null) {
        return null; // Transaction aborted
      }
      // Return just the values (exec returns [[err, result], ...])
      return results.map(([err, result]) => {
        if (err) throw err;
        return result;
      });
    } catch {
      return null;
    }
  }

  /**
   * Watch keys for optimistic locking. If any watched key changes before
   * the transaction completes, the transaction will be aborted.
   */
  async watch(...keys: string[]): Promise<void> {
    const fullKeys = keys.map(k => this.config.keyPrefix + k);
    await this.client.watch(...fullKeys);
  }

  /**
   * Unwatch all previously watched keys.
   */
  async unwatch(): Promise<void> {
    await this.client.unwatch();
  }

  /**
   * Execute an atomic hash update with optimistic locking.
   * Returns the updated data or null if the update failed due to concurrent modification.
   */
  async atomicHashUpdate(
    key: string,
    updates: Record<string, string>,
    expectedVersion?: string
  ): Promise<Record<string, string> | null> {
    const fullKey = this.config.keyPrefix + key;

    // Watch the key for changes
    await this.client.watch(fullKey);

    try {
      // Check current version if provided
      if (expectedVersion) {
        const currentVersion = await this.client.hget(fullKey, "updatedAt");
        if (currentVersion !== expectedVersion) {
          await this.client.unwatch();
          return null; // Version mismatch - concurrent modification detected
        }
      }

      // Execute the update atomically
      const multi = this.client.multi();
      for (const [field, value] of Object.entries(updates)) {
        multi.hset(fullKey, field, value);
      }

      const results = await multi.exec();
      if (results === null) {
        return null; // Transaction aborted due to watched key change
      }

      // Return the updated data
      return this.hgetall(key);
    } catch {
      await this.client.unwatch();
      return null;
    }
  }
}
