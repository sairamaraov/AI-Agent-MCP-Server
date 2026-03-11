import { RedisAdapter } from './RedisAdapter.js';

/**
 * Create a database instance based on configuration.
 * Redis is the only supported backend.
 *
 * @param {object} config - Database-specific configuration
 * @returns {DatabaseAdapter} - Instance of selected adapter
 */
export function createDatabase(config = {}) {
  return new RedisAdapter({
    host: config.host || process.env.REDIS_HOST,
    port: config.port || process.env.REDIS_PORT,
    password: config.password || process.env.REDIS_PASSWORD,
    db: config.db || process.env.REDIS_DB,
    keyPrefix: config.keyPrefix || process.env.REDIS_PREFIX,
  });
}

export { DatabaseAdapter } from './DatabaseAdapter.js';
export { RedisAdapter } from './RedisAdapter.js';
