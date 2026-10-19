import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

test('a send with an Idempotency-Key goes out once: repeats get its result, a running one is refused, a failed one can be retried', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Only an isolated disposable schema is allowed');
  process.env.JWT_SECRET ||= 'send-once-test-only-secret';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'send-once-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-send-once-bootstrap-password';
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
    database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 5 });
  const state = require('../dist/src/state') as typeof import('../src/state');
  const originalDb = state.getDb();
  let ownsSchema = false;
  t.after(async () => {
    try {
      if (ownsSchema) {
        const cx = await pool.getConnection();
        try {
          await cx.query('SET FOREIGN_KEY_CHECKS = 0');
          for (const row of (await cx.query<RowDataPacket[]>('SHOW TABLES'))[0]) await cx.query('DROP TABLE ??', [Object.values(row)[0]]);
          await cx.query('SET FOREIGN_KEY_CHECKS = 1');
        } finally { cx.release(); }
      }
    } finally { state.setDb(originalDb); await pool.end(); }
  });
  assert.equal((await pool.query<RowDataPacket[]>('SHOW TABLES'))[0].length, 0, 'Refuse to touch a populated schema');
  ownsSchema = true;
  state.setDb(pool);
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  await (require('../dist/src/services/database') as typeof import('../src/services/database')).ensureSchema();
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
