import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

// A large body backlog (thousands of discovered messages without content) must
// drain in batches, ahead of background sweeps, and must not be stranded when
// a body chain stops.
const userId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const accountId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const engine = (name: FixtureValue) => require.resolve(`../dist/src/services/mail-engine/${name}`);

function stub<T>(t: import('node:test').TestContext, entries: FixtureValue, target: string): T {
  const paths = [...entries.map(([p]: FixtureValue) => p), target];
  const prior = paths.map(p => require.cache[p]);
  for (const [p, exports] of entries) require.cache[p] = { id: p, filename: p, loaded: true, exports } as NodeJS.Module;
  delete require.cache[target];
  t.after(() => paths.forEach((p, i) => { if (prior[i]) require.cache[p] = prior[i]; else delete require.cache[p]; }));
  return require(target);
}

function backlog(t: import('node:test').TestContext, count: number, { fetchRawMessage }: FixtureValue = {}) {
  const queued = Array.from({ length: count }, (_, i) => ({ occurrence_id: `occ-${i}`, uid: count - i, uidvalidity: 7,
    email_id: `email-${i}`, import_complete: 0, is_read: 0 }));
  const persisted: FixtureValue[] = [], reports: FixtureValue[] = [], marked: FixtureValue[] = [], fetches: FixtureValue[] = [];
  const db = { async execute(sql: string, params: FixtureValue) {
    if (sql.includes('SELECT o.id AS occurrence_id')) return [queued.slice(0, 1)];
    if (sql.includes('UPDATE emails SET content_state = ?')) {
      marked.push(params.slice(0, 2));
      queued.splice(queued.findIndex(q => q.email_id === params[1]), 1);
      return [{ affectedRows: 1 }];
    }
    throw Error(`Unexpected SQL: ${sql}`);
  } };
  const content = stub<typeof import('../src/services/mail-engine/content')>(t, [
    [engine('repository'), { withTransaction: (fn: FixtureValue) => fn(db) }],
    [engine('runtime'), { async assertFence() {} }],
    [engine('transport'), { async selectMailbox() { return { uidvalidity: 7 }; },
      async fetchRawMessage(connection: FixtureValue, address: FixtureValue, options: FixtureValue) {
        fetches.push({ uid: address.uid, maxBytes: address.maxBytes, timeoutMs: options.timeoutMs });
        if (fetchRawMessage) return fetchRawMessage(address, options);
        return { raw: Buffer.from('From: a@example.test\r\nSubject: Hi\r\n\r\nBody') }; } }],
    [require.resolve('../dist/src/services/mail-import'), { async persistImportedMessage(input: FixtureValue) {
      persisted.push(input.uid); queued.shift(); return { emailId: input.existingEmail.id }; } }],
    [require.resolve('../dist/src/services/mail'), { MAIL_RAW_STORAGE_ROOT: '/nonexistent', recordMailServerMessageForDeletion: async () => {} }],
  ], engine('content'));
  const run = (options = {}) => content.processBodySlice({ db: db as FixtureValue, connection: {} as FixtureValue, account: { id: accountId, user_id: userId },
    folder: { folderName: 'INBOX', dbFolderName: 'inbox' }, mailboxId: 'box',
    job: { id: 'job', lease_owner: 'worker', worker_generation: 1 } as FixtureValue, report: (change: FixtureValue) => reports.push(change), ...options });
  return { content, queued, persisted, reports, marked, fetches, run };
}

test('a body job imports a batch of messages, newest first, and continues while work remains', async t => {
  const h = backlog(t, 30);
  const first = await h.run();
  assert.equal(first.processed, h.content.BODY_SLICE_MESSAGES);
  assert.equal(first.more, true);
  assert.deepEqual(h.persisted.slice(0, 3), [30, 29, 28]);
  assert.deepEqual(h.reports.at(-1), { phase: 'bodies', processed: h.content.BODY_SLICE_MESSAGES, total: null },
    'progress is cumulative for the job');
  const last = await h.run();
  assert.equal(last.processed, 30 - h.content.BODY_SLICE_MESSAGES);
  assert.equal(last.more, false, 'an exhausted mailbox ends the chain in the same job');
  assert.equal(h.queued.length, 0);
});

test('a body job hands the lease back when its time budget is spent', async t => {
  const h = backlog(t, 10);
  let clock = 0;
  const result = await h.run({ now: () => { clock += 6000; return clock; } });
  assert(result.processed >= 1 && result.processed < 10, `processed ${result.processed}`);
  assert.equal(result.more, true);
});

test('a cancelled or yielding body job stops between messages, keeping committed ones', async t => {
  const h = backlog(t, 10);
  const controller = new AbortController();
  await assert.rejects(h.run({ signal: controller.signal, report: (change: FixtureValue) => {
    if (change.processed === 2) controller.abort('interactive-yield');
  } }), error => (error as FixtureValue).code === 'MAIL_SYNC_CANCELLED');
  assert.deepEqual(h.persisted, [10, 9]);
});

test('a large message gets five minutes and up to 50 MiB, and the FETCH itself the same deadline', async t => {
  const h = backlog(t, 1);
  await h.run();
  assert.equal(h.content.DEFAULT_TIMEOUT_MS, 5 * 60 * 1000);
  assert.equal(h.content.DEFAULT_MAX_BYTES, 50 * 1024 * 1024);
  assert.deepEqual(h.fetches, [{ uid: 1, maxBytes: 50 * 1024 * 1024, timeoutMs: 5 * 60 * 1000 }]);
  assert.equal((require('../dist/src/services/mail-imap-client') as typeof import('../src/services/mail-imap-client')).MAX_LITERAL_BYTES, 50 * 1024 * 1024);
});

for (const code of ['MAIL_BODY_TIMEOUT', 'MAIL_IMAP_TIMEOUT']) {
  test(`a message that misses the download deadline (${code}) is set aside and stops blocking the mailbox`, async t => {
    const h = backlog(t, 5, { async fetchRawMessage(address: FixtureValue) {
      if (address.uid === 4) throw Object.assign(new Error('deadline'), { code });
      return { raw: Buffer.from('From: a@example.test\r\nSubject: Hi\r\n\r\nBody') };
    } });
    const first = await h.run();
    assert.deepEqual(h.persisted, [5], 'messages committed before the timeout are kept');
    assert.deepEqual(h.marked, [['slow', 'email-1']]);
    assert.deepEqual({ processed: first.processed, deferred: first.deferred, more: first.more },
      { processed: 1, deferred: 1, more: true }, 'the closed session ends the slice; the continuation reconnects');
    const next = await h.run();
    assert.deepEqual(h.persisted, [5, 3, 2, 1], 'the next job continues behind the slow message');
    assert.equal(next.more, false);
  });
}

test('a cancelled download is not set aside as slow', async t => {
  const controller = new AbortController();
  const h = backlog(t, 2, { async fetchRawMessage() {
    controller.abort('interactive-yield');
    throw Object.assign(new Error('closed'), { code: 'MAIL_IMAP_TIMEOUT' });
  } });
  await assert.rejects(h.run({ signal: controller.signal }));
  assert.deepEqual(h.marked, []);
  assert.equal(h.queued.length, 2, 'the message stays queued for the next job');
});

test('discovery requeues body work for every mailbox with queued content and promotes old priorities', async t => {
  const enqueued: FixtureValue[] = [], statements: FixtureValue[] = [];
  const sync = stub<typeof import('../src/services/mail-engine/sync')>(t, [
    [engine('runtime'), { async enqueueJob(input: FixtureValue) { enqueued.push(input); } }],
  ], engine('sync'));
  const db = { async execute(sql: string, params: FixtureValue) {
    statements.push({ sql, params });
    if (sql.includes('SELECT DISTINCT o.mailbox_id')) return [[{ mailbox_id: 'inbox' }, { mailbox_id: 'all-mail' }]];
    if (sql.includes('UPDATE mail_engine_jobs SET priority')) return [{ affectedRows: 1 }];
    throw Error(`Unexpected SQL: ${sql}`);
  } };
  assert.deepEqual(await sync.enqueuePendingBodies({ userId, accountId }, db as FixtureValue), { mailboxes: 2 });
  assert.deepEqual(enqueued, ['inbox', 'all-mail'].map(mailboxId =>
    ({ userId, accountId, mailboxId, kind: 'body', priority: sync.BODY_PRIORITY })));
  const select = statements.find(s => s.sql.includes('SELECT DISTINCT'));
  assert.match(select.sql, /content_state = 'queued' AND e\.import_complete = FALSE/);
  assert.match(select.sql, /presence = 'present'/);
  assert.match(select.sql, /m\.state = 'active'/);
  assert.deepEqual(select.params, [userId, accountId], 'owner scoped');
  const promote = statements.find(s => s.sql.includes('SET priority'));
  assert.match(promote.sql, /kind = 'body' AND state IN \('queued','paused'\)/);
  assert.deepEqual(promote.params, [sync.BODY_PRIORITY, userId, accountId, sync.BODY_PRIORITY]);
});

test('a manual sync queues set-aside slow messages again; a scheduled one does not', async t => {
  const sync = stub<typeof import('../src/services/mail-engine/sync')>(t, [[engine('runtime'), { async enqueueJob() {} }]], engine('sync'));
  for (const retrySlow of [false, true]) {
    const statements: FixtureValue[] = [];
    const db = { async execute(sql: string, params: FixtureValue) {
      statements.push({ sql, params });
      if (sql.includes("SET content_state = 'queued'")) return [{ affectedRows: 3 }];
      if (sql.includes('SELECT DISTINCT o.mailbox_id')) return [[]];
      if (sql.includes('UPDATE mail_engine_jobs SET priority')) return [{ affectedRows: 0 }];
      throw Error(`Unexpected SQL: ${sql}`);
    } };
    await sync.enqueuePendingBodies({ userId, accountId, retrySlow }, db as FixtureValue);
    const requeue = statements.filter(s => s.sql.includes("SET content_state = 'queued'"));
    if (!retrySlow) { assert.deepEqual(requeue, []); continue; }
    assert.equal(requeue.length, 1);
    assert.equal(statements.indexOf(requeue[0]), 0, 'requeued before mailboxes are collected');
    assert.match(requeue[0].sql, /content_state = 'slow' AND import_complete = FALSE/);
    assert.deepEqual(requeue[0].params, [userId, accountId], 'owner scoped');
  }
});
