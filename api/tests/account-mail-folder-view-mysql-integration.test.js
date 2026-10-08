const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');

test('real MySQL folder views preserve Gmail memberships, distinct items, intent overlays and owner boundaries', { skip: !process.env.MYSQL_TEST_HOST }, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, timezone: '+00:00' });
  let owned = false;
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'folder-gate-admin@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-folder-gate-password';
  const state = require('../dist/src/state'), old = state.getDb();
  t.after(async () => {
    if (owned) {
      const cx = await pool.getConnection();
      try {
        await cx.query('SET FOREIGN_KEY_CHECKS=0');
        const [tables] = await cx.query('SHOW TABLES');
        for (const row of tables) { const name = Object.values(row)[0]; assert.match(name, /^[a-z_]+$/); await cx.query('DROP TABLE `' + name + '`'); }
      } finally { cx.release(); }
    }
    state.setDb(old); await pool.end();
  });
  const [tables] = await pool.query('SHOW TABLES');
  assert.equal(tables.length, 0, 'Requires an empty disposable test schema'); owned = true;
  state.setDb(pool); await require('../dist/src/services/database').ensureSchema();
  const owner = randomUUID(), stranger = randomUUID(), account = randomUUID(), item = randomUUID(), copy = randomUUID();
  await pool.execute("INSERT INTO users (id,email,password_hash) VALUES (?,'labels@example.test','test'),(?,'stranger@example.test','test')", [owner,stranger]);
  await pool.execute("INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active) VALUES (?,?,'mail@example.test','custom','sync',FALSE)", [account,owner]);
  for (const id of [item,copy]) await pool.execute(`INSERT INTO emails
    (id,user_id,mail_account_id,from_address,to_addresses,folder,message_id,is_read,is_starred)
    VALUES (?,?,?,'fixture@example.test','[]','inbox','duplicate-message-id@example.test',FALSE,FALSE)`, [id,owner,account]);
  const repository = require('../dist/src/services/mail-engine/repository');
  const boxes = new Map();
  for (const [slug,name] of [['inbox','INBOX'],['all-mail','[Gmail]/All Mail'],['label','Projects/Grüße']]) {
    const folder = randomUUID();
    await pool.execute('INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,mail_account_id) VALUES (?,?,?,?,?,?)',
      [folder,owner,slug,name,slug === 'inbox' ? 1 : 0,slug === 'inbox' ? null : account]);
    await pool.execute('INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,?)', [folder,account,name]);
    const box = await repository.withTransaction(cx => repository.ensureMailbox({userId:owner,accountId:account,folderName:name,epoch:17},cx),pool);
    boxes.set(slug,box);
    await repository.withTransaction(cx => repository.upsertOccurrence({userId:owner,accountId:account,mailboxId:box.id,
      epoch:17,uid:11,emailId:item,gmailMsgId:'9007199254740993123'},cx),pool);
  }
  await repository.withTransaction(cx => repository.upsertOccurrence({userId:owner,accountId:account,mailboxId:boxes.get('inbox').id,
    epoch:17,uid:12,emailId:copy},cx),pool);
  const routes = require('../dist/src/routes/mail');
  const list = async (folder, user = owner) => {
    const result = await routes['GET /api/mail/emails']({url:`/api/mail/emails?folder=${encodeURIComponent(folder)}`,headers:{host:'localhost'}},user);
    assert.equal(result.error,undefined); return result;
  };
  const counts = async user => {
    const result = await routes['GET /api/mail/unread-counts']({url:'/api/mail/unread-counts?include_by_account=true',headers:{host:'localhost'}},user || owner);
    assert.equal(result.error,undefined); return result;
  };
  await t.test('one logical Gmail item appears in each label, but all-items remains unique and generic copy remains separate', async () => {
    assert.equal((await list('all')).pagination.total,2);
    assert.equal((await list('inbox')).pagination.total,2);
    for (const folder of ['all-mail','label']) { const rows = await list(folder); assert.equal(rows.pagination.total,1); assert.equal(rows.emails[0].id,item); assert.equal(rows.emails[0].folder,folder); }
    const badges = await counts();
    assert.deepEqual(badges.unreadByFolder, {'all-mail':1,inbox:2,label:1});
    assert.equal(badges.unreadByFolderAccount.label[account],1);
    const folders = await routes['GET /api/mail/folders']({url:'/api/mail/folders'},owner);
    assert.equal(folders.error,undefined);
    assert.equal(folders.folders.find(row => row.slug === 'label').unread_count,1);
    assert.equal((await list('label',stranger)).pagination.total,0);
    assert.deepEqual((await counts(stranger)).unreadByFolder,{});
  });
  await t.test('standalone pooled occurrence writes roll back a Gmail identity when a tuple conflict rejects the write', async () => {
    await assert.rejects(repository.upsertOccurrence({userId:owner,accountId:account,mailboxId:boxes.get('inbox').id,
      epoch:17,uid:11,emailId:copy,gmailMsgId:'42'},pool), {code:'MAIL_TUPLE_CONFLICT'});
    const [[mappings]] = await pool.execute('SELECT COUNT(*) AS n FROM mail_gmail_messages WHERE mail_account_id=? AND gmail_msgid=?',[account,'42']);
    assert.equal(mappings.n,0, 'A rejected occurrence cannot leave a partial provider identity binding');
  });
  await t.test('latest accepted MOVE overrides every stale membership, then read overlay updates all badges', async () => {
    await pool.execute(`INSERT INTO mail_writebacks (id,user_id,mail_account_id,email_id,action,target_value,base_value,target_folder,
      remote_folder,remote_uid,remote_uidvalidity,status,state,is_current,intent_revision)
      VALUES (?,?,?,?,'move','label','INBOX','label','INBOX',11,17,'pending','queued',TRUE,1)`, [randomUUID(),owner,account,item]);
    assert.equal((await list('inbox')).pagination.total,1);
    assert.equal((await list('all-mail')).pagination.total,0);
    assert.equal((await list('label')).pagination.total,1);
    assert.deepEqual((await counts()).unreadByFolder,{inbox:1,label:1});
    await pool.execute(`INSERT INTO mail_writebacks (id,user_id,mail_account_id,email_id,action,target_value,base_value,
      remote_folder,remote_uid,remote_uidvalidity,status,state,is_current,intent_revision)
      VALUES (?,?,?,?,'read','1','0','INBOX',11,17,'pending','queued',TRUE,2)`, [randomUUID(),owner,account,item]);
    assert.deepEqual((await counts()).unreadByFolder,{inbox:1});
    assert.equal((await list('label')).emails[0].is_read,true);
    await pool.execute("UPDATE mail_writebacks SET status='done',state='confirmed',is_current=FALSE WHERE user_id=?",[owner]);
  });
  await t.test('lost remote membership stays retained in All mail without reappearing in a stale provider folder', async () => {
    await pool.execute("UPDATE mail_remote_occurrences SET presence='absent' WHERE email_id=? AND mailbox_id=?",[item,boxes.get('inbox').id]);
    assert.equal((await list('inbox')).pagination.total,1);
    assert.equal((await list('label')).pagination.total,1, 'Another live label still owns membership');
    await pool.execute("UPDATE mail_remote_occurrences SET presence='absent' WHERE email_id=?",[item]);
    await pool.execute('UPDATE emails SET remote_missing=TRUE WHERE id=?',[item]);
    assert.equal((await list('inbox')).pagination.total,1);
    assert.equal((await list('label')).pagination.total,0);
    assert.equal((await list('all-mail')).pagination.total,0);
    assert.equal((await list('all')).pagination.total,2, 'Provider absence never deletes the local archive');
    assert.equal((await list('all')).emails.find(row => row.id===item).remote_missing,true);
    assert.deepEqual((await counts()).unreadByFolder,{inbox:1});
    await pool.execute("UPDATE mail_remote_occurrences SET presence='present' WHERE email_id=?",[item]);
    await pool.execute('UPDATE emails SET remote_missing=FALSE WHERE id=?',[item]);
  });
  await t.test('explicit local Legacy filing is not overwritten by provider labels', async () => {
    await pool.execute("UPDATE emails SET is_legacy=TRUE,folder='retained' WHERE id=?",[item]);
    assert.equal((await list('label')).pagination.total,0);
    assert.equal((await list('retained')).emails[0].id,item);
    const badges = await counts();
    assert.deepEqual(badges.unreadByFolder,{inbox:1,retained:1});
    assert.equal(badges.unreadByFolderAccount.retained.legacy,1);
  });
  await t.test('local Legacy recovery survives a lost HTTP response with the same durable receipt and rejects key reuse', async () => {
    const receiving = randomUUID();
    await pool.execute("INSERT INTO mail_accounts (id,user_id,email_address,provider,is_active) VALUES (?,?,'receiving@example.test','custom',FALSE)", [receiving,owner]);
    const request = { url:'/api/mail/emails/bulk-move', headers:{host:'localhost','idempotency-key':'legacy-recovery-fixture'} };
    const body = {email_ids:[item],folder:'inbox',account_id:receiving};
    // Two concurrent identical requests: one files, the other waits and replays (no deadlock).
    const [result, raced] = await Promise.all([1, 2].map(() => routes['POST /api/mail/emails/bulk-move'](request,owner,body)));
    assert.equal(result.error,undefined); assert.equal(result.local_only,true); assert.equal(result.sync_pending,false);
    assert.deepEqual(raced,result);
    assert.equal((await pool.execute('SELECT COUNT(*) AS n FROM mail_folder_recovery_items WHERE email_id=?',[item]))[0][0].n,1);
    const again = await routes['POST /api/mail/emails/bulk-move'](request,owner,body);
    assert.deepEqual(again,result, 'A retried accepted local filing must not be rejected as no longer Legacy');
    const [[message]] = await pool.execute('SELECT mail_account_id,filing_account_id,folder,is_legacy FROM emails WHERE id=?',[item]);
    assert.deepEqual(message,{mail_account_id:account,filing_account_id:receiving,folder:'inbox',is_legacy:0});
    const receipt = await require('../dist/src/services/mail-writebacks').getOperationReceipt(owner,'legacy-recovery-fixture');
    assert.equal(receipt.found,true); assert.deepEqual(receipt.response,result); assert.deepEqual(receipt.operations,[]);
    assert.equal((await require('../dist/src/services/mail-writebacks').getOperationReceipt(stranger,'legacy-recovery-fixture')).found,false);
    const conflict = await routes['POST /api/mail/emails/bulk-move'](request,owner,{...body,folder:'label'});
    assert.equal(conflict.status,409); assert.equal(conflict.error,'Idempotency-Key already used for a different request');
    const [[unchanged]] = await pool.execute('SELECT folder FROM emails WHERE id=?',[item]);
    assert.equal(unchanged.folder,'inbox');
  });
});
