import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

test('a send with an Idempotency-Key goes out once: repeats get its result, a running one is refused, a failed one can be retried, an unknown outcome never is', {
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

  // The connection ended after the message was handed over (B-02): the key
  // stays taken, and every repeat says the outcome is unknown, never sends.
  const unknown = (error: FixtureValue) => error.status === 409 && error.code === 'SEND_OUTCOME_UNKNOWN';
  const lostAfterData = async () => { throw Object.assign(new Error('lost after DATA'), { status: 409, code: 'SEND_OUTCOME_UNKNOWN' }); };
  await assert.rejects(once('send-d', lostAfterData), unknown);
  await assert.rejects(once('send-d'), unknown);
  await assert.rejects(once('send-d'), unknown);
  assert.equal(sent, 5);
  // 0.23.0 treats any receipt without send_pending as the sent result; after a
  // rollback the unknown outcome must still read as "being sent", never "sent".
  const [[stored]] = await pool.execute<FixtureValue[]>("SELECT response_json FROM mail_command_receipts WHERE user_id = ? AND client_key = 'send-d'", [owner]);
  const storedResponse = typeof stored.response_json === 'string' ? JSON.parse(stored.response_json) : stored.response_json;
  assert.deepEqual(storedResponse, { send_pending: true, send_unknown: true });

  // A send that stopped without an outcome (a crash, B-03) is in progress for
  // a while and then reported as unknown, without closing the composer.
  const pendingHash = (request: unknown) => crypto.createHash('sha256').update(JSON.stringify({ kind: 'send', request })).digest('hex');
  await pool.execute(`INSERT INTO mail_command_receipts (user_id, client_key, request_hash, response_json) VALUES (?, 'send-e', ?, '{"send_pending":true}')`, [owner, pendingHash(message)]);
  await assert.rejects(once('send-e'), (error: FixtureValue) => error.status === 409 && error.code === 'SEND_IN_PROGRESS');
  await pool.execute("UPDATE mail_command_receipts SET updated_at = UTC_TIMESTAMP() - INTERVAL 3 MINUTE WHERE user_id = ? AND client_key = 'send-e'", [owner]);
  await assert.rejects(once('send-e'), unknown);
  await assert.rejects(once('send-e'), unknown, 'and stays unknown');
  const [[settled]] = await pool.execute<FixtureValue[]>("SELECT response_json FROM mail_command_receipts WHERE user_id = ? AND client_key = 'send-e'", [owner]);
  assert.equal((typeof settled.response_json === 'string' ? JSON.parse(settled.response_json) : settled.response_json).send_pending, true);
  assert.equal(sent, 5);
  // A send running in this process longer than that is still in progress.
  let finishLong!: () => void;
  const long = once('send-f', () => new Promise(resolve => { finishLong = () => resolve({ success: true, messageId: '<long@example.test>' }); }));
  await new Promise(resolve => setTimeout(resolve, 50));
  await pool.execute("UPDATE mail_command_receipts SET updated_at = UTC_TIMESTAMP() - INTERVAL 10 MINUTE WHERE user_id = ? AND client_key = 'send-f'", [owner]);
  await assert.rejects(once('send-f'), (error: FixtureValue) => error.code === 'SEND_IN_PROGRESS');
  finishLong();
  assert.equal((await long).messageId, '<long@example.test>');

  // Receipts are kept for 30 days, then pruned.
  const { pruneCommandReceipts } = require('../dist/src/services/mail-engine/repository') as typeof import('../src/services/mail-engine/repository');
  await pool.execute("UPDATE mail_command_receipts SET updated_at = UTC_TIMESTAMP() - INTERVAL 31 DAY WHERE user_id = ? AND client_key = 'send-a'", [owner]);
  assert.equal(await pruneCommandReceipts(pool), 1);
  const [left] = await pool.execute<FixtureValue[]>('SELECT client_key FROM mail_command_receipts WHERE user_id = ? ORDER BY client_key', [owner]);
  assert.deepEqual(left.map((row: FixtureValue) => row.client_key), ['send-b', 'send-c', 'send-d', 'send-e', 'send-f']);

  // A reply answers the Message-ID of the user's own copy of the message, never another user's (B-10).
  const { replyThreading } = require('../dist/src/services/mail-send') as typeof import('../src/services/mail-send');
  const account = crypto.randomUUID(), received = crypto.randomUUID(), noId = crypto.randomUUID();
  await pool.execute("INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active) VALUES (?,?,'owner@example.test','custom','sync',TRUE)", [account, owner]);
  await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,message_id,from_address,to_addresses,folder)
    VALUES (?,?,?,'<quote-1@example.test>','sparks@example.test','["owner@example.test"]','inbox'), (?,?,?,'not a message id','sparks@example.test','["owner@example.test"]','inbox')`,
  [received, owner, account, noId, owner, account]);
  assert.deepEqual(await replyThreading(owner, received), { inReplyTo: '<quote-1@example.test>', references: ['<quote-1@example.test>'], threadKey: null });
  assert.equal(await replyThreading(stranger, received), null, 'another user\'s message gives nothing');
  assert.equal(await replyThreading(owner, noId), null, 'an unusable id is not sent');
  assert.equal(await replyThreading(owner, undefined), null);
  await assert.rejects(replyThreading(owner, { id: received }), (error: FixtureValue) => error.status === 400);
});
