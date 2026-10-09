'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MySQL 8 database ending in _test.
// Run before database-startup-mysql-integration, which leaves its schema populated.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { randomUUID, createHash } = (require('node:crypto') as typeof import('node:crypto'));
const mysql = require('mysql2/promise');

const uuid = (suffix: string | number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const rows = async (db: FixtureValue, sql: string, args: FixtureValue[] = []) => (await db.execute(sql, args))[0];
const one = async (db: FixtureValue, sql: string, args: FixtureValue[] = []) => (await rows(db, sql, args))[0];
const json = (value: FixtureValue) => typeof value === 'string' ? JSON.parse(value) : value;

test('MySQL 8 mail-engine migration, identity, durable recovery and restore safety', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 180000,
}, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Only an isolated disposable schema is allowed');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
    database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 5 });
  // Set synthetic bootstrap configuration before loading state/database/config;
  // never inherit a real installation's bootstrap credentials in this fixture.
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'recovery-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-recovery-bootstrap-password';
  const state = require('../dist/src/state');
  const originalDb = state.getDb();
  let ownsSchema = false;
  t.after(async () => {
    try {
      if (ownsSchema) {
        const cx = await pool.getConnection();
        try {
          await cx.query('SET FOREIGN_KEY_CHECKS = 0');
          try {
            for (const table of await rows(cx, 'SHOW TABLES')) {
              const name = Object.values(table)[0];
              assert.match((name as string), /^[a-z_]+$/);
              await cx.query(`DROP TABLE \`${name}\``);
            }
          } finally { await cx.query('SET FOREIGN_KEY_CHECKS = 1'); }
        } finally { cx.release(); }
      }
    } finally { state.setDb(originalDb); await pool.end(); }
  });
  assert.match((await one(pool, 'SELECT VERSION() AS version')).version, /MariaDB/);
  assert.equal((await rows(pool, 'SHOW TABLES')).length, 0, 'Refuse to touch a populated schema');
  ownsSchema = true;
  state.setDb(pool);
  const { ensureSchema } = require('../dist/src/services/database');
  const repo = require('../dist/src/services/mail-engine/repository');
  const runtime = require('../dist/src/services/mail-engine/runtime');
  await ensureSchema();
  const owner = randomUUID(), other = randomUUID();
  const account = randomUUID(), secondAccount = randomUUID(), otherAccount = randomUUID();
  await pool.execute("INSERT INTO users (id,email,password_hash) VALUES (?,'recovery-owner@example.test','test'),(?,'recovery-other@example.test','test')", [owner, other]);
  for (const [id, user, address] of [[account,owner,'primary@example.test'],[secondAccount,owner,'second@example.test'],[otherAccount,other,'other@example.test']] as const) {
    await pool.execute("INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active) VALUES (?,?,?,'custom','sync',TRUE)", [id,user,address]);
  }
  const insertEmail = async (id: FixtureValue, user = owner, accountId = account, extra: FixtureValue = {}) => {
    const fields = { id, user_id:user, mail_account_id:accountId, from_address:'synthetic@example.test', to_addresses:'[]', folder:'inbox', ...extra };
    const names = Object.keys(fields);
    await pool.execute(`INSERT INTO emails (${names.map(name => `\`${name}\``).join(',')}) VALUES (${names.map(() => '?').join(',')})`, Object.values(fields));
  };
  const insertOp = async ({ id = randomUUID(), user = owner, accountId = account, emailId, action = 'move', status = 'pending', state = null, dispatched = 0, uid = 11, epoch = 7, folder = 'INBOX' }: FixtureValue, executor = pool) => {
    await executor.execute(`INSERT INTO mail_writebacks (id,user_id,mail_account_id,email_id,action,target_value,base_value,target_folder,
      remote_folder,remote_uid,remote_uidvalidity,status,state,dispatched) VALUES (?,?,?,?,?,'Archive','INBOX','archive',?,?,?,?,?,?)`,
    [id,user,accountId,emailId,action,folder,uid,epoch,status,state,dispatched]);
    return id;
  };
  const txn = (callback: FixtureValue) => repo.withTransaction(callback,pool);
  const box = (name: FixtureValue, epoch = 7, accountId = account, user = owner) => txn((cx: FixtureValue) => repo.ensureMailbox({userId:user,accountId,folderName:name,epoch},cx));
  const occurrence = (mailbox: FixtureValue, emailId: string, opts: FixtureValue = {}) => txn((cx: FixtureValue) => repo.upsertOccurrence({userId:owner,accountId:account,
    mailboxId:mailbox.id,epoch:7,uid:11,emailId, ...opts},cx));

  // The later steps share an archived message with a current server copy.
  await insertEmail(uuid(2),owner,account,{message_id:'<duplicate@example.test>',remote_folder:'Archive',remote_uid:20,remote_uidvalidity:7});
  await occurrence(await box('Archive'),uuid(2),{uid:20});

  await t.test('exact binary mailbox paths, owner-scoped occurrences, independent copies and account-scoped Gmail identity', async () => {
    const names = ['Projects','projects','Projects ','Projekte/Grüße','[Gmail]/Papierkorb'];
    const boxes: FixtureValue[] = [];
    for (const name of names) boxes.push(await box(name));
    assert.deepEqual((await rows(pool,'SELECT remote_name FROM mail_remote_mailboxes WHERE mail_account_id=? ORDER BY BINARY remote_name',[account])).map((row: FixtureValue) => row.remote_name).filter((name: FixtureValue) => name.toLowerCase().startsWith('projects')),
      ['Projects','Projects ','projects']);
    assert.equal((await box('inbox')).id,(await box('INBOX')).id);
    assert.notEqual(boxes[0].id,boxes[1].id);
    assert.notEqual(boxes[0].id,boxes[2].id);
    const [[column]] = await pool.execute("SHOW FULL COLUMNS FROM mail_folder_remote_boxes WHERE Field='remote_name'");
    assert.equal(column.Collation,'utf8mb4_nopad_bin','Old mapping unique index must also be NO PAD');
    const folderIds = [randomUUID(),randomUUID()];
    for (const [index,name] of ['Projects','Projects '].entries()) {
      await pool.execute('INSERT INTO mail_folders (id,user_id,slug,display_name,mail_account_id) VALUES (?,?,?,?,?)',
        [folderIds[index],owner,`mapped-${index}`,name,account]);
      await pool.execute('INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,?)',[folderIds[index],account,name]);
    }
    const copy = randomUUID(), rival = randomUUID(), foreign = randomUUID(), cross = randomUUID();
    await insertEmail(copy,owner,account,{message_id:'<duplicate@example.test>',raw_sha256:hash('same bytes')});
    await insertEmail(rival,owner,account,{message_id:'<duplicate@example.test>',raw_sha256:hash('same bytes')});
    await insertEmail(foreign,other,otherAccount);
    await insertEmail(cross,owner,secondAccount);
    const first = await occurrence(boxes[0],copy,{uid:100,modseq:'9007199254740993123'});
    const duplicate = await occurrence(boxes[0],rival,{uid:101,modseq:'9007199254740993124'});
    assert.notEqual(first.email_id,duplicate.email_id);
    assert.notEqual(first.id,duplicate.id);
    await assert.rejects(occurrence(boxes[0],rival,{uid:100}),{code:'MAIL_TUPLE_CONFLICT'});
    await assert.rejects(pool.execute(`INSERT INTO mail_remote_occurrences
      (id,user_id,mail_account_id,mailbox_id,uidvalidity,uid,email_id) VALUES (?,?,?,?,?,?,?)`,
    [randomUUID(),owner,account,boxes[0].id,7,100,rival]),{code:'ER_DUP_ENTRY'});
    await assert.rejects(occurrence(boxes[0],foreign,{uid:102}),{code:'MAIL_ITEM_NOT_OWNED'});
    await assert.rejects(occurrence(boxes[0],cross,{uid:102}),{code:'MAIL_ITEM_NOT_OWNED'});
    await assert.rejects(txn((cx: FixtureValue) => repo.upsertOccurrence({userId:other,accountId:account,mailboxId:boxes[0].id,epoch:7,uid:102,emailId:foreign},cx)),{code:'MAILBOX_NOT_OWNED'});
    assert.equal(await repo.getOccurrence({userId:other,accountId:account,mailboxId:boxes[0].id,epoch:7,uid:100},pool),null);
    assert.equal((await repo.getOccurrence({userId:owner,accountId:account,mailboxId:boxes[0].id,epoch:7,uid:100},pool)).email_id,copy);
    await occurrence(boxes[0],copy,{uid:100,modseq:'9007199254740993122',flags:['\\Seen']});
    assert.equal((await one(pool,'SELECT observed_modseq FROM mail_remote_occurrences WHERE id=?',[first.id])).observed_modseq,'9007199254740993123');
    const gmail = '9007199254740993123';
    await occurrence(boxes[1],copy,{uid:201,gmailMsgId:gmail});
    await occurrence(boxes[2],copy,{uid:202,gmailMsgId:gmail});
    // A legacy per-label copy keeps its own occurrence; the conflict is quarantined for review.
    await occurrence(boxes[3],rival,{uid:203,gmailMsgId:gmail});
    assert.equal((await one(pool,"SELECT COUNT(*) AS n FROM mail_engine_quarantine WHERE source_id=? AND reason='gmail_identity_conflict'",[rival])).n,1);
    await assert.rejects(pool.execute('INSERT INTO mail_gmail_messages (mail_account_id,gmail_msgid,user_id,email_id) VALUES (?,?,?,?)',
      [account,gmail,owner,rival]),{code:'ER_DUP_ENTRY'});
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_gmail_messages WHERE mail_account_id=? AND gmail_msgid=?',[account,gmail])).n,1);
    assert.equal((await one(pool,'SELECT email_id FROM mail_remote_occurrences WHERE mailbox_id=? AND uid=203',[boxes[3].id])).email_id,rival);
    assert.equal((await one(pool,'SELECT email_id FROM mail_gmail_messages WHERE mail_account_id=? AND gmail_msgid=?',[account,gmail])).email_id,copy);
    const otherBox = await box('Projects',7,secondAccount,owner);
    await txn((cx: FixtureValue) => repo.upsertOccurrence({userId:owner,accountId:secondAccount,mailboxId:otherBox.id,epoch:7,uid:201,emailId:cross,gmailMsgId:gmail},cx));
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_gmail_messages WHERE gmail_msgid=?',[gmail])).n,2);
    const otherOwnersBox = await box('Projects',7,otherAccount,other);
    assert.notEqual(otherOwnersBox.id,boxes[0].id);
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_remote_occurrences WHERE mailbox_id=?',[boxes[0].id])).n,2);
  });

  await t.test('only complete same-epoch windows advance cursors or infer bounded absence', async () => {
    const mailbox = await box('Coverage');
    const items = [randomUUID(),randomUUID(),randomUUID()];
    for (const item of items) await insertEmail(item);
    for (const [index,item] of items.entries()) await occurrence(mailbox,item,{uid:100+index});
    const cursor = {userId:owner,accountId:account,mailboxId:mailbox.id,stream:'presence',epoch:7,
      windowStart:100,windowEnd:101,coveredThrough:101,checkpoint:'9007199254740993123'};
    await assert.rejects(txn((cx: FixtureValue) => repo.saveCursor({...cursor,complete:false},cx)),{code:'INCOMPLETE_COVERAGE'});
    assert.equal(await repo.loadCursor({userId:owner,accountId:account,mailboxId:mailbox.id,stream:'presence',epoch:7},pool),null);
    await txn((cx: FixtureValue) => repo.saveCursor({...cursor,complete:true},cx));
    await assert.rejects(txn((cx: FixtureValue) => repo.saveCursor({...cursor,windowEnd:102,coveredThrough:100},cx)),{code:'CURSOR_REGRESSION'});
    await assert.rejects(txn((cx: FixtureValue) => repo.markAbsentInWindow({userId:owner,accountId:account,mailboxId:mailbox.id,
      epoch:7,windowStart:100,windowEnd:101,presentUids:[100],complete:false},cx)),{code:'INCOMPLETE_COVERAGE'});
    assert.equal(await txn((cx: FixtureValue) => repo.markAbsentInWindow({userId:owner,accountId:account,mailboxId:mailbox.id,
      epoch:7,windowStart:100,windowEnd:101,presentUids:[100],complete:true},cx)),1);
    assert.deepEqual((await rows(pool,'SELECT uid,presence FROM mail_remote_occurrences WHERE mailbox_id=? ORDER BY uid',[mailbox.id])).map((r: FixtureValue) => r.presence),
      ['present','absent','present'],'Uncovered UID 102 is not called absent');
    await box('Coverage',8);
    assert.equal(await repo.loadCursor({userId:owner,accountId:account,mailboxId:mailbox.id,stream:'presence',epoch:7},pool),null);
    await assert.rejects(txn((cx: FixtureValue) => repo.markAbsentInWindow({userId:owner,accountId:account,mailboxId:mailbox.id,
      epoch:7,windowStart:100,windowEnd:102,presentUids:[],complete:true},cx)),{code:'MAIL_EPOCH_STALE'});
    assert.deepEqual((await rows(pool,'SELECT uid,presence FROM mail_remote_occurrences WHERE mailbox_id=? ORDER BY uid',[mailbox.id])).map((r: FixtureValue) => r.presence),
      ['quarantined','absent','quarantined'],'Epoch reset preserves historical absence and quarantines only formerly present addresses');
  });

  await t.test('receipt rollback, persisted replay and hash collision never admit another command', async () => {
    const key = 'synthetic-collision', requestHash = hash('move once'), differentHash = hash('move somewhere else');
    const operation = randomUUID(), accepted = {operation_ids:[operation],sync_pending:true,accepted_revision:1};
    await assert.rejects(txn(async (cx: FixtureValue) => {
      await repo.recordReceipt({userId:owner,clientKey:key,requestHash,response:accepted},cx);
      throw new Error('synthetic admission failure');
    }), /synthetic admission failure/);
    assert.equal(await repo.getReceipt({userId:owner,clientKey:key},pool),null);
    const result = await txn(async (cx: FixtureValue) => {
      const receipt = await repo.recordReceipt({userId:owner,clientKey:key,requestHash,response:accepted},cx);
      await insertOp({id:operation,emailId:uuid(2),state:'queued',uid:20,folder:'Archive'},cx);
      return receipt;
    });
    assert.equal(result.replayed,false);
    assert.deepEqual(await txn((cx: FixtureValue) => repo.recordReceipt({userId:owner,clientKey:key,requestHash,response:{operation_ids:['different']}},cx)),{response:accepted,replayed:true});
    await assert.rejects(txn((cx: FixtureValue) => repo.recordReceipt({userId:owner,clientKey:key,requestHash:differentHash,response:{operation_ids:['different']}},cx)),{code:'IDEMPOTENCY_KEY_REUSED'});
    assert.deepEqual(json((await repo.getReceipt({userId:owner,clientKey:key},pool)).response_json),accepted);
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_writebacks WHERE id=?',[operation])).n,1);
    assert.equal(await repo.getReceipt({userId:other,clientKey:key},pool),null);
    assert.equal((await txn((cx: FixtureValue) => repo.recordReceipt({userId:other,clientKey:key,requestHash:differentHash,response:{operation_ids:[]}},cx))).replayed,false);
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_command_receipts WHERE client_key=?',[key])).n,2);
  });

  await t.test('expired lease fences old worker; crash after dispatch fence becomes reconciliation, never a blind retry', async () => {
    const mailbox = await box('Recovery',9);
    const item = randomUUID(); await insertEmail(item);
    const observed = await txn((cx: FixtureValue) => repo.upsertOccurrence({userId:owner,accountId:account,mailboxId:mailbox.id,epoch:9,uid:50,emailId:item},cx));
    const op = await insertOp({emailId:item,state:'queued',uid:50,epoch:9,folder:'Recovery'});
    const job = await runtime.enqueueJob({userId:owner,accountId:account,operationId:op,kind:'operation'},pool);
    const claimed = await runtime.claimDueJob({workerId:'old-worker',kinds:['operation']},pool);
    assert.equal(claimed.id,job.id);
    assert.equal((await runtime.beginOperationAttempt({operationId:op,userId:owner,accountId:account,workerId:'old-worker',generation:Number(claimed.worker_generation)},pool)).operation_id,op);
    assert.equal((await one(pool,'SELECT source_occurrence_id FROM mail_writebacks WHERE id=?',[op])).source_occurrence_id,observed.id);
    await assert.rejects(runtime.beginOperationAttempt({operationId:op,userId:owner,accountId:account,workerId:'old-worker',generation:Number(claimed.worker_generation)},pool),
      {code:'MAIL_OPERATION_UNCERTAIN'});
    await pool.execute('UPDATE mail_engine_accounts SET lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 SECOND) WHERE mail_account_id=?',[account]);
    await pool.execute('UPDATE mail_engine_jobs SET lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 SECOND) WHERE id=?',[job.id]);
    await assert.rejects(runtime.updateJob({jobId:job.id,accountId:account,workerId:'old-worker',generation:Number(claimed.worker_generation),phase:'unsafe'},pool),{code:'MAIL_WORKER_FENCED'});
    const recovery = await runtime.recoverExpiredJobs(pool);
    assert.ok(recovery.jobs >= 1 && recovery.operations >= 1);
    assert.deepEqual(await one(pool,'SELECT state,status,dispatched FROM mail_writebacks WHERE id=?',[op]),{state:'reconciling',status:'pending',dispatched:1});
    assert.deepEqual(await one(pool,'SELECT kind,state FROM mail_engine_jobs WHERE id=?',[job.id]),{kind:'reconcile',state:'queued'});
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_operation_attempts WHERE operation_id=?',[op])).n,1);
    assert.equal((await one(pool,'SELECT outcome FROM mail_operation_attempts WHERE operation_id=?',[op])).outcome,'prepared');
    await assert.rejects(runtime.completeJob({jobId:job.id,accountId:account,workerId:'old-worker',generation:Number(claimed.worker_generation)},pool),{code:'MAIL_WORKER_FENCED'});
    const resumed = await runtime.claimDueJob({workerId:'new-worker',kinds:['reconcile']},pool);
    assert.equal(resumed.id,job.id);
    await assert.rejects(runtime.beginOperationAttempt({operationId:op,userId:owner,accountId:account,workerId:'new-worker',generation:Number(resumed.worker_generation)},pool),
      {code:'MAIL_OPERATION_UNCERTAIN'});
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_operation_attempts WHERE operation_id=?',[op])).n,1);
    await runtime.completeJob({jobId:job.id,accountId:account,workerId:'new-worker',generation:Number(resumed.worker_generation)},pool);
    const stale = await insertOp({emailId:item,state:'queued',uid:50,epoch:9,folder:'Recovery'});
    await box('Recovery',10);
    assert.deepEqual(await one(pool,'SELECT state,status FROM mail_writebacks WHERE id=?',[stale]),
      {state:'needs_attention',status:'conflict'},'Undispatched intent on a reset epoch waits for user retry or discard');
    assert.equal((await one(pool,'SELECT presence FROM mail_remote_occurrences WHERE id=?',[observed.id])).presence,'quarantined');
    assert.equal((await one(pool,'SELECT state FROM mail_writebacks WHERE id=?',[op])).state,'reconciling');
  });

  await t.test('restore retains accepted journal, remaps receipt and quarantines provider evidence without executable mappings', async () => {
    const { restoreMailEngineEvidence } = require('../dist/src/services/backup-mail-engine');
    const prior = await insertOp({emailId:uuid(2),state:'executing',dispatched:1,uid:20,folder:'Archive'});
    const pendingSync = await runtime.enqueueJob({userId:owner,accountId:account,kind:'sync'},pool);
    const sourceId = randomUUID(), receiptKey = 'restore-unknown';
    const archived = {id:sourceId,user_id:other,mail_account_id:account,email_id:uuid(2),action:'move',target_value:'Archive',
      base_value:'INBOX',target_folder:'archive',remote_folder:'Archive',remote_uid:20,remote_uidvalidity:7,
      state:'reconciling',status:'pending',dispatched:1,attempts:1,intent_revision:'2'};
    const options = () => ({accountIds:new Map([[account,account]]),emailIds:new Map([[uuid(2),uuid(2)]]),
      writtenEmailIds:new Set<FixtureValue>(),restoredPaths:new Map(),checkCancelled:async () => {},warnings:[]});
    const data = {mail_accounts:[{id:account}],mail_writebacks:[archived],mail_command_receipts:[{
      user_id:other,client_key:receiptKey,request_hash:hash('restored request'),
      response_json:{operation_ids:[sourceId],sync_pending:true},
    }],mail_remote_occurrences:[{id:randomUUID(),user_id:other,mail_account_id:account,email_id:uuid(2),
      mailbox_id:randomUUID(),uidvalidity:7,uid:20,presence:'present'}],
      mail_operation_attempts:[{id:randomUUID(),user_id:other,mail_account_id:account,operation_id:sourceId,
        worker_generation:1,outcome:'uncertain',transmission:'unknown'}]};
    const opts = options();
    await txn((cx: FixtureValue) => restoreMailEngineEvidence(cx,owner,data,opts));
    const restored = await one(pool,'SELECT * FROM mail_writebacks WHERE user_id=? AND id<>? AND JSON_UNQUOTE(JSON_EXTRACT(evidence_json,"$.archive_operation_id"))=?',
      [owner,prior,sourceId]);
    assert.ok(restored); assert.notEqual(restored.id,sourceId);
    assert.equal(restored.state,'needs_attention'); assert.equal(restored.status,'conflict');
    assert.equal(restored.dispatched,1); assert.equal(restored.is_current,0);
    const existing = await one(pool,'SELECT state FROM mail_writebacks WHERE id=?',[prior]);
    assert.equal(existing.state,'needs_attention','Existing accepted operation survives but is paused');
    const receipt = await repo.getReceipt({userId:owner,clientKey:receiptKey},pool);
    assert.deepEqual(json(receipt.response_json).operation_ids,[restored.id]);
    assert.equal(json(receipt.response_json).recovery_required,true);
    assert.deepEqual((await rows(pool,'SELECT source_table,COUNT(*) AS n FROM mail_engine_quarantine WHERE user_id=? AND reason="restored_evidence" GROUP BY source_table ORDER BY source_table',[owner])),
      [{source_table:'mail_operation_attempts',n:1},{source_table:'mail_remote_occurrences',n:1}]);
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_remote_occurrences WHERE email_id=?',[uuid(2)])).n,1,
      'Existing migration occurrence survives; archived mapping was not activated');
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_operation_attempts WHERE operation_id=?',[restored.id])).n,0);
    assert.equal((await one(pool,'SELECT is_active,delete_emails_on_server FROM mail_accounts WHERE id=?',[account])).is_active,0);
    assert.ok(opts.warnings.some(w => /never blindly replayed/.test(w)));
    await assert.rejects(txn((cx: FixtureValue) => restoreMailEngineEvidence(cx,owner,{mail_command_receipts:[{
      client_key:receiptKey,request_hash:hash('conflicting request'),response_json:{operation_ids:[]},
    }]},options())),/conflicts with an existing accepted request/);
    assert.equal((await repo.getReceipt({userId:owner,clientKey:receiptKey},pool)).request_hash,hash('restored request'));
    assert.equal((await one(pool,'SELECT COUNT(*) AS n FROM mail_engine_jobs WHERE operation_id=?',[restored.id])).n,0);
    assert.equal((await one(pool,'SELECT state FROM mail_engine_jobs WHERE id=?',[pendingSync.id])).state,'paused');
    // Reconnection's DB transition alone cannot leave a coalesced paused job
    // permanently blocking fresh sync work; no provider call is needed here.
    await assert.rejects(runtime.resumeAccount({userId:owner,accountId:account},pool),/Reconnect and verify/);
    await pool.execute('UPDATE mail_accounts SET is_active=TRUE, disconnected_at=NULL WHERE id=? AND user_id=?',[account,owner]);
    await runtime.resumeAccount({userId:owner,accountId:account},pool);
    assert.equal((await one(pool,'SELECT state FROM mail_writebacks WHERE id=?',[restored.id])).state,'needs_attention','Reconnection must not replay archived provider effects');
    const resumedSync = await runtime.enqueueJob({userId:owner,accountId:account,kind:'sync'},pool);
    assert.equal(resumedSync.state,'queued','Reconnection must make paused same-kind work runnable');
    const claimedSync = await runtime.claimDueJob({workerId:'reconnected-worker',kinds:['sync']},pool);
    assert.equal(claimedSync?.id,resumedSync.id,'Paused job may not suppress work after reconnect');
    await runtime.completeJob({jobId:claimedSync.id,accountId:account,workerId:'reconnected-worker',
      generation:Number(claimedSync.worker_generation)},pool);
  });
  await t.test('foreground flags resume only module-paused writes; later Sync resumes reads without fencing a writer or bypassing restore', async () => {
    const reasons=['Mail module disabled','Mail background paused'];
    const readJob=await runtime.enqueueJob({userId:owner,accountId:account,kind:'sync'},pool);
    const intents=await rows(pool,'SELECT id,state,dispatched FROM mail_writebacks ORDER BY id');
    await runtime.pauseAccount({userId:owner,accountId:account,reason:'Mail background paused'},pool);
    await runtime.resumeAccount({userId:owner,accountId:account,resumeStreams:false,reasons},pool);
    assert.equal((await one(pool,'SELECT state FROM mail_engine_jobs WHERE id=?',[readJob.id])).state,'paused');
    const before=await one(pool,'SELECT generation,lease_owner FROM mail_engine_accounts WHERE mail_account_id=?',[account]);
    await runtime.resumeAccount({userId:owner,accountId:account,resumeStreams:true,reasons},pool);
    assert.equal((await one(pool,'SELECT state FROM mail_engine_jobs WHERE id=?',[readJob.id])).state,'queued');
    assert.deepEqual(await one(pool,'SELECT generation,lease_owner FROM mail_engine_accounts WHERE mail_account_id=?',[account]),before,
      'Resuming only read streams must not invalidate an admitted writer');
    await runtime.pauseAccount({userId:owner,accountId:account,reason:'Restore needs revalidation'},pool);
    assert.deepEqual(await runtime.resumeAccount({userId:owner,accountId:account,resumeStreams:true,reasons},pool),{resumed:0,retired:0});
    assert.equal((await one(pool,'SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id=?',[account])).paused_reason,'Restore needs revalidation');
    assert.equal((await one(pool,'SELECT state FROM mail_engine_jobs WHERE id=?',[readJob.id])).state,'paused');
    assert.deepEqual(await rows(pool,'SELECT id,state,dispatched FROM mail_writebacks ORDER BY id'),intents);
    await assert.rejects(runtime.resumeAccount({userId:other,accountId:account,reasons},pool),/Mail account not found/);
  });
});
