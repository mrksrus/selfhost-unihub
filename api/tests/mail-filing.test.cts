import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const routes = require('../dist/src/routes/mail') as typeof import('../src/routes/mail');
const { getDb, setDb } = require('../dist/src/state') as typeof import('../src/state');
const { presentMailFiling, folderAcceptsAccount } = require('../dist/src/services/mail-filing') as typeof import('../src/services/mail-filing');
const mailWritebacks = require('../dist/src/services/mail-writebacks') as typeof import('../src/services/mail-writebacks');

const request = (url: string) => ({ url, headers: { host: 'localhost' } });
const recovered = () => ({ id: 'message', user_id: 'user', mail_account_id: 'source', filing_account_id: 'receiving',
  folder: 'inbox', source_folder: 'Provider/Original', imap_uid: 41, imap_uidvalidity: 12, is_legacy: 0,
  from_address: 'sender@example.test', to_addresses: '[]', received_at_cursor: '2026-09-12 09:00:00.000000' });

function installDb(t: import('node:test').TestContext, db: FixtureValue) {
  const previous = getDb(); setDb(db); t.after(() => setDb(previous));
}

test('list and detail preserve provider identity while presenting the receiving account', async t => {
  const stored: FixtureValue = recovered();
  stored.is_read = 1;
  stored.is_starred = 0;
  installDb(t, { async execute(sql: string, params: FixtureValue) {
    assert.equal(params.includes('user'), true);
    if (sql.includes('COUNT(*)')) return [[{ total: 1 }]];
    if (sql.includes('FROM email_attachments')) return [[]];
    assert.match(sql, /FROM emails/);
    if (sql.includes('FROM emails WHERE id = ? AND user_id = ?')) {
      assert.deepEqual(params, ['message', 'user']);
      return [[{ ...stored, effective_is_read: stored.is_read, effective_is_starred: stored.is_starred }]];
    }
    assert.match(sql, /is_legacy = FALSE AND COALESCE\(filing_account_id, mail_account_id\) = \?/);
    assert.equal(params.includes('receiving'), true);
    return [[{ ...stored }]];
  } });
  const list = await routes['GET /api/mail/emails'](request('/api/mail/emails?account_id=receiving') as FixtureValue, 'user');
  const detail = await routes['GET /api/mail/emails/:id'](request('/api/mail/emails/message') as FixtureValue, 'user');
  assert.equal(list.error, undefined);
  assert.equal(detail.error, undefined);
  for (const email of [list.emails[0], detail.email]) {
    assert.equal(email.mail_account_id, 'receiving');
    assert.equal(email.source_mail_account_id, 'source');
    assert.equal((email as FixtureValue).source_folder, undefined);
    assert.equal((email as FixtureValue).imap_uid, undefined);
    assert.equal((email as FixtureValue).imap_uidvalidity, undefined);
    assert.equal(email.is_legacy, false);
    assert.equal(email.is_read, true);
    assert.equal(email.is_starred, false);
  }
  assert.deepEqual(presentMailFiling(presentMailFiling(stored)), presentMailFiling(stored));
  assert.equal(stored.mail_account_id, 'source');
  assert.equal(stored.source_folder, 'Provider/Original');
  assert.equal(stored.imap_uid, 41);
  assert.equal(stored.imap_uidvalidity, 12);
});

function backfillDb(t: import('node:test').TestContext, { concurrentChange = false, target = 'connected', syncMode = 'download', remoteLinks = ['receiving'] }: FixtureValue = {}) {
  const stored = { ...recovered(), sync_mode: syncMode };
  const moves: FixtureValue[] = [];
  const folders = [
    { slug: 'inbox', is_system: true },
    { slug: 'archive', is_system: true },
    { slug: 'source-only', mail_account_id: 'source', is_system: false },
    { slug: 'connected', mail_account_id: null, is_system: false },
    { slug: 'unconnected', mail_account_id: null, is_system: false },
  ];
  installDb(t, { async execute(sql: string, params: FixtureValue) {
    if (sql.includes('SELECT id FROM mail_accounts')) return [[{ id: 'receiving' }]];
    if (sql.includes('FROM emails e')) {
      assert.match(sql, /e.is_legacy = FALSE/);
      assert.match(sql, /COALESCE\(e.filing_account_id, e.mail_account_id\) = \?/);
      assert.doesNotMatch(sql, /sync_mode = 'sync'/);
      assert.equal(params[1], 'receiving');
      return [[{ ...stored }]];
    }
    if (sql.includes('INSERT INTO mail_folders')) return [{ affectedRows: 0 }];
    if (sql.includes('JOIN mail_folder_remote_boxes')) return [remoteLinks.map((account: FixtureValue) => ({ slug: 'connected', mail_account_id: account }))];
    if (sql.includes('FROM mail_folders')) return [folders];
    if (sql.includes('FROM mail_sender_rules')) {
      assert.deepEqual(params, ['receiving', 'user', 'receiving']);
      return [[{ id: 'receiving-rule', mail_account_id: 'receiving', match_type: 'email', match_value: 'sender@example.test', target_folder: target }]];
    }
    throw new Error(`Unexpected SQL ${sql}`);
  } });
  // Stands in for the shared move path: locks rows, validates, then moves.
  t.mock.method(mailWritebacks, 'mutateMessages', async (userId: string, ids: FixtureValue, changes: FixtureValue, validate: FixtureValue) => {
    assert.equal(userId, 'user'); assert.deepEqual(ids, [stored.id]);
    if (concurrentChange) stored.filing_account_id = 'source';
    await validate(null, [{ ...stored }]);
    moves.push({ ids, changes });
    stored.folder = changes.move;
    return { sync_pending: stored.sync_mode === 'sync', operation_ids: stored.sync_mode === 'sync' ? ['operation'] : [] };
  });
  return { stored, moves };
}

test('sender backfill uses receiving-account rules and connected destinations without rewriting provider IDs', async t => {
  const f = backfillDb(t);
  const result = await routes['POST /api/mail/sender-rules/backfill']({} as FixtureValue, 'user', { account_id: 'receiving', mode: 'apply' });
  assert.equal(result.matched, 1); assert.equal(result.applied, 1); assert.equal(result.queued, 0);
  assert.equal(result.updates[0].rule_id, 'receiving-rule');
  assert.deepEqual(f.moves, [{ ids: ['message'], changes: { move: 'connected' } }]);
  assert.equal(f.stored.folder, 'connected');
  assert.equal(f.stored.mail_account_id, 'source');
  assert.equal(f.stored.filing_account_id, 'receiving');
  assert.equal(f.stored.source_folder, 'Provider/Original');
  assert.equal(f.stored.imap_uid, 41);
});

test('sender backfill dry run reports matches without moving mail', async t => {
  const f = backfillDb(t);
  const result = await routes['POST /api/mail/sender-rules/backfill']({} as FixtureValue, 'user', { account_id: 'receiving' });
  assert.equal(result.dry_run, true); assert.equal(result.matched, 1); assert.equal(result.applied, 0);
  assert.deepEqual(f.moves, []);
});

test('sender backfill skips messages whose filing changed after scanning and reports actual applied count', async t => {
  const f = backfillDb(t, { concurrentChange: true });
  const result = await routes['POST /api/mail/sender-rules/backfill']({} as FixtureValue, 'user', { account_id: 'receiving', mode: 'apply' });
  assert.equal(result.matched, 1); assert.equal(result.applied, 0); assert.equal(result.skipped, 1);
  assert.equal(f.stored.folder, 'inbox'); assert.deepEqual(f.moves, []);
});

test('sender backfill queues server moves for Sync accounts', async t => {
  const f = backfillDb(t, { syncMode: 'sync' });
  f.stored.mail_account_id = 'receiving';
  const result = await routes['POST /api/mail/sender-rules/backfill']({} as FixtureValue, 'user', { account_id: 'receiving', mode: 'apply' });
  assert.equal(result.applied, 1); assert.equal(result.queued, 1); assert.equal(result.skipped, 0);
  assert.deepEqual(f.moves, [{ ids: ['message'], changes: { move: 'connected' } }]);
});

test('sender backfill skips Sync messages when the folder is not on their server', async t => {
  // System folders accept every account, but this one has no server folder.
  const f = backfillDb(t, { syncMode: 'sync', target: 'archive' });
  f.stored.mail_account_id = 'receiving';
  const result = await routes['POST /api/mail/sender-rules/backfill']({} as FixtureValue, 'user', { account_id: 'receiving', mode: 'apply' });
  assert.equal(result.matched, 1); assert.equal(result.applied, 0); assert.equal(result.skipped, 1);
  assert.deepEqual(f.moves, []); assert.equal(f.stored.folder, 'inbox');
});

for (const target of ['source-only', 'unconnected']) test(`sender backfill rejects destination ${target} outside receiving account`, async t => {
  const f = backfillDb(t, { target });
  const result = await routes['POST /api/mail/sender-rules/backfill']({} as FixtureValue, 'user', { account_id: 'receiving', mode: 'apply' });
  assert.equal(result.matched, 0); assert.equal(result.applied, 0);
  assert.equal(f.stored.folder, 'inbox');
});

test('destination validation requires an account and either a system, owned or verified connected folder', () => {
  const links = new Map([['linked', ['receiving']]]);
  assert.equal(folderAcceptsAccount({ slug: 'inbox', is_system: 1 }, 'receiving', links), true);
  assert.equal(folderAcceptsAccount({ slug: 'own', mail_account_id: 'receiving' }, 'receiving', links), true);
  assert.equal(folderAcceptsAccount({ slug: 'linked', is_system: '0' }, 'receiving', links), true);
  assert.equal(folderAcceptsAccount({ slug: 'orphan' }, 'receiving', links), false);
  assert.equal(folderAcceptsAccount({ slug: 'inbox', is_system: true }, null, links), false);
});
