const test = require('node:test');
const assert = require('node:assert/strict');

function mailFixture(t, { active = 1, disconnected = null, failCopy = false } = {}) {
  const state = require.resolve('../dist/src/state');
  const nodemailer = require.resolve('nodemailer');
  const encryption = require.resolve('../dist/src/security/encryption');
  const network = require.resolve('../dist/src/security/outbound-network');
  const settings = require.resolve('../dist/src/services/module-settings');
  const mailPath = require.resolve('../dist/src/services/mail');
  const paths = [state, nodemailer, encryption, network, settings, mailPath];
  const original = new Map(paths.map(p => [p, require.cache[p]]));
  let sends = 0, inserts = 0;
  const account = { id: 'account-1', user_id: 'user-1', email_address: 'sender@example.test',
    smtp_host: 'smtp.example.test', smtp_port: 587, encrypted_password: 'vault-ciphertext',
    is_active: active, disconnected_at: disconnected, allow_self_signed: 0 };
  const stubs = [
    [state, { db: { async execute(sql) {
      if (sql.includes('FROM mail_accounts')) return [[account]];
      if (sql.includes('INSERT INTO emails')) { inserts++; if (failCopy) throw Error('storage offline'); return [{ affectedRows: 1 }]; }
      return [[]];
    } } }],
    [nodemailer, { createTransport: () => ({ async sendMail() { sends++; return { messageId: '<delivered@example.test>' }; } }) }],
    [encryption, { decrypt: () => 'test-placeholder' }],
    [network, { normalizeNetworkHost: x => x, isTrustedMailHost: () => true, isPublicNetworkAddress: () => true,
      resolveNetworkHost: async () => [], resolveMailConnectionTarget: async () => ({ address: '127.0.0.1', hostname: 'smtp.example.test' }) }],
    [settings, { isModuleEnabled: async () => true, isModuleBackgroundEnabled: async () => true }],
  ];
  for (const [p, exports] of stubs) require.cache[p] = { id: p, filename: p, loaded: true, exports };
  t.after(require('./helpers/mail-service-modules').evictMailServiceModules());
  const { sendEmail } = require(mailPath);
  t.after(() => { for (const [p, entry] of original) { if (entry) require.cache[p] = entry; else delete require.cache[p]; } });
  return { send: () => sendEmail(account.id, { to: 'receiver@example.test', subject: 'Fixture', body: 'hello' }),
    get sends() { return sends; }, get inserts() { return inserts; } };
}

test('inactive and disconnected accounts cannot dispatch SMTP', async t => {
  const inactive = mailFixture(t, { active: '0' });
  await assert.rejects(inactive.send(), /inactive or disconnected/);
  assert.equal(inactive.sends, 0);
});
test('SMTP success plus local Sent-copy failure is not reported as overall send failure', async t => {
  const h = mailFixture(t, { failCopy: true });
  const result = await h.send();
  assert.equal(h.sends, 1);
  assert.equal(h.inserts, 1);
  assert.equal(result.sent, true);
  assert.equal(result.success, true);
  assert.equal(result.sent_copy_state, 'failed');
  assert.equal(result.messageId, '<delivered@example.test>');
  assert.match(result.message, /Do not resend/);
});
test('successful local Sent copy is separately confirmed', async t => {
  const h = mailFixture(t);
  const result = await h.send();
  assert.equal(h.sends, 1);
  assert.equal(result.sent_copy_state, 'confirmed');
  assert.match(result.sent_copy_id, /^[0-9a-f-]{36}$/i);
});
