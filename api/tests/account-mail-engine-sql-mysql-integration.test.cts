'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
// Disposable MySQL 8 schema ending _test. Real SQL for queue maintenance and
// recovery paths that the unit suites only exercise against fake executors.
// Named to sort before database-startup smoke, which leaves a populated schema.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const mysql = require('mysql2/promise');

const uuid = () => crypto.randomUUID();
const DAY = 86400;
const json = (value: FixtureValue) => value == null ? null : typeof value === 'string' ? JSON.parse(value) : value;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('MySQL mail engine SQL: job pruning, fair claims, due backoff, accepted server state, epoch reset, deadlock retry', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 180000,
}, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Disposable schema only');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
    database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 6 });
  const state = require('../dist/src/state'), previous = state.getDb();
  let ownsSchema = false;
  const rows = async (sql: string, params: FixtureValue[] = []) => (await pool.execute(sql, params))[0];
  const one = async (sql: string, params: FixtureValue[] = []) => (await rows(sql, params))[0];
  t.after(async () => {
    try {
      if (ownsSchema) {
        const cx = await pool.getConnection();
        try {
          await cx.query('SET FOREIGN_KEY_CHECKS = 0');
          for (const row of (await cx.query('SHOW TABLES'))[0]) {
            const name = Object.values(row)[0]; assert.match((name as string), /^[a-z_]+$/);
            await cx.query(`DROP TABLE \`${name}\``);
          }
        } finally { await cx.query('SET FOREIGN_KEY_CHECKS = 1'); cx.release(); }
      }
    } finally { state.setDb(previous); await pool.end(); }
  });
  assert.match((await one('SELECT VERSION() AS version')).version, /MariaDB/);
  assert.equal((await rows('SHOW TABLES')).length, 0, 'Refuse a populated schema');
  ownsSchema = true; state.setDb(pool);
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'engine-sql-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-engine-sql-bootstrap-password';
  await require('../dist/src/services/database').ensureSchema();
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const repo = require('../dist/src/services/mail-engine/repository');
  const writebacks = require('../dist/src/services/mail-writebacks');
  const mail = require('../dist/src/services/mail');

  async function seedAccount(label: string) {
    const userId = uuid(), accountId = uuid();
    await pool.execute('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, `sql-${label}@example.test`, 'synthetic']);
    await pool.execute(`INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active)
      VALUES (?,?,?,'custom','sync',TRUE)`, [accountId, userId, `sql-${label}@example.test`]);
    return { userId, accountId };
  }
  async function seedEmail({ userId, accountId }: FixtureValue, uid = 12, uidvalidity = 9) {
    const id = uuid();
    await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,remote_folder,remote_uid,remote_uidvalidity)
      VALUES (?,?,?,'fixture@example.test','[]','inbox','INBOX',?,?)`, [id, userId, accountId, uid, uidvalidity]);
    return id;
  }
  async function seedWriteback(owner: FixtureValue, { action = 'read', target = '1', base = '0', remoteFolder = 'INBOX', uid = 12, uidvalidity = 9,
    state: opState = 'queued', status = 'pending', dispatched = false, isCurrent = true, evidence = null, emailId = null }: FixtureValue = {}) {
    const id = uuid(), email = emailId || await seedEmail(owner, uid, uidvalidity);
    // available_at is set explicitly in UTC: its column default follows the session time zone.
    await pool.execute(`INSERT INTO mail_writebacks (id,user_id,mail_account_id,email_id,action,target_value,base_value,remote_folder,
        remote_uid,remote_uidvalidity,status,state,dispatched,is_current,evidence_json,available_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 SECOND))`,
    [id, owner.userId, owner.accountId, email, action, target, base, remoteFolder, uid, uidvalidity, status, opState,
      dispatched ? 1 : 0, isCurrent ? 1 : 0, evidence === null ? null : JSON.stringify(evidence)]);
    return id;
  }
  // Every timestamp relative to UTC_TIMESTAMP() on the server, never the client clock.
  async function seedJob(owner: FixtureValue, { kind, jobState, mailboxId = null, operationId = null, priority = 0, createdAgo, completedAgo = null }: FixtureValue) {
    const id = uuid();
    await pool.execute(`INSERT INTO mail_engine_jobs (id,user_id,mail_account_id,mailbox_id,operation_id,kind,state,priority,due_at,created_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND),DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND),
        ${completedAgo === null ? 'NULL' : 'DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? SECOND)'})`,
    [id, owner.userId, owner.accountId, mailboxId, operationId, kind, jobState, priority, createdAgo, createdAgo,
      ...(completedAgo === null ? [] : [completedAgo])]);
    return id;
  }
  // Global queue scans (claims, due pass, prune) must only see the section under
  // test, also after a failed section.
  async function retire(...owners: FixtureValue[]) {
    for (const { userId, accountId } of owners) {
      await pool.execute('DELETE FROM mail_engine_jobs WHERE user_id = ? AND mail_account_id = ?', [userId, accountId]);
      await pool.execute('UPDATE mail_accounts SET is_active = FALSE WHERE id = ? AND user_id = ?', [accountId, userId]);
    }
  }
  const jobIds = async (owner: FixtureValue) => new Set<FixtureValue>((await rows('SELECT id FROM mail_engine_jobs WHERE user_id = ? AND mail_account_id = ?',
    [owner.userId, owner.accountId])).map((row: FixtureValue) => row.id));

  await t.test('pruneFinishedJobs deletes old finished history in batches, keeps the newest per stream and unsettled operations', async t => {
    const owner = await seedAccount('prune'), other = await seedAccount('prune-other');
    t.after(() => retire(owner, other));
    const box = await repo.ensureMailbox({ userId: owner.userId, accountId: owner.accountId, folderName: 'INBOX', epoch: 9 }, pool);
    const job = (spec: FixtureValue, who = owner) => seedJob(who, spec);
    const doneAgo = (seconds: FixtureValue) => ({ createdAgo: seconds, completedAgo: seconds });
    const ids: FixtureValue = {
      // sync stream (no mailbox): three old finished states, one recent, one queued
      sy1: await job({ kind: 'sync', jobState: 'idle', ...doneAgo(20 * DAY) }),
      sy2: await job({ kind: 'sync', jobState: 'error', ...doneAgo(19 * DAY) }),
      sy3: await job({ kind: 'sync', jobState: 'cancelled', ...doneAgo(18 * DAY) }),
      sy4: await job({ kind: 'sync', jobState: 'idle', ...doneAgo(3 * DAY) }),
      sy5: await job({ kind: 'sync', jobState: 'queued', createdAgo: 3600 }),
      // history stream of one mailbox: the newest finished job stays even when old
      hi1: await job({ kind: 'history', jobState: 'idle', mailboxId: box.id, ...doneAgo(30 * DAY) }),
      hi2: await job({ kind: 'history', jobState: 'idle', mailboxId: box.id, ...doneAgo(25 * DAY) }),
      // flags stream: a newer running job supersedes the old finished one
      fl1: await job({ kind: 'flags', jobState: 'idle', mailboxId: box.id, ...doneAgo(21 * DAY) }),
      fl2: await job({ kind: 'flags', jobState: 'running', mailboxId: box.id, createdAgo: 2 * DAY }),
      // same stream name, different mailbox (NULL): its own newest job
      flNull: await job({ kind: 'flags', jobState: 'idle', ...doneAgo(40 * DAY) }),
      // other account: a single old job is that stream's newest
      otherOnly: await job({ kind: 'sync', jobState: 'idle', ...doneAgo(40 * DAY) }, other),
    };
    const unsettled = await seedWriteback(owner, { state: 'needs_attention', status: 'conflict' });
    const confirmed = await seedWriteback(owner, { state: 'confirmed', status: 'done', isCurrent: false });
    const cancelled = await seedWriteback(owner, { state: 'cancelled', status: 'done', isCurrent: false });
    const legacy = await seedWriteback(owner, { state: null, isCurrent: false });
    Object.assign(ids, {
      ou1: await job({ kind: 'operation', jobState: 'error', operationId: unsettled, ...doneAgo(24 * DAY) }),
      ou2: await job({ kind: 'operation', jobState: 'idle', operationId: unsettled, ...doneAgo(23 * DAY) }),
      os1: await job({ kind: 'operation', jobState: 'idle', operationId: confirmed, ...doneAgo(22 * DAY) }),
      ol1: await job({ kind: 'operation', jobState: 'idle', operationId: legacy, ...doneAgo(26 * DAY) }),
      // newest operation job of the account: kept although its operation is settled
      oc1: await job({ kind: 'operation', jobState: 'cancelled', operationId: cancelled, ...doneAgo(10 * DAY) }),
    });
    const expectedDeleted = ['hi1', 'os1', 'fl1', 'sy1', 'sy2', 'sy3']; // completed_at order
    const all = new Set<FixtureValue>([...await jobIds(owner), ...await jobIds(other)]);
    assert.equal(all.size, Object.keys(ids).length);

    assert.deepEqual(await runtime.pruneFinishedJobs({ olderThanDays: 35 }, pool), { deleted: 0, batches: 1 },
      'nothing eligible is older than 35 days');
    assert.deepEqual(await runtime.pruneFinishedJobs({ olderThanDays: 7, batchSize: 2, maxBatches: 1 }, pool), { deleted: 2, batches: 1 },
      'one bounded batch');
    let left = await jobIds(owner);
    assert(!left.has(ids.hi1) && !left.has(ids.os1), 'oldest completed go first');
    assert(expectedDeleted.slice(2).every(key => left.has(ids[key])));
    assert.deepEqual(await runtime.pruneFinishedJobs({ olderThanDays: 7, batchSize: 2, maxBatches: 20 }, pool), { deleted: 4, batches: 3 },
      'full batches continue; the empty batch ends the pass');
    assert.deepEqual(await runtime.pruneFinishedJobs({ olderThanDays: 7 }, pool), { deleted: 0, batches: 1 });
    left = await jobIds(owner);
    for (const [key, id] of Object.entries(ids)) {
      if (key === 'otherOnly') continue;
      assert.equal(left.has(id), !expectedDeleted.includes(key), `${key} ${expectedDeleted.includes(key) ? 'pruned' : 'kept'}`);
    }
    assert((await jobIds(other)).has(ids.otherOnly), 'another account keeps its only job');
    assert.equal((await rows('SELECT id FROM mail_writebacks WHERE user_id = ?', [owner.userId])).length, 4, 'operations are never pruned');
  });

  await t.test('claimDueJob returns another account while a leased account holds more than the candidate window', async t => {
    const busy = await seedAccount('claim-busy'), idle = await seedAccount('claim-idle');
    t.after(() => retire(busy, idle));
    await pool.execute(`INSERT INTO mail_engine_accounts (mail_account_id,user_id,generation,lease_owner,lease_until)
      VALUES (?,?,5,'busy-worker',DATE_ADD(UTC_TIMESTAMP(), INTERVAL 300 SECOND))`, [busy.accountId, busy.userId]);
    // Older queued work ages ahead in ORDER BY; 40 rows exceed LIMIT 32.
    for (let i = 0; i < 40; i++) await seedJob(busy, { kind: 'sync', jobState: 'queued', createdAgo: 600 + i });
    const waiting = await seedJob(idle, { kind: 'sync', jobState: 'queued', createdAgo: 1 });
    const claimed = await runtime.claimDueJob({ workerId: 'fair-worker' }, pool);
    assert.equal(claimed?.id, waiting, 'a busy account backlog cannot starve another account');
    assert.equal(claimed.state, 'running');
    assert.deepEqual({ ...await one('SELECT lease_owner, generation FROM mail_engine_accounts WHERE mail_account_id = ?', [busy.accountId]) },
      { lease_owner: 'busy-worker', generation: 5 }, 'the busy lease is untouched');
    assert.equal(Number((await one("SELECT COUNT(*) AS n FROM mail_engine_jobs WHERE mail_account_id = ? AND state = 'queued'",
      [busy.accountId])).n), 40);
    await runtime.completeJob({ jobId: claimed.id, accountId: idle.accountId, workerId: 'fair-worker',
      generation: Number(claimed.worker_generation) }, pool);
    assert.equal(await runtime.claimDueJob({ workerId: 'fair-worker' }, pool), null, 'still leased');
    // Expired but unrecovered: the old worker may still hold an unknown provider outcome.
    await pool.execute('UPDATE mail_engine_accounts SET lease_until = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 SECOND) WHERE mail_account_id = ?', [busy.accountId]);
    assert.equal(await runtime.claimDueJob({ workerId: 'fair-worker' }, pool), null, 'expired lease still awaits recovery');
    await pool.execute('UPDATE mail_engine_accounts SET lease_owner = NULL, lease_until = NULL WHERE mail_account_id = ?', [busy.accountId]);
    const recovered = await runtime.claimDueJob({ workerId: 'fair-worker' }, pool);
    assert.equal(recovered?.mail_account_id, busy.accountId);
    assert.equal(Number(recovered.worker_generation), 6);
    await runtime.completeJob({ jobId: recovered.id, accountId: busy.accountId, workerId: 'fair-worker',
      generation: Number(recovered.worker_generation) }, pool);
  });

  await t.test('runDueWritebacks waits 15*2^(jobs-1) seconds, capped at one hour, after an operation last finished', async t => {
    const owner = await seedAccount('due');
    t.after(() => retire(owner));
    const op = async (jobsAgo: FixtureValue, spec: FixtureValue = {}) => {
      const id = await seedWriteback(owner, { state: 'retry_wait', ...spec });
      // Oldest first; the last value is the latest completion.
      for (const [i, ago] of jobsAgo.entries()) await seedJob(owner, { kind: spec.action === 'move' ? 'reconcile' : 'operation',
        jobState: i % 2 ? 'error' : 'idle', operationId: id, createdAgo: ago + 1, completedAgo: ago });
      return id;
    };
    const many = (latest: FixtureValue) => [...Array.from({ length: 9 }, (_, i) => latest + 7200 - i), latest];
    const ops = {
      none: await op([]), // never ran: due
      one_recent: await op([5]), // 1 job: 15 s
      one_waited: await op([40]),
      three_recent: await op([400, 300, 30]), // 3 jobs: 60 s
      three_waited: await op([400, 300, 120]),
      ten_recent: await op(many(3000)), // 10 jobs: 15*2^8 = 3840 s, capped at 3600 s
      ten_waited: await op(many(3700)), // due only because of the cap
      move_recent: await op([5], { action: 'move', target: 'Archive', base: 'INBOX', state: 'reconciling', dispatched: true, isCurrent: false }),
      move_waited: await op([40], { action: 'move', target: 'Archive', base: 'INBOX', state: 'reconciling', dispatched: true, isCurrent: false }),
    };
    const name = Object.fromEntries(Object.entries(ops).map(([key, id]) => [id, key]));
    const enqueued: FixtureValue[] = [];
    t.mock.method(runtime, 'enqueueJob', async (job: FixtureValue) => { enqueued.push({ op: name[job.operationId], kind: job.kind }); return { id: uuid() }; });
    // Each pass nudges the durable scheduler once per account; nothing may dial here.
    const nudged: FixtureValue[] = [];
    t.mock.method(mail, 'runMailOperationsNow', async (id: FixtureValue) => { nudged.push(id); return true; });
    const selected = await writebacks.runDueWritebacks();
    await sleep(10);
    assert.deepEqual(nudged, [owner.accountId]);
    assert.deepEqual(enqueued.map(entry => entry.op).sort(), ['move_waited', 'none', 'one_waited', 'ten_waited', 'three_waited']);
    assert.equal(enqueued.find(entry => entry.op === 'move_waited').kind, 'reconcile', 'a sent move gets an outcome check');
    assert(enqueued.filter(entry => entry.op !== 'move_waited').every(entry => entry.kind === 'operation'));
    assert.equal(selected, 5);
  });

  await t.test('acceptServerState settles only a sent move that needs attention and keeps its evidence', async t => {
    const owner = await seedAccount('accept'), offline = await seedAccount('accept-offline'), stranger = await seedAccount('accept-stranger');
    t.after(() => retire(owner, offline, stranger));
    const scheduled: FixtureValue[] = [];
    t.mock.method(mail, 'scheduleMailAccountSync', async (accountId: string) => { scheduled.push(accountId); return { started: true }; });
    const sentMove = { action: 'move', target: 'Archive', base: 'INBOX', dispatched: true, state: 'needs_attention', status: 'conflict' };
    const withEvidence = await seedWriteback(owner, { ...sentMove, evidence: { reason: 'outcome_unknown', sourceUid: '12', mappingValid: true } });
    const withoutEvidence = await seedWriteback(owner, sentMove);
    const refused = {
      unsent: await seedWriteback(owner, { ...sentMove, dispatched: false }),
      flag: await seedWriteback(owner, { ...sentMove, action: 'read', target: '1', base: '0' }),
      checking: await seedWriteback(owner, { ...sentMove, state: 'reconciling', status: 'pending' }),
    };
    const snapshot = async (id: FixtureValue) => ({ ...await one('SELECT state,status,is_current,error,evidence_json FROM mail_writebacks WHERE id = ?', [id]) });
    const before: FixtureValue = {};
    for (const [key, id] of Object.entries(refused)) before[key] = await snapshot(id);

    await pool.execute("UPDATE mail_writebacks SET error = 'Outcome unknown' WHERE id = ?", [withEvidence]);
    const result = await writebacks.acceptServerState(owner.userId, withEvidence);
    assert.equal(result.sync_queued, true);
    assert.deepEqual(scheduled, [owner.accountId]);
    const settled = await snapshot(withEvidence);
    assert.deepEqual([settled.state, settled.status, Number(settled.is_current), settled.error], ['superseded', 'done', 0, null]);
    assert.deepEqual(json(settled.evidence_json), { reason: 'user_accepted_server_state', sourceUid: '12', mappingValid: true },
      'JSON_SET replaces the reason and keeps recorded mapping evidence');
    await writebacks.acceptServerState(owner.userId, withoutEvidence);
    assert.deepEqual(json((await snapshot(withoutEvidence)).evidence_json), { reason: 'user_accepted_server_state' });

    for (const [key, id] of Object.entries(refused)) {
      await assert.rejects(writebacks.acceptServerState(owner.userId, id), { status: 409 }, key);
      assert.deepEqual(await snapshot(id), before[key], `${key} unchanged`);
    }
    await assert.rejects(writebacks.acceptServerState(owner.userId, withEvidence), { status: 409 }, 'already superseded');
    const foreign = await seedWriteback(stranger, sentMove);
    await assert.rejects(writebacks.acceptServerState(owner.userId, foreign), { status: 404 }, 'owner scoped');
    assert.equal((await snapshot(foreign)).state, 'needs_attention');

    const disconnected = await seedWriteback(offline, sentMove);
    await pool.execute('UPDATE mail_accounts SET disconnected_at = UTC_TIMESTAMP() WHERE id = ?', [offline.accountId]);
    const quiet = await writebacks.acceptServerState(offline.userId, disconnected);
    assert.equal(quiet.sync_queued, false, 'no sync for a disconnected account');
    assert.equal((await snapshot(disconnected)).state, 'superseded');
    assert.equal(scheduled.length, 2, 'only the two active-account resolutions asked for a sync');
  });

  await t.test('ensureMailbox UIDVALIDITY change: sent work is checked with its evidence kept, unsent work needs attention', async t => {
    const owner = await seedAccount('epoch'), sibling = await seedAccount('epoch-sibling');
    t.after(() => retire(owner, sibling));
    const box = await repo.ensureMailbox({ userId: owner.userId, accountId: owner.accountId, folderName: 'INBOX', epoch: 9 }, pool);
    assert.equal(Number(box.uidvalidity), 9);
    const observed = await seedEmail(owner, 30);
    await repo.upsertOccurrence({ userId: owner.userId, accountId: owner.accountId, mailboxId: box.id, epoch: 9, uid: 30,
      emailId: observed, flags: [] }, pool);
    await repo.withTransaction((cx: FixtureValue) => repo.saveCursor({ userId: owner.userId, accountId: owner.accountId, mailboxId: box.id,
      stream: 'recent', epoch: 9, windowStart: 1, windowEnd: 30, coveredThrough: 30 }, cx), pool);
    const move = { action: 'move', target: 'Archive', base: 'INBOX' };
    const ops = {
      sentMove: await seedWriteback(owner, { ...move, dispatched: true, state: 'executing',
        evidence: { reason: 'transport_timeout', sourceUid: '12', destinationUid: '77', sourceUidvalidity: '9' } }),
      sentFlag: await seedWriteback(owner, { dispatched: true, state: 'verifying' }),
      unsent: await seedWriteback(owner, { state: 'queued', evidence: { reason: 'stale_hint', sourceUid: '12' } }),
      unsentRetry: await seedWriteback(owner, { action: 'star', state: 'retry_wait' }),
      lowerInbox: await seedWriteback(owner, { remoteFolder: 'inbox', state: 'queued' }),
      otherFolder: await seedWriteback(owner, { remoteFolder: 'Archive', state: 'queued' }),
      newEpoch: await seedWriteback(owner, { uidvalidity: 10, state: 'queued' }),
      confirmed: await seedWriteback(owner, { ...move, dispatched: true, state: 'confirmed', status: 'done', isCurrent: false }),
      siblingAccount: await seedWriteback(sibling, { state: 'queued' }),
    };
    const snapshot = async (id: FixtureValue) => ({ ...await one('SELECT state,status,error,evidence_json FROM mail_writebacks WHERE id = ?', [id]) });
    const before: FixtureValue = {};
    for (const [key, id] of Object.entries(ops)) before[key] = await snapshot(id);

    const reset = await repo.ensureMailbox({ userId: owner.userId, accountId: owner.accountId, folderName: 'INBOX', epoch: 10 }, pool);
    assert.deepEqual([Number(reset.uidvalidity), reset.state, Number(reset.epoch_revision)], [10, 'active', Number(box.epoch_revision) + 1]);
    assert.deepEqual({ ...await one('SELECT presence, quarantine_reason FROM mail_remote_occurrences WHERE mailbox_id = ?', [box.id]) },
      { presence: 'quarantined', quarantine_reason: 'epoch_changed' });
    assert.equal((await rows('SELECT stream FROM mail_engine_cursors WHERE mailbox_id = ?', [box.id])).length, 0);

    const after: FixtureValue = {};
    for (const [key, id] of Object.entries(ops)) after[key] = await snapshot(id);
    assert.deepEqual([after.sentMove.state, after.sentMove.status], ['reconciling', 'pending']);
    assert.deepEqual(json(after.sentMove.evidence_json), { reason: 'epoch_changed', sourceUid: '12', destinationUid: '77', sourceUidvalidity: '9' },
      'JSON_SET keeps the recorded COPYUID mapping');
    assert.deepEqual([after.sentFlag.state, after.sentFlag.status, json(after.sentFlag.evidence_json)],
      ['reconciling', 'pending', { reason: 'epoch_changed' }]);
    for (const key of ['unsent', 'unsentRetry', 'lowerInbox']) {
      assert.deepEqual([after[key].state, after[key].status, json(after[key].evidence_json)],
        ['needs_attention', 'conflict', { reason: 'epoch_changed' }], key);
      assert.match(after[key].error, /Provider reset this mailbox/);
    }
    for (const key of ['otherFolder', 'newEpoch', 'confirmed', 'siblingAccount']) assert.deepEqual(after[key], before[key], `${key} unchanged`);

    const again = await repo.ensureMailbox({ userId: owner.userId, accountId: owner.accountId, folderName: 'INBOX', epoch: 10 }, pool);
    assert.equal(Number(again.epoch_revision), Number(reset.epoch_revision), 'same epoch is not a reset');
  });

  await t.test('enqueuePendingBodies queues one body job per mailbox with queued content and promotes old body jobs', async t => {
    const { enqueuePendingBodies, BODY_PRIORITY } = require('../dist/src/services/mail-engine/sync');
    const owner = await seedAccount('bodies'), sibling = await seedAccount('bodies-sibling');
    t.after(() => retire(owner, sibling));
    const box = async (who: FixtureValue, folderName: FixtureValue) => repo.ensureMailbox({ userId: who.userId, accountId: who.accountId, folderName, epoch: 9 }, pool);
    const [inbox, allMail, done, other] = [await box(owner, 'INBOX'), await box(owner, '[Gmail]/All Mail'),
      await box(owner, 'Done'), await box(sibling, 'INBOX')];
    const seed = async (who: FixtureValue, mailbox: FixtureValue, uid: FixtureValue, contentState: FixtureValue) => {
      const id = await seedEmail(who, uid);
      await pool.execute('UPDATE emails SET content_state = ?, import_complete = ? WHERE id = ?',
        [contentState, contentState === 'complete', id]);
      await repo.upsertOccurrence({ userId: who.userId, accountId: who.accountId, mailboxId: mailbox.id, epoch: 9, uid,
        emailId: id, flags: [] }, pool);
    };
    await seed(owner, inbox, 1, 'queued');
    await seed(owner, inbox, 2, 'queued');
    await seed(owner, allMail, 3, 'queued');
    await seed(owner, done, 4, 'complete');
    await seed(sibling, other, 5, 'queued');
    const stale = await seedJob(owner, { kind: 'body', jobState: 'queued', mailboxId: inbox.id, priority: 90, createdAgo: 60 });
    assert.deepEqual(await enqueuePendingBodies({ userId: owner.userId, accountId: owner.accountId }, pool), { mailboxes: 2 });
    const jobs = await rows(`SELECT id, mailbox_id, priority FROM mail_engine_jobs WHERE mail_account_id = ? AND kind = 'body'
      AND state = 'queued' ORDER BY mailbox_id`, [owner.accountId]);
    assert.deepEqual(jobs.map((job: FixtureValue) => job.mailbox_id).sort(), [inbox.id, allMail.id].sort(), 'none for a complete mailbox');
    assert(jobs.every((job: FixtureValue) => Number(job.priority) === BODY_PRIORITY));
    assert(jobs.some((job: FixtureValue) => job.id === stale), 'the existing INBOX job is promoted, not duplicated');
    assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM mail_engine_jobs WHERE mail_account_id = ? AND kind = 'body'`,
      [sibling.accountId])).n), 0, 'another account is untouched');
    await enqueuePendingBodies({ userId: owner.userId, accountId: owner.accountId }, pool);
    assert.equal(Number((await one(`SELECT COUNT(*) AS n FROM mail_engine_jobs WHERE mail_account_id = ? AND kind = 'body'`,
      [owner.accountId])).n), 2, 'repeating the pass adds nothing');
  });

  await t.test('withTransaction runs the callback again after InnoDB picks it as a real deadlock victim', async () => {
    await pool.query('CREATE TABLE tx_deadlock_probe (id INT PRIMARY KEY, v INT NOT NULL DEFAULT 0) ENGINE=InnoDB');
    await pool.query(`INSERT INTO tx_deadlock_probe (id) VALUES ${Array.from({ length: 202 }, (_, i) => `(${i + 1})`).join(',')}`);
    let runs = 0, firstLocked: FixtureValue, secondLocked: FixtureValue;
    const firstLockedP = new Promise(resolve => { firstLocked = resolve; });
    const secondLockedP = new Promise(resolve => { secondLocked = resolve; });
    const retried = repo.withTransaction(async (cx: FixtureValue) => {
      runs++;
      await cx.execute('SELECT v FROM tx_deadlock_probe WHERE id = 1 FOR UPDATE');
      if (runs === 1) { firstLocked(); await secondLockedP; }
      await cx.execute('UPDATE tx_deadlock_probe SET v = v + 1 WHERE id = 2');
      return runs;
    }, pool);
    const other = await pool.getConnection();
    try {
      await firstLockedP;
      await other.beginTransaction();
      // Many modified rows make this transaction heavier, so InnoDB rolls back
      // the lighter withTransaction attempt, not this one.
      await other.execute('UPDATE tx_deadlock_probe SET v = v + 10 WHERE id > 2');
      await other.execute('SELECT v FROM tx_deadlock_probe WHERE id = 2 FOR UPDATE');
      secondLocked();
      await sleep(200); // let the first attempt wait on row 2 before closing the cycle
      await other.execute('SELECT v FROM tx_deadlock_probe WHERE id = 1 FOR UPDATE');
      await other.commit();
    } catch (error) {
      await other.rollback();
      throw error;
    } finally { other.release(); }
    assert.equal(await retried, 2, 'first attempt was the deadlock victim and the second committed');
    assert.equal(runs, 2);
    assert.deepEqual((await rows('SELECT id, v FROM tx_deadlock_probe WHERE id IN (1,2,3) ORDER BY id')).map((row: FixtureValue) => [row.id, row.v]),
      [[1, 0], [2, 1], [3, 10]], 'the rolled-back attempt left no write; the retry wrote once');
  });
});
