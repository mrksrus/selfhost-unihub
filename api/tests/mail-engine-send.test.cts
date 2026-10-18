import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const path = (require('node:path') as typeof import('node:path'));
const os = (require('node:os') as typeof import('node:os'));

async function temporaryAttachmentRoot(t: import('node:test').TestContext) {
  const previous = process.env.MAIL_ATTACHMENT_UPLOAD_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-send-'));
  process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.MAIL_ATTACHMENT_UPLOAD_ROOT; else process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function mailFixture(t: import('node:test').TestContext, { active = 1, disconnected = null, failCopy = false, displayName = null }: FixtureValue = {}) {
  const state = require.resolve('../dist/src/state');
  const nodemailer = require.resolve('nodemailer');
  const encryption = require.resolve('../dist/src/security/encryption');
  const network = require.resolve('../dist/src/security/outbound-network');
  const settings = require.resolve('../dist/src/services/module-settings');
  const mailPath = require.resolve('../dist/src/services/mail');
  // The Sent copy commits through services/transactions (via mail-engine/repository),
  // which keeps the db it was loaded with; both must reload with this fixture's state stub.
  const repository = require.resolve('../dist/src/services/mail-engine/repository');
  const transactionHelper = require.resolve('../dist/src/services/transactions');
  const paths = [state, nodemailer, encryption, network, settings, mailPath, repository, transactionHelper];
  const original = new Map(paths.map(p => [p, require.cache[p]]));
  delete require.cache[repository]; delete require.cache[transactionHelper];
  let sends = 0, inserts = 0, delivered: FixtureValue = null, sentCopy: FixtureValue = null;
  const attachmentRows: FixtureValue[] = [], transactions: string[] = [];
  // The Sent copy commits through a pool connection; attachment rows are only
  // visible when the same transaction committed.
  const execute = async (sql: string, params: FixtureValue[]) => {
    if (sql.includes('FROM mail_accounts')) return [[account]];
    if (sql.includes('INSERT INTO emails')) {
      inserts++; if (failCopy) throw Error('storage offline');
      sentCopy = { from_address: params[5], from_name: params[6], cc: params[8], bcc: params[9], has_attachments: params[12] };
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('INSERT INTO email_attachments')) {
      attachmentRows.push({ id: params[0], email_id: params[1], user_id: params[2], filename: params[3], content_type: params[4], storage_path: params[6] });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM email_attachments')) return [attachmentRows.filter(row => row.id === params[0] && row.user_id === params[1])];
    return [[]];
  };
  const db = { execute, async getConnection() {
    return { execute, async beginTransaction() { transactions.push('begin'); }, async commit() { transactions.push('commit'); },
      async rollback() { transactions.push('rollback'); }, release() {} };
  } };
  const account = { id: 'account-1', user_id: 'user-1', email_address: 'sender@example.test', display_name: displayName,
    smtp_host: 'smtp.example.test', smtp_port: 587, encrypted_password: 'vault-ciphertext',
    is_active: active, disconnected_at: disconnected, allow_self_signed: 0 };
  const stubs = [
    [state, { db }],
    [nodemailer, { createTransport: () => ({ async sendMail(message: FixtureValue) { sends++; delivered = message; return { messageId: '<delivered@example.test>' }; } }) }],
    [encryption, { decrypt: () => 'test-placeholder' }],
    [network, { normalizeNetworkHost: (x: FixtureValue) => x, isTrustedMailHost: () => true, isPublicNetworkAddress: () => true,
      resolveNetworkHost: async () => [], resolveMailConnectionTarget: async () => ({ address: '127.0.0.1', hostname: 'smtp.example.test' }) }],
    [settings, { isModuleEnabled: async () => true, isModuleBackgroundEnabled: async () => true }],
  ];
  for (const [p, exports] of stubs) require.cache[(p as FixtureValue)] = { id: p, filename: p, loaded: true, exports } as NodeJS.Module;
  t.after(require('./helpers/mail-service-modules.cts').evictMailServiceModules());
  t.after(require('./helpers/mail-service-modules.cts').evictMailRouteModules());
  const { sendEmail } = require(mailPath) as typeof import('../src/services/mail');
  const routes = require('../dist/src/routes/mail-messages') as typeof import('../src/routes/mail-messages');
  t.after(() => { for (const [p, entry] of original) { if (entry) require.cache[p] = entry; else delete require.cache[p]; } });
  return { send: (recipients: FixtureValue = {}) => sendEmail(account.id, { to: 'receiver@example.test', subject: 'Fixture', body: 'hello', ...recipients }),
    download: (attachmentId: string, userId = account.user_id) => (routes['GET /api/mail/attachments/:id'] as FixtureValue)({ url: `/api/mail/attachments/${attachmentId}` }, userId),
    get sends() { return sends; }, get inserts() { return inserts; }, get delivered() { return delivered; }, get sentCopy() { return sentCopy; },
    get attachmentRows() { return attachmentRows; }, get transactions() { return transactions; } };
}

test('inactive and disconnected accounts cannot dispatch SMTP', async t => {
  const inactive = mailFixture(t, { active: '0' });
  await assert.rejects(inactive.send(), /inactive or disconnected/);
  assert.equal(inactive.sends, 0);
});
test('SMTP success plus local Sent-copy failure is not reported as overall send failure', async t => {
  const root = await temporaryAttachmentRoot(t);
  const h = mailFixture(t, { failCopy: true });
  const result = await h.send({ attachments: [{ filename: 'notes.txt', contentType: 'text/plain', dataBase64: Buffer.from('kept').toString('base64') }] });
  assert.equal(h.sends, 1);
  assert.equal(h.inserts, 1);
  assert.equal(result.sent, true);
  assert.equal(result.success, true);
  assert.equal(result.sent_copy_state, 'failed');
  assert.equal(result.messageId, '<delivered@example.test>');
  assert.match(result.message!, /Do not resend/);
  assert.deepEqual(h.transactions, ['begin', 'rollback'], 'The attachment rows roll back with the email row');
  assert.deepEqual(await fs.readdir(path.join(root, 'user-1')), [], 'Staged files are discarded with the failed copy');
});
test('the Sent copy stores its attachments under the configured root and the download route streams them', async t => {
  const root = await temporaryAttachmentRoot(t);
  const h = mailFixture(t);
  const content = Buffer.from('%PDF-1.4 synthetic');
  const result = await h.send({ attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', dataBase64: content.toString('base64') }] });
  assert.equal(result.sent_copy_state, 'confirmed');
  assert.deepEqual(h.transactions, ['begin', 'commit']);
  assert.equal(h.sentCopy.has_attachments, 1);
  assert.equal(h.attachmentRows.length, 1);
  const row = h.attachmentRows[0];
  assert.equal(row.email_id, result.sent_copy_id);
  assert.ok(row.storage_path.startsWith(path.join(root, 'user-1') + path.sep), `stored inside the owner's directory of the root: ${row.storage_path}`);
  assert.equal((await fs.stat(row.storage_path)).mode & 0o777, 0o600);
  const response = await h.download(row.id);
  assert.equal(response.__streamPath, row.storage_path);
  assert.equal(response.__contentType, 'application/pdf');
  assert.equal(response.__contentLength, content.length);
  assert.deepEqual(await fs.readFile(response.__streamPath), content);
  assert.equal((await h.download(row.id, 'other-user')).status, 404, 'Another account never sees the file');
});
test('successful local Sent copy is separately confirmed and keeps Cc and Bcc with their names', async t => {
  const h = mailFixture(t);
  const result = await h.send({ cc: '"Doe, Jane" <copy@example.test>, other@example.test', bcc: 'hidden@example.test' });
  assert.equal(h.sends, 1);
  assert.deepEqual(h.delivered.cc, ['"Doe, Jane" <copy@example.test>', 'other@example.test']);
  assert.deepEqual(h.delivered.bcc, ['hidden@example.test']);
  const MailComposer = require('nodemailer/lib/mail-composer');
  const mime = String(await new MailComposer(h.delivered).compile().build());
  assert.match(mime, /^Cc: "Doe, Jane" <copy@example.test>, other@example.test$/m);
  assert.doesNotMatch(mime, /^Bcc:/m);
  assert.deepEqual(JSON.parse(h.sentCopy.cc), ['"Doe, Jane" <copy@example.test>', 'other@example.test']);
  assert.deepEqual(JSON.parse(h.sentCopy.bcc), ['hidden@example.test']);
  assert.equal(result.sent_copy_state, 'confirmed');
  assert.match(result.sent_copy_id!, /^[0-9a-f-]{36}$/i);
});
test('a display name containing an address does not change the sender address', async t => {
  const h = mailFixture(t, { displayName: 'Jane <evil@example.net> Doe' });
  await h.send();
  assert.equal(h.sends, 1);
  assert.deepEqual(h.delivered.from, { name: 'Jane <evil@example.net> Doe', address: 'sender@example.test' });
  const MailComposer = require('nodemailer/lib/mail-composer');
  const compiled = new MailComposer(h.delivered).compile();
  assert.deepEqual(compiled.getEnvelope().from, 'sender@example.test');
  const mime = String(await compiled.build());
  assert.match(mime, /^From: "Jane <evil@example.net> Doe" <sender@example.test>$/m);
  assert.equal(h.sentCopy.from_address, 'sender@example.test');
  assert.equal(h.sentCopy.from_name, 'Jane <evil@example.net> Doe');
});
