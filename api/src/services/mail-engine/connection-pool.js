'use strict';
// Parks at most one idle, authenticated IMAP session per account between
// sequential jobs so an idle account does not LOGIN for every stream slice.
// Jobs of one account are serialized by the durable account lease, and a
// checkout removes the entry, so a session is never shared by two running
// jobs. Only a job that completed unaborted may park its transport; a failed,
// aborted, cancelled or fenced job's transport is destroyed by its guard.
const crypto = require('node:crypto');
const imapClient = require('../mail-imap-client');
const { guardImapConnection, runGuardedImap, imapSessionUsable, closeImapConnection } = require('../mail-imap-guard');

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
// No command may be in flight: every command of a guarded client runs through
// runGuardedImap, so an idle guard means an idle session.
function usable(connection, now = Date.now()) {
  const owner = owners.get(connection);
  return !!owner && now - owner.createdAt < MAX_AGE_MS && imapSessionUsable(connection) && connection.idling !== true;
}
// A parked socket must not keep the process alive; a checked-out one must.
function referenceSocket(connection, ref) {
  try { connection.socket?.[ref ? 'ref' : 'unref']?.(); } catch { /* closed */ }
}
function take(key) {
  const entry = parked.get(key);
  if (!entry) return null;
  parked.delete(key);
  clearTimeout(entry.timer);
  referenceSocket(entry.connection, true);
  return entry;
}
function close(connection) { closeImapConnection(connection); }
// A NAT/provider may have silently dropped the idle session. A bounded NOOP
// is cheaper than a job failing on its first real command. ImapFlow's noop()
// does not reject on a failed NOOP, so the session state is checked after it.
function probe(connection) {
  if (typeof connection.noop !== 'function') return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => { resolve(false); close(connection); }, PROBE_MS);
    timer.unref?.();
    runGuardedImap(connection, () => connection.noop())
      .then(() => { clearTimeout(timer); resolve(imapSessionUsable(connection)); }, () => { clearTimeout(timer); resolve(false); });
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
  const raw = await (connect || imapClient.connectImap)(config);
  const connection = guardImapConnection(raw, { signal });
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
  referenceSocket(connection, false);
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
