import Redis from 'ioredis';
import { DatabaseAdapter } from './DatabaseAdapter.js';
import { EventEmitter } from 'events';

/**
 * RedisAdapter - Redis implementation of DatabaseAdapter
 * Wraps ioredis client with DatabaseAdapter interface
 */
export class RedisAdapter extends DatabaseAdapter {
  constructor(config = {}) {
    super();
    this.config = {
      host: config.host || process.env.REDIS_HOST || 'localhost',
      port: config.port || parseInt(process.env.REDIS_PORT || '6379'),
      password: config.password || process.env.REDIS_PASSWORD,
      db: config.db || parseInt(process.env.REDIS_DB || '0'),
      keyPrefix: config.keyPrefix || process.env.REDIS_PREFIX || 'agent-team:',
    };

    this.client = null;
    this.pubsub = null;
    this.subscriptions = new Map();
    this.eventEmitter = new EventEmitter();
  }

  async connect() {
    this.client = new Redis({
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      db: this.config.db,
      keyPrefix: this.config.keyPrefix,
    });

    this.pubsub = new Redis({
      host: this.config.host,
      port: this.config.port,
      password: this.config.password,
      db: this.config.db,
    });

    await this.client.ping();
  }

  async disconnect() {
    if (this.client) await this.client.quit();
    if (this.pubsub) await this.pubsub.quit();
  }

  async isConnected() {
    return this.client && this.client.status === 'ready';
  }

  // String operations
  async set(key, value, ttl = null) {
    if (ttl) {
      await this.client.setex(key, ttl, JSON.stringify(value));
    } else {
      await this.client.set(key, JSON.stringify(value));
    }
  }

  async get(key) {
    const value = await this.client.get(key);
    return value ? JSON.parse(value) : null;
  }

  async del(...keys) {
    return await this.client.del(...keys);
  }

  async exists(key) {
    return (await this.client.exists(key)) === 1;
  }

  async type(key) {
    return await this.client.type(key);
  }

  // Hash operations
  async hset(hash, field, value) {
    return await this.client.hset(hash, field, JSON.stringify(value));
  }

  async hget(hash, field) {
    const value = await this.client.hget(hash, field);
    return value ? JSON.parse(value) : null;
  }

  async hgetall(hash) {
    const data = await this.client.hgetall(hash);
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    }
    return result;
  }

  async hdel(hash, ...fields) {
    return await this.client.hdel(hash, ...fields);
  }

  async hexists(hash, field) {
    return (await this.client.hexists(hash, field)) === 1;
  }

  // Set operations
  async sadd(set, ...members) {
    return await this.client.sadd(set, ...members);
  }

  async smembers(set) {
    return await this.client.smembers(set);
  }

  async scard(set) {
    return await this.client.scard(set);
  }

  async sismember(set, member) {
    return (await this.client.sismember(set, member)) === 1;
  }

  async srem(set, ...members) {
    return await this.client.srem(set, ...members);
  }

  // List operations
  async lpush(list, ...values) {
    return await this.client.lpush(list, ...values);
  }

  async rpush(list, ...values) {
    return await this.client.rpush(list, ...values);
  }

  async lpop(list, count = 1) {
    return await this.client.lpop(list, count);
  }

  async rpop(list, count = 1) {
    return await this.client.rpop(list, count);
  }

  async lrange(list, start, stop) {
    return await this.client.lrange(list, start, stop);
  }

  async llen(list) {
    return await this.client.llen(list);
  }

  async lindex(list, index) {
    return await this.client.lindex(list, index);
  }

  // TTL operations
  async setex(key, seconds, value) {
    await this.client.setex(key, seconds, JSON.stringify(value));
  }

  async ttl(key) {
    return await this.client.ttl(key);
  }

  async expire(key, seconds) {
    return (await this.client.expire(key, seconds)) === 1;
  }

  // Pub/Sub operations
  async subscribe(channel, callback) {
    const fullChannel = this.config.keyPrefix + channel;
    if (!this.subscriptions.has(fullChannel)) {
      await this.pubsub.subscribe(fullChannel);
      this.pubsub.on('message', (ch, message) => {
        if (ch === fullChannel) {
          try {
            const data = JSON.parse(message);
            callback(data);
          } catch {
            callback(message);
          }
        }
      });
      this.subscriptions.set(fullChannel, callback);
    }
  }

  async psubscribe(pattern, callback) {
    const fullPattern = this.config.keyPrefix + pattern;
    if (!this.subscriptions.has(fullPattern)) {
      await this.pubsub.psubscribe(fullPattern);
      this.pubsub.on('pmessage', (pat, channel, message) => {
        if (pat === fullPattern) {
          try {
            const data = JSON.parse(message);
            callback(data, channel.replace(this.config.keyPrefix, ''));
          } catch {
            callback(message, channel.replace(this.config.keyPrefix, ''));
          }
        }
      });
      this.subscriptions.set(fullPattern, callback);
    }
  }

  async publish(channel, message) {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    return await this.pubsub.publish(channel, payload);
  }

  async unsubscribe(channel) {
    if (this.subscriptions.has(channel)) {
      await this.pubsub.unsubscribe(channel);
      this.subscriptions.delete(channel);
    }
  }

  // Transaction operations (not critical for dashboard)
  async multi() {
    return this.client.multi();
  }

  async exec() {
    return await this.client.exec();
  }

  async discard() {
    return await this.client.discard();
  }
}
