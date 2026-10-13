import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { randomUUID } = (require('node:crypto') as typeof import('node:crypto'));
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

test('real MySQL: a task made from an email keeps the email, both sides show the link, and the link survives the email', { skip: !process.env.MYSQL_TEST_HOST }, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, timezone: '+00:00' });
  let owned = false;
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'email-task-admin@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-email-task-password';
  const state = require('../dist/src/state') as typeof import('../src/state'), old = state.getDb();
  t.after(async () => {
    if (owned) {
      const cx = await pool.getConnection();
      try {
        await cx.query('SET FOREIGN_KEY_CHECKS=0');
        const [tables] = await cx.query<RowDataPacket[]>('SHOW TABLES');
        for (const row of tables) { const name = Object.values(row)[0]; assert.match((name as string), /^[a-z_]+$/); await cx.query('DROP TABLE `' + name + '`'); }
      } finally { cx.release(); }
    }
    state.setDb(old); await pool.end();
  });
  const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES');
  assert.equal(tables.length, 0, 'Requires an empty disposable test schema'); owned = true;
  state.setDb(pool); await (require('../dist/src/services/database') as typeof import('../src/services/database')).ensureSchema();

  const owner = randomUUID(), stranger = randomUUID(), account = randomUUID(), email = randomUUID();
  await pool.execute<ResultSetHeader>("INSERT INTO users (id,email,password_hash) VALUES (?,'tasks@example.test','test'),(?,'other@example.test','test')", [owner, stranger]);
  await pool.execute<ResultSetHeader>("INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active) VALUES (?,?,'alex@example.test','custom','download',TRUE)", [account, owner]);
  await pool.execute<ResultSetHeader>(`INSERT INTO emails (id,user_id,mail_account_id,subject,from_address,from_name,to_addresses,folder,received_at,has_attachments)
    VALUES (?,?,?,'Re: Invoice 4711','billing@power.example','Power Co','[]','inbox','2026-10-10 08:00:00',TRUE)`, [email, owner, account]);
  for (const name of ['invoice-4711.pdf', 'terms.pdf']) await pool.execute<ResultSetHeader>(`INSERT INTO email_attachments (id,email_id,user_id,filename,content_type,size_bytes,storage_path)
    VALUES (?,?,?,?,'application/pdf',10,?)`, [randomUUID(), email, owner, name, `/tmp/${name}`]);
  await pool.execute<ResultSetHeader>(`INSERT INTO email_attachments (id,email_id,user_id,filename,content_type,size_bytes,storage_path,content_id)
    VALUES (?,?,?,'logo.png','image/png',10,'/tmp/logo.png','cid-logo')`, [randomUUID(), email, owner]);

  const calendar = require('../dist/src/routes/calendar') as typeof import('../src/routes/calendar');
  const mail = require('../dist/src/routes/mail') as typeof import('../src/routes/mail');
  const request = (url: string) => ({ url, headers: { host: 'localhost' } }) as FixtureValue;

  await t.test('creating from another user\'s email is refused; from an own email the header and attachment names are kept', async () => {
    const refused = await calendar['POST /api/calendar/events'](request('/api/calendar/events'), stranger, { title: 'Steal', is_todo_only: true, source_email_id: email });
    assert.equal((refused as FixtureValue).status, 404);
    const created = await calendar['POST /api/calendar/events'](request('/api/calendar/events'), owner, { title: 'Pay invoice 4711', is_todo_only: true, source_email_id: email });
    assert.equal((created as FixtureValue).error, undefined, JSON.stringify(created));
    const source = (created as FixtureValue).event.source_email;
    assert.deepEqual(source, { email_id: email, subject: 'Re: Invoice 4711', from_name: 'Power Co', from_address: 'billing@power.example',
      received_at: '2026-10-10T08:00:00.000Z', attachments: ['invoice-4711.pdf', 'terms.pdf'], account: 'alex@example.test', available: true });
  });

  await t.test('the email lists its tasks and the list row counts them; the stranger sees neither', async () => {
    const detail = await mail['GET /api/mail/emails/:id'](request(`/api/mail/emails/${email}`), owner);
    assert.equal((detail as FixtureValue).email.tasks.length, 1);
    assert.equal((detail as FixtureValue).email.tasks[0].title, 'Pay invoice 4711');
    assert.equal((detail as FixtureValue).email.tasks[0].is_todo_only, true);
    const list = await mail['GET /api/mail/emails'](request('/api/mail/emails?folder=inbox'), owner);
    assert.equal((list as FixtureValue).emails[0].task_count, 1);
    const strangerList = await mail['GET /api/mail/emails'](request('/api/mail/emails?folder=inbox'), stranger);
    assert.equal((strangerList as FixtureValue).emails.length, 0);
    const strangerEvents = await calendar['GET /api/calendar/events'](request('/api/calendar/events?include_todos=true'), stranger);
    assert.equal((strangerEvents as FixtureValue).events.length, 0);
  });

  await t.test('after the email is deleted the task keeps the email\'s header and says it is gone', async () => {
    await pool.execute<ResultSetHeader>('DELETE FROM email_attachments WHERE email_id=?', [email]);
    await pool.execute<ResultSetHeader>('DELETE FROM emails WHERE id=?', [email]);
    const events = await calendar['GET /api/calendar/events'](request('/api/calendar/events?include_todos=true'), owner);
    const [task] = (events as FixtureValue).events;
    assert.equal(task.source_email.available, false);
    assert.equal(task.source_email.subject, 'Re: Invoice 4711');
    assert.deepEqual(task.source_email.attachments, ['invoice-4711.pdf', 'terms.pdf']);
    const single = await calendar['GET /api/calendar/events/:id'](request(`/api/calendar/events/${task.id}`), owner);
    assert.equal((single as FixtureValue).event.source_email.available, false);
    assert.equal((single as FixtureValue).event.source_email_json, undefined, 'the raw snapshot is not part of the API shape');
  });
});
