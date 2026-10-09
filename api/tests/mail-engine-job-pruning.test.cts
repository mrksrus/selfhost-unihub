import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const runtime = require('../dist/src/services/mail-engine/runtime');

const DAY = 86400;
// Synthetic job table. The fake evaluates the statement's documented predicate
// from its bound parameters so batching and parameters are exercised; the SQL
// text itself is asserted separately.
function fakeDb({ jobs, operations = {}, now = 100 * DAY }: FixtureValue) {
  const log: FixtureValue[] = [];
  const olderThan = (job: FixtureValue, days: FixtureValue) => job.completed_at != null && job.completed_at < now - days * DAY;
  const newerInGroup = (job: FixtureValue) => jobs.some((n: FixtureValue) => n.user_id === job.user_id && n.mail_account_id === job.mail_account_id
    && n.kind === job.kind && (n.mailbox_id ?? null) === (job.mailbox_id ?? null)
    && (n.created_at > job.created_at || (n.created_at === job.created_at && n.id > job.id)));
  const execute = async (sql: string, args: FixtureValue) => {
    log.push({ sql, args });
    if (sql.startsWith('SELECT j.id FROM mail_engine_jobs j')) {
      const finished = args.slice(0, 3), days = args[3], settled = args.slice(4, 8), limit = Number(args[8]);
      const rows = jobs.filter((job: FixtureValue) => finished.includes(job.state) && olderThan(job, days) && newerInGroup(job)
        && (!job.operation_id || !operations[job.operation_id] || (operations[job.operation_id].user_id === job.user_id
          ? settled.includes(operations[job.operation_id].state) : true)))
        .sort((a: FixtureValue, b: FixtureValue) => a.completed_at - b.completed_at || a.id.localeCompare(b.id)).slice(0, limit);
      return [rows.map(({ id }: FixtureValue) => ({ id }))];
    }
    if (sql.startsWith('DELETE FROM mail_engine_jobs')) {
      const ids = args.slice(0, -4), finished = args.slice(-4, -1), days = args.at(-1);
      const before = jobs.length;
      for (let i = jobs.length - 1; i >= 0; i--)
        if (ids.includes(jobs[i].id) && finished.includes(jobs[i].state) && olderThan(jobs[i], days)) jobs.splice(i, 1);
      return [{ affectedRows: before - jobs.length }];
    }
    throw new Error(sql);
  };
  return { execute, log };
}
const job = (id: FixtureValue, extra?: FixtureValue) => ({ id, user_id: 'owner', mail_account_id: 'acct', kind: 'sync', mailbox_id: null,
  operation_id: null, state: 'idle', created_at: 0, completed_at: 0, ...extra });

test('prune SQL is bounded, parameterized and keeps the newest job of each account/kind/mailbox', async () => {
  const db = fakeDb({ jobs: [job('a')] });
  await runtime.pruneFinishedJobs({}, db);
  const [select, del] = db.log;
  assert.match(select.sql, /j\.state IN \(\?,\?,\?\) AND j\.completed_at < DATE_SUB\(UTC_TIMESTAMP\(\), INTERVAL \? DAY\)/);
  assert.match(select.sql, /n\.user_id = j\.user_id AND n\.mail_account_id = j\.mail_account_id\s+AND n\.kind = j\.kind AND n\.mailbox_id <=> j\.mailbox_id/);
  assert.match(select.sql, /n\.created_at > j\.created_at OR \(n\.created_at = j\.created_at AND n\.id > j\.id\)/);
  assert.match(select.sql, /w\.id = j\.operation_id\s+AND w\.user_id = j\.user_id AND \(w\.state IS NULL OR w\.state NOT IN \(\?,\?,\?,\?\)\)/);
  assert.match(select.sql, /LIMIT \?$/);
  assert.deepEqual(select.args, ['idle', 'cancelled', 'error', 7, 'confirmed', 'cancelled', 'superseded', 'rejected', '1000']);
  assert.equal(del, undefined, 'a lone job is the latest of its group and is never selected');
  assert(!/\$\{|owner|acct/.test(select.sql), 'no interpolated values');
});

test('prune deletes only old finished history and keeps status, discovery and backoff inputs', async () => {
  const now = 100 * DAY, old = now - 8 * DAY, recent = now - 2 * DAY;
  const jobs = [
    job('sync-old', { created_at: 1, completed_at: old }),
    job('sync-error-old', { created_at: 2, completed_at: old, state: 'error' }),
    job('sync-latest', { created_at: 3, completed_at: old }), // newest sync: kept even though old
    job('sync-running', { mailbox_id: 'box', kind: 'recent', created_at: 5, state: 'running', completed_at: null }),
    job('recent-old', { mailbox_id: 'box', kind: 'recent', created_at: 4, completed_at: old, state: 'cancelled' }),
    job('recent-other-box', { mailbox_id: 'box-2', kind: 'recent', created_at: 1, completed_at: old }), // only job of its mailbox
    job('sync-recent', { mail_account_id: 'other', created_at: 1, completed_at: recent }),
    job('sync-recent-2', { mail_account_id: 'other', created_at: 2, completed_at: recent }),
    job('paused-old', { kind: 'flags', created_at: 1, completed_at: old, state: 'paused' }),
    job('paused-newer', { kind: 'flags', created_at: 2, completed_at: null, state: 'queued' }),
    job('op-settled', { kind: 'operation', operation_id: 'done', created_at: 1, completed_at: old }),
    job('op-pending-1', { kind: 'operation', operation_id: 'stuck', created_at: 2, completed_at: old, state: 'error' }),
    job('op-pending-2', { kind: 'operation', operation_id: 'stuck', created_at: 3, completed_at: old, state: 'error' }),
    job('op-legacy', { kind: 'operation', operation_id: 'legacy', created_at: 4, completed_at: old }),
    job('op-latest', { kind: 'operation', operation_id: 'done', created_at: 5, completed_at: old }),
  ];
  const operations = { done: { user_id: 'owner', state: 'confirmed' }, stuck: { user_id: 'owner', state: 'needs_attention' },
    legacy: { user_id: 'owner', state: null } };
  const db = fakeDb({ jobs, operations, now });
  assert.deepEqual(await runtime.pruneFinishedJobs({}, db), { deleted: 4, batches: 1 });
  assert.deepEqual(jobs.map(j => j.id).sort(), ['op-latest', 'op-legacy', 'op-pending-1', 'op-pending-2', 'paused-newer', 'paused-old',
    'recent-other-box', 'sync-latest', 'sync-recent', 'sync-recent-2', 'sync-running'].sort());
});

test('prune works in bounded batches and stops at its cap', async () => {
  const jobs = Array.from({ length: 26 }, (_, i) => job(`j${String(i).padStart(2, '0')}`, { created_at: i, completed_at: i }));
  const db = fakeDb({ jobs });
  assert.deepEqual(await runtime.pruneFinishedJobs({ batchSize: 10, maxBatches: 2 }, db), { deleted: 20, batches: 2 });
  assert.equal(jobs.length, 6);
  assert(db.log.filter(entry => entry.sql.startsWith('DELETE')).every(entry => entry.args.length === 10 + 4));
  assert.deepEqual(await runtime.pruneFinishedJobs({ batchSize: 10, maxBatches: 2 }, db), { deleted: 5, batches: 1 });
  assert.deepEqual(jobs.map(j => j.id), ['j25'], 'the newest job survives');
  await assert.rejects(runtime.pruneFinishedJobs({ batchSize: 5000 }, db), RangeError);
  await assert.rejects(runtime.pruneFinishedJobs({ olderThanDays: 0 }, db), RangeError);
});
