'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { assertUid32, assertDecimal64 } = require('../dist/src/services/mail-engine/repository-identity') as typeof import('../src/services/mail-engine/repository-identity');
const repo = require('../dist/src/services/mail-engine/repository') as typeof import('../src/services/mail-engine/repository');
const runtime = require('../dist/src/services/mail-engine/runtime') as typeof import('../src/services/mail-engine/runtime');
const { createDurableMailScheduler } = require('../dist/src/services/mail-sync-scheduler') as typeof import('../src/services/mail-sync-scheduler');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('protocol IDs, decimal precision and boolean wire values are strict', () => {
  assert.equal(assertUid32('4294967295'), 4294967295);
  assert.equal(assertDecimal64('18446744073709551615'), '18446744073709551615');
  for (const value of [0, '0', -1, '4294967296', '1e3', 1.5, Number.MAX_SAFE_INTEGER + 2, '01']) {
    assert.throws(() => assertUid32(value));
  }
  assert.throws(() => assertDecimal64(18446744073709551615n + 1n));
});

test('repository refuses incomplete coverage, stale epoch and unrelated-owner occurrence', async () => {
  const calls: FixtureValue[] = [];
  const cx = { async execute(sql: string, args: FixtureValue) {
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
  await assert.rejects(repo.saveCursor({ ...base, complete: false }, cx as FixtureValue), { code: 'INCOMPLETE_COVERAGE' });
  await assert.rejects(repo.saveCursor({ ...base, windowEnd: 50000 }, cx as FixtureValue), RangeError);
  await assert.rejects(repo.saveCursor({ ...base, epoch: 10 }, cx as FixtureValue), { code: 'MAIL_EPOCH_STALE' });
  await repo.saveCursor(base, cx as FixtureValue);
  assert(calls.some(({ sql }) => sql.includes('covered_through=VALUES(covered_through)')));
  await assert.rejects(repo.markAbsentInWindow({ ...base, presentUids: [], complete: false }, cx as FixtureValue), { code: 'INCOMPLETE_COVERAGE' });
  assert.equal(await repo.markAbsentInWindow({ ...base, presentUids: [11, 13], complete: true }, cx as FixtureValue), 1);
  const update = calls.find(({ sql }) => sql.includes("presence = 'absent'"));
  assert.match(update.sql, /uid BETWEEN \? AND \?.*uid NOT IN \(\?,\?\)/s);
  assert.equal(await repo.getOccurrence({ userId: 'foreign', accountId: 'a', mailboxId: 'm', epoch: 9, uid: 11 }, cx as FixtureValue), null);
});

test('idempotency receipt replays exact response and rejects payload reuse', async () => {
  let saved: FixtureValue = null; const calls: FixtureValue[] = [];
  const cx = { async execute(sql: string, args: FixtureValue) {
    calls.push(sql);
    if (sql.startsWith('SELECT request_hash')) return [saved ? [saved] : []];
    if (sql.startsWith('INSERT INTO mail_command_receipts')) {
      if (saved) throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 });
      saved = { request_hash: args[2], response_json: args[3] }; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('UPDATE mail_command_receipts')) {
      const hit = saved && saved.request_hash === args[3]; if (hit) saved.response_json = args[0]; return [{ affectedRows: hit ? 1 : 0 }];
    }
    throw new Error(sql);
  } };
  const input = { userId: 'u', clientKey: 'abc-123', requestHash: 'a'.repeat(64), response: { operation_ids: ['original'], accepted_revision: 12 } };
  assert.equal((await repo.recordReceipt(input, cx as FixtureValue)).replayed, false);
  assert.deepEqual(await repo.recordReceipt({ ...input, response: { operation_ids: ['different'] } }, cx as FixtureValue), { response: input.response, replayed: true });
  await assert.rejects(repo.recordReceipt({ ...input, requestHash: 'b'.repeat(64) }, cx as FixtureValue), { code: 'IDEMPOTENCY_KEY_REUSED' });
  await assert.rejects(repo.recordReceipt({ ...input, clientKey: 'bad key\n' }, cx as FixtureValue), TypeError);
  // Claim by INSERT first; a duplicate is only read with a shared lock (no FOR UPDATE gap lock before INSERT).
  assert(!calls.some(sql => sql.includes('FOR UPDATE')));
  assert(calls.some(sql => sql.startsWith('SELECT request_hash') && sql.includes('LOCK IN SHARE MODE')));
  await repo.finishReceipt({ ...input, response: { operation_ids: ['final'] } }, cx as FixtureValue);
  assert.deepEqual((await repo.recordReceipt(input, cx as FixtureValue)).response, { operation_ids: ['final'] });
  await assert.rejects(repo.finishReceipt({ ...input, requestHash: 'b'.repeat(64), response: {} }, cx as FixtureValue), { code: 'IDEMPOTENCY_KEY_BUSY' });
});

test('claim skips active account and fences stale commits; unknown operation outcomes stay reconciling', async () => {
  const jobs = [{ id: 'j1', user_id: 'u', mail_account_id: 'busy', state: 'queued' },
    { id: 'j2', user_id: 'u', mail_account_id: 'free', state: 'queued' }];
  const calls: FixtureValue[] = [];
  const cx = { async execute(sql: string, args: FixtureValue) {
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
  const job = await runtime.claimDueJob({ workerId: 'worker' }, cx as FixtureValue);
  assert.equal(job!.id, 'j2');
  assert(calls.some(({ sql }) => sql.includes('FOR UPDATE SKIP LOCKED')));
  await assert.rejects(runtime.assertFence({ accountId: 'free', jobId: 'j2', workerId: 'old', generation: 2 }, cx as FixtureValue), { code: 'MAIL_WORKER_FENCED' });
  assert.equal(calls.filter(({ sql }) => sql.startsWith('UPDATE mail_engine_jobs')).length, 1);
  const rec = await runtime.recoverExpiredJobs(cx as FixtureValue);
  assert.deepEqual(rec, { jobs: 1, operations: 1 });
  assert(calls.some(({ sql }) => sql.includes("kind = IF(operation_id IS NULL,kind,'reconcile')")));
  assert(calls.some(({ sql }) => sql.includes("w.state = 'reconciling', w.status = 'pending'")));
});

test('dispatch fence refuses a stale source tuple before journaling an attempt', async () => {
  const calls: FixtureValue[] = [];
  const cx = { async execute(sql: string, args: FixtureValue) {
    calls.push(sql);
    if (sql.includes('SELECT a.generation')) return [[{ generation: 4, paused_reason: null }]];
    if (sql.includes('SELECT * FROM mail_writebacks')) return [[{ id: 'op', user_id: 'u', mail_account_id: 'a',
      email_id: 'email', action: 'move', state: 'queued', dispatched: 0, remote_folder: 'INBOX', remote_uid: 42, remote_uidvalidity: 9 }]];
    if (sql.includes('SELECT o.id FROM mail_remote_occurrences')) return [[]];
    throw new Error(sql);
  } };
  await assert.rejects(runtime.beginOperationAttempt({ operationId: 'op', userId: 'u', accountId: 'a',
    workerId: 'worker', generation: 4 }, cx as FixtureValue), { code: 'MAIL_EPOCH_STALE' });
  assert(!calls.some(sql => sql.includes('INSERT INTO mail_operation_attempts')));
});

test('durable scheduler uses repository claims and persists progress before success', async () => {
  const updates: FixtureValue[] = [], resolved: FixtureValue[] = [];
  let recoveryCount = 0;
  let queued = false, claimed = false;
  const fake = {
    async recoverExpiredJobs() { recoveryCount++; },
    async enqueueJob(input: FixtureValue) { queued = true; return { id: 'j', ...input }; },
    async claimDueJob() { if (!queued || claimed) return null; claimed = true; return { id: 'j', mail_account_id: 'a', worker_generation: 1 }; },
    async updateJob(input: FixtureValue) { updates.push(input); return { cancellationRequested: false }; },
    async completeJob(input: FixtureValue) { resolved.push(input.state); },
    async getJobStatus() { return { state: resolved.at(-1) }; },
  };
  const scheduler = createDurableMailScheduler(async (_job, signal, report) => {
    assert.equal(signal.aborted, false); await report({ phase: 'recent', processed: 2, total: null }); return { success: true };
  }, { repository: fake as FixtureValue, pollMs: 100000 });
  try {
    await scheduler.start(); await scheduler.enqueue({ userId: 'u', accountId: 'a' });
    await tick(); await tick();
    assert.deepEqual(resolved, ['idle']);
    assert.equal(recoveryCount, 1, 'recover at startup; later drains are time-gated');
    assert.equal(updates[0].phase, 'recent');
    assert.equal(await scheduler.state({ userId: 'u', accountId: 'a' }).then((s) => s.state), 'idle');
  } finally { scheduler.stop(); }
});
