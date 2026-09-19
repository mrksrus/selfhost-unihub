// One process owns mail workers. Settings and remote deletion share this queue,
// so committing Sync mode guarantees an older deletion has finished first.
const tails = new Map();
async function withMailAccountLock(accountId, callback) {
  const key = String(accountId || '').trim();
  if (!key) throw new Error('Account ID required');
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  tails.set(key, current);
  await previous;
  try { return await callback(); }
  finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}
module.exports = { withMailAccountLock };
