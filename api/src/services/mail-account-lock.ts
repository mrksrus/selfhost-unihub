// One process owns mail workers. Settings and remote deletion share this queue,
// so committing Sync mode guarantees an older deletion has finished first.
const tails = new Map<string, Promise<void>>();
async function withMailAccountLock<T>(accountId: unknown, callback: () => T | PromiseLike<T>, { wait = true } = {}) {
  const key = String(accountId || '').trim();
  if (!key) throw new Error('Account ID required');
  // HTTP actions must not join an unbounded queue behind network work. Reject
  // before adding a waiter: a rejected request must never execute later.
  if (!wait && tails.has(key)) {
    throw Object.assign(new Error('Mail account is busy syncing or applying another change. Nothing was changed; please retry.'),
      { status: 409, code: 'MAIL_ACCOUNT_BUSY' });
  }
  const previous = tails.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  tails.set(key, current);
  await previous;
  try { return await callback(); }
  finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}
export = { withMailAccountLock };
