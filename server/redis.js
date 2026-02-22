/**
 * Optional Redis-backed cache. If REDIS_URL is set, use Redis (shared across instances).
 * Otherwise use an in-memory Map so the app runs without Redis.
 */
const REDIS_URL = process.env.REDIS_URL;
let client = null;
const memory = new Map();

function isAvailable() {
  return !!client;
}

async function init() {
  if (!REDIS_URL) return;
  try {
    const Redis = require('ioredis');
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      }
    });
    client.on('error', (err) => console.error('Redis:', err.message || err));
    await client.ping();
    console.log('Redis connected.');
  } catch (err) {
    console.error('Redis connection failed:', err.message || err);
    client = null;
  }
}

async function get(key) {
  if (client) {
    try {
      const raw = await client.get(key);
      return raw != null ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }
  const entry = memory.get(key);
  return entry && entry.expires > Date.now() ? entry.value : null;
}

/** ttlMs: optional TTL in milliseconds. */
async function set(key, value, ttlMs) {
  const payload = JSON.stringify(value);
  if (client) {
    try {
      if (ttlMs > 0) await client.set(key, payload, 'PX', ttlMs);
      else await client.set(key, payload);
    } catch (err) {
      console.error('Redis set:', err.message || err);
    }
    return;
  }
  memory.set(key, {
    value,
    expires: ttlMs > 0 ? Date.now() + ttlMs : Number.MAX_SAFE_INTEGER
  });
}

async function del(key) {
  if (client) {
    try {
      await client.del(key);
    } catch (err) {
      console.error('Redis del:', err.message || err);
    }
    return;
  }
  memory.delete(key);
}

module.exports = {
  init,
  isAvailable,
  get,
  set,
  del
};
