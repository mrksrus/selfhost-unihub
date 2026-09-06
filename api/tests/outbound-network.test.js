const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns').promises;
process.env.ENCRYPTION_KEY = 'outbound-network-test-only-key';
process.env.TRUSTED_MAIL_HOSTS = 'mail.internal.example';
const {
  isPublicNetworkAddress, resolveMailConnectionTarget, isTrustedMailHost,
} = require('../src/security/outbound-network');
const { encrypt } = require('../src/security/encryption');
const mail = require('../src/services/mail');
const imaps = require('imap-simple');
const nodemailer = require('nodemailer');
const { setDb } = require('../src/state');

const publicAddress = '93.184.216.34';

test('outbound policy denies local, mapped, transition and special-use addresses', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.1.1', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.1.1',
    '::127.0.0.1', '64:ff9b::7f00:1', 'fc00::1', 'fe90::1', 'ff02::1',
    '2001:db8::1', '2001:0::1', '2002:7f00:1::', '3fff::1', 'not-an-address',
  ]) assert.equal(isPublicNetworkAddress(address), false, address);
  for (const address of [publicAddress, '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicNetworkAddress(address), true, address);
  }
});

test('DNS failures and mixed public/private answers fail closed, including trusted DNS failures', async () => {
  await assert.rejects(resolveMailConnectionTarget('mail.example', { lookup: async () => [] }), /did not resolve/);
  await assert.rejects(resolveMailConnectionTarget('mail.internal.example', {
    lookup: async () => { throw Object.assign(new Error('missing'), { code: 'ENOTFOUND' }); },
  }), /could not be resolved/);
  await assert.rejects(resolveMailConnectionTarget('mail.example', { lookup: async () => [
    { address: publicAddress }, { address: '::ffff:7f00:1' },
  ] }), /non-public/);
  await assert.rejects(resolveMailConnectionTarget('mail.example', {
    timeoutMs: 5, lookup: () => new Promise(() => {}),
  }), /timed out/);
});

test('administrator-configured private mail hosts remain allowed without suffix confusion', async () => {
  const target = await resolveMailConnectionTarget('mail.internal.example', {
    lookup: async () => [{ address: '192.168.1.20', family: 4 }],
  });
  assert.equal(target.address, '192.168.1.20');
  assert.equal(target.hostname, 'mail.internal.example');
  assert.equal(isTrustedMailHost('child.mail.internal.example'), true);
  assert.equal(isTrustedMailHost('mail.internal.example.evil.test'), false);
  assert.equal(isTrustedMailHost('evilmail.internal.example'), false);
  await assert.rejects(resolveMailConnectionTarget('other.internal.example', {
    lookup: async () => [{ address: '192.168.1.20', family: 4 }],
  }), /non-public/);
});

test('account policy rejects a failed DNS lookup rather than treating it as consentable', async t => {
  t.mock.method(dns, 'lookup', async () => { throw new Error('fixture DNS failure'); });
  const result = await mail.validateMailHostPolicy({ imap_host: 'imap.example', smtp_host: 'smtp.example' });
  assert.equal(result.status, 400);
  assert.equal(result.mailHostTrust.blocked, true);
});

function installMailFixture(t, host) {
  const account = { id: 'account-1', user_id: 'user-1', email_address: 'user@example.test',
    imap_host: host, imap_port: 993, smtp_host: host, smtp_port: 587,
    encrypted_password: encrypt('fixture-password'), is_active: 1, delete_emails_on_server: 1,
    server_delete_grace_until: new Date(0), allow_self_signed: 0 };
  setDb({ execute: async sql => {
    if (sql.includes('FROM mail_accounts')) return [[account]];
    if (sql.includes('FROM mail_server_messages')) return [[{ id: 'queued', user_id: account.user_id }]];
    return [[]];
  } });
  t.after(() => setDb(null));
  const imapConfigs = [];
  const smtpConfigs = [];
  t.mock.method(imaps, 'connect', async config => { imapConfigs.push(config); throw new Error('fixture transport stop'); });
  t.mock.method(nodemailer, 'createTransport', config => { smtpConfigs.push(config); throw new Error('fixture transport stop'); });
  return { account, imapConfigs, smtpConfigs };
}

async function exerciseMailConnectionPaths(account) {
  await mail.testImapConnection(account);
  await mail.createRemoteMailFolderForUserAccounts(account.user_id, 'Folder');
  await mail.syncMailAccount(account.id);
  await mail.processMailServerDeletionForAccount(account.id);
  await assert.rejects(mail.sendEmail(account.id, { to: 'nobody@example.test', subject: 'Fixture', body: '' }));
}

test('every foreground/background mail path blocks a host rebound after account validation', async t => {
  const { account, imapConfigs, smtpConfigs } = installMailFixture(t, 'mail.example');
  let privateNow = false;
  t.mock.method(dns, 'lookup', async () => [{ address: privateNow ? '127.0.0.1' : publicAddress, family: 4 }]);
  assert.equal((await mail.validateMailHostPolicy({ imap_host: account.imap_host, smtp_host: account.smtp_host })).accepted, true);
  privateNow = true;
  await exerciseMailConnectionPaths(account);
  assert.equal(imapConfigs.length, 0);
  assert.equal(smtpConfigs.length, 0);
});

test('every mail connection pins its checked IP and preserves TLS hostname verification', async t => {
  const { account, imapConfigs, smtpConfigs } = installMailFixture(t, 'mail.example');
  let lookups = 0;
  t.mock.method(dns, 'lookup', async () => { lookups += 1; return [{ address: publicAddress, family: 4 }]; });
  await exerciseMailConnectionPaths(account);
  assert.equal(imapConfigs.length, 4);
  assert.equal(smtpConfigs.length, 1);
  assert.equal(lookups, 5);
  for (const config of imapConfigs) {
    assert.equal(config.imap.host, publicAddress);
    assert.equal(config.imap.tlsOptions.servername, 'mail.example');
    assert.equal(config.imap.tlsOptions.rejectUnauthorized, true);
  }
  assert.equal(smtpConfigs[0].host, publicAddress);
  assert.equal(smtpConfigs[0].tls.servername, 'mail.example');
  assert.equal(smtpConfigs[0].requireTLS, true);
});

test('administrator-authorized private hosts work in the actual mail transport path', async t => {
  const { account, imapConfigs } = installMailFixture(t, 'mail.internal.example');
  t.mock.method(dns, 'lookup', async () => [{ address: '192.168.1.20', family: 4 }]);
  await mail.testImapConnection(account);
  assert.equal(imapConfigs[0].imap.host, '192.168.1.20');
  assert.equal(imapConfigs[0].imap.tlsOptions.servername, 'mail.internal.example');
  assert.equal(imapConfigs[0].imap.tlsOptions.rejectUnauthorized, true);
});

test('accepting an unverified TLS certificate cannot authorize a private or mapped mail endpoint', async t => {
  const { account, imapConfigs } = installMailFixture(t, '::ffff:7f00:1');
  account.allow_self_signed = 1;
  const result = await mail.testImapConnection(account);
  assert.equal(result.success, false);
  assert.match(result.error, /non-public/);
  assert.equal(imapConfigs.length, 0);
});
