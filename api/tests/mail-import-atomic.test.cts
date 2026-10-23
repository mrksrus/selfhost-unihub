import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const path = (require('node:path') as typeof import('node:path'));
const os = (require('node:os') as typeof import('node:os'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const { persistImportedMessage } = require('../dist/src/services/mail-import') as typeof import('../src/services/mail-import');

async function fixture(t: import('node:test').TestContext, { failAttachment = false, failCommit = false, existingEmail = null, heldNotification = false }: FixtureValue = {}) {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'mail-import-'));
  const previousRoot = process.env.MAIL_ATTACHMENT_UPLOAD_ROOT;
  process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.MAIL_ATTACHMENT_UPLOAD_ROOT;
    else process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });
  const calls: FixtureValue[] = [];
  const statements: FixtureValue[] = [];
  let committed = false;
  let rolledBack = false;
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { committed = true; calls.push('commit'); if (failCommit) throw new Error('Connection lost after COMMIT'); },
    async rollback() { rolledBack = true; calls.push('rollback'); },
    release() { calls.push('release'); },
    async execute(sql: string, params: FixtureValue) {
      calls.push(sql); statements.push({ sql, params });
      assert.equal((sql.match(/\?/g) || []).length, (params ?? []).length, 'prepared SQL parameter count');
      if (failAttachment && sql.includes('INSERT INTO email_attachments')) throw new Error('Injected attachment insert failure');
      if (sql.includes('SELECT id, storage_path')) return [[]];
      if (sql.includes('FROM notification_events')) return [heldNotification ? [{ id: 'event-1', payload: JSON.stringify({ kind: 'mail', held: true }) }] : []];
      if (sql.includes('FROM emails e LEFT JOIN mail_folders')) return [[{ id: params[0], subject: 'Subject', from_name: 'Sender', from_address: 'sender@example.test', folder: 'inbox', mail_account_id: null, is_draft: 0, is_read: 0 }]];
      if (sql.includes('FROM setting_policies')) return [[]];
      if (sql.includes('FROM push_subscriptions p')) return [[{ id: 'device-1' }]];
      return [{ affectedRows: 1 }];
    },
  };
  const args = {
    db: { async getConnection() { return connection; } }, account: { user_id: 'u1', sync_mode: 'download' }, accountId: 'a1',
    folderName: 'INBOX', uid: 1, uidValidity: 10, existingEmail, messageId: '<id@example.test>',
    fullEmail: Buffer.from([0x52, 0x61, 0x77, 0xff]), parsed: { subject: 'Subject', text: 'text', html: '<img src="cid:pic">',
      attachments: [{ filename: 'pic.png', contentType: 'image/png', cid: 'pic', content: Buffer.from('image') }] },
    fromAddress: 'sender@example.test', fromName: 'Sender', toAddresses: ['recipient@example.test'], folder: 'inbox', isRead: false,
    async archiveRaw({ emailId, rawEmail }: FixtureValue) {
      const rawStoragePath = path.join(root, `${emailId}.eml`);
      await fs.writeFile(rawStoragePath, rawEmail);
      return { rawStoragePath, rawSha256: crypto.createHash('sha256').update(rawEmail).digest('hex'),
        rawBytes: rawEmail.length, rawFormat: 'exact_octets', rawVerified: true };
    },
    async enqueueDeletion({ connection: actual }: FixtureValue) {
      assert.equal(actual, connection);
      assert.ok(calls.some(sql => sql.includes('INSERT INTO email_attachments')));
      assert.equal(committed, false);
      calls.push('queue deletion');
    },
  };
  return { root, args, calls, statements, get committed() { return committed; }, get rolledBack() { return rolledBack; } };
}

test('complete imported message, attachments and deletion queue commit together', async (t) => {
  const h = await fixture(t);
  const result = await persistImportedMessage(h.args as FixtureValue);
  assert.equal(result.isNew, true);
  assert.equal(h.committed, true);
  assert.equal(h.rolledBack, false);
  const insert = h.calls.find(sql => sql.includes('INSERT INTO emails'));
  assert.match(insert, /import_complete/);
  assert.match(insert, /raw_verified/);
  assert.ok(h.calls.indexOf('queue deletion') < h.calls.indexOf('commit'));
  const archived = path.join(h.root, `${result.emailId}.eml`);
  assert.deepEqual(await fs.readFile(archived), h.args.fullEmail);
});

test('attachment persistence failure rolls back metadata and removes staged raw and attachment files', async (t) => {
  const h = await fixture(t, { failAttachment: true });
  await assert.rejects(persistImportedMessage(h.args as FixtureValue), /Injected attachment/);
  assert.equal(h.committed, false);
  assert.equal(h.rolledBack, true);
  assert.equal(h.calls.includes('queue deletion'), false);
  const rootEntries = await fs.readdir(h.root);
  assert.deepEqual(rootEntries, ['u1']);
  assert.deepEqual(await fs.readdir(path.join(h.root, 'u1')), []);
});

test('repair updates completeness and content while preserving local folder and read/star choices', async (t) => {
  const h = await fixture(t, { existingEmail: { id: 'existing', import_complete: false } });
  const result = await persistImportedMessage(h.args as FixtureValue);
  assert.equal(result.isNew, false);
  const update = h.calls.find(sql => sql.includes('UPDATE emails SET'));
  assert.match(update, /import_complete = TRUE/);
  assert.doesNotMatch(update, /\bfolder =|is_read =|is_starred =/);
});

test('uncertain COMMIT retains staged files that committed metadata may reference', async (t) => {
  const h = await fixture(t, { failCommit: true });
  await assert.rejects(persistImportedMessage(h.args as FixtureValue), /Connection lost after COMMIT/);
  assert.equal(h.committed, true);
  assert.equal((await fs.readdir(path.join(h.root, 'u1'))).length, 1);
  assert.equal((await fs.readdir(h.root)).filter(name => name.endsWith('.eml')).length, 1);
});

test('the import releases the notification held at discovery inside its own transaction', async (t) => {
  const h = await fixture(t, { existingEmail: { id: 'existing', import_complete: false }, heldNotification: true });
  await persistImportedMessage(h.args as FixtureValue);
  const release = h.calls.findIndex(sql => sql.includes('UPDATE notification_events SET payload'));
  const delivery = h.calls.findIndex(sql => sql.includes('INSERT IGNORE INTO notification_deliveries'));
  const commit = h.calls.indexOf('commit');
  assert.ok(release > 0 && release < commit, 'the held event is filled in before COMMIT');
  assert.ok(delivery > release && delivery < commit, 'its deliveries are queued in the same transaction');
  assert.ok(h.calls.indexOf('begin') < release, 'and only after the transaction began');
});

test('an import without a held notification sends nothing', async (t) => {
  const h = await fixture(t, { existingEmail: { id: 'existing', import_complete: false } });
  await persistImportedMessage(h.args as FixtureValue);
  assert.ok(!h.calls.some(sql => sql.includes('notification_deliveries') || sql.includes('UPDATE notification_events')));
});

// The fake accepts any length; the real-database case is in mail-mysql-integration.
test('header values longer than their columns are stored cut to the column length; the raw message keeps the originals', async (t) => {
  const h = await fixture(t);
  const args = { ...h.args, messageId: `<${'m'.repeat(600)}@example.test>`, fromAddress: `${'a'.repeat(300)}@example.test`,
    fromName: '\u{1F600}'.repeat(300), parsed: { ...h.args.parsed, html: '<img src="cid:pic">', attachments: [
      { filename: `${'f'.repeat(300)}.png`, contentType: `image/${'x'.repeat(150)}`, contentId: 'c'.repeat(300), content: Buffer.from('image') }] } };
  const result = await persistImportedMessage(args as FixtureValue);
  assert.equal(h.committed, true);
  const email = h.statements.find(s => s.sql.includes('INSERT INTO emails')).params;
  assert.equal(email[3], args.messageId.slice(0, 500));
  assert.equal(email[5], args.fromAddress.slice(0, 255));
  assert.equal(Array.from(email[6]).length, 255, 'characters, not UTF-16 units: no surrogate pair is split');
  assert.equal(email[6], '\u{1F600}'.repeat(255));
  const attachment = h.statements.find(s => s.sql.includes('INSERT INTO email_attachments')).params;
  assert.equal(attachment[3], 'f'.repeat(255));
  assert.equal(attachment[4], `image/${'x'.repeat(94)}`);
  assert.equal(attachment[7], 'c'.repeat(255));
  await fs.access(attachment[6]);
  assert.deepEqual(await fs.readFile(path.join(h.root, `${result.emailId}.eml`)), h.args.fullEmail);
});
