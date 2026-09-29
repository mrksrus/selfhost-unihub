/**
 * Opt-in end-to-end mail check through the public API and an independent IMAP
 * client. Never imports application services, edits the database, or repairs
 * provider state behind the application's back. See docs/LIVE_MAIL_TESTING.md.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const require = createRequire(new URL('../api/package.json', import.meta.url));
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const env = process.env;
assert.equal(env.UNIHUB_SMOKE_CONFIRM, 'I own this test mailbox', 'Explicitly authorize a dedicated test mailbox');
for (const key of ['UNIHUB_BASE_URL', 'UNIHUB_TEST_EMAIL', 'UNIHUB_TEST_PASSWORD', 'UNIHUB_IMAP_HOST', 'UNIHUB_IMAP_USER', 'UNIHUB_IMAP_PASSWORD']) {
  assert(env[key], `${key} is required`);
}
const origin = new URL(env.UNIHUB_BASE_URL);
assert(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)), 'HTTPS is required except on loopback');
assert(!origin.username && !origin.password && !origin.search && !origin.hash, 'Use a credential-free origin URL');
assert.equal(origin.pathname, '/', 'Use the application origin, without a path');
const base = origin.origin;
const address = env.UNIHUB_TEST_EMAIL;
const subject = env.UNIHUB_SMOKE_SUBJECT || `UniHub live smoke ${crypto.randomUUID()}`;
assert.match(subject, /^UniHub live smoke [a-f0-9-]{36}$/, 'Only smoke-test subjects may be reused');
const sentinel = `UniHub authorized live mail regression: ${subject}`;
const maxAcceptanceMs = Number(env.UNIHUB_SMOKE_ACCEPT_MS || 2000);
const timeoutMs = Number(env.UNIHUB_SMOKE_TIMEOUT_MS || 180000);
assert(Number.isFinite(maxAcceptanceMs) && maxAcceptanceMs > 0 && Number.isFinite(timeoutMs) && timeoutMs > 0);
const results = [];
const cookies = new Map();
let csrf;
let phase = 'authentication';
let account;
let emailId;
let provider;
let selectedBox;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(method, path, body, accepted = [200]) {
  const start = performance.now();
  const response = await fetch(base + path, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
      ...(csrf && !['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const data = await response.json();
  assert(accepted.includes(response.status), `${method} ${path}: HTTP ${response.status}; ${String(data.error || 'Unexpected status').slice(0, 250)}`);
  if (data.csrfToken) csrf = data.csrfToken;
  return { data, ms: Math.round(performance.now() - start) };
}
function fast(result, label) {
  assert(result.ms <= maxAcceptanceMs, `${label} waited ${result.ms} ms (limit ${maxAcceptanceMs} ms); provider work must not block acceptance`);
  results.push({ check: label, acceptance_ms: result.ms });
  return result.data;
}
async function until(label, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(500);
  }
  throw new Error(`${label} did not complete within ${timeoutMs} ms`);
}
const imapCall = (method, ...args) => new Promise((resolve, reject) => {
  provider[method](...args, (error, result) => error ? reject(error) : resolve(result));
});
async function connectProvider() {
  provider = new Imap({
    user: env.UNIHUB_IMAP_USER, password: env.UNIHUB_IMAP_PASSWORD,
    host: env.UNIHUB_IMAP_HOST, port: Number(env.UNIHUB_IMAP_PORT || 993), tls: true,
    tlsOptions: { servername: env.UNIHUB_IMAP_HOST, rejectUnauthorized: true },
    connTimeout: 15000, authTimeout: 15000, socketTimeout: 30000,
  });
  await new Promise((resolve, reject) => {
    provider.once('ready', resolve);
    provider.on('error', reject);
    provider.connect();
  });
}
async function providerMessage(folder = 'INBOX', writable = false) {
  const selection = `${folder}:${writable}`;
  if (selection !== selectedBox) {
    await imapCall('openBox', folder, !writable);
    selectedBox = selection;
  }
  const uids = await imapCall('search', [['HEADER', 'SUBJECT', subject]]);
  assert(uids.length <= 1, `Duplicate smoke fixture in ${folder}; refusing ambiguous mutation`);
  if (!uids.length) return null;
  const message = await new Promise((resolve, reject) => {
    const fetcher = provider.fetch(uids, { bodies: [''], markSeen: false });
    const result = { raw: Buffer.alloc(0), flags: [], uid: uids[0] };
    fetcher.on('message', item => {
      item.on('body', stream => {
        const chunks = [];
        stream.on('data', data => chunks.push(data));
        stream.on('error', reject);
        stream.on('end', () => { result.raw = Buffer.concat(chunks); });
      });
      item.on('attributes', attributes => { result.flags = attributes.flags; });
    });
    fetcher.on('error', reject);
    fetcher.once('end', () => resolve(result));
  });
  const parsed = await simpleParser(message.raw);
  assert.equal(parsed.subject, subject);
  assert(parsed.from?.value.some(item => item.address?.toLowerCase() === address.toLowerCase()), 'Fixture sender must be the authorized test mailbox');
  assert(parsed.to?.value.some(item => item.address?.toLowerCase() === address.toLowerCase()), 'Fixture recipient must be the authorized test mailbox');
  assert(parsed.text?.includes(sentinel), 'Fixture body must match the authorized smoke message');
  return { ...message, sha256: crypto.createHash('sha256').update(message.raw).digest('hex') };
}
async function fixture() {
  const { data } = await api('GET', `/api/mail/emails?folder=all&account_id=${encodeURIComponent(account.id)}&search=${encodeURIComponent(subject)}&limit=100`);
  const rows = data.emails.filter(item => item.subject === subject && item.folder !== 'sent');
  assert(rows.length <= 1, 'Ambiguous application fixture; refusing mutation');
  if (rows.length) {
    assert.equal(rows[0].mail_account_id, account.id);
    emailId = rows[0].id;
  }
  return rows[0];
}
async function sync() {
  const accepted = fast(await api('POST', '/api/mail/sync', { account_id: account.id }, [200, 202]), 'sync request');
  assert.equal(accepted.success, true, 'Sync request must actually be accepted');
  await until('account sync', async () => {
    const { data } = await api('GET', `/api/mail/sync/status?account_id=${encodeURIComponent(account.id)}`);
    assert(data.accounts.every(item => item.account_id === account.id), 'Scoped status leaked another account');
    const state = data.accounts.find(item => item.account_id === account.id);
    assert(state, 'Account status must be returned');
    assert(!['error', 'cancelled'].includes(state.state), `Sync ${state.state}: ${state.error || ''}`);
    return state.state === 'idle';
  });
}
async function flagsMatch(read, star, folder = 'INBOX') {
  return until('provider-confirmed flags and application state', async () => {
    const remote = await providerMessage(folder);
    if (!remote || remote.flags.includes('\\Seen') !== read || remote.flags.includes('\\Flagged') !== star) return false;
    const item = await fixture();
    if (!item || item.is_read !== read || item.is_starred !== star) return false;
    if (item.read_sync_pending || item.star_sync_pending) return false;
    const { data } = await api('GET', '/api/mail/writebacks');
    const operations = data.operations.filter(op => op.email_id === emailId);
    const failed = operations.find(op => ['failed', 'conflict'].includes(op.status));
    assert(!failed, `Provider operation ${failed?.action} ${failed?.status}: ${failed?.error}`);
    // The list uses pending overlays; provider equality alone can coincide with
    // the target while no application write ever completed (or no queue exists).
    if (!['read', 'star'].every(action => operations.some(op => op.action === action && op.status === 'done'))) return false;
    return operations.every(op => op.status === 'done');
  });
}
async function putFlag(kind, value) {
  const accepted = fast(await api('PUT', `/api/mail/emails/${emailId}/${kind}`, { [kind === 'read' ? 'is_read' : 'is_starred']: value }), `${kind}=${value}`);
  assert.equal(accepted.sync_pending, true, `${kind}=${value} must queue a provider write, not only change local state`);
  return accepted;
}
async function move(folder) {
  const accepted = fast(await api('POST', '/api/mail/emails/bulk-move', { email_ids: [emailId], folder }), `move to ${folder}`);
  assert.equal(accepted.sync_pending, true, `move to ${folder} must queue a provider write`);
  return accepted;
}
async function moveDone(previousId = null) {
  return until('durable provider move completion', async () => {
    const { data } = await api('GET', '/api/mail/writebacks');
    const moveOp = data.operations.find(op => op.email_id === emailId && op.action === 'move');
    if (!moveOp || moveOp.id === previousId) return false;
    assert(!['failed', 'conflict'].includes(moveOp.status), `Move ${moveOp.status}: ${moveOp.error}`);
    return moveOp.status === 'done' ? moveOp.id : false;
  });
}

try {
  const login = await api('POST', '/api/auth/signin', { email: address, password: env.UNIHUB_TEST_PASSWORD });
  assert.equal(login.data.user.email.toLowerCase(), address.toLowerCase());
  assert.equal(login.data.user.role, 'user', 'Use a regular dedicated test user, never the administrator');
  const { data: accounts } = await api('GET', '/api/mail/accounts');
  const matches = accounts.accounts.filter(item => item.email_address.toLowerCase() === address.toLowerCase()
    && (!env.UNIHUB_TEST_ACCOUNT_ID || item.id === env.UNIHUB_TEST_ACCOUNT_ID));
  assert.equal(matches.length, 1, 'Exactly one owned test account must match');
  account = matches[0];
  assert.equal(account.sync_mode, 'sync', 'Two-way sync mode is required');
  assert.equal(account.imap_host, env.UNIHUB_IMAP_HOST);
  assert.equal(account.username || account.email_address, env.UNIHUB_IMAP_USER);
  await connectProvider();
  phase = 'send-and-receive';
  if (!env.UNIHUB_SMOKE_SUBJECT) {
    await api('POST', '/api/mail/send', { account_id: account.id, to: address, subject, body: sentinel, isHtml: false });
  }
  const original = await until('SMTP delivery', () => providerMessage());
  assert(!original.flags.includes('\\Seen') && !original.flags.includes('\\Flagged'), 'New fixture must start unread and unstarred to exercise both provider writes');
  await sync();
  await until('message imported with content', async () => {
    if (!await fixture()) return false;
    const { data } = await api('GET', `/api/mail/emails/${emailId}`);
    assert((data.email.body_text || data.email.body_html || '').includes(sentinel), 'Incoming body must be preserved');
    return true;
  });
  results.push({ check: phase, passed: true });

  phase = 'nonblocking-flags-during-sync';
  const parallelSync = fast(await api('POST', '/api/mail/sync', { account_id: account.id }, [200, 202]), 'parallel sync request');
  assert.equal(parallelSync.success, true, 'Parallel sync request must be accepted');
  await Promise.all([putFlag('read', true), putFlag('star', true), api('GET', '/api/mail/accounts').then(result => fast(result, 'account list during sync'))]);
  await flagsMatch(true, true);
  results.push({ check: phase, passed: true });

  phase = 'rapid-opposite-intents';
  await putFlag('read', false);
  await putFlag('read', true);
  await putFlag('read', false);
  await putFlag('star', false);
  await flagsMatch(false, false);
  await sync();
  await flagsMatch(false, false);
  results.push({ check: phase, passed: true });

  phase = 'inbound-external-client-change';
  const external = await providerMessage('INBOX', true);
  // This deliberately simulates another mail client, AFTER outbound writes
  // passed independent readback. It is not used to make a failed app write pass.
  await imapCall('addFlags', external.uid, '\\Flagged');
  await sync();
  await flagsMatch(false, true);
  await putFlag('star', false);
  await flagsMatch(false, false);
  results.push({ check: phase, passed: true });

  phase = 'move-and-restore';
  const displayName = 'UniHub Live Smoke';
  let { data: folders } = await api('GET', `/api/mail/folders?account_id=${encodeURIComponent(account.id)}`);
  let target = folders.folders.find(item => item.display_name === displayName && item.mail_account_id === account.id);
  if (!target) {
    await api('POST', '/api/mail/folders', { mail_account_id: account.id, display_name: displayName });
    ({ data: folders } = await api('GET', `/api/mail/folders?account_id=${encodeURIComponent(account.id)}`));
    target = folders.folders.find(item => item.display_name === displayName && item.mail_account_id === account.id);
  }
  assert(target, 'Created folder must be visible for the correct account');
  await move(target.slug);
  await until('provider move to dedicated folder', async () => {
    const destination = await providerMessage(displayName);
    if (!destination) return false;
    assert.equal(destination.sha256, original.sha256, 'Move must preserve exact message bytes');
    return !await providerMessage('INBOX') && (await fixture())?.folder === target.slug;
  });
  const outboundMoveId = await moveDone();
  await flagsMatch(false, false, displayName);
  await move('inbox');
  await until('provider move back to Inbox', async () => {
    const destination = await providerMessage('INBOX');
    if (!destination) return false;
    assert.equal(destination.sha256, original.sha256, 'Restored message must preserve exact bytes');
    return !await providerMessage(displayName) && (await fixture())?.folder === 'inbox';
  });
  await moveDone(outboundMoveId);
  await flagsMatch(false, false);
  results.push({ check: phase, passed: true });
  phase = 'complete';
} catch (error) {
  results.push({ check: phase, passed: false, error: error.message });
  process.exitCode = 1;
} finally {
  provider?.end();
  const report = { passed: phase === 'complete', base, account_id: account?.id, email_id: emailId, subject, phase, results };
  if (env.UNIHUB_SMOKE_REPORT) await writeFile(env.UNIHUB_SMOKE_REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
