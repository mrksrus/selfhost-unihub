// One process owns mail workers. Settings and remote deletion share this queue,
// so committing Sync mode guarantees an older deletion has finished first.
const tails = new Map();
async function withMailAccountLock(accountId, callback, { wait = true } = {}) {
  const key = String(accountId || '').trim();
  if (!key) throw new Error('Account ID required');
  // HTTP actions must not join an unbounded queue behind network work. Reject
  // before adding a waiter: a rejected request must never execute later.
  if (!wait && tails.has(key)) {
    throw Object.assign(new Error('Mail account is busy syncing or applying another change. Nothing was changed; please retry.'),
      { status: 409, code: 'MAIL_ACCOUNT_BUSY' });
  }
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
// Short DB ownership critical sections only: callback may perform SQL but must
// not wait on IMAP. This fence blocks stale commits; it cannot fence the server.
async function withFencedMailAccountLock({ userId, accountId, workerId, leaseSeconds = 30 }, callback, executor) {
  const { db } = require('../state');
  const { withTransaction, ownAccount } = require('./mail-engine/repository');
  const pool = executor || db;
  if (typeof callback !== 'function' || !workerId || !Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 3600) {
    throw new TypeError('Invalid fenced mail lock');
  }
  return withTransaction(async cx => {
    await ownAccount(cx, userId, accountId, true);
    await cx.execute(`INSERT INTO mail_engine_accounts (mail_account_id,user_id) VALUES (?,?)
      ON DUPLICATE KEY UPDATE mail_account_id = mail_account_id`, [accountId, userId]);
    const [[row]] = await cx.execute('SELECT * FROM mail_engine_accounts WHERE mail_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
    if (row.paused_reason || (row.lease_owner && row.lease_until && new Date(row.lease_until).getTime() > Date.now())) {
      throw Object.assign(new Error('Account engine is busy or paused'), { code: 'MAIL_ACCOUNT_BUSY', status: 409 });
    }
    const generation = Number(row.generation) + 1;
    if (!Number.isSafeInteger(generation)) throw new RangeError('Generation exhausted');
    await cx.execute(`UPDATE mail_engine_accounts SET generation = ?, lease_owner = ?,
      lease_until = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND) WHERE mail_account_id = ? AND user_id = ?`,
    [generation, workerId, leaseSeconds, accountId, userId]);
    // The callback's writes commit atomically with acquisition. No provider
    // dispatch or slow task is permitted inside this transaction.
    const result = await callback(cx, { workerId, generation, accountId });
    await cx.execute('UPDATE mail_engine_accounts SET lease_owner = NULL, lease_until = NULL WHERE mail_account_id = ? AND generation = ? AND lease_owner = ?',
      [accountId, generation, workerId]);
    return result;
  }, pool);
}
module.exports = { withMailAccountLock, withFencedMailAccountLock };
