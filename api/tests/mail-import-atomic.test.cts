import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const path = (require('node:path') as typeof import('node:path'));
const os = (require('node:os') as typeof import('node:os'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const { persistImportedMessage } = require('../dist/src/services/mail-import');

async function fixture(t: import('node:test').TestContext, { failAttachment = false, failCommit = false, existingEmail = null }: FixtureValue = {}) {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'mail-import-'));
  const previousRoot = process.env.MAIL_ATTACHMENT_UPLOAD_ROOT;
  process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = root;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.MAIL_ATTACHMENT_UPLOAD_ROOT;
    else process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  });
  const calls: FixtureValue[] = [];
  let committed = false;
  let rolledBack = false;
  const connection = {
    async beginTransaction() { calls.push('begin'); },
    async commit() { committed = true; calls.push('commit'); if (failCommit) throw new Error('Connection lost after COMMIT'); },
    async rollback() { rolledBack = true; calls.push('rollback'); },
    release() { calls.push('release'); },
    async execute(sql: string, params: FixtureValue) {
      calls.push(sql);
      assert.equal((sql.match(/\?/g) || []).length, params.length, 'prepared SQL parameter count');
      if (failAttachment && sql.includes('INSERT INTO email_attachments')) throw new Error('Injected attachment insert failure');
      if (sql.includes('SELECT id, storage_path')) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  const args = {
    db: { async getConnection() { return connection; } }, account: { user_id: 'u1', sync_mode: 'download' }, accountId: 'a1',
    folderName: 'INBOX', uid: 1, uidValidity: 10, existingEmail, messageId: '<id@example.test>',
    fullEmail: Buffer.from([0x52, 0x61, 0x77, 0xff]), parsed: { subject: 'Subject', text: 'text', html: '<img src="cid:pic">',
      attachments: [{ filename: 'pic.png', contentType: 'image/png', cid: 'pic', content: Buffer.from('image') }] },
    fromAddress: 'sender@example.test', fromName: 'Sender', toAddresses: ['recipient@example.test'], folder: 'inbox', isRead: false,
    suppressNotifications: true,
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
  return { root, args, calls, get committed() { return committed; }, get rolledBack() { return rolledBack; } };
}

test('complete imported message, attachments and deletion queue commit together', async (t) => {
  const h = await fixture(t);
  const result = await persistImportedMessage(h.args);
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
  await assert.rejects(persistImportedMessage(h.args), /Injected attachment/);
  assert.equal(h.committed, false);
  assert.equal(h.rolledBack, true);
  assert.equal(h.calls.includes('queue deletion'), false);
  const rootEntries = await fs.readdir(h.root);
  assert.deepEqual(rootEntries, ['u1']);
  assert.deepEqual(await fs.readdir(path.join(h.root, 'u1')), []);
});

test('repair updates completeness and content while preserving local folder and read/star choices', async (t) => {
  const h = await fixture(t, { existingEmail: { id: 'existing', import_complete: false } });
  const result = await persistImportedMessage(h.args);
  assert.equal(result.isNew, false);
  const update = h.calls.find(sql => sql.includes('UPDATE emails SET'));
  assert.match(update, /import_complete = TRUE/);
  assert.doesNotMatch(update, /\bfolder =|is_read =|is_starred =/);
});

test('uncertain COMMIT retains staged files that committed metadata may reference', async (t) => {
  const h = await fixture(t, { failCommit: true });
  await assert.rejects(persistImportedMessage(h.args), /Connection lost after COMMIT/);
  assert.equal(h.committed, true);
  assert.equal((await fs.readdir(path.join(h.root, 'u1'))).length, 1);
  assert.equal((await fs.readdir(h.root)).filter(name => name.endsWith('.eml')).length, 1);
});
