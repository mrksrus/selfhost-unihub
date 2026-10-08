import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../../types';
import imported1 = require('./repository');
const { withTransaction } = imported1;
const HOLD_REASON = 'Deployment canary hold';
const USER_PAUSES = ['Mail module disabled', 'Mail background paused'];
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function requireAccountId(value: unknown) {
  if (!uuid(value)) throw new TypeError('An exact mail-account UUID is required');
}

// Operator maintenance only: the old/new API and provider workers must be
// stopped before prepare. This does not disconnect accounts, reset jobs, or
// change any accepted operation, attempt, cursor, credential or account mode.
async function prepareRollout(pool: Pick<Pool, 'getConnection'>, canaryAccountId: string) {
  requireAccountId(canaryAccountId);
  return withTransaction(async cx => {
    const [accounts] = await cx.execute<RowDataPacket[]>('SELECT id,user_id,sync_mode FROM mail_accounts WHERE is_active = TRUE ORDER BY id FOR UPDATE');
    if (!accounts.some(a => a.id === canaryAccountId)) throw new Error('Canary must be an existing active mail account');
    if (accounts.some(a => a.sync_mode !== 'sync')) throw new Error('This staged rollout supports Sync accounts only; Download deletion workers need a separate maintenance procedure');
    const [leases] = await cx.execute<RowDataPacket[]>('SELECT mail_account_id FROM mail_engine_accounts WHERE lease_owner IS NOT NULL AND lease_until > UTC_TIMESTAMP() FOR UPDATE');
    if (leases.length) throw new Error('Provider worker leases remain active; stop and drain the workers before preparing rollout');
    const [canary] = await cx.execute<RowDataPacket[]>('SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id = ? FOR UPDATE', [canaryAccountId]);
    if (canary[0]?.paused_reason && canary[0].paused_reason !== HOLD_REASON) throw new Error('Canary has a non-rollout pause; resolve it explicitly without clearing its quarantine');
    // Module pauses are lifted by a user toggle, so the hold replaces them; the
    // module preference itself is still checked live by every worker.
    for (const account of accounts) {
      await cx.execute(`INSERT INTO mail_engine_accounts (mail_account_id,user_id,paused_reason) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE paused_reason = IF(paused_reason IS NULL OR paused_reason IN (${USER_PAUSES.map(() => '?').join(',')}),
          VALUES(paused_reason), paused_reason)`,
      [account.id, account.user_id, HOLD_REASON, ...USER_PAUSES]);
    }
    // Only our own hold is released. Recovery, restore and module pauses remain.
    await cx.execute('UPDATE mail_engine_accounts SET paused_reason = NULL WHERE mail_account_id = ? AND paused_reason = ?', [canaryAccountId, HOLD_REASON]);
    return rolloutStatus(cx);
  }, pool);
}
async function releaseRollout(pool: Pick<Pool, 'getConnection'>, accountId: string) {
  requireAccountId(accountId);
  return withTransaction(async cx => {
    const [accounts] = await cx.execute<RowDataPacket[]>('SELECT id,user_id FROM mail_accounts WHERE id = ? AND is_active = TRUE AND disconnected_at IS NULL FOR UPDATE', [accountId]);
    if (accounts.length !== 1) throw new Error('Account must remain active and connected; rollout release cannot reconnect it');
    const [held] = await cx.execute<RowDataPacket[]>('SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id = ? FOR UPDATE', [accountId]);
    if (held[0]?.paused_reason !== HOLD_REASON) throw new Error('Account does not have a deployment canary hold; refusing to clear another pause');
    await cx.execute('UPDATE mail_engine_accounts SET paused_reason = NULL WHERE mail_account_id = ? AND paused_reason = ?', [accountId, HOLD_REASON]);
    // Read streams paused while held (settings/module stops absorbed by the
    // hold) would otherwise dedupe new syncs forever. Writes stay untouched.
    await require('./runtime').resumeAccount({ userId: accounts[0].user_id, accountId, reasons: [HOLD_REASON] }, cx);
    return rolloutStatus(cx);
  }, pool);
}
async function rolloutStatus(cx: SqlExecutor) {
  const [accounts] = await cx.execute<RowDataPacket[]>(`SELECT a.id AS account_id,a.is_active,a.sync_mode,e.paused_reason,
    (e.lease_owner IS NOT NULL AND e.lease_until > UTC_TIMESTAMP()) AS worker_active
    FROM mail_accounts a LEFT JOIN mail_engine_accounts e ON e.mail_account_id = a.id ORDER BY a.id`);
  return { accounts };
}
export = { HOLD_REASON, USER_PAUSES, requireAccountId, prepareRollout, releaseRollout, rolloutStatus };
