'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');

test('MySQL staged rollout retains intent and credentials, fences other accounts and avoids held-job starvation', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 180000,
}, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
    database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 3 });
  const state = require('../src/state'), previous = state.getDb();
  let ownsSchema = false;
  const rows = async (sql, params = []) => (await pool.execute(sql, params))[0];
  t.after(async () => {
    try {
      if (ownsSchema) {
        const cx = await pool.getConnection();
        try {
          await cx.query('SET FOREIGN_KEY_CHECKS = 0');
          for (const row of await rows('SHOW TABLES')) {
            const name = Object.values(row)[0]; assert.match(name, /^[a-z_]+$/);
            await cx.query(`DROP TABLE \`${name}\``);
          }
        } finally { await cx.query('SET FOREIGN_KEY_CHECKS = 1'); cx.release(); }
      }
    } finally { state.setDb(previous); await pool.end(); }
  });
  assert.equal((await rows('SHOW TABLES')).length, 0, 'Refuse a populated schema');
  ownsSchema = true; state.setDb(pool);
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'rollout-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-rollout-bootstrap-password';
  await require('../src/services/database').ensureSchema();
  const runtime = require('../src/services/mail-engine/runtime');
  const { HOLD_REASON, prepareRollout, releaseRollout, rolloutStatus } = require('../src/services/mail-engine/rollout');
  const owner = randomUUID(), accounts = Array.from({ length: 40 }, () => randomUUID());
  await pool.execute("INSERT INTO users (id,email,password_hash) VALUES (?,'rollout-owner@example.test','test')", [owner]);
  for (const [i, id] of accounts.entries()) {
    await pool.execute(`INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active,encrypted_password)
      VALUES (?,?,?,'custom','sync',TRUE,'synthetic-credential-not-for-use')`, [id,owner,`rollout-${i}@example.test`]);
    await runtime.enqueueJob({ userId:owner,accountId:id,kind:'sync',priority:i === 0 ? 1000 : -1000 },pool);
  }
  const email = randomUUID(), operation = randomUUID();
  await pool.execute("INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder) VALUES (?,?,?,'fixture@example.test','[]','inbox')", [email,owner,accounts[1]]);
  await pool.execute(`INSERT INTO mail_writebacks
    (id,user_id,mail_account_id,email_id,action,target_value,base_value,remote_folder,remote_uid,remote_uidvalidity,status,state,is_current)
    VALUES (?,?,?,?,'read','1','0','INBOX',1,1,'pending','queued',TRUE)`, [operation,owner,accounts[1],email]);
  await runtime.enqueueJob({userId:owner,accountId:accounts[1],operationId:operation,kind:'operation',priority:0},pool);
  const live = await runtime.claimDueJob({workerId:'old-worker',accountId:accounts[2]},pool);
  await assert.rejects(prepareRollout(pool,accounts[0]),/leases remain active/);
  assert((await rolloutStatus(pool)).accounts.every(a => a.paused_reason === null), 'failed prepare is atomic');
  await runtime.completeJob({jobId:live.id,accountId:live.mail_account_id,workerId:'old-worker',generation:Number(live.worker_generation)},pool);
  await runtime.enqueueJob({userId:owner,accountId:accounts[2],kind:'sync',priority:-1000},pool);
  await runtime.pauseAccount({userId:owner,accountId:accounts.at(-1),reason:'Restore requires revalidation'},pool);
  const accountSql = 'SELECT id,user_id,sync_mode,is_active,encrypted_password FROM mail_accounts ORDER BY id';
  const jobsSql = 'SELECT * FROM mail_engine_jobs ORDER BY id';
  const operationsSql = 'SELECT * FROM mail_writebacks ORDER BY id';
  const originalAccounts = await rows(accountSql), originalJobs = await rows(jobsSql), originalOperations = await rows(operationsSql);
  await assert.rejects(prepareRollout(pool,accounts.at(-1)),/non-rollout pause/);
  await prepareRollout(pool,accounts[0]);
  await prepareRollout(pool,accounts[0]); // retry before cutover must be harmless
  assert.deepEqual(await rows(accountSql),originalAccounts);
  assert.deepEqual(await rows(jobsSql),originalJobs,'prepare must not cancel/reset/replay accepted jobs');
  assert.deepEqual(await rows(operationsSql),originalOperations,'accepted provider intentions remain byte-for-byte unchanged');
  const held = (await rolloutStatus(pool)).accounts;
  assert.equal(held.find(a => a.account_id === accounts[0]).paused_reason,null);
  assert.equal(held.find(a => a.account_id === accounts.at(-1)).paused_reason,'Restore requires revalidation');
  assert.equal(held.filter(a => a.paused_reason === HOLD_REASON).length,38);
  await runtime.enqueueJob({userId:owner,accountId:accounts[1],operationId:operation,kind:'operation',priority:0,foreground:true},pool);
  assert.equal(await runtime.claimDueJob({workerId:'blocked',accountId:accounts[1]},pool),null,'foreground acceptance cannot bypass a deployment hold');
  const canary = await runtime.claimDueJob({workerId:'canary'},pool);
  assert.equal(canary.mail_account_id,accounts[0], 'more than 32 higher-priority held jobs cannot starve the canary');
  assert.equal(await runtime.claimDueJob({workerId:'another'},pool),null);
  await runtime.completeJob({jobId:canary.id,accountId:canary.mail_account_id,workerId:'canary',generation:Number(canary.worker_generation)},pool);
  const beforeRelease = await rows(jobsSql);
  await assert.rejects(releaseRollout(pool,accounts.at(-1)),/refusing to clear another pause/);
  await releaseRollout(pool,accounts[1]);
  assert.deepEqual(await rows(jobsSql),beforeRelease,'release preserves queued work and original job IDs');
  assert.deepEqual(await rows(operationsSql),originalOperations);
  assert.deepEqual(await rows(accountSql),originalAccounts);
  const next = await runtime.claimDueJob({workerId:'next-account'},pool);
  assert.equal(next.mail_account_id,accounts[1]);
  await runtime.completeJob({jobId:next.id,accountId:next.mail_account_id,workerId:'next-account',generation:Number(next.worker_generation)},pool);
  const heldAccount = accounts[4], reasonOf = async () => (await rows('SELECT paused_reason FROM mail_engine_accounts WHERE mail_account_id=?',[heldAccount]))[0].paused_reason;
  const heldJobState = async () => (await rows("SELECT state FROM mail_engine_jobs WHERE mail_account_id=? AND kind='sync'",[heldAccount]))[0].state;
  await runtime.pauseAccount({userId:owner,accountId:heldAccount,reason:'Account settings changing'},pool);
  assert.equal(await reasonOf(),HOLD_REASON,'a settings stop cannot overwrite the operator hold');
  await runtime.resumeAccount({userId:owner,accountId:heldAccount},pool);
  assert.equal(await reasonOf(),HOLD_REASON,'an authenticated reconnect cannot clear the operator hold');
  await runtime.pauseAccount({userId:owner,accountId:heldAccount,reason:'Mail module disabled'},pool);
  await runtime.resumeAccount({userId:owner,accountId:heldAccount,reasons:['Mail module disabled','Mail background paused']},pool);
  assert.equal(await reasonOf(),HOLD_REASON,'a module toggle cannot clear the operator hold');
  assert.equal(await heldJobState(),'paused');
  assert.equal(await runtime.claimDueJob({workerId:'held',accountId:heldAccount},pool),null);
  await releaseRollout(pool,heldAccount);
  assert.equal(await reasonOf(),null);
  assert.equal(await heldJobState(),'queued','release re-queues read streams paused while held');
  const released = await runtime.claimDueJob({workerId:'released',accountId:heldAccount},pool);
  assert.equal(released?.mail_account_id,heldAccount);
  await runtime.completeJob({jobId:released.id,accountId:heldAccount,workerId:'released',generation:Number(released.worker_generation)},pool);
  await assert.rejects(releaseRollout(pool,randomUUID()),/active and connected/);
  await pool.execute("UPDATE mail_accounts SET sync_mode='download' WHERE id=?",[accounts[3]]);
  await assert.rejects(prepareRollout(pool,accounts[0]),/Sync accounts only/);
});
