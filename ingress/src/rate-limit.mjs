export function createRateLimiter({ window_ms, max }) {
  const buckets = new Map();

  return function allow(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= window_ms) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) return false;
    // opportunistic cleanup
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) {
        if (now - v.start >= window_ms) buckets.delete(k);
      }
    }
    return true;
  };
}
