'use strict';
// Parks at most one idle, authenticated IMAP session per account between
// sequential jobs so an idle account does not LOGIN for every stream slice.
// Jobs of one account are serialized by the durable account lease, and a
// checkout removes the entry, so a session is never shared by two running
// jobs. Only a job that completed unaborted may park its transport; a failed,
// aborted, cancelled or fenced job's transport is destroyed by its guard.
const crypto = require('node:crypto');
const { guardImapConnection, runGuardedImap, imapGuardIdle } = require('../mail-imap-guard');

const IDLE_MS = 90 * 1000;
const MAX_AGE_MS = 30 * 60 * 1000;
const PROBE_MS = 5000;
const parked = new Map();
const owners = new WeakMap();
const stats = { connects: 0, reuses: 0 };

// Any credential, host or TLS trust change must never reuse an old session.
function fingerprint(account) {
  return crypto.createHash('sha256').update(JSON.stringify([String(account.imap_host || '').trim().toLowerCase(),
    String(account.imap_port || 993), account.username || account.email_address || null, account.encrypted_password || null,
    String(account.allow_self_signed ?? ''), account.trusted_imap_fingerprint256 || null])).digest('hex');
}
function usable(connection, now = Date.now()) {
  const owner = owners.get(connection), imap = connection?.imap;
  return !!owner && now - owner.createdAt < MAX_AGE_MS && imapGuardIdle(connection) && imap?.state === 'authenticated'
    && !imap._queue?.length && (!imap._curReq || imap._curReq.type === 'IDLE');
}
function take(key) {
  const entry = parked.get(key);
  if (!entry) return null;
  parked.delete(key);
  clearTimeout(entry.timer);
  try { entry.connection.imap?._sock?.ref?.(); } catch { /* closed */ }
  return entry;
}
function close(connection) { try { connection.end(); } catch { /* already closed */ } }
// A NAT/provider may have silently dropped the idle session. A bounded NOOP
// is cheaper than a job failing on its first real command.
function probe(connection) {
  if (typeof connection.imap?._enqueue !== 'function') return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => { resolve(false); close(connection); }, PROBE_MS);
    timer.unref?.();
    runGuardedImap(connection, done => connection.imap._enqueue('NOOP', done))
      .then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(false); });
  });
}
async function acquireImapConnection(account, config, { signal, connect } = {}) {
  const key = String(account.id), print = fingerprint(account), entry = take(key);
  if (entry) {
    if (entry.fingerprint === print && usable(entry.connection)) {
      guardImapConnection(entry.connection, { signal });
      if (await probe(entry.connection) && usable(entry.connection)) { stats.reuses++; return entry.connection; }
    }
    close(entry.connection);
  }
  const raw = await (connect || require('imap-simple').connect)(config);
  const connection = guardImapConnection(raw, { signal });
  connection.on('error', () => {});
  owners.set(connection, { key, fingerprint: print, createdAt: Date.now() });
  stats.connects++;
  return connection;
}
// The released transport stays bound to its finished job's signal: a late
// abort of that job (lost fence at completion, shutdown) destroys it in place.
function releaseImapConnection(connection, { reusable = false } = {}) {
  const owner = owners.get(connection), now = Date.now();
  if (!reusable || !usable(connection, now)) { close(connection); return false; }
  const prior = take(owner.key);
  if (prior && prior.connection !== connection) close(prior.connection);
  const entry = { connection, fingerprint: owner.fingerprint };
  entry.timer = setTimeout(() => { if (parked.get(owner.key) === entry) close(take(owner.key).connection); },
    Math.max(1, Math.min(IDLE_MS, MAX_AGE_MS - (now - owner.createdAt))));
  entry.timer.unref?.();
  try { connection.imap?._sock?.unref?.(); } catch { /* closed */ }
  parked.set(owner.key, entry);
  return true;
}
function evictImapConnections(accountId = null) {
  for (const key of accountId == null ? [...parked.keys()] : [String(accountId)]) {
    const entry = take(key);
    if (entry) close(entry.connection);
  }
}
module.exports = { acquireImapConnection, releaseImapConnection, evictImapConnections, fingerprint,
  IDLE_MS, MAX_AGE_MS, stats, parkedCount: () => parked.size };
