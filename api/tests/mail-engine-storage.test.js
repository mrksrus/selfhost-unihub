'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertUid32, assertDecimal64 } = require('../src/services/mail-engine/repository-identity');
const schema = require('../src/services/mail-engine/schema');
const repo = require('../src/services/mail-engine/repository');
const runtime = require('../src/services/mail-engine/runtime');
const { createDurableMailScheduler } = require('../src/services/mail-sync-scheduler');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('protocol IDs, decimal precision and boolean wire values are strict', () => {
  assert.equal(assertUid32('4294967295'), 4294967295);
  assert.equal(assertDecimal64('18446744073709551615'), '18446744073709551615');
  for (const value of [0, '0', -1, '4294967296', '1e3', 1.5, Number.MAX_SAFE_INTEGER + 2, '01']) {
    assert.throws(() => assertUid32(value));
  }
  assert.throws(() => assertDecimal64(18446744073709551615n + 1n));
});

test('DDL groups expensive email/account ALTERs and drops unique writeback index', async () => {
  const calls = [];
  let legacyCollation = 'utf8mb4_bin';
  const db = { async execute(sql, params) {
    calls.push(sql);
    if (sql.startsWith('SHOW FULL COLUMNS')) return [[{ Field: 'remote_name', Collation: legacyCollation }]];
    if (sql.startsWith('ALTER TABLE mail_folder_remote_boxes')) legacyCollation = 'utf8mb4_0900_bin';
    if (sql.startsWith('SHOW COLUMNS')) return [[]];
    if (sql.startsWith('SHOW INDEX')) return [params[0] === 'uq_mail_writeback' ? [{ Key_name: 'uq_mail_writeback' }] : []];
    return [{ affectedRows: 0 }];
  } };
  await schema.migrateMailEngineSchema(db);
  const alters = calls.filter(sql => sql.startsWith('ALTER TABLE `emails`'));
  assert.equal(alters.length, 1);
  for (const field of ['observation_revision','observed_modseq','raw_format','raw_bytes','raw_verified','content_state']) assert.match(alters[0], new RegExp(field));
  assert(calls.some(sql => sql.includes('DROP INDEX uq_mail_writeback')));
  assert(calls.some(sql => sql.includes('utf8mb4_0900_bin')));
  assert.equal(calls.filter(sql => sql.startsWith('ALTER TABLE mail_folder_remote_boxes')).length, 1);
  await schema.migrateMailEngineSchema(db);
  assert.equal(calls.filter(sql => sql.startsWith('ALTER TABLE mail_folder_remote_boxes')).length, 1,
    'legacy mailbox collation upgrade is resumable and runs only when required');
  for (const table of ['mail_remote_mailboxes','mail_remote_occurrences','mail_engine_cursors','mail_engine_jobs','mail_engine_accounts','mail_operation_attempts','mail_command_receipts','mail_engine_quarantine','mail_engine_migration_progress']) {
    assert(calls.some(sql => sql.includes(`CREATE TABLE IF NOT EXISTS ${table} (`)), `missing ${table}`);
  }
  assert(!calls.some(sql => /^DROP TABLE|^DELETE FROM emails|^DELETE FROM mail_writebacks/.test(sql)));
});

test('legacy backfill is restart-safe and quarantines duplicate and changed epochs without altering original emails', async () => {
  const email = (id, uid, extra = {}) => ({ id, user_id: 'u', mail_account_id: 'a', remote_folder: 'INBOX', remote_uid: uid,
    remote_uidvalidity: 9, source_folder: 'INBOX', imap_uid: uid, imap_uidvalidity: 9,
    remote_missing: 0, is_draft: 0, is_legacy: 0, is_read: 1, is_starred: 1, sync_mode: 'sync', ...extra });
  const emails = [email('a1', 10), email('a2', 10), email('a3', 11, { remote_uidvalidity: 10 }),
    email('a4', 12, { remote_missing: 1 }), email('a5', null, { remote_folder: null, remote_uidvalidity: null, source_folder: 'INBOX', imap_uid: 13 }),
    email('a6', 14, { remote_uidvalidity: 0 })];
  const writes = [
    { id: 'w1', user_id: 'u', mail_account_id: 'a', email_id: 'a1', action: 'read', status: 'done', dispatched: 1, remote_folder: 'INBOX', remote_uid: 10, remote_uidvalidity: 9, state: null },
    { id: 'w2', user_id: 'u', mail_account_id: 'a', email_id: 'a1', action: 'move', status: 'conflict', dispatched: 1, remote_folder: 'INBOX', remote_uid: 10, remote_uidvalidity: 9, state: null },
    { id: 'w3', user_id: 'u', mail_account_id: 'a', email_id: 'a1', action: 'star', status: 'failed', dispatched: 0, remote_folder: 'INBOX', remote_uid: 10, remote_uidvalidity: 9, state: null },
    { id: 'w4', user_id: 'u', mail_account_id: 'a', email_id: 'a1', action: 'read', status: 'pending', dispatched: 0, remote_folder: 'INBOX', remote_uid: 10, remote_uidvalidity: 9, state: null },
    { id: 'w5', user_id: 'u', mail_account_id: 'a', email_id: 'a1', action: 'move', status: 'pending', dispatched: 0, remote_folder: 'INBOX', remote_uid: 10, remote_uidvalidity: 0, state: null },
  ];
  const progress = new Map(), occurrences = new Map(), quarantine = new Map(), queries = [];
  let box = null, commits = 0;
  const db = { async beginTransaction() {}, async commit() { commits++; }, async rollback() { throw new Error('unexpected rollback'); },
    async execute(sql, args = []) {
      queries.push({ sql, args });
      if (sql.startsWith('INSERT IGNORE INTO mail_engine_migration_progress')) { if (!progress.has(args[0])) progress.set(args[0], ''); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('SELECT last_id FROM mail_engine_migration_progress')) return [[{ last_id: progress.get(args[0]) }]];
      if (sql.includes('FROM emails e JOIN mail_accounts')) return [emails.filter(row => row.id > args[0]).slice(0, args[1])];
      if (sql.includes('FROM mail_writebacks WHERE id >')) return [writes.filter(row => row.id > args[0]).slice(0, args[1])];
      if (sql.startsWith('UPDATE mail_engine_migration_progress')) { progress.set(args[2], args[0]); return [{ affectedRows: 1 }]; }
      if (sql.includes('SELECT id FROM mail_accounts WHERE')) return [[{ id: 'a' }]];
      if (sql.includes('SELECT * FROM mail_remote_mailboxes WHERE mail_account_id')) return [box ? [{ ...box }] : []];
      if (sql.startsWith('INSERT INTO mail_remote_mailboxes')) { box = { id: args[0], user_id: args[1], mail_account_id: args[2], remote_name: args[3], uidvalidity: args[4], state: 'active' }; return [{ affectedRows: 1 }]; }
      if (sql.includes('SELECT * FROM mail_remote_mailboxes WHERE id')) return [[{ ...box }]];
      if (sql.startsWith('SELECT id,email_id FROM mail_remote_occurrences')) {
        const occ = occurrences.get(`${args[1]}:${args[2]}`); return [occ ? [{ ...occ }] : []];
      }
      if (sql.startsWith('INSERT INTO mail_remote_occurrences')) { occurrences.set(`${args[4]}:${args[5]}`, { id: args[0], email_id: args[6], flags: JSON.parse(args[7]), presence: 'present' }); return [{ affectedRows: 1 }]; }
      if (sql.includes('UPDATE mail_remote_occurrences SET presence')) {
        for (const item of occurrences.values()) item.presence = 'quarantined'; return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE mail_remote_mailboxes SET state = 'quarantined'")) { box.state = 'quarantined'; return [{ affectedRows: 1 }]; }
      if (sql.startsWith('INSERT INTO mail_engine_quarantine')) { quarantine.set(`${args[0]}:${args[1]}:${args[4]}`, args); return [{ affectedRows: 1 }]; }
      if (sql.startsWith('UPDATE mail_writebacks SET state')) { const row = writes.find(row => row.id === args.at(-1)); row.state = args[0]; row.is_current = args[1]; return [{ affectedRows: 1 }]; }
      throw new Error(`Unexpected SQL: ${sql}`);
    } };
  await schema.backfillMailEngine(db, { batchSize: 2 });
  assert.equal(progress.get('emails'), 'a6'); assert.equal(progress.get('mail_writebacks'), 'w5');
  assert.deepEqual(writes.map(({ id,state,is_current }) => [id,state,is_current]), [
    ['w1','confirmed',0], ['w2','reconciling',1], ['w3','needs_attention',1], ['w4','queued',1], ['w5','needs_attention',1] ]);
  assert.deepEqual(occurrences.get('9:10').flags, ['\\Seen','\\Flagged']);
  assert.equal(occurrences.get('9:10').presence, 'quarantined');
  assert.equal(box.state, 'quarantined');
  assert(quarantine.has('emails:a1:duplicate_remote_tuple') && quarantine.has('emails:a2:duplicate_remote_tuple'));
  assert(quarantine.has('emails:a3:stale_epoch') && quarantine.has('emails:a6:invalid_remote_tuple'));
  assert(quarantine.has('mail_writebacks:w5:invalid_source_tuple'));
  assert(!queries.some(({ sql }) => sql.startsWith('UPDATE emails') || sql.startsWith('DELETE FROM mail_writebacks')));
  const count = commits;
  await schema.backfillMailEngine(db, { batchSize: 2 });
  assert.equal(commits, count + 2, 'rerun only checks empty batches; IDs unchanged');
});

test('repository refuses incomplete coverage, stale epoch and unrelated-owner occurrence', async () => {
  const calls = [];
  const cx = { async execute(sql, args) {
    calls.push({ sql, args });
    if (sql.includes('FROM mail_remote_mailboxes WHERE id')) return [[{ id: 'm', user_id: 'u', mail_account_id: 'a', uidvalidity: 9, state: 'active' }]];
    if (sql.includes('FROM mail_engine_cursors WHERE mailbox_id')) return [[]];
    if (sql.startsWith('INSERT INTO mail_engine_cursors')) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT c.* FROM mail_engine_cursors')) return [[{ covered_through: 20 }]];
    if (sql.startsWith('UPDATE mail_remote_occurrences')) return [{ affectedRows: 1 }];
    if (sql.startsWith('SELECT o.* FROM mail_remote_occurrences')) return [[]];
    throw new Error(sql);
  } };
  const base = { userId: 'u', accountId: 'a', mailboxId: 'm', epoch: 9, stream: 'recent', windowStart: 11, windowEnd: 20, coveredThrough: 20 };
  await assert.rejects(repo.saveCursor({ ...base, complete: false }, cx), { code: 'INCOMPLETE_COVERAGE' });
  await assert.rejects(repo.saveCursor({ ...base, windowEnd: 50000 }, cx), RangeError);
  await assert.rejects(repo.saveCursor({ ...base, epoch: 10 }, cx), { code: 'MAIL_EPOCH_STALE' });
  await repo.saveCursor(base, cx);
  assert(calls.some(({ sql }) => sql.includes('covered_through=VALUES(covered_through)')));
  await assert.rejects(repo.markAbsentInWindow({ ...base, presentUids: [], complete: false }, cx), { code: 'INCOMPLETE_COVERAGE' });
  assert.equal(await repo.markAbsentInWindow({ ...base, presentUids: [11, 13], complete: true }, cx), 1);
  const update = calls.find(({ sql }) => sql.includes("presence = 'absent'"));
  assert.match(update.sql, /uid BETWEEN \? AND \?.*uid NOT IN \(\?,\?\)/s);
  assert.equal(await repo.getOccurrence({ userId: 'foreign', accountId: 'a', mailboxId: 'm', epoch: 9, uid: 11 }, cx), null);
});

test('idempotency receipt replays exact response and rejects payload reuse', async () => {
  let saved = null;
  const cx = { async execute(sql, args) {
    if (sql.startsWith('SELECT request_hash')) return [saved ? [saved] : []];
    if (sql.startsWith('INSERT INTO mail_command_receipts')) { saved = { request_hash: args[2], response_json: args[3] }; return [{ affectedRows: 1 }]; }
    throw new Error(sql);
  } };
  const input = { userId: 'u', clientKey: 'abc-123', requestHash: 'a'.repeat(64), response: { operation_ids: ['original'], accepted_revision: 12 } };
  assert.equal((await repo.recordReceipt(input, cx)).replayed, false);
  assert.deepEqual(await repo.recordReceipt({ ...input, response: { operation_ids: ['different'] } }, cx), { response: input.response, replayed: true });
  await assert.rejects(repo.recordReceipt({ ...input, requestHash: 'b'.repeat(64) }, cx), { code: 'IDEMPOTENCY_KEY_REUSED' });
  await assert.rejects(repo.recordReceipt({ ...input, clientKey: 'bad key\n' }, cx), TypeError);
});

test('claim skips active account and fences stale commits; unknown operation outcomes stay reconciling', async () => {
  const jobs = [{ id: 'j1', user_id: 'u', mail_account_id: 'busy', state: 'queued' },
    { id: 'j2', user_id: 'u', mail_account_id: 'free', state: 'queued' }];
  const calls = [];
  const cx = { async execute(sql, args) {
    calls.push({ sql, args });
    if (sql.includes('FROM mail_engine_jobs j JOIN mail_accounts')) return [jobs];
    if (sql.startsWith('INSERT INTO mail_engine_accounts')) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT * FROM mail_engine_accounts')) return [[args[0] === 'busy'
      ? { generation: 3, lease_until: new Date(Date.now() + 60000), lease_owner: 'other' }
      : { generation: 2, lease_until: null, lease_owner: null }]];
    if (sql.includes('SELECT * FROM mail_engine_jobs WHERE id')) return [[{ ...jobs[1], state: 'running', worker_generation: 3 }]];
    if (sql.startsWith('UPDATE')) return [{ affectedRows: 1 }];
    if (sql.includes('SELECT a.generation')) return [[]];
    throw new Error(sql);
  } };
  const job = await runtime.claimDueJob({ workerId: 'worker' }, cx);
  assert.equal(job.id, 'j2');
  assert(calls.some(({ sql }) => sql.includes('FOR UPDATE SKIP LOCKED')));
  await assert.rejects(runtime.assertFence({ accountId: 'free', jobId: 'j2', workerId: 'old', generation: 2 }, cx), { code: 'MAIL_WORKER_FENCED' });
  assert.equal(calls.filter(({ sql }) => sql.startsWith('UPDATE mail_engine_jobs')).length, 1);
  const rec = await runtime.recoverExpiredJobs(cx);
  assert.deepEqual(rec, { jobs: 1, operations: 1 });
  assert(calls.some(({ sql }) => sql.includes("kind = IF(operation_id IS NULL,kind,'reconcile')")));
  assert(calls.some(({ sql }) => sql.includes("w.state = 'reconciling', w.status = 'pending'")));
});

test('dispatch fence refuses a stale source tuple before journaling an attempt', async () => {
  const calls = [];
  const cx = { async execute(sql, args) {
    calls.push(sql);
    if (sql.includes('SELECT a.generation')) return [[{ generation: 4, paused_reason: null }]];
    if (sql.includes('SELECT * FROM mail_writebacks')) return [[{ id: 'op', user_id: 'u', mail_account_id: 'a',
      email_id: 'email', action: 'move', state: 'queued', dispatched: 0, remote_folder: 'INBOX', remote_uid: 42, remote_uidvalidity: 9 }]];
    if (sql.includes('SELECT o.id FROM mail_remote_occurrences')) return [[]];
    throw new Error(sql);
  } };
  await assert.rejects(runtime.beginOperationAttempt({ operationId: 'op', userId: 'u', accountId: 'a',
    workerId: 'worker', generation: 4 }, cx), { code: 'MAIL_EPOCH_STALE' });
  assert(!calls.some(sql => sql.includes('INSERT INTO mail_operation_attempts')));
  await assert.rejects(runtime.finishOperationAttempt({ attemptId: 'attempt', operationId: 'op', userId: 'u',
    accountId: 'a', workerId: 'worker', generation: 4, outcome: 'confirmed', transmission: 'yes' }, cx),
  /verified provider evidence/);
});

test('durable scheduler uses repository claims and persists progress before success', async () => {
  const updates = [], resolved = [];
  let recoveryCount = 0;
  let queued = false, claimed = false;
  const fake = {
    async recoverExpiredJobs() { recoveryCount++; },
    async enqueueJob(input) { queued = true; return { id: 'j', ...input }; },
    async claimDueJob() { if (!queued || claimed) return null; claimed = true; return { id: 'j', mail_account_id: 'a', worker_generation: 1 }; },
    async updateJob(input) { updates.push(input); return { cancellationRequested: false }; },
    async completeJob(input) { resolved.push(input.state); },
    async getJobStatus() { return { state: resolved.at(-1) }; },
  };
  const scheduler = createDurableMailScheduler(async (_job, signal, report) => {
    assert.equal(signal.aborted, false); await report({ phase: 'recent', processed: 2, total: null }); return { success: true };
  }, { repository: fake, pollMs: 100000 });
  try {
    await scheduler.start(); await scheduler.enqueue({ userId: 'u', accountId: 'a' });
    await tick(); await tick();
    assert.deepEqual(resolved, ['idle']);
    assert.equal(recoveryCount, 1, 'recover at startup; later drains are time-gated');
    assert.equal(updates[0].phase, 'recent');
    assert.equal(await scheduler.state({ userId: 'u', accountId: 'a' }).then(s => s.state), 'idle');
  } finally { scheduler.stop(); }
});
