// Requires an empty disposable MySQL 8 schema ending in _test. Real ImapFlow sockets.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { fork } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { connectImap } = require('../dist/src/services/mail-imap-client');
const { guardImapConnection, closeImapConnection } = require('../dist/src/services/mail-imap-guard');
const { selectMailbox } = require('../dist/src/services/mail-engine/transport');

const rows = async (db, sql, params = []) => (await db.execute(sql, params))[0];
const one = async (db, sql, params = []) => (await rows(db, sql, params))[0];
const decode = v => typeof v === 'string' ? JSON.parse(v) : v;
const timeout = (promise, ms = 5000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Peer event timed out')), ms))]);

async function peer(db, opId, { ack = 'mapped', deferAck = false, firstDestinationMiss = false } = {}) {
  const commands = [], sockets = new Set(), errors = [];
  let sourcePresent = true, destinationPresent = false, destinationFetches = 0, moves = 0;
  let releaseAck, dispatched;
  const moved = new Promise(resolve => { dispatched = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => errors.push(error));
    socket.write('* OK disposable IMAP peer\r\n');
    let input = '', queue = Promise.resolve(), selected = null;
    const write = value => { if (!socket.destroyed) socket.write(value); };
    socket.on('data', data => {
      input += data.toString('latin1');
      let index;
      while ((index = input.indexOf('\r\n')) >= 0) {
        const line = input.slice(0, index); input = input.slice(index + 2);
        const match = /^([0-9A-F]+) (.*)$/.exec(line);
        if (!match) continue;
        const [, tag, cmd] = match;
        queue = queue.then(async () => {
          commands.push(cmd);
          const ok = text => write(`${tag} OK ${text || 'completed'}\r\n`);
          if (cmd === 'CAPABILITY') { write('* CAPABILITY IMAP4rev1 UIDPLUS MOVE CONDSTORE ENABLE\r\n'); ok(); }
          else if (cmd.startsWith('LOGIN ')) ok();
          else if (cmd === 'ENABLE CONDSTORE') { write('* ENABLED CONDSTORE\r\n'); ok(); }
          else if (cmd.startsWith('LIST ')) { write('* LIST (\\Noselect) "/" ""\r\n'); ok(); }
          else if (cmd.startsWith('LSUB ')) ok();
          else if (/^(SELECT|EXAMINE) "?(INBOX|Filed)"?$/.test(cmd)) {
            selected = /INBOX/.test(cmd) ? 'INBOX' : 'Filed';
            const present = selected === 'INBOX' ? sourcePresent : destinationPresent;
            write(`* FLAGS (\\Seen)\r\n* ${present ? 1 : 0} EXISTS\r\n* OK [UIDVALIDITY ${selected === 'INBOX' ? 9 : 10}] valid\r\n* OK [UIDNEXT ${selected === 'INBOX' ? 104 : 208}] next\r\n`);
            ok(`[${cmd.startsWith('EXAMINE') ? 'READ-ONLY' : 'READ-WRITE'}] selected`);
          } else if (/^UID FETCH \d+:\d+ \(UID FLAGS INTERNALDATE MODSEQ\)$/.test(cmd)) {
            const [, low, high] = /^UID FETCH (\d+):(\d+)/.exec(cmd).map(Number);
            const uid = selected === 'INBOX' ? 103 : 207;
            if (Number.isFinite(low) && low <= uid && high >= uid &&
                (selected === 'INBOX' ? sourcePresent : destinationPresent && !(firstDestinationMiss && ++destinationFetches === 1))) {
              write(`* 1 FETCH (UID ${uid} FLAGS (\\Seen) MODSEQ (19) INTERNALDATE "29-Sep-2026 12:00:00 +0000")\r\n`);
            }
            ok();
          } else if (cmd === 'UID MOVE 103 "Filed"') {
            const op = await one(db, 'SELECT dispatched,state,attempts FROM mail_writebacks WHERE id=?', [opId]);
            const attempt = await one(db, 'SELECT outcome,dispatched_at FROM mail_operation_attempts WHERE operation_id=?', [opId]);
            assert.equal(op.dispatched, 1, 'dispatch committed before MOVE wire bytes');
            assert.equal(op.state, 'executing'); assert.equal(op.attempts, 1);
            assert.equal(attempt.outcome, 'prepared'); assert.ok(attempt.dispatched_at);
            assert.equal(sourcePresent, true, 'never replay MOVE of an already moved UID');
            moves++; sourcePresent = false; destinationPresent = true;
            dispatched();
            if (ack === 'lost') socket.destroy();
            else if (deferAck) await new Promise(resolve => { releaseAck = resolve; });
            if (!socket.destroyed && ack === 'mapped') ok('[COPYUID 10 103 207] moved');
            else if (!socket.destroyed && ack === 'absent') ok('moved');
          } else if (cmd === 'LOGOUT') { write('* BYE goodbye\r\n'); ok(); }
          else assert.fail(`Unexpected IMAP wire command: ${cmd}`);
        }).catch(error => { errors.push(error); socket.destroy(); dispatched(); });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    commands, errors, moved, port:server.address().port, get moves() { return moves; },
    get sourcePresent() { return sourcePresent; }, get destinationPresent() { return destinationPresent; },
    release() { assert.ok(releaseAck, 'ACK must be deferred'); releaseAck(); },
    async connect() {
      const connection = guardImapConnection(await connectImap({ imap: {
        host: '127.0.0.1', port: server.address().port, user: 'fixture', password: 'fixture',
        tls: false, keepalive: false, connTimeout: 1000, authTimeout: 1000, socketTimeout: 1000,
      } }), { timeoutMs: 3000 });
      return connection;
    },
    async close() {
      if (releaseAck) releaseAck();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      assert.deepEqual(errors, []);
    },
  };
}

test('MySQL + installed IMAP wire peer: dispatched MOVE, scan-first and recovered no-replay', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 180000,
}, async t => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Refuse non-test database');
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
    database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 8 });
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'wire-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-wire-bootstrap-password';
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
              assert.match(name, /^[a-z_]+$/);
              await cx.query(`DROP TABLE \`${name}\``);
            }
          } finally { await cx.query('SET FOREIGN_KEY_CHECKS = 1'); }
        } finally { cx.release(); }
      }
    } finally { state.setDb(originalDb); await pool.end(); }
  });
  assert.match((await one(pool, 'SELECT VERSION() AS version')).version, /MariaDB/);
  assert.equal((await rows(pool, 'SHOW TABLES')).length, 0, 'Refuse populated database');
  ownsSchema = true; state.setDb(pool);
  await require('../dist/src/services/database').ensureSchema();
  const repo = require('../dist/src/services/mail-engine/repository');
  const runtime = require('../dist/src/services/mail-engine/runtime');
  const operations = require('../dist/src/services/mail-engine/operations');
  const { scanMailboxSlice } = require('../dist/src/services/mail-engine/sync');
  const { runRecoveredReconcileJob } = require('../dist/src/services/mail');

  async function setup(label, options) {
    const userId = randomUUID(), accountId = randomUUID(), emailId = randomUUID();
    await pool.execute('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, `${label}@example.test`, 'synthetic']);
    await pool.execute(`INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active)
      VALUES (?,?,?,'custom','sync',TRUE)`, [accountId,userId,`${label}@example.test`]);
    await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,
      remote_folder,remote_uid,remote_uidvalidity,raw_storage_path,raw_sha256) VALUES (?,?,?,'synthetic@example.test','[]','inbox','INBOX',103,9,?,?)`,
    [emailId,userId,accountId,`/synthetic/${label}/original.eml`, 'a'.repeat(64)]);
    const source = await repo.withTransaction(async cx => {
      const mailbox = await repo.ensureMailbox({ userId, accountId, folderName: 'INBOX', epoch: 9 }, cx);
      return repo.upsertOccurrence({ userId, accountId, mailboxId: mailbox.id, epoch: 9, uid: 103,
        emailId, flags: ['\\Seen'] }, cx);
    }, pool);
    const opId = randomUUID();
    await pool.execute(`INSERT INTO mail_writebacks (id,user_id,mail_account_id,email_id,action,target_value,
      base_value,target_folder,remote_folder,remote_uid,remote_uidvalidity,source_occurrence_id,status,state,
      is_current,intent_revision,dispatched) VALUES (?,?,?,?, 'move','Filed','INBOX','filed','INBOX',103,9,?,
      'pending','queued',TRUE,1,FALSE)`, [opId,userId,accountId,emailId,source.id]);
    const job = await runtime.enqueueJob({ userId,accountId,operationId:opId,kind:'operation',priority:0 }, pool);
    const workerId = `${label}-worker`;
    const claimed = await runtime.claimDueJob({ workerId,kinds:['operation'] }, pool);
    assert.equal(claimed.id,job.id);
    const fixture = await peer(pool,opId,options); t.after(() => fixture.close());
    const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
    await selectMailbox(connection, { folder: 'INBOX' });
    const account = { id:accountId,user_id:userId,sync_mode:'sync' };
    const op = { id:opId,user_id:userId,mail_account_id:accountId,
      email_id:emailId,action:'move',target_value:'Filed',target_folder:'filed',remote_folder:'INBOX',
      remote_uid:103,remote_uidvalidity:9,source_occurrence_id:source.id,intent_revision:1,state:'queued',dispatched:0 };
    const apply = () => operations.applyMove(op,
      connection,Number(claimed.worker_generation),new AbortController().signal,workerId,job.id);
    return { userId,accountId,emailId,opId,source,job,claimed,workerId,fixture,connection,account,op,apply };
  }
  const opRow = id => one(pool, 'SELECT id,email_id,state,status,dispatched,attempts,evidence_json FROM mail_writebacks WHERE id=?', [id]);
  const moveCommands = fixture => fixture.commands.filter(cmd => /\b(?:MOVE|COPY|STORE|EXPUNGE)\b/.test(cmd));

  await t.test('ACK held after effect: scanner first, original ID and archive retained, exact operation settles once', async () => {
    const f = await setup('scan-first', { deferAck: true });
    const running = f.apply(); await timeout(f.fixture.moved);
    assert.equal(f.fixture.sourcePresent,false); assert.equal(f.fixture.destinationPresent,true);
    const scanner = await f.fixture.connect();
    try {
      const scanned = await scanMailboxSlice({ db:pool,connection:scanner,account:f.account,
        folder:{ folderName:'Filed',dbFolderName:'filed' },stream:'recent' });
      assert.equal(scanned.inserted,1);
    } finally { closeImapConnection(scanner); }
    const provisional = await one(pool, `SELECT o.id,o.email_id FROM mail_remote_occurrences o
      JOIN mail_remote_mailboxes m ON m.id=o.mailbox_id WHERE m.mail_account_id=? AND m.remote_name='Filed' AND o.uid=207`, [f.accountId]);
    assert.ok(provisional); assert.notEqual(provisional.email_id,f.emailId);
    const provisionalArchive = `/synthetic/scan-first/provisional.eml`;
    await pool.execute(`UPDATE emails SET raw_storage_path=?,raw_sha256=? WHERE id=?`,
      [provisionalArchive,'b'.repeat(64),provisional.email_id]);
    f.fixture.release(); await timeout(running);
    const op = await opRow(f.opId); assert.equal(op.state,'confirmed'); assert.equal(op.status,'done');
    assert.equal(decode(op.evidence_json).kind,'copyuid_verified'); assert.equal(op.attempts,1);
    const found = await one(pool,'SELECT id,email_id,presence FROM mail_remote_occurrences WHERE id=?',[provisional.id]);
    assert.equal(found.email_id,f.emailId); assert.equal(found.presence,'present');
    assert.equal((await one(pool,'SELECT presence FROM mail_remote_occurrences WHERE id=?',[f.source.id])).presence,'absent');
    assert.deepEqual(await one(pool,'SELECT remote_folder,remote_uid,remote_uidvalidity,raw_storage_path FROM emails WHERE id=?',[f.emailId]),
      {remote_folder:'Filed',remote_uid:207,remote_uidvalidity:10,raw_storage_path:'/synthetic/scan-first/original.eml'});
    assert.deepEqual(await one(pool,'SELECT remote_missing,remote_folder,raw_storage_path,raw_sha256 FROM emails WHERE id=?',[provisional.email_id]),
      {remote_missing:1,remote_folder:null,raw_storage_path:provisionalArchive,raw_sha256:'b'.repeat(64)});
    assert.equal((await one(pool,'SELECT outcome FROM mail_operation_attempts WHERE operation_id=?',[f.opId])).outcome,'confirmed');
    assert.deepEqual(moveCommands(f.fixture),['UID MOVE 103 "Filed"']);
  });

  await t.test('lost ACK after actual effect: recovered check reads only and cannot falsely confirm without mapping', async () => {
    const f = await setup('lost-ack', { ack:'lost' });
    await timeout(f.apply());
    assert.equal(f.fixture.destinationPresent,true);
    assert.equal((await opRow(f.opId)).state,'reconciling');
    await pool.execute('UPDATE mail_engine_accounts SET lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 SECOND) WHERE mail_account_id=?',[f.accountId]);
    await pool.execute('UPDATE mail_engine_jobs SET lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 SECOND) WHERE id=?',[f.job.id]);
    await assert.rejects(runtime.completeJob({ jobId:f.job.id,accountId:f.accountId,workerId:f.workerId,
      generation:Number(f.claimed.worker_generation) },pool),{code:'MAIL_WORKER_FENCED'});
    const recovered = await runtime.recoverExpiredJobs(pool);
    assert.ok(recovered.jobs >= 1);
    const job = await runtime.claimDueJob({ workerId:'lost-recovered',kinds:['reconcile'] },pool);
    assert.equal(job.id,f.job.id);
    const fresh = await f.fixture.connect();
    try {
      const result = await runRecoveredReconcileJob({ job,account:f.account,connection:fresh,
        signal:new AbortController().signal,report(){} });
      assert.equal(result.success,true);
    } finally { closeImapConnection(fresh); }
    const op = await opRow(f.opId);
    if (op.state !== 'needs_attention') throw new Error('Lost ACK diagnosis: ' + JSON.stringify({ commands:f.fixture.commands, op }));
    assert.notEqual(op.status,'done');
    assert.equal(decode(op.evidence_json).kind,'bounded_move_check');
    assert.equal(decode(op.evidence_json).sourcePresent,false);
    assert.equal(decode(op.evidence_json).destinationCount,1);
    assert.equal((await one(pool,'SELECT remote_folder FROM emails WHERE id=?',[f.emailId])).remote_folder,'INBOX');
    assert.deepEqual(await one(pool,'SELECT outcome,completed_at FROM mail_operation_attempts WHERE operation_id=?',[f.opId]),
      {outcome:'needs_attention',completed_at:null}, 'A stopped outcome check is attention-required, not still running or falsely resolved');
    assert.deepEqual(moveCommands(f.fixture),['UID MOVE 103 "Filed"']);
    await runtime.completeJob({ jobId:job.id,accountId:f.accountId,workerId:'lost-recovered',
      generation:Number(job.worker_generation) },pool);
  });

  await t.test('SIGKILL after server effect, before ACK: fresh worker reconciles without replay', async () => {
    const f = await setup('kill-before-ack', { deferAck:true });
    const child = fork(path.join(__dirname,'helpers/mail-engine-wire-dispatch-child.cjs'),[],
      { execArgv:[],stdio:['ignore','pipe','pipe','ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const childMessages = [];
    child.on('message', message => childMessages.push(message));
    child.send({ op:f.op,job:f.claimed,port:f.fixture.port });
    await timeout(f.fixture.moved);
    assert.equal((await opRow(f.opId)).state,'executing');
    assert.equal((await one(pool,'SELECT outcome FROM mail_operation_attempts WHERE operation_id=?',[f.opId])).outcome,'prepared');
    child.kill('SIGKILL');
    const ended = await timeout(new Promise(resolve => child.once('exit',(code,signal) => resolve({code,signal}))));
    assert.equal(ended.signal,'SIGKILL'); assert.deepEqual(childMessages,[]);
    f.fixture.release();
    assert.equal(f.fixture.destinationPresent,true);
    await pool.execute('UPDATE mail_engine_accounts SET lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 SECOND) WHERE mail_account_id=?',[f.accountId]);
    await pool.execute('UPDATE mail_engine_jobs SET lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 SECOND) WHERE id=?',[f.job.id]);
    const recovered = await runtime.recoverExpiredJobs(pool);
    assert.ok(recovered.jobs >= 1 && recovered.operations >= 1);
    const job = await runtime.claimDueJob({ workerId:'post-kill',kinds:['reconcile'] },pool);
    assert.equal(job.id,f.job.id);
    const fresh = await f.fixture.connect();
    try {
      assert.equal((await runRecoveredReconcileJob({ job,account:f.account,connection:fresh,
        signal:new AbortController().signal,report(){} })).success,true);
    } finally { closeImapConnection(fresh); }
    const op = await opRow(f.opId);
    assert.equal(op.state,'needs_attention'); assert.equal(op.dispatched,1); assert.equal(op.attempts,1);
    assert.equal(decode(op.evidence_json).kind,'bounded_move_check');
    assert.deepEqual(moveCommands(f.fixture),['UID MOVE 103 "Filed"']);
    await runtime.completeJob({ jobId:job.id,accountId:f.accountId,workerId:'post-kill',
      generation:Number(job.worker_generation) },pool);
  });

  await t.test('native MOVE OK without COPYUID: bounded outcome remains attention-required, never replayed', async () => {
    const f = await setup('absent-copyuid', { ack:'absent' });
    await timeout(f.apply());
    const pending = await opRow(f.opId);
    assert.equal(pending.state,'reconciling');
    assert.equal(decode(pending.evidence_json).mappingStatus,'missing');
    await runtime.completeJob({ jobId:f.job.id,accountId:f.accountId,workerId:f.workerId,
      generation:Number(f.claimed.worker_generation) },pool);
    const queued = await runtime.enqueueJob({ userId:f.userId,accountId:f.accountId,operationId:f.opId,
      kind:'reconcile',priority:0 },pool);
    const job = await runtime.claimDueJob({ workerId:'absent-recovered',kinds:['reconcile'] },pool);
    assert.equal(job.id,queued.id);
    const fresh = await f.fixture.connect();
    try {
      assert.equal((await runRecoveredReconcileJob({ job,account:f.account,connection:fresh,
        signal:new AbortController().signal,report(){} })).success,true);
    } finally { closeImapConnection(fresh); }
    const checked = await opRow(f.opId);
    assert.equal(checked.state,'needs_attention'); assert.equal(checked.attempts,1);
    assert.equal(decode(checked.evidence_json).kind,'bounded_move_check');
    assert.equal(decode(checked.evidence_json).destinationCount,1);
    assert.equal((await one(pool,'SELECT remote_folder FROM emails WHERE id=?',[f.emailId])).remote_folder,'INBOX');
    assert.deepEqual(moveCommands(f.fixture),['UID MOVE 103 "Filed"']);
    await runtime.completeJob({ jobId:job.id,accountId:f.accountId,workerId:'absent-recovered',
      generation:Number(job.worker_generation) },pool);
  });

  await t.test('later ordinary scan consumes persisted COPYUID and settles original operation', async () => {
    const f = await setup('scan-later', { firstDestinationMiss:true });
    await timeout(f.apply());
    assert.equal((await opRow(f.opId)).state,'reconciling');
    const scanner = await f.fixture.connect();
    try {
      const scanned = await scanMailboxSlice({ db:pool,connection:scanner,account:f.account,
        folder:{ folderName:'Filed',dbFolderName:'filed' },stream:'recent' });
      assert.equal(scanned.inserted,1);
    } finally { closeImapConnection(scanner); }
    const op = await opRow(f.opId);
    assert.equal(op.state,'confirmed'); assert.equal(op.id,f.opId); assert.equal(op.attempts,1);
    assert.equal((await one(pool,'SELECT outcome FROM mail_operation_attempts WHERE operation_id=?',[f.opId])).outcome,'confirmed');
    const destination = await one(pool,`SELECT o.email_id FROM mail_remote_occurrences o JOIN mail_remote_mailboxes m
      ON m.id=o.mailbox_id WHERE m.mail_account_id=? AND m.remote_name='Filed' AND o.uid=207`,[f.accountId]);
    assert.equal(destination.email_id,f.emailId);
    assert.deepEqual(moveCommands(f.fixture),['UID MOVE 103 "Filed"']);
    await runtime.completeJob({ jobId:f.job.id,accountId:f.accountId,workerId:f.workerId,
      generation:Number(f.claimed.worker_generation) },pool);
  });

  await t.test('ACK mapping persisted before lease expiry: recovered reconciliation confirms same operation without replay', async () => {
    const f = await setup('mapped-recovery', { firstDestinationMiss:true });
    await timeout(f.apply());
    const pending = await opRow(f.opId);
    assert.equal(pending.state,'reconciling');
    assert.deepEqual(decode(pending.evidence_json).mapping,{uidvalidity:10,sourceUids:[103],destinationUids:[207]});
    await pool.execute('UPDATE mail_engine_accounts SET lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 SECOND) WHERE mail_account_id=?',[f.accountId]);
    await pool.execute('UPDATE mail_engine_jobs SET lease_until=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 10 SECOND) WHERE id=?',[f.job.id]);
    const recovered = await runtime.recoverExpiredJobs(pool); assert.ok(recovered.jobs >= 1);
    assert.equal((await one(pool,'SELECT kind,state FROM mail_engine_jobs WHERE id=?',[f.job.id])).kind,'reconcile');
    const job = await runtime.claimDueJob({ workerId:'mapped-recovered',kinds:['reconcile'] },pool);
    assert.equal(job.id,f.job.id);
    const fresh = await f.fixture.connect();
    try {
      const result = await runRecoveredReconcileJob({ job,account:f.account,connection:fresh,
        signal:new AbortController().signal,report(){} });
      assert.equal(result.success,true);
    } finally { closeImapConnection(fresh); }
    const settled = await opRow(f.opId);
    assert.equal(settled.state,'confirmed'); assert.equal(settled.id,f.opId); assert.equal(settled.attempts,1);
    assert.equal(decode(settled.evidence_json).kind,'copyuid_verified');
    assert.equal((await one(pool,'SELECT remote_folder FROM emails WHERE id=?',[f.emailId])).remote_folder,'Filed');
    assert.equal((await one(pool,'SELECT outcome FROM mail_operation_attempts WHERE operation_id=?',[f.opId])).outcome,'confirmed');
    assert.deepEqual(moveCommands(f.fixture),['UID MOVE 103 "Filed"']);
    await runtime.completeJob({ jobId:job.id,accountId:f.accountId,workerId:'mapped-recovered',
      generation:Number(job.worker_generation) },pool);
  });
});
