type AuthAttemptScope = 'ip' | 'signup' | 'password' | 'secondFactor';

// Separate short network budgets from account budgets. Successful logins do
// not reset either: authenticating one account must not erase another's limits.
function createLoginLimiter({ now = Date.now, maxEntries = 20000 } = {}) {
  const entries = new Map<string, { count: number; until: number }>();
  let nextCleanup = 0;
  function consume(scope: string, identity: string, limit: number, windowMs: number): number | null {
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
  // Gives back an attempt that consume() spent, for a check that turned out
  // not to be a guess (a right password).
  function refund(scope: string, identity: string) {
    const entry = entries.get(`${scope}:${identity}`);
    if (entry && entry.until > now() && entry.count > 0) entry.count--;
  }
  return { consume, refund };
}

const limiter = createLoginLimiter();
function consumeAuthAttempt(scope: AuthAttemptScope, identity: unknown) {
  const budgets: Record<AuthAttemptScope, [number, number]> = {
    ip: [60, 60000],
    signup: [10, 3600000],
    password: [10, 600000],
    secondFactor: [10, 600000],
  };
  const budget = budgets[scope];
  if (!budget) throw new Error('Unknown authentication rate limit');
  return limiter.consume(scope, String(identity), ...budget);
}

// An admin confirming an action with their password has a budget of its own,
// so failed sign-ins cannot lock them out of admin actions or the other way
// round. Each confirmation reserves an attempt before anything is awaited, so
// a burst of parallel requests gets no more than the budget; a right password
// gives its attempt back, so only wrong passwords use it up.
const REAUTH_BUDGET: [number, number] = [10, 600000];
function reserveReauth(userId: string) {
  return limiter.consume('reauth', userId, ...REAUTH_BUDGET);
}
function refundReauth(userId: string) {
  limiter.refund('reauth', userId);
}

export { createLoginLimiter, consumeAuthAttempt, reserveReauth, refundReauth };
