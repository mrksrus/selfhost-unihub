'use strict';
// Regressions from a live 0.10.13 queue that stopped draining: deadlocks,
// candidate starvation, a Gmail system-folder collision and a failing
// operation that blocked every other change of its account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');
const repository = require('../src/services/mail-engine/repository');
const runtime = require('../src/services/mail-engine/runtime');
const operations = require('../src/services/mail-engine/operations');
const transport = require('../src/services/mail-engine/transport');
const writebacks = require('../src/services/mail-writebacks');
const mail = require('../src/services/mail');

const deadlock = () => Object.assign(new Error('Deadlock found when trying to get lock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 });
function pool(onExecute) {
  const calls = { begin: 0, commit: 0, rollback: 0, release: 0 };
  const cx = { execute: onExecute, beginTransaction: async () => { calls.begin++; }, commit: async () => { calls.commit++; },
    rollback: async () => { calls.rollback++; }, release() { calls.release++; } };
  return { calls, pool: { execute: onExecute, getConnection: async () => cx } };
}

test('a deadlocked transaction is rolled back and run again; other errors are not retried', async () => {
  let runs = 0;
  const { calls, pool: p } = pool(async () => [[]]);
  const result = await repository.withTransaction(async () => { if (++runs < 3) throw deadlock(); return 'done'; }, p);
  assert.equal(result, 'done');
  assert.deepEqual([runs, calls.rollback, calls.commit, calls.release], [3, 2, 1, 3]);
  let other = 0;
  await assert.rejects(repository.withTransaction(async () => { other++; throw new Error('boom'); }, p), /boom/);
  assert.equal(other, 1);
  let always = 0;
  await assert.rejects(repository.withTransaction(async () => { always++; throw deadlock(); }, p), { code: 'ER_LOCK_DEADLOCK' });
  assert.equal(always, 4, 'bounded retries');
});

test('claim candidates exclude accounts that are leased or awaiting recovery', async () => {
  let candidateSql = '';
  const { pool: p } = pool(async sql => {
    if (sql.includes('FROM mail_engine_jobs j JOIN mail_accounts a')) { candidateSql = sql; return [[]]; }
    return [[]];
  });
  assert.equal(await runtime.claimDueJob({ workerId: 'w' }, p), null);
  assert.match(candidateSql, /held\.lease_owner IS NULL/);
  assert.match(candidateSql, /held\.lease_until IS NULL OR held\.lease_until <= UTC_TIMESTAMP\(\)/);
  assert.ok(candidateSql.indexOf('held.lease_owner') < candidateSql.indexOf('LIMIT 32'), 'filtered before the candidate window');
});

test('a deadlock on one due operation does not abort the rest of the due pass', async t => {
  const old = getDb(); t.after(() => setDb(old));
  const rows = [{ id: 'op1', user_id: 'u', mail_account_id: 'a1', state: 'queued', action: 'read' },
    { id: 'op2', user_id: 'u', mail_account_id: 'a2', state: 'queued', action: 'read' }];
  setDb({ execute: async sql => {
    if (sql.includes('SELECT w.id,w.user_id,w.mail_account_id')) return [rows];
    if (sql.includes('FROM user_settings')) return [[]];
    return [[]];
  } });
  const enqueued = [];
  t.mock.method(runtime, 'enqueueJob', async job => { if (job.operationId === 'op1') throw deadlock(); enqueued.push(job.operationId); });
  const nudged = [];
  t.mock.method(mail, 'runMailOperationsNow', async id => { nudged.push(id); return true; });
  assert.equal(await writebacks.runDueWritebacks(), 2);
  assert.deepEqual(enqueued, ['op2']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(nudged, ['a2'], 'only the account whose job was enqueued is started');
});

test('a second remote mailbox for an already mapped system folder becomes its own folder instead of failing sync', async t => {
  const inserts = [];
  const executor = { execute: async (sql, args = []) => {
    if (sql.includes('FROM mail_folder_remote_boxes b') && sql.includes('JOIN mail_folders f')) return [[]]; // not mapped yet
    if (sql.startsWith('SELECT id FROM mail_folders WHERE user_id = ? AND slug = ?')) return [[{ id: 'local-sent' }]];
    if (sql.includes('SELECT folder_id FROM mail_folder_remote_boxes')) return [[]]; // PK kept the existing Sent mapping
    if (sql.includes('FROM mail_folders f') && sql.includes('display_name = ?')) return [[]];
    if (sql.startsWith('SELECT slug FROM mail_folders')) return [[{ slug: 'sent' }]]; // the local system folder
    if (sql.includes('MAX(position)')) return [[{ max_position: 100 }]];
    if (sql.startsWith('INSERT INTO mail_folders ')) inserts.push(args);
    return [{ affectedRows: 1 }];
  } };
  const registered = await mail.registerCustomImapFoldersForUser('u', 'acct', ['Sent'], executor, new Map([['Sent', 'sent']]), true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].remoteName, 'Sent');
  assert.notEqual(registered[0].slug, 'sent');
  const created = inserts.filter(args => args[5] === 'Sent');
  assert.equal(created.length, 1);
  assert.equal(created[0][3], null, 'demoted mailbox does not claim the system special-use');
});

test('a failing operation is counted, backs off, and does not block the next change of the account', async t => {
  const old = getDb(); t.after(() => setDb(old));
  const ops = [
    { id: 'bad', user_id: 'u', mail_account_id: 'acct', email_id: 'e1', action: 'read', target_value: '1', remote_folder: 'INBOX',
      remote_uid: 5, remote_uidvalidity: 9, state: 'queued', is_current: 1, dispatched: 0, attempts: 7 },
    { id: 'good', user_id: 'u', mail_account_id: 'acct', email_id: 'e2', action: 'read', target_value: '1', remote_folder: 'INBOX',
      remote_uid: 6, remote_uidvalidity: 9, state: 'queued', is_current: 1, dispatched: 0, attempts: 0 },
  ];
  const updates = [];
  const execute = async (sql, args = []) => {
    if (sql.includes('FROM user_settings') || sql.includes('backup_restore_jobs')) return [[]];
    if (sql.startsWith('SELECT * FROM mail_writebacks WHERE mail_account_id=?')) return [ops];
    if (sql.includes('SELECT * FROM mail_writebacks WHERE id=?')) return [[ops.find(op => op.id === args[0])]];
    if (sql.includes('SELECT e.generation, a.is_active')) return [[{ generation: 1, is_active: 1, sync_mode: 'sync' }]];
    if (sql.includes('SELECT observation_revision FROM emails')) return [[{ observation_revision: 1 }]];
    if (sql.startsWith('UPDATE mail_writebacks SET state=?')) updates.push({ id: args[7], state: args[0], bump: args[6] });
    return [[]];
  };
  const cx = { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  setDb({ execute, getConnection: async () => cx });
  t.mock.method(runtime, 'assertFence', async () => ({ cancellationRequested: false }));
  const applied = [];
  t.mock.method(transport, 'selectMailbox', async (_c, { folder }) => { if (applied.length === 0) { applied.push('bad'); throw new Error('[NONEXISTENT] Unknown Mailbox: ' + folder); }
    applied.push('good'); return { uidvalidity: 9, capabilities: {} }; });
  t.mock.method(transport, 'fetchMetadataWindow', async () => ({ items: [] }));
  const errors = t.mock.method(console, 'error', () => {});
  // A session that survived the refusal: guard idle and authenticated.
  const guarded = Object.assign(new (require('node:events'))(), { usable: true, isClosed: false, close() {} });
  require('../src/services/mail-imap-guard').guardImapConnection(guarded, {});
  const result = await operations.processDueOperations({ id: 'acct', user_id: 'u' }, guarded,
    { workerGeneration: 1, workerId: 'w', jobId: 'j' });
  assert.deepEqual(applied, ['bad', 'good'], 'the second change still ran on the same session');
  assert.equal(result.connectionFailed, false);
  const bad = updates.find(update => update.id === 'bad');
  assert.equal(bad.state, 'needs_attention', 'eighth failure asks for attention');
  assert.equal(bad.bump, 1, 'failure is counted');
  assert.match(String(errors.mock.calls[0].arguments[0]), /\[MAIL OPERATION\] read bad failed/);
});
