// Run before database-startup smoke, which intentionally leaves a populated schema.
// Node sorts test file paths even when the runner supplies another argument order.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

test('durable mail commands: ownership, restart, retry retention and operation-aware settlement', { skip: !process.env.MYSQL_TEST_HOST }, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00' });
  let owned = false;
  t.after(async () => {
    if (owned) { const c = await pool.getConnection(); try { await c.query('SET FOREIGN_KEY_CHECKS=0'); const [tables] = await c.query('SHOW TABLES'); for (const row of tables) { const name = Object.values(row)[0]; assert.match(name, /^[a-z_]+$/); await c.query('DROP TABLE `' + name + '`'); } } finally { c.release(); } }
    await pool.end();
  });
  const [tables] = await pool.query('SHOW TABLES'); assert.equal(tables.length, 0, 'Requires empty disposable schema'); owned = true;
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'writeback-admin@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-writeback-admin-password';
  const { setDb } = require('../dist/src/state'); setDb(pool);
  await require('../dist/src/services/database').ensureSchema();
  const service = require('../dist/src/services/mail-writebacks');
  const user = crypto.randomUUID(), stranger = crypto.randomUUID(), accountId = crypto.randomUUID(), emailId = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id,email,password_hash) VALUES (?, 'sync-owner@example.test', 'test'), (?, 'sync-other@example.test', 'test')", [user, stranger]);
  await pool.execute("INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active) VALUES (?,?,'mail@example.test','custom','sync',TRUE)", [accountId, user]);
  const raw = 'From: test@example.test\r\n\r\nMail fixture';
  await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,remote_folder,remote_uid,remote_uidvalidity,raw_sha256)
    VALUES (?,?,?,'test@example.test','[]','inbox','INBOX',12,9,?)`, [emailId,user,accountId,crypto.createHash('sha256').update(raw).digest('hex')]);
  const account = { id: accountId, user_id: user };
  const queue = async (changes) => {
    const [[email]] = await pool.execute('SELECT e.*, a.sync_mode FROM emails e JOIN mail_accounts a ON a.id=e.mail_account_id WHERE e.id=?', [emailId]);
    await service.queueChanges(pool, user, [email], changes);
  };
  const op = async () => (await pool.execute('SELECT * FROM mail_writebacks WHERE email_id=?', [emailId]))[0][0];
  await assert.rejects(service.mutateMessages(stranger, [emailId], { read: 1 }), { status: 404 });
  const mailRoutes = require('../dist/src/routes/mail');
  const list = async query => mailRoutes['GET /api/mail/emails']({ url: `/api/mail/emails${query}`, headers: { host: 'localhost' } }, user);
  const detail = async () => mailRoutes['GET /api/mail/emails/:id']({ url: `/api/mail/emails/${emailId}` }, user);
  const assertSnapshot = async (read, star, readPending, starPending) => {
    const page = await list('');
    assert.equal(page.pagination.total, 1);
    assert.equal(page.emails.length, 1);
    for (const row of [page.emails[0], (await detail()).email]) {
      assert.equal(row.is_read, Boolean(read)); assert.equal(row.is_starred, Boolean(star));
      assert.equal(row.read_sync_pending, readPending); assert.equal(row.star_sync_pending, starPending);
    }
    for (const [flag, value] of [['is_read', read], ['is_starred', star]]) {
      for (const requested of [false, true]) {
        const filtered = await list(`?${flag}=${requested}`);
        const expected = Boolean(value) === requested ? 1 : 0;
        assert.equal(filtered.pagination.total, expected); assert.equal(filtered.emails.length, expected);
      }
    }
    const starred = await list('?folder=starred');
    assert.equal(starred.pagination.total, Number(star)); assert.equal(starred.emails.length, Number(star));
    const counts = await mailRoutes['GET /api/mail/unread-counts']({ url: '/api/mail/unread-counts', headers: { host: 'localhost' } }, user);
    assert.equal(counts.unreadByFolder.inbox || 0, read ? 0 : 1);
    const shownAccount = (await mailRoutes['GET /api/mail/accounts']({}, user)).accounts.find(row => row.id === accountId);
    assert.equal(shownAccount.unread_count, read ? 0 : 1);
    const inbox = (await mailRoutes['GET /api/mail/folders']({ url: '/api/mail/folders' }, user)).folders.find(row => row.slug === 'inbox');
    assert.equal(inbox.unread_count, read ? 0 : 1);
  };
  await t.test('MySQL numeric-string flags: independent stored/pending false and true, filters, badges and ownership', async () => {
    // Exercise the actual mysql2 COALESCE/CAST type, not a mock that returns only
    // numbers or only true. Each flag independently has no overlay, false or true.
    for (const storedRead of [0, 1]) for (const storedStar of [0, 1]) {
      for (const pendingRead of [null, 0, 1]) for (const pendingStar of [null, 0, 1]) {
        await pool.execute('DELETE FROM mail_writebacks WHERE email_id = ?', [emailId]);
        await pool.execute('UPDATE emails SET is_read = ?, is_starred = ? WHERE id = ?', [storedRead, storedStar, emailId]);
        const changes = {};
        if (pendingRead !== null) changes.read = pendingRead;
        if (pendingStar !== null) changes.star = pendingStar;
        await queue(changes);
        await assertSnapshot(pendingRead ?? storedRead, pendingStar ?? storedStar, pendingRead !== null, pendingStar !== null);
      }
    }
    // Failed/conflicted intent in either direction must expose stored provider
    // flags again, including false on unfiltered list and detail.
    for (const status of ['failed', 'conflict']) for (const storedRead of [0, 1]) for (const storedStar of [0, 1]) {
      await pool.execute('DELETE FROM mail_writebacks WHERE email_id = ?', [emailId]);
      await pool.execute('UPDATE emails SET is_read = ?, is_starred = ? WHERE id = ?', [storedRead, storedStar, emailId]);
      await queue({ read: 1 - storedRead, star: 1 - storedStar });
      await pool.execute('UPDATE mail_writebacks SET status = ? WHERE email_id = ?', [status, emailId]);
      await assertSnapshot(storedRead, storedStar, false, false);
    }
    await pool.execute('UPDATE emails SET is_read = 0, is_starred = 0 WHERE id = ?', [emailId]);
    await pool.execute('DELETE FROM mail_writebacks WHERE email_id = ?', [emailId]);
    await queue({ read: 1, star: 1 });
    const strangerList = await mailRoutes['GET /api/mail/emails']({ url: '/api/mail/emails', headers: { host: 'localhost' } }, stranger);
    assert.equal(strangerList.pagination.total, 0); assert.deepEqual(strangerList.emails, []);
    assert.equal((await mailRoutes['GET /api/mail/emails/:id']({ url: `/api/mail/emails/${emailId}` }, stranger)).status, 404);
    // A mismatched owner on a pending row must not overlay or count this email.
    await pool.execute('UPDATE mail_writebacks SET user_id = ? WHERE email_id = ?', [stranger, emailId]);
    await assertSnapshot(0, 0, false, false);
    await pool.execute('DELETE FROM mail_writebacks WHERE email_id = ?', [emailId]);
  });
  await queue({ read: 1 });
  assert.equal((await list('')).emails[0].is_read, true, 'Accepted read intent is visible before IMAP completes');
  assert.equal((await list('')).emails[0].read_sync_pending, true);
  assert.equal((await list('?is_read=false')).emails.length, 0, 'Unread filter follows pending read intent');
  assert.equal((await detail()).email.is_read, true, 'Reloaded message detail follows pending read intent');
  assert.equal((await detail()).email.read_sync_pending, true);
  assert.deepEqual((await mailRoutes['GET /api/mail/unread-counts']({ url: '/api/mail/unread-counts', headers: { host: 'localhost' } }, user)).unreadByFolder, {});
  const pendingAccount = (await mailRoutes['GET /api/mail/accounts']({}, user)).accounts.find(row => row.id === accountId);
  assert.equal(pendingAccount.unread_count, 0, 'Account badge follows pending read intent');
  const pendingInbox = (await mailRoutes['GET /api/mail/folders']({ url: '/api/mail/folders' }, user)).folders.find(row => row.slug === 'inbox');
  assert.equal(pendingInbox.unread_count, 0, 'Folder badge follows pending read intent');
  // Reloading module simulates process restart with the same persisted intent.
  delete require.cache[require.resolve('../dist/src/services/mail-writebacks')];
  const restarted = require('../dist/src/services/mail-writebacks');
  const reconcile = require('../dist/src/services/mail-engine/reconciliation');
  const repository = require('../dist/src/services/mail-engine/repository');
  const readOp = await op();
  assert.equal(readOp.state, 'queued', 'Restart preserved accepted operation');
  const settledRead = await reconcile.settleFlagObservation({ operationId: readOp.id, userId: user, accountId,
    source: { folder: 'INBOX', uid: 12, uidvalidity: 9 }, flags: ['\\Seen'],
    modseq: '9007199254740993123', observationRevision: 0 });
  assert.equal(settledRead.settled, true, 'Verified readback atomically settles exact operation');
  assert.equal((await op()).status,'done');
  assert.equal((await pool.execute('SELECT is_read FROM emails WHERE id=?',[emailId]))[0][0].is_read,1);
  assert.equal((await list('')).emails[0].is_read, true, 'Confirmed provider state remains read');
  assert.equal((await list('')).emails[0].read_sync_pending, false);
  await queue({ star:1 });
  assert.equal((await list('?is_starred=true')).emails[0].is_starred, true, 'Pending star also appears immediately');
  await require('../dist/src/services/mail-engine/operations').deferAccountOffline(accountId,user,new Error('offline'));
  await pool.execute("UPDATE mail_writebacks SET available_at=UTC_TIMESTAMP() WHERE action='star'");
  await require('../dist/src/services/mail-engine/operations').deferAccountOffline(accountId,user,new Error('offline'));
  const star=(await pool.execute("SELECT * FROM mail_writebacks WHERE action='star'"))[0][0];
  assert.equal(star.status,'pending'); assert.equal(star.state,'retry_wait'); assert.equal(star.attempts,2);
  assert.equal((await list('?is_starred=true')).emails.length,1,'Transient offline requests retain effective overlay');
  await restarted.cancelForAccount(pool,accountId,user);
  assert.equal((await pool.execute("SELECT state FROM mail_writebacks WHERE action='star'"))[0][0].state,'retry_wait');
  const folderId=crypto.randomUUID();
  await pool.execute("INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,mail_account_id) VALUES (?,?,'filed','Filed',FALSE,?)",[folderId,user,accountId]);
  await pool.execute("INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,'Filed')",[folderId,accountId]);
  await queue({move:'filed'});
  const [[move]]=await pool.execute("SELECT * FROM mail_writebacks WHERE action='move'");
  const box=await repository.withTransaction(cx => repository.ensureMailbox({userId:user,accountId,folderName:'Filed',epoch:10},cx),pool);
  await repository.withTransaction(cx => repository.upsertOccurrence({userId:user,accountId,mailboxId:box.id,epoch:10,
    uid:77,emailId,flags:['\\Seen'],modseq:'9007199254740993124'},cx),pool);
  const result=await reconcile.settleMoveEvidence({operationId:move.id,userId:user,accountId,
    mapping:{uidvalidity:10,sourceUids:[12],destinationUids:[77]},
    destination:{mailboxId:box.id,folder:'Filed',uidvalidity:10,uid:77},source:{absent:true},evidence:{verified:true}});
  assert.equal(result.settled,true);
  const [[email]]=await pool.execute('SELECT folder,remote_uid,remote_uidvalidity,remote_folder FROM emails WHERE id=?',[emailId]);
  assert.deepEqual(email,{folder:'filed',remote_uid:77,remote_uidvalidity:10,remote_folder:'Filed'});
  assert.equal((await pool.execute('SELECT state FROM mail_writebacks WHERE id=?',[move.id]))[0][0].state,'confirmed');
  const route=require('../dist/src/routes/mail')['GET /api/mail/writebacks'];
  const statusRequest = {url:'/api/mail/writebacks',headers:{host:'localhost'}};
  const strangers = await route(statusRequest,stranger);
  assert.equal(strangers.error,undefined, JSON.stringify(strangers));
  assert.deepEqual(strangers.operations,[]);
  const ownedResult = await route(statusRequest,user);
  assert.equal(ownedResult.error,undefined, JSON.stringify(ownedResult));
  const shown=ownedResult.operations;
  assert(shown.length>0); assert(shown.every(row=>!('remote_uid' in row) && !('mail_account_id' in row)));
  await t.test('bulk change with an item that never had a server link: changed locally, the rest goes to the server', async () => {
    const linked = crypto.randomUUID(), unlinked = crypto.randomUUID();
    await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,remote_folder,remote_uid,remote_uidvalidity,is_read)
      VALUES (?,?,?,'test@example.test','[]','inbox','INBOX',41,9,FALSE), (?,?,?,'test@example.test','[]','inbox',NULL,NULL,NULL,FALSE)`,
    [linked, user, accountId, unlinked, user, accountId]);
    const result = await service.mutateMessages(user, [linked, unlinked], { read: 1 });
    assert.equal(result.operation_ids.length, 1);
    const [ops] = await pool.execute('SELECT email_id FROM mail_writebacks WHERE email_id IN (?,?)', [linked, unlinked]);
    assert.deepEqual(ops.map(row => row.email_id), [linked]);
    assert.equal(Number((await pool.execute('SELECT is_read FROM emails WHERE id=?', [unlinked]))[0][0].is_read), 1);
    await pool.execute('UPDATE emails SET remote_folder=? WHERE id=?', ['INBOX', unlinked]);
    await assert.rejects(service.mutateMessages(user, [unlinked], { star: 1 }), { status: 409, message: /link to the mail server is damaged/ });
  });
  await t.test('concurrent identical requests with one Idempotency-Key admit one operation and one response', async () => {
    // Before 0.11.1 each request took a gap lock (SELECT ... FOR UPDATE on a
    // missing key) and then INSERTed, so same-key requests could deadlock.
    const itemId = crypto.randomUUID();
    await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,remote_folder,remote_uid,remote_uidvalidity)
      VALUES (?,?,?,'test@example.test','[]','inbox','INBOX',31,9)`, [itemId, user, accountId]);
    const key = 'synthetic-concurrent-key';
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      service.mutateMessages(user, [itemId], { star: 1 }, undefined, { idempotencyKey: key })));
    assert.equal(results[0].operation_ids.length, 1);
    for (const result of results) assert.deepEqual(result, results[0]);
    const [ops] = await pool.execute("SELECT id FROM mail_writebacks WHERE email_id=? AND action='star'", [itemId]);
    assert.deepEqual(ops.map(row => row.id), results[0].operation_ids);
    const [[jobs]] = await pool.execute('SELECT COUNT(*) AS n FROM mail_engine_jobs WHERE operation_id=?', [ops[0].id]);
    assert.equal(Number(jobs.n), 1);
    const [[receipts]] = await pool.execute('SELECT COUNT(*) AS n FROM mail_command_receipts WHERE user_id=? AND client_key=?', [user, key]);
    assert.equal(Number(receipts.n), 1);
    // A later retry replays the stored response without a new operation.
    assert.deepEqual(await service.mutateMessages(user, [itemId], { star: true }, undefined, { idempotencyKey: key }), results[0]);
    // The same key with another payload, concurrently: one is admitted, the other is refused.
    const mixed = await Promise.allSettled([{ star: 0 }, { read: 1 }].map(changes =>
      service.mutateMessages(user, [itemId], changes, undefined, { idempotencyKey: 'synthetic-mixed-key' })));
    assert.equal(mixed.filter(result => result.status === 'fulfilled').length, 1);
    const refused = mixed.find(result => result.status === 'rejected').reason;
    assert.equal(refused.status, 409);
    assert.equal(refused.message, 'Idempotency-Key already used for a different request');
    assert.equal((await pool.execute('SELECT COUNT(*) AS n FROM mail_writebacks WHERE email_id=?', [itemId]))[0][0].n, 2);
    // Accepted commands start their durable operation jobs; this account has no
    // credentials, so they defer. Let them finish before the pool closes.
    const mail = require('../dist/src/services/mail');
    for (let i = 0; i < 100; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const [[open]] = await pool.execute(`SELECT COUNT(*) AS n FROM mail_engine_jobs WHERE mail_account_id=?
        AND state IN ('queued','running')`, [accountId]);
      if (!Number(open.n) && !mail.isAnyMailAccountSyncRunning()) break;
    }
  });
});
