const crypto = require('node:crypto');

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);
const DEFAULT_LIMIT = Number(process.env.RATE_LIMIT_DEFAULT || 120);
const ADMIN_LIMIT = Number(process.env.RATE_LIMIT_ADMIN || 600);
const HEALTH_LIMIT = Number(process.env.RATE_LIMIT_HEALTH || 600);

const buckets = new Map();

function keyFor(role, path) {
  return role + '|' + path;
}

function take({ role, path, limit }) {
  const k = keyFor(role || 'public', path);
  const now = Date.now();
  let bucket = buckets.get(k);
  if (!bucket || now - bucket.start >= WINDOW_MS) {
    bucket = { start: now, count: 0 };
    buckets.set(k, bucket);
  }
  bucket.count++;
  const max = limit || (role === 'admin' ? ADMIN_LIMIT : (path === '/api/health' ? HEALTH_LIMIT : DEFAULT_LIMIT));
  return { allowed: bucket.count <= max, count: bucket.count, limit: max, resetMs: WINDOW_MS - (now - bucket.start) };
}

function purgeExpired() {
  const now = Date.now();
  for (const [k, bucket] of buckets.entries()) {
    if (now - bucket.start >= WINDOW_MS * 2) buckets.delete(k);
  }
}

setInterval(purgeExpired, WINDOW_MS).unref();

module.exports = { take, purgeExpired };
