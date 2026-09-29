const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dns = require('node:dns').promises;
const imaps = require('imap-simple');
process.env.ENCRYPTION_KEY = 'mail-sync-cancellation-test-only-key';
const mail = require('../src/services/mail');
const routes = require('../src/routes/mail');
const { encrypt } = require('../src/security/encryption');
const { getDb, setDb } = require('../src/state');
const { withMailAccountLock } = require('../src/services/mail-account-lock');
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const failure of ['cancel', 'socket', 'deadline']) test(`stalled sync LIST: ${failure} tears down transport and releases worker only after state cleanup`, { timeout: 2000 }, async t => {
  const old = getDb(); t.after(() => setDb(old));
  const account = { id: `sync-${failure}`, user_id: 'owner', sync_mode: 'sync', is_active: 1, email_address: 'mail@example.test',
    imap_host: 'imap.example.test', encrypted_password: encrypt('synthetic-test-password') };
  const writes = []; let destroyed = 0, finishList, inList = false;
  const connection = new EventEmitter();
  connection.imap = { destroy() { destroyed++; } };
  connection.getBoxes = () => { inList = true; return new Promise(resolve => { finishList = resolve; }); };
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(imaps, 'connect', async config => {
    assert.equal(config.imap.socketTimeout, 60000);
    assert.equal(config.imap.connTimeout, 60000);
    assert.equal(config.imap.authTimeout, 30000);
    return connection;
  });
  if (failure === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
  setDb({ execute: async (sql, params) => {
    if (sql.includes('SELECT * FROM mail_accounts')) return [[account]];
    if (sql.includes('SELECT mail_account_id FROM emails')) return [[{ mail_account_id: account.id }]];
    if (sql.startsWith('UPDATE mail_accounts')) { writes.push({ sql, params }); return [{ affectedRows: 1 }]; }
    if (sql.includes('FROM user_settings') || sql.includes('FROM backup_restore_jobs')) return [[]];
    assert.fail(`No mail/folder mutations expected: ${sql}`);
  } });
  const worker = mail.syncMailAccount(account.id);
  await tick(); assert.equal(inList, true);
  assert.equal(mail.getMailSyncState(account.id).state, 'running');
  if (failure === 'cancel') assert.equal(mail.cancelMailAccountSync(account.id), true);
  else if (failure === 'socket') connection.emit('error', new Error('socket timeout'));
  else t.mock.timers.tick(120000);
  const result = await worker;
  assert.equal(result.success, false);
  assert.equal(result.cancelled, failure === 'cancel');
  assert.equal(destroyed, 1);
  assert.equal(writes.at(-1).params[0], failure === 'cancel' ? 'cancelled' : 'error');
  assert.equal(mail.isAnyMailAccountSyncRunning(), false);
  assert.equal(await withMailAccountLock(account.id, async () => 'free', { wait: false }), 'free');
  const savedWrites = writes.length;
  finishList({ INBOX: { children: {} } }); await tick();
  assert.equal(writes.length, savedWrites, 'Late LIST reply must not run reconciliation or set last_synced_at');
});
