const test = require('node:test');
const assert = require('node:assert/strict');

// A large body backlog (thousands of discovered messages without content) must
// drain in batches, ahead of background sweeps, and must not be stranded when
// a body chain stops.
const userId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const accountId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const engine = name => require.resolve(`../src/services/mail-engine/${name}`);

function stub(t, entries, target) {
  const paths = [...entries.map(([p]) => p), target];
  const prior = paths.map(p => require.cache[p]);
  for (const [p, exports] of entries) require.cache[p] = { id: p, filename: p, loaded: true, exports };
  delete require.cache[target];
  t.after(() => paths.forEach((p, i) => { if (prior[i]) require.cache[p] = prior[i]; else delete require.cache[p]; }));
  return require(target);
}

function backlog(t, count) {
  const queued = Array.from({ length: count }, (_, i) => ({ occurrence_id: `occ-${i}`, uid: count - i, uidvalidity: 7,
    email_id: `email-${i}`, import_complete: 0, is_read: 0 }));
  const persisted = [], reports = [];
  const db = { async execute(sql) {
    if (sql.includes('SELECT o.id AS occurrence_id')) return [queued.slice(0, 1)];
    throw Error(`Unexpected SQL: ${sql}`);
  } };
  const content = stub(t, [
    [engine('repository'), { withTransaction: fn => fn(db) }],
    [engine('runtime'), { async assertFence() {} }],
    [engine('transport'), { async selectMailbox() { return { uidvalidity: 7 }; },
      async fetchRawMessage() { return { raw: Buffer.from('From: a@example.test\r\nSubject: Hi\r\n\r\nBody') }; } }],
    [require.resolve('../src/services/mail-import'), { async persistImportedMessage(input) {
      persisted.push(input.uid); queued.shift(); return { emailId: input.existingEmail.id }; } }],
    [require.resolve('../src/services/mail'), { MAIL_RAW_STORAGE_ROOT: '/nonexistent', recordMailServerMessageForDeletion: async () => {} }],
  ], engine('content'));
  const run = (options = {}) => content.processBodySlice({ db, connection: {}, account: { id: accountId, user_id: userId },
    folder: { folderName: 'INBOX', dbFolderName: 'inbox' }, mailboxId: 'box',
    job: { id: 'job', lease_owner: 'worker', worker_generation: 1 }, report: change => reports.push(change), ...options });
  return { content, queued, persisted, reports, run };
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
  await assert.rejects(h.run({ signal: controller.signal, report: change => {
    if (change.processed === 2) controller.abort('interactive-yield');
  } }), error => error.code === 'MAIL_SYNC_CANCELLED');
  assert.deepEqual(h.persisted, [10, 9]);
});

test('discovery requeues body work for every mailbox with queued content and promotes old priorities', async t => {
  const enqueued = [], statements = [];
  const sync = stub(t, [
    [engine('runtime'), { async enqueueJob(input) { enqueued.push(input); } }],
  ], engine('sync'));
  const db = { async execute(sql, params) {
    statements.push({ sql, params });
    if (sql.includes('SELECT DISTINCT o.mailbox_id')) return [[{ mailbox_id: 'inbox' }, { mailbox_id: 'all-mail' }]];
    if (sql.includes('UPDATE mail_engine_jobs SET priority')) return [{ affectedRows: 1 }];
    throw Error(`Unexpected SQL: ${sql}`);
  } };
  assert.deepEqual(await sync.enqueuePendingBodies({ userId, accountId }, db), { mailboxes: 2 });
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
