const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dns = require('node:dns').promises;
const imapClient = require('../dist/src/services/mail-imap-client');
process.env.ENCRYPTION_KEY = 'mail-sync-cancellation-test-only-key';
const mail = require('../dist/src/services/mail');
const runtime = require('../dist/src/services/mail-engine/runtime');
const { encrypt } = require('../dist/src/security/encryption');
const { getDb, setDb } = require('../dist/src/state');
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const failure of ['cancel', 'socket', 'deadline']) test(`stalled durable sync LIST: ${failure} destroys transport and ignores late reply`, { timeout: 2000 }, async t => {
  const old = getDb(); t.after(() => setDb(old));
  const account = { id: `sync-${failure}`, user_id: 'owner', sync_mode: 'sync', is_active: 1, email_address: 'mail@example.test',
    imap_host: 'imap.example.test', encrypted_password: encrypt('synthetic-test-password') };
  const queries = []; let destroyed = 0, finishList, inList = false;
  const connection = new EventEmitter();
  connection.close = () => { destroyed++; };
  connection.list = () => { inList = true; return new Promise(resolve => { finishList = resolve; }); };
  t.mock.method(runtime, 'assertFence', async () => ({ cancellationRequested: false }));
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(imapClient, 'connectImap', async config => {
    assert.equal(config.imap.socketTimeout, 60000);
    assert.equal(config.imap.connTimeout, 60000);
    assert.equal(config.imap.authTimeout, 30000);
    return connection;
  });
  if (failure === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
  setDb({ execute: async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT * FROM mail_accounts')) return [[account]];
    if (sql.includes('FROM user_settings') || sql.includes('FROM backup_restore_jobs')) return [[]];
    assert.fail(`No mail/folder mutations expected: ${sql}`);
  } });
  const controller = new AbortController();
  const worker = mail.runDurableMailJob({ id: 'job', user_id: account.user_id, mail_account_id: account.id,
    lease_owner: 'worker', worker_generation: 1, kind: 'sync' }, controller.signal, async () => {});
  for (let i = 0; i < 40 && !inList; i++) await tick();
  assert.equal(inList, true, 'durable worker reaches guarded LIST');
  if (failure === 'cancel') controller.abort();
  else if (failure === 'socket') connection.emit('error', new Error('socket timeout'));
  else t.mock.timers.tick(120000);
  if (failure === 'socket' || failure === 'deadline') await assert.rejects(worker, /socket timeout|IMAP command timeout/);
  else assert.deepEqual(await worker, { success: false, cancelled: true });
  assert.equal(destroyed, 1, 'hard teardown is idempotent');
  const savedQueries = queries.length;
  finishList([{ path: 'INBOX', flags: new Set(), delimiter: '/' }]); await tick();
  assert.equal(queries.length, savedQueries, 'Late LIST cannot register folders or advance coverage');
});

test('manual sync admission resumes only eligible module/background pauses; scheduled background work never resumes', async t => {
  const old = getDb(); t.after(() => setDb(old));
  const resumes = [], enqueued = [];
  let enabled = true, restoring = false;
  setDb({ execute: async sql => {
    if (sql.includes('SELECT user_id FROM mail_accounts')) return [[{ user_id: 'owner' }]];
    if (sql.includes('FROM user_settings')) return [[{ setting_value: JSON.stringify({ mail: { enabled } }) }]];
    if (sql.includes('FROM backup_restore_jobs')) return [restoring ? [{ requested_sections: '["mail"]' }] : []];
    assert.fail(`Unexpected SQL: ${sql}`);
  } });
  t.mock.method(runtime, 'resumeAccount', async input => { resumes.push(input); return { resumed: 0 }; });
  t.mock.method(runtime, 'recoverExpiredJobs', async () => ({}));
  t.mock.method(runtime, 'claimDueJob', async () => null);
  t.mock.method(runtime, 'getJobStatus', async () => null);
  t.mock.method(runtime, 'enqueueJob', async input => { enqueued.push(input); return { id: `job-${enqueued.length}` }; });
  await mail.scheduleMailAccountSync('A', { background: true });
  assert.deepEqual(resumes, [], 'periodic background work must not lift a pause');
  await mail.scheduleMailAccountSync('A');
  assert.deepEqual(resumes, [{ userId: 'owner', accountId: 'A', resumeStreams: true,
    reasons: ['Mail module disabled', 'Mail background paused'] }]);
  enabled = false;
  await mail.scheduleMailAccountSync('A');
  assert.equal(resumes.length, 1, 'manual sync cannot lift a disabled-module fence');
  enabled = true; restoring = true;
  await mail.scheduleMailAccountSync('A');
  assert.equal(resumes.length, 1, 'manual sync cannot reopen an active restore');
  assert.equal(enqueued.length, 4);
});
