const test = require('node:test');
const assert = require('node:assert/strict');
const routes = require('../src/routes/mail');
const { getDb, setDb } = require('../src/state');
const { presentMailFiling, folderAcceptsAccount } = require('../src/services/mail-filing');

const request = url => ({ url, headers: { host: 'localhost' } });
const recovered = () => ({ id: 'message', user_id: 'user', mail_account_id: 'source', filing_account_id: 'receiving',
  folder: 'inbox', source_folder: 'Provider/Original', imap_uid: 41, imap_uidvalidity: 12, is_legacy: 0,
  from_address: 'sender@example.test', to_addresses: '[]', received_at_cursor: '2026-09-12 09:00:00.000000' });

function installDb(t, db) {
  const previous = getDb(); setDb(db); t.after(() => setDb(previous));
}

test('list and detail preserve provider identity while presenting the receiving account', async t => {
  const stored = recovered();
  installDb(t, { async execute(sql, params) {
    assert.equal(params.includes('user'), true);
    if (sql.includes('COUNT(*)')) return [[{ total: 1 }]];
    if (sql.includes('FROM email_attachments')) return [[]];
    assert.match(sql, /FROM emails/);
    if (!sql.includes('SELECT *')) {
      assert.match(sql, /is_legacy = FALSE AND COALESCE\(filing_account_id, mail_account_id\) = \?/);
      assert.equal(params.includes('receiving'), true);
    }
    return [[{ ...stored }]];
  } });
  const list = await routes['GET /api/mail/emails'](request('/api/mail/emails?account_id=receiving'), 'user');
  const detail = await routes['GET /api/mail/emails/:id'](request('/api/mail/emails/message'), 'user');
  for (const email of [list.emails[0], detail.email]) {
    assert.equal(email.mail_account_id, 'receiving');
    assert.equal(email.source_mail_account_id, 'source');
    assert.equal(email.source_folder, undefined);
    assert.equal(email.imap_uid, undefined);
    assert.equal(email.imap_uidvalidity, undefined);
    assert.equal(email.is_legacy, false);
  }
  assert.deepEqual(presentMailFiling(presentMailFiling(stored)), presentMailFiling(stored));
  assert.equal(stored.mail_account_id, 'source');
  assert.equal(stored.source_folder, 'Provider/Original');
  assert.equal(stored.imap_uid, 41);
  assert.equal(stored.imap_uidvalidity, 12);
});

function backfillDb({ concurrentChange = false, target = 'connected' } = {}) {
  const stored = recovered();
  let changed = 0;
  const calls = [];
  const folders = [
    { slug: 'inbox', is_system: true },
    { slug: 'source-only', mail_account_id: 'source', is_system: false },
    { slug: 'connected', mail_account_id: null, is_system: false },
    { slug: 'unconnected', mail_account_id: null, is_system: false },
  ];
  const db = { async execute(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('SELECT id FROM mail_accounts')) return [[{ id: 'receiving' }]];
    if (sql.includes('FROM emails e')) {
      assert.match(sql, /e.is_legacy = FALSE/);
      assert.match(sql, /COALESCE\(e.filing_account_id, e.mail_account_id\) = \?/);
      assert.equal(params[1], 'receiving');
      return [[{ ...stored }]];
    }
    if (sql.includes('INSERT INTO mail_folders')) return [{ affectedRows: 0 }];
    if (sql.includes('JOIN mail_folder_remote_boxes')) return [[{ slug: 'connected', mail_account_id: 'receiving' }]];
    if (sql.includes('FROM mail_folders')) return [folders];
    if (sql.includes('FROM mail_sender_rules')) {
      assert.deepEqual(params, ['receiving', 'user', 'receiving']);
      return [[{ id: 'receiving-rule', mail_account_id: 'receiving', match_type: 'email', match_value: 'sender@example.test', target_folder: target }]];
    }
    if (sql.includes('UPDATE emails SET folder')) {
      assert.match(sql, /folder = \? AND is_legacy = FALSE/);
      assert.match(sql, /mail_account_id <=> \? AND filing_account_id <=> \?/);
      const [folder, id, userId, originalFolder, source, filing] = params;
      assert.equal(id, stored.id); assert.equal(userId, stored.user_id);
      if (stored.folder !== originalFolder || stored.mail_account_id !== source || stored.filing_account_id !== filing || stored.is_legacy) return [{ affectedRows: 0 }];
      stored.folder = folder; changed++; return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL ${sql}`);
  }, async getConnection() { return { execute: db.execute,
    async beginTransaction() { if (concurrentChange) stored.filing_account_id = 'source'; },
    async commit() {}, async rollback() {}, release() {},
  }; } };
  return { db, stored, calls, changed: () => changed };
}

test('sender backfill uses receiving-account rules and connected destinations without rewriting provider IDs', async t => {
  const f = backfillDb(); installDb(t, f.db);
  const result = await routes['POST /api/mail/sender-rules/backfill']({}, 'user', { account_id: 'receiving', mode: 'apply' });
  assert.equal(result.matched, 1); assert.equal(result.applied, 1);
  assert.equal(result.updates[0].rule_id, 'receiving-rule');
  assert.equal(f.stored.folder, 'connected');
  assert.equal(f.stored.mail_account_id, 'source');
  assert.equal(f.stored.filing_account_id, 'receiving');
  assert.equal(f.stored.source_folder, 'Provider/Original');
  assert.equal(f.stored.imap_uid, 41);
});

test('sender backfill skips messages whose filing changed after scanning and reports actual applied count', async t => {
  const f = backfillDb({ concurrentChange: true }); installDb(t, f.db);
  const result = await routes['POST /api/mail/sender-rules/backfill']({}, 'user', { account_id: 'receiving', mode: 'apply' });
  assert.equal(result.matched, 1); assert.equal(result.applied, 0);
  assert.equal(f.stored.folder, 'inbox'); assert.equal(f.changed(), 0);
});

for (const target of ['source-only', 'unconnected']) test(`sender backfill rejects destination ${target} outside receiving account`, async t => {
  const f = backfillDb({ target }); installDb(t, f.db);
  const result = await routes['POST /api/mail/sender-rules/backfill']({}, 'user', { account_id: 'receiving', mode: 'apply' });
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
