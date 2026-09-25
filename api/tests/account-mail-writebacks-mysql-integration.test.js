// Run before database-startup smoke, which intentionally leaves a populated schema.
// Node sorts test file paths even when the runner supplies another argument order.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

test('durable mail commands: ownership, restart, retries, account cancellation and provider moves', { skip: !process.env.MYSQL_TEST_HOST }, async t => {
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
  const { setDb } = require('../src/state'); setDb(pool);
  await require('../src/services/database').ensureSchema();
  const service = require('../src/services/mail-writebacks');
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
  await queue({ read: 1 });
  // Reloading module simulates process restart with the same persisted intent.
  delete require.cache[require.resolve('../src/services/mail-writebacks')];
  const restarted = require('../src/services/mail-writebacks');
  const remoteFlags = new Set(), writes = [];
  let modseq='100', currentFolder='INBOX', connectionError=false;
  const connection = {
    openBox: async folder => { currentFolder=folder; return { uidvalidity: folder==='Filed'?10:9 }; },
    search: async (_criteria, options) => {
      if (connectionError) throw new Error('Disconnected');
      return [{ attributes: { uid:currentFolder==='Filed'?77:12, flags:[...remoteFlags], modseq }, parts: options.bodies.length ? [{which:'',body:raw}] : [] }];
    },
    imap: { _box:{}, serverSupports:c=>['MOVE','CONDSTORE'].includes(c), addFlagsSince:(_uid,flag,_version,cb)=>{writes.push(flag);remoteFlags.add(flag);modseq='101';cb(null);}, move:(_uid,_folder,cb)=>{writes.push('move');cb(null,'77');} }
  };
  await restarted.processPending(account, connection);
  assert.equal((await op()).status,'done'); assert.deepEqual(writes,['\\Seen']);
  assert.equal((await pool.execute('SELECT is_read FROM emails WHERE id=?',[emailId]))[0][0].is_read,1);
  await queue({ star:1 }); connectionError=true;
  await restarted.processPending(account,connection);
  let star=(await pool.execute("SELECT * FROM mail_writebacks WHERE action='star'"))[0][0]; assert.equal(star.status,'pending'); assert.equal(star.attempts,1);
  await pool.execute("UPDATE mail_writebacks SET available_at=UTC_TIMESTAMP() WHERE action='star'");
  await restarted.processPending(account,connection);
  star=(await pool.execute("SELECT * FROM mail_writebacks WHERE action='star'"))[0][0]; assert.equal(star.status,'failed'); assert.equal(star.attempts,2);
  await restarted.processPending(account,connection); assert.equal((await pool.execute("SELECT attempts FROM mail_writebacks WHERE action='star'"))[0][0].attempts,2);
  await restarted.cancelForAccount(pool,accountId,user); assert.equal((await pool.execute("SELECT status FROM mail_writebacks WHERE action='star'"))[0][0].status,'conflict');
  connectionError=false;
  const folderId=crypto.randomUUID();
  await pool.execute("INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,mail_account_id) VALUES (?,?,'filed','Filed',FALSE,?)",[folderId,user,accountId]);
  await pool.execute("INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,'Filed')",[folderId,accountId]);
  await queue({move:'filed'}); await restarted.processPending(account,connection);
  const [[email]]=await pool.execute('SELECT folder,remote_uid,remote_uidvalidity,remote_folder FROM emails WHERE id=?',[emailId]);
  assert.deepEqual(email,{folder:'filed',remote_uid:77,remote_uidvalidity:10,remote_folder:'Filed'});
  assert.equal(writes.filter(x=>x==='move').length,1);
  const route=require('../src/routes/mail')['GET /api/mail/writebacks'];
  assert.deepEqual((await route({},stranger)).operations,[]);
  const shown=(await route({},user)).operations;
  assert(shown.length>0); assert(shown.every(row=>!('remote_uid' in row) && !('mail_account_id' in row)));
});
