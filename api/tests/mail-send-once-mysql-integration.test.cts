import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

test('a send with an Idempotency-Key goes out once: repeats get its result, a running one is refused, a failed one can be retried', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'send-once-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-send-once-bootstrap-password';
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const { sendOnce } = require('../dist/src/services/mail-send') as typeof import('../src/services/mail-send');
  const owner = crypto.randomUUID(), stranger = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'owner@example.test', 'x'), (?, 'stranger@example.test', 'x')", [owner, stranger]);

  let sent = 0;
  const message = { account_id: 'account-1', to: 'reader@example.test', subject: 'Hello', body: '<p>Hi</p>' };
  const deliver = async () => ({ success: true, messageId: `<${++sent}@example.test>` });
  const once = (clientKey: string | undefined, send: () => Promise<Record<string, unknown>> = deliver, userId = owner, request: unknown = message) =>
    sendOnce({ userId, clientKey, request }, send);

  const first = await once('send-a');
  assert.deepEqual(await once('send-a'), first, 'a repeat gets the first result');
  assert.equal(sent, 1, 'and sends nothing');
  await assert.rejects(once('send-a', deliver, owner, { ...message, subject: 'Edited' }), (error: FixtureValue) => error.status === 409 && error.code === 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(sent, 1);
  await once('send-a', deliver, stranger);
  assert.equal(sent, 2, 'keys are per user');

  // A second click while the first send is still running is refused.
  let finish!: () => void;
  const slow = once('send-b', () => new Promise(resolve => { finish = () => resolve({ success: true, messageId: '<slow@example.test>' }); }));
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(once('send-b'), (error: FixtureValue) => error.status === 409 && error.code === 'SEND_IN_PROGRESS');
  finish();
  assert.equal((await slow).messageId, '<slow@example.test>');
  assert.equal((await once('send-b')).messageId, '<slow@example.test>');

  // A failed send (thrown or returned) releases the key: the same message can be sent again.
  await assert.rejects(once('send-c', async () => { throw new Error('SMTP refused the login'); }), /SMTP refused/);
  assert.deepEqual(await once('send-c', async () => ({ error: 'Draft not found', status: 404 })), { error: 'Draft not found', status: 404 });
  const retried = await once('send-c');
  assert.equal(retried.success, true);
  assert.equal(sent, 3);

  // Without a key every request sends, as before.
  await once(undefined); await once(undefined);
  assert.equal(sent, 5);
});
