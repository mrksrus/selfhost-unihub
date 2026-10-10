import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));

const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const accountId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const emailId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const folder = { folderName: 'INBOX', dbFolderName: 'inbox' };

// Real bounded sync algorithm with fake transactional storage and provider.
// The retired pre-0.11 folder sync used ALL and a global import checkpoint; the
// durable engine has independent recent/history and body work instead.
function scanFixture(t: import('node:test').TestContext, { uids = [1, 2, 3], epoch = 100 }: FixtureValue = {}) {
  const names = ['repository', 'runtime', 'transport', 'sync'];
  const paths = names.map(n => require.resolve(`../dist/src/services/mail-engine/${n}`));
  const prior = paths.map(p => require.cache[p]);
  const remotes = new Set<FixtureValue>(uids), occurrences = new Map(), cursors = new Map();
  const reads: FixtureValue[] = [], writes: FixtureValue[] = [], bodyJobs: FixtureValue[] = [];
  let selectedEpoch = epoch, storedEpoch = epoch, upper = Math.max(...uids), failWindow = false;
  const db = { async execute(sql: string, params: FixtureValue[] = []) {
    if (sql.includes('SELECT uidvalidity FROM mail_remote_mailboxes')) return [[{ uidvalidity: storedEpoch }]];
    if (sql.includes('SELECT o.uid, o.observation_revision')) return [[...occurrences.values()].filter(o => o.uid >= params[4] && o.uid <= params[5])
      .map(o => ({ uid: o.uid, observation_revision: o.observation_revision, email_revision: 0, observed_modseq: null }))];
    if (sql.includes('SELECT o.email_id FROM mail_remote_occurrences')) return [[occurrences.get(params[4])].filter(Boolean)];
    if (sql.includes('FROM mail_writebacks w JOIN')) return [[]];
    if (sql.includes('INSERT INTO emails')) { writes.push(['email', params[0], params[5]]); return [{ affectedRows: 1 }]; }
    if (sql.includes('UPDATE emails')) return [{ affectedRows: 1 }];
    throw Error(`Unexpected SQL: ${sql}`);
  } };
  const repository = {
    withTransaction: (fn: FixtureValue) => fn(db),
    async ensureMailbox({ epoch: observed }: FixtureValue) {
      if (storedEpoch !== observed) { storedEpoch = observed; occurrences.clear(); cursors.clear(); }
      return { id: 'box', uidvalidity: observed };
    },
    async loadCursor({ stream }: FixtureValue) { return cursors.get(stream) || null; },
    async saveCursor(input: FixtureValue) { cursors.set(input.stream, { covered_through: input.coveredThrough,
      coverage_json: input.coverage, uidvalidity: input.epoch }); writes.push(['cursor', input.stream, input.coveredThrough]); },
    async getOccurrence({ uid }: FixtureValue) { return occurrences.get(uid) || null; },
    async upsertOccurrence(input: FixtureValue) {
      const row = { uid: input.uid, email_id: input.emailId, observation_revision: input.observationRevision };
      occurrences.set(input.uid, row); return row;
    },
  };
  const transport = {
    async selectMailbox() { return { uidvalidity: selectedEpoch, uidnext: upper + 1, capabilities: {} }; },
    async fetchMetadataWindow(_connection: FixtureValue, input: FixtureValue) {
      reads.push([input.startUid, input.endUid]);
      return { ...input, complete: !failWindow, uidvalidity: selectedEpoch,
        items: [...remotes].filter(uid => uid >= input.startUid && uid <= input.endUid).map(uid => ({ uid, flags: [] })) };
    },
  };
  const runtime = { async assertFence() {}, async enqueueJob(input: FixtureValue) { bodyJobs.push(input); } };
  for (const [p, exports] of [[paths[0], repository], [paths[1], runtime], [paths[2], transport]] as const)
    require.cache[p] = { id: p, filename: p, loaded: true, exports } as NodeJS.Module;
  delete require.cache[paths[3]];
  const { scanMailboxSlice } = require(paths[3]) as typeof import('../src/services/mail-engine/sync');
  t.after(() => paths.forEach((p, i) => { if (prior[i]) require.cache[p] = prior[i]; else delete require.cache[p]; }));
  return { reads, writes, occurrences, cursors, bodyJobs,
    setEpoch(n: FixtureValue) { selectedEpoch = n; }, setUpper(n: FixtureValue) { upper = n; }, fail(value: FixtureValue) { failWindow = value; },
    scan(stream = 'history') { return scanMailboxSlice({ db: db as FixtureValue, connection: {} as FixtureValue, account: { id: accountId, user_id: userId }, folder, stream }); } };
}

test('new folder scans historical UIDs despite recent account timestamp; bodies remain independently queued', async t => {
  const h = scanFixture(t, { uids: [1, 2, 300] });
  assert.equal((await h.scan('recent')).inserted, 1);
  assert.deepEqual(h.reads[0], [173, 300], 'recent is bounded, never ALL');
  assert.equal((await h.scan('history')).inserted, 2);
  assert.deepEqual(h.reads[1], [1, 128]);
  assert(h.bodyJobs.every(job => job.kind === 'body'));
  assert.equal(h.occurrences.size, 3);
});

test('failed historical window retains checkpoint and retries without reimporting already observed items', async t => {
  const h = scanFixture(t);
  h.fail(true);
  await assert.rejects(h.scan(), /Incomplete/);
  assert.equal(h.cursors.has('history'), false);
  assert.equal(h.occurrences.size, 0);
  h.fail(false);
  assert.equal((await h.scan()).inserted, 3);
  assert.equal(h.cursors.get('history').covered_through, 3);
  assert.deepEqual(h.reads, [[1, 3], [1, 3]]);
  assert.equal(h.writes.filter(w => w[0] === 'email').length, 3);
});

test('UIDVALIDITY changes reset the folder baseline without reusing an old occurrence identity', async t => {
  const h = scanFixture(t, { uids: [1] });
  await h.scan();
  const old = h.occurrences.get(1).email_id;
  h.setEpoch(101);
  await h.scan();
  assert.deepEqual(h.reads, [[1, 1], [1, 1]]);
  assert.notEqual(h.occurrences.get(1).email_id, old);
  assert.equal(h.cursors.get('history').uidvalidity, 101);
});

function bodyFixture(t: import('node:test').TestContext, { missing = false, tamper = false, uidStillPresent = false }: FixtureValue = {}) {
  const paths = ['repository', 'runtime', 'transport', 'content'].map(n => require.resolve(`../dist/src/services/mail-engine/${n}`));
  const importPath = require.resolve('../dist/src/services/mail-import');
  const mailPath = require.resolve('../dist/src/services/mail');
  const prior = [...paths, importPath, mailPath].map(p => require.cache[p]);
  const root = path.join(process.env.TMPDIR || (require('node:os') as typeof import('node:os')).tmpdir(), `mail-checkpoints-${crypto.randomUUID()}`);
  const raw = Buffer.from('From: sender@example.test\r\nTo: receiver@example.test\r\nMessage-ID: <legacy@example.test>\r\nSubject: Archived\r\n\r\nRecovered from raw archive');
  const row = { occurrence_id: 'occurrence', uid: 1, uidvalidity: 100, email_id: emailId,
    raw_storage_path: path.join(root, userId, 'legacy.eml'), raw_sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    raw_bytes: raw.length, raw_format: 'exact_octets', raw_verified: 1, import_complete: 0, is_read: 0 };
  if (tamper) row.raw_sha256 = '0'.repeat(64);
  let failPersist = false, complete = false;
  const persisted: FixtureValue[] = [], fetched: FixtureValue[] = [];
  const db = { async execute(sql: string) {
    if (sql.includes('SELECT o.id AS occurrence_id')) return [complete ? [] : [row]];
    if (sql.includes('SELECT o.email_id FROM mail_remote_occurrences')) return [[{ email_id: emailId }]];
    throw Error(`Unexpected SQL: ${sql}`);
  } };
  const repo = { withTransaction: (fn: FixtureValue) => fn(db) };
  const runtime = { async assertFence() {} };
  const transport = {
    async selectMailbox() { return { uidvalidity: 100 }; },
    async fetchMetadataWindow(_connection: FixtureValue, input: FixtureValue) { return { uidvalidity: 100, startUid: input.startUid,
      endUid: input.endUid, complete: true, items: uidStillPresent ? [{ uid: 1, flags: [] }] : [] }; },
    async fetchRawMessage(_connection: FixtureValue, input: FixtureValue) {
      fetched.push(input.uid);
      if (missing) throw new Error('Raw fetch must return exactly one message');
      return { raw };
    },
  };
  for (const [p, exports] of [[paths[0], repo], [paths[1], runtime], [paths[2], transport],
    [importPath, { async persistImportedMessage(input: FixtureValue) {
      if (failPersist) throw new Error('Injected storage failure');
      persisted.push(input); complete = true; return { emailId };
    } }], [mailPath, { MAIL_RAW_STORAGE_ROOT: root, recordMailServerMessageForDeletion: async () => {} }]] as const)
    require.cache[p] = { id: p, filename: p, loaded: true, exports } as NodeJS.Module;
  delete require.cache[paths[3]];
  const { processBodySlice } = require(paths[3]) as typeof import('../src/services/mail-engine/content');
  t.after(async () => {
    [...paths, importPath, mailPath].forEach((p, i) => { if (prior[i]) require.cache[p] = prior[i]; else delete require.cache[p]; });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { row, raw, root, fetched, get persisted() { return persisted; }, fail(value: FixtureValue) { failPersist = value; },
    async archive() { await fs.mkdir(path.dirname(row.raw_storage_path), { recursive: true }); await fs.writeFile(row.raw_storage_path, raw); },
    run() { return processBodySlice({ db: db as FixtureValue, connection: {} as FixtureValue, account: { id: accountId, user_id: userId }, folder, mailboxId: 'box',
      job: { id: 'job', lease_owner: 'worker', worker_generation: 1 } as FixtureValue }); } };
}

test('independent body job retries incomplete old UID below its recent metadata checkpoint', async t => {
  const h = bodyFixture(t);
  h.fail(true);
  await assert.rejects(h.run(), /Injected storage failure/);
  assert.equal(h.persisted.length, 0);
  h.fail(false);
  assert.equal((await h.run()).processed, 1);
  assert.deepEqual(h.fetched, [1, 1]);
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].uid, 1);
  assert.equal((await h.run()).more, false);
});

test('provider-missing incomplete message recovers only from verified exact local archive', async t => {
  const h = bodyFixture(t, { missing: true });
  await h.archive();
  assert.equal((await h.run()).processed, 1);
  assert.equal(h.persisted[0].existingEmail.id, emailId);
  assert(Buffer.isBuffer(h.persisted[0].fullEmail));
  assert.match(h.persisted[0].fullEmail.toString(), /Recovered from raw archive/);
});

test('provider-missing body refuses a tampered archive rather than accepting unverified bytes', async t => {
  const bad = bodyFixture(t, { missing: true, tamper: true });
  await bad.archive();
  await assert.rejects(bad.run(), /Raw fetch must return exactly one message/);
  assert.equal(bad.persisted.length, 0, 'tampered archive cannot silently repair an incomplete import');
});

test('malformed raw FETCH never falls back when the exact provider UID still exists', async t => {
  const h = bodyFixture(t, { missing: true, uidStillPresent: true });
  await h.archive();
  await assert.rejects(h.run(), /Raw fetch must return exactly one message/);
  assert.equal(h.persisted.length, 0, 'a nonempty exact UID probe is not provider absence');
});
