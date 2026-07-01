/**
 * Simple in-memory fixed-window rate limiter for login attempts. Keyed by a
 * string (e.g. ip+email). Not distributed — fine for a single-instance,
 * single-tenant deployment.
 */
const buckets = new Map();

export function tooManyAttempts(key, { max = 8, windowMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  b.count += 1;
  return b.count > max;
}

export function clearAttempts(key) {
  buckets.delete(key);
}

// Avoid unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60 * 1000).unref?.();
