// Separate short network budgets from account budgets. Successful logins do
// not reset either: authenticating one account must not erase another's limits.
function createLoginLimiter({ now = Date.now, maxEntries = 20000 } = {}) {
  const entries = new Map();
  let nextCleanup = 0;
  function consume(scope, identity, limit, windowMs) {
    const time = now();
    if (time >= nextCleanup) {
      for (const [key, entry] of entries) if (entry.until <= time) entries.delete(key);
      nextCleanup = time + 60000;
    }
    const key = `${scope}:${identity}`;
    let entry = entries.get(key);
    if (!entry || entry.until <= time) {
      // Do not evict active counters under pressure, which would reset limits.
      if (!entry && entries.size >= maxEntries) return 60;
      entry = { count: 0, until: time + windowMs };
      entries.set(key, entry);
    }
    if (entry.count >= limit) return Math.max(1, Math.ceil((entry.until - time) / 1000));
    entry.count++;
    return null;
  }
  return { consume };
}

const limiter = createLoginLimiter();
function consumeAuthAttempt(scope, identity) {
  const budgets = {
    ip: [60, 60000],
    signup: [10, 3600000],
    password: [10, 600000],
    secondFactor: [10, 600000],
  };
  const budget = budgets[scope];
  if (!budget) throw new Error('Unknown authentication rate limit');
  return limiter.consume(scope, String(identity), ...budget);
}

module.exports = { createLoginLimiter, consumeAuthAttempt };
