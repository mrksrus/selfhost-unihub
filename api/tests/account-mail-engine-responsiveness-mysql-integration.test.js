// Disposable MySQL 8 schema ending _test; real installed ImapFlow over loopback TCP.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { connectImap } = require('../src/services/mail-imap-client');
const { guardImapConnection, closeImapConnection } = require('../src/services/mail-imap-guard');
const transport = require('../src/services/mail-engine/transport');
const { createDurableMailScheduler } = require('../src/services/mail-sync-scheduler');
const { scanMailboxSlice } = require('../src/services/mail-engine/sync');
const { fetchRawBounded } = require('../src/services/mail-engine/content');

const now = () => performance.now();
const waitFor = async (predicate, label, ms = 12000) => {
  const deadline = now() + ms;
  while (now() < deadline) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); }
  throw new Error(`Timed out: ${label}`);
};
const queryOne = async (db, sql, args = []) => (await db.execute(sql, args))[0][0];

async function startPeer() {
  const sockets = new Set(), commands = [], errors = [], held = new Map();
  const mail = {
    A: new Map([[499, { flags: [], modseq: 19 }], [500, { flags: [], modseq: 19 }], [501, { flags: [], modseq: 19 }]]),
    B: new Map([[499, { flags: [], modseq: 19 }]]),
    C: new Map(Array.from({ length: 260 }, (_, i) => [i + 1, { flags: [], modseq: 19 }])),
  };
  const moved = new Map();
  let releaseB = false, arrivalCount = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); held.delete(socket); });
    socket.on('error', () => {});
    socket.write('* OK synthetic responsiveness peer\r\n');
    let input = '', chain = Promise.resolve(), identity = null, folder = null;
    const send = value => { if (!socket.destroyed) socket.write(value); };
    const sendBody = (tag, uid, item) => {
      const raw = Buffer.from('From: fixture@example.test\r\nTo: fixture@example.test\r\nSubject: synthetic\r\n\r\nbody\r\n');
      send(`* 1 FETCH (UID ${uid} FLAGS (${item.flags.join(' ')}) MODSEQ (${item.modseq}) INTERNALDATE "29-Sep-2026 12:00:00 +0000" BODY[] {${raw.length}}\r\n`);
      if (!socket.destroyed) socket.write(raw);
      send(')\r\n');
      send(`${tag} OK done\r\n`);
    };
    socket.on('data', chunk => {
      input += chunk.toString('latin1');
      let index;
      while ((index = input.indexOf('\r\n')) !== -1) {
        const line = input.slice(0, index); input = input.slice(index + 2);
        const match = /^([0-9A-F]+) (.*)$/.exec(line);
        if (!match) { errors.push(`unrecognized request shape: ${line.slice(0, 48)}`); socket.destroy(); break; }
        const [, tag, cmd] = match;
        chain = chain.then(async () => {
          commands.push({ identity, cmd, at: now() });
          const ok = suffix => send(`${tag} OK ${suffix || 'done'}\r\n`);
          if (cmd === 'CAPABILITY') { send('* CAPABILITY IMAP4rev1 UIDPLUS MOVE CONDSTORE ENABLE\r\n'); ok(); return; }
          if (cmd === 'ENABLE CONDSTORE') { send('* ENABLED CONDSTORE\r\n'); ok(); return; }
          if (cmd.startsWith('LSUB ')) { ok(); return; }
          if (cmd.startsWith('LOGIN ')) { identity = /LOGIN "?(A|B|C)"? /.exec(cmd)?.[1]; assert(identity); ok(); return; }
          if (cmd.startsWith('LIST ')) { send('* LIST (\\Noselect) "/" ""\r\n'); ok(); return; }
          const selected = /^(SELECT|EXAMINE) "?(INBOX|Filed)"?$/.exec(cmd);
          if (selected) {
            folder = selected[2];
            const entries = folder === 'Filed' ? moved : mail[identity];
            const next = identity === 'A' ? folder === 'Filed' ? 701 : 502
              : identity === 'B' ? 500 : Math.max(...entries.keys(), 0) + 1;
            send(`* FLAGS (\\Seen \\Flagged)\r\n* ${entries.size} EXISTS\r\n* OK [UIDVALIDITY ${folder === 'Filed' ? 10 : 9}] valid\r\n* OK [UIDNEXT ${next}] next\r\n`);
            ok(`[${selected[1] === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] selected`); return;
          }
          const fetch = /^UID FETCH (\d+)(?::(\d+))? \(UID (?:FLAGS INTERNALDATE|(BODY\.PEEK\[\])) MODSEQ\)$/.exec(cmd);
          if (fetch) {
            const low = Number(fetch[1]), high = Number(fetch[2] || fetch[1]);
            const entries = folder === 'Filed' ? moved : mail[identity];
            if (fetch[3] && (identity === 'A' || identity === 'B') && low === 499 &&
                (identity === 'A' || !releaseB)) {
              held.set(socket, { release: () => sendBody(tag, low, entries.get(low)) });
              // The A fetch must be interrupted by the accepted command. B
              // remains stalled until explicitly released, never blocking C.
              return;
            }
            if (identity === 'C' && !fetch[3]) await new Promise(r => setTimeout(r, 35));
            const values = [...entries].filter(([uid]) => uid >= low && uid <= high).sort((a,b) => a[0]-b[0]);
            for (const [uid, item] of values) {
              const flags = item.flags.join(' ');
              if (fetch[3]) {
                sendBody(tag, uid, item);
              } else send(`* 1 FETCH (UID ${uid} FLAGS (${flags}) MODSEQ (${item.modseq}) INTERNALDATE "29-Sep-2026 12:00:00 +0000")\r\n`);
            }
            if (!fetch[3]) ok(); return;
          }
          const store = /^UID STORE (\d+)(?: \(UNCHANGEDSINCE \d+\))? ([+-])FLAGS\.SILENT \((\\Seen|\\Flagged)\)$/.exec(cmd);
          if (store) {
            const item = mail[identity].get(Number(store[1])); assert(item);
            item.flags = store[2] === '+' ? [...new Set([...item.flags, store[3]])] : item.flags.filter(f => f !== store[3]);
            item.modseq++; ok(); return;
          }
          const move = /^UID MOVE (\d+) "Filed"$/.exec(cmd);
          if (move) {
            const uid = Number(move[1]), item = mail[identity].get(uid);
            assert.equal(identity, 'A'); assert(item);
            mail.A.delete(uid); moved.set(700, item); ok(`[COPYUID 10 ${uid} 700] moved`); return;
          }
          if (cmd === 'LOGOUT') { send('* BYE bye\r\n'); ok(); return; }
          throw new Error(`Unexpected IMAP command: ${cmd}`);
        }).catch(e => { errors.push(e.message); socket.destroy(); });
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    commands, errors, held, mail, moved, get arrivalCount() { return arrivalCount; },
    arrive() { const uid = 260 + ++arrivalCount; mail.C.set(uid, { flags: [], modseq: 19 }); return uid; },
    releaseOtherBody() { releaseB = true; for (const [socket, pending] of held) {
      if (!socket.destroyed) pending.release();
      held.delete(socket);
    } },
    async connect(identity, signal) {
      const connected = await connectImap({ imap: { host: '127.0.0.1', port: server.address().port,
        user: identity, password: 'fixture-only', tls: false, keepalive: false,
        // The deliberately held B BODY spans the arrivals/history checks;
        // transport must remain alive until the test explicitly releases it.
        // Connect/auth remain bounded independently of this fixture hold.
        connTimeout: 1000, authTimeout: 1000, socketTimeout: 60000 } });
      return guardImapConnection(connected, { timeoutMs: 60000, signal });
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r)); assert.deepEqual(errors, []); },
  };
}

test('real MySQL + IMAP TCP + durable scheduler: two held bodies, accepted writes, fair history under arrivals',
  { skip: !process.env.MYSQL_TEST_HOST, timeout: 150000 }, async t => {
    assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Disposable schema only');
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'responsive-bootstrap@example.test';
    process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-bootstrap-only';
    const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
      database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 12 });
    const state = require('../src/state'), priorDb = state.getDb();
    let ownsSchema = false, peer, scheduler, arrivals;
    t.after(async () => {
      clearInterval(arrivals); await scheduler?.stop();
      if (scheduler) await waitFor(() => scheduler.ids().length === 0, 'scheduler read workers drained before teardown');
      try { if (peer) await peer.close(); } finally {
        try {
          if (ownsSchema) {
            const cx = await pool.getConnection();
            try {
              await cx.query('SET FOREIGN_KEY_CHECKS=0');
              try { for (const table of (await cx.query('SHOW TABLES'))[0]) {
                const name = Object.values(table)[0]; assert.match(name, /^[a-z_]+$/);
                await cx.query(`DROP TABLE \`${name}\``);
              } } finally { await cx.query('SET FOREIGN_KEY_CHECKS=1'); }
            } finally { cx.release(); }
          }
        } finally { state.setDb(priorDb); await pool.end(); }
      }
    });
    assert.match((await queryOne(pool, 'SELECT VERSION() AS version')).version, /^8\./);
    assert.equal((await pool.query('SHOW TABLES'))[0].length, 0);
    ownsSchema = true; state.setDb(pool);
    await require('../src/services/database').ensureSchema();
    peer = await startPeer();
    const runtime = require('../src/services/mail-engine/runtime');
    const repo = require('../src/services/mail-engine/repository');
    const admission = require('../src/services/mail-writebacks');
    const operations = require('../src/services/mail-engine/operations');
    const identities = {};
    for (const label of ['A', 'B', 'C']) {
      const userId = crypto.randomUUID(), accountId = crypto.randomUUID();
      identities[label] = { id: accountId, user_id: userId, sync_mode: 'sync' };
      await pool.execute('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)',
        [userId, `${label.toLowerCase()}@fixture.test`, 'synthetic']);
      await pool.execute(`INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active)
        VALUES (?,?,?,'custom','sync',TRUE)`, [accountId,userId,`${label.toLowerCase()}@fixture.test`]);
    }
    const mailbox = {};
    for (const label of ['A', 'B', 'C']) {
      const account = identities[label];
      mailbox[label] = await repo.withTransaction(cx => repo.ensureMailbox({ userId: account.user_id,
        accountId: account.id, folderName: 'INBOX', epoch: 9 }, cx), pool);
    }
    const email = {};
    async function seed(label, uid, contentState, imported = false) {
      const account = identities[label], id = crypto.randomUUID();
      await pool.execute(`INSERT INTO emails (id,user_id,mail_account_id,from_address,to_addresses,folder,
        source_folder,remote_folder,remote_uid,remote_uidvalidity,imap_uid,imap_uidvalidity,content_state,import_complete)
        VALUES (?,?,?,'synthetic@example.test','[]','inbox','INBOX','INBOX',?,9,?,9,?,?)`,
      [id,account.user_id,account.id,uid,uid,contentState,imported]);
      await repo.withTransaction(cx => repo.upsertOccurrence({ userId:account.user_id, accountId:account.id,
        mailboxId:mailbox[label].id, epoch:9, uid, emailId:id, flags:[] },cx), pool);
      return id;
    }
    email.bodyA = await seed('A',499,'queued'); email.bodyB = await seed('B',499,'queued');
    email.flag = await seed('A',500,'complete',true); email.move = await seed('A',501,'complete',true);
    const accountA = identities.A;
    const folderId = crypto.randomUUID();
    await pool.execute("INSERT INTO mail_folders (id,user_id,slug,display_name,is_system,mail_account_id) VALUES (?,?,'filed','Filed',FALSE,?)",
      [folderId,accountA.user_id,accountA.id]);
    await pool.execute("INSERT INTO mail_folder_remote_boxes (folder_id,mail_account_id,remote_name) VALUES (?,?,'Filed')",
      [folderId,accountA.id]);
    const start = [], finish = [], scans = [], bodies = [], ms = {}, issues = [];
    let transientDeadlocks = 0, recentEnqueuePending = false;
    scheduler = createDurableMailScheduler(async (job, signal, report) => {
      const label = Object.keys(identities).find(key => identities[key].id === job.mail_account_id);
      const account = identities[label];
      let cx;
      try {
        cx = await peer.connect(label, signal);
        if (job.kind === 'body') {
          await transport.selectMailbox(cx,{ folder:'INBOX', readOnly:true, signal });
          const raw = await fetchRawBounded(transport, cx, { folder:'INBOX',uidvalidity:9,uid:499 },
            { signal, timeoutMs:60000 });
          bodies.push({ label, bytes:raw.length, at:now() });
          return { success:true, more:false };
        }
        if (job.kind === 'operation') {
          const result = await operations.processDueOperations(account,cx,{ workerGeneration:Number(job.worker_generation),
            workerId:job.lease_owner, jobId:job.id, operationId:job.operation_id, signal });
          return { success:!result.connectionFailed };
        }
        const result = await scanMailboxSlice({ db:pool,connection:cx,account,
          folder:{folderName:'INBOX',dbFolderName:'inbox'},stream:job.kind,signal,job,report });
        scans.push({ label, stream:job.kind, through:result.through, upper:result.upper, currentUpper:result.currentUpper,
          processed:result.processed, more:result.more, at:now() });
        return { success:true, more:result.more };
      } catch (error) {
        if (signal.aborted) return { success:false,cancelled:true };
        issues.push(`${label}:${job.kind}:${error.code || error.message}`);
        throw error;
      } finally { if (cx) closeImapConnection(cx); }
    }, { concurrency:2, pollMs:100, leaseSeconds:30,
      onState:s => { if (s.id && s.state === 'running') start.push({ id:s.id,kind:s.kind,at:now() });
        if (s.id && ['idle','cancelled','error'].includes(s.state)) finish.push({ id:s.id,kind:s.kind,state:s.state,at:now() }); } });
    const bodyJobs = {};
    for (const label of ['A','B']) bodyJobs[label] = await runtime.enqueueJob({userId:identities[label].user_id,
      accountId:identities[label].id,mailboxId:mailbox[label].id,kind:'body',priority:90},pool);
    await scheduler.start();
    await waitFor(() => peer.held.size === 2,'two actual BODY.PEEK[] commands held');
    assert.equal(start.filter(s => s.kind === 'body').length,2);
    const before = now();
    // The same atomic acceptance primitive used by the route, without its
    // asynchronous direct writer: keep this gate's only provider peer synthetic.
    const accepted = [];
    for (const [id, change] of [[email.flag,{read:1}],[email.move,{move:'filed'}]]) {
      const at = now();
      await repo.withTransaction(async cx => {
        const [[row]] = await cx.execute(`SELECT e.*,a.sync_mode,a.is_active FROM emails e
          JOIN mail_accounts a ON a.id=e.mail_account_id WHERE e.id=? AND e.user_id=? FOR UPDATE`,
        [id,accountA.user_id]);
        await admission.queueChanges(cx, accountA.user_id, [row], change);
      },pool);
      accepted.push({ action:Object.keys(change)[0], ms:now()-at });
    }
    ms.accepted = accepted;
    assert(accepted.every(x => x.ms < 2000), 'durable acceptance independent of both held provider bodies');
    assert.equal((await queryOne(pool,"SELECT COUNT(*) AS n FROM mail_writebacks WHERE mail_account_id=? AND state='queued'",[accountA.id])).n,2);
    const yielded = await scheduler.yieldReadWork(accountA.id);
    assert.equal(yielded,true);
    assert.equal(peer.held.size,1,'other-account slow BODY remains held');
    const history = await runtime.enqueueJob({userId:identities.C.user_id,accountId:identities.C.id,
      mailboxId:mailbox.C.id,kind:'history',priority:60},pool);
    await scheduler.drain();
    await waitFor(() => scans.some(s=>s.label==='C' && s.stream==='history'), 'first C history slice');
    arrivals = setInterval(() => {
      if (peer.arrivalCount >= 12 || recentEnqueuePending) return;
      peer.arrive(); recentEnqueuePending = true;
      // Recent stream is a separate independent continuation. Do not append
      // arrivals to the finite history sweep.
      void (async () => {
        try {
          for (let attempt=0; attempt<4; attempt++) {
            try {
              await runtime.enqueueJob({userId:identities.C.user_id,accountId:identities.C.id,
                mailboxId:mailbox.C.id,kind:'recent',priority:10},pool);
              await scheduler.drain(); return;
            } catch (error) {
              if (error.code !== 'ER_LOCK_DEADLOCK' || attempt===3) throw error;
              transientDeadlocks++;
              await new Promise(r=>setTimeout(r,25*(attempt+1)));
            }
          }
        } catch (error) { issues.push(`recent-enqueue:${error.code || error.message}`); }
        finally { recentEnqueuePending = false; }
      })();
    },75);
    const ownHistory = await runtime.enqueueJob({userId:accountA.user_id,accountId:accountA.id,
      mailboxId:mailbox.A.id,kind:'history',priority:60},pool);
    await scheduler.drain();
    await waitFor(async () => (await queryOne(pool,"SELECT COUNT(*) AS n FROM mail_writebacks WHERE mail_account_id=? AND state='confirmed'",[accountA.id])).n===2,
      'accepted read and MOVE provider verification',12000);
    const ops = (await pool.execute('SELECT action,state,status,attempts FROM mail_writebacks WHERE mail_account_id=? ORDER BY action',[accountA.id]))[0];
    assert.deepEqual(ops.map(o=>[o.action,o.state,o.attempts]),[['move','confirmed',1],['read','confirmed',1]]);
    ms.confirmed = now()-before;
    await waitFor(() => scans.some(s=>s.label==='C' && s.stream==='history' && s.through >= 260) && peer.arrivalCount >= 8,
      'finite history continues under arrivals and stalled B body',20000);
    clearInterval(arrivals); arrivals = null;
    try {
      await waitFor(() => scans.some(s=>s.label==='C' && s.stream==='recent' && s.through >= 260+peer.arrivalCount),
        'recent arrivals caught without restarting history',12000);
    } catch (error) {
      const [pendingJobs] = await pool.execute(`SELECT kind,state,phase,priority,processed,coverage_json FROM mail_engine_jobs
        WHERE mail_account_id=? ORDER BY created_at`, [identities.C.id]);
      console.log('RESPONSIVENESS_DIAGNOSTIC '+JSON.stringify({ arrivals:peer.arrivalCount,
        scans:scans.filter(s=>s.label==='C'), pendingJobs, issues, transientDeadlocks:transientDeadlocks }));
      throw error;
    }
    const cHistory = scans.filter(s=>s.label==='C' && s.stream==='history');
    assert(cHistory.length >= 3, 'history slices bounded to 128 UIDs');
    assert(cHistory.some(s=>s.currentUpper > s.upper), 'new arrivals did not extend pinned history boundary');
    assert(scans.some(s=>s.label==='A' && s.stream==='history'), 'same-account history resumes after writes');
    assert(start.some(s=>s.id===history.id));
    assert(start.some(s=>s.id===ownHistory.id));
    assert(peer.held.size === 1 && !bodies.some(b=>b.label==='B'), 'B body still stalled while C history and A operations progress');
    peer.releaseOtherBody();
    await waitFor(()=>bodies.some(b=>b.label==='B'),'stalled B body eventually resumes',12000);
    const flag = peer.mail.A.get(500);
    assert(flag.flags.includes('\\Seen'));
    assert(!peer.mail.A.has(501) && peer.moved.has(700));
    assert.equal(peer.commands.filter(x=>x.cmd==='UID MOVE 501 "Filed"').length,1);
    assert.equal(peer.commands.filter(x=>x.cmd.includes('UID STORE 500')).length,1);
    assert.equal(peer.commands.filter(x=>/UID (?:COPY|EXPUNGE)/.test(x.cmd)).length,0);
    assert.deepEqual(issues,[]);
    assert.equal(finish.find(s=>s.id===bodyJobs.A.id)?.state,'idle','interactive yield is continuation, not cancellation');
    const [cursors] = await pool.execute(`SELECT stream,covered_through,coverage_json FROM mail_engine_cursors
      WHERE mail_account_id=? ORDER BY stream`,[identities.C.id]);
    const latest = peer.arrivalCount+260;
    assert(Number(cursors.find(c=>c.stream==='history').covered_through)>=260);
    assert(Number(cursors.find(c=>c.stream==='recent').covered_through)>=latest);
    const observed = await queryOne(pool,`SELECT COUNT(*) AS n FROM mail_remote_occurrences
      WHERE mail_account_id=? AND uidvalidity=9 AND uid BETWEEN 261 AND ?`,[identities.C.id,latest]);
    assert.equal(observed.n,peer.arrivalCount);
    // A notification during a *running* recent scan cannot be swallowed by
    // active-job deduplication. Verify the lease and one queued successor in
    // the same real database, including a duplicate notification.
    await scheduler.stop();
    await waitFor(() => scheduler.ids().length === 0, 'workers drained for recent continuation fence');
    const next = await runtime.enqueueJob({userId:identities.C.user_id,accountId:identities.C.id,
      mailboxId:mailbox.C.id,kind:'recent',priority:10},pool);
    const active = await runtime.claimDueJob({workerId:'continuation-check',kinds:['recent'],
      accountId:identities.C.id},pool);
    assert.equal(active?.id,next.id);
    const notified = await runtime.enqueueJob({userId:identities.C.user_id,accountId:identities.C.id,
      mailboxId:mailbox.C.id,kind:'recent',priority:10},pool);
    const duplicated = await runtime.enqueueJob({userId:identities.C.user_id,accountId:identities.C.id,
      mailboxId:mailbox.C.id,kind:'recent',priority:10},pool);
    assert.notEqual(notified.id,active.id);
    assert.equal(duplicated.id,notified.id,'duplicate arrivals share one waiting successor');
    assert.equal(await runtime.claimDueJob({workerId:'different-worker',kinds:['recent'],
      accountId:identities.C.id},pool),null,'account lease excludes concurrent recent scans');
    await runtime.completeJob({jobId:active.id,accountId:identities.C.id,
      workerId:'continuation-check',generation:Number(active.worker_generation)},pool);
    const successor = await runtime.claimDueJob({workerId:'continuation-check',kinds:['recent'],
      accountId:identities.C.id},pool);
    assert.equal(successor?.id,notified.id,'waiting arrival survives completion of earlier scan');
    await runtime.completeJob({jobId:successor.id,accountId:identities.C.id,
      workerId:'continuation-check',generation:Number(successor.worker_generation)},pool);
    // Hold a real DB claim across stop(), not merely a fake cancellation event.
    // The exact same job must remain queued without starting a provider call.
    const stoppedJob = await runtime.enqueueJob({userId:identities.C.user_id,accountId:identities.C.id,
      mailboxId:mailbox.C.id,kind:'recent',priority:10},pool);
    let heldClaim, releaseClaim, unexpectedRuns = 0;
    const stoppingScheduler = createDurableMailScheduler(() => { unexpectedRuns++; }, {
      workerId:'stopped-claim',pollMs:60000,repository:{...runtime,
        async claimDueJob(input) {
          const claimed = await runtime.claimDueJob({...input,kinds:['recent'],accountId:identities.C.id},pool);
          if (claimed) {
            heldClaim = claimed;
            await new Promise(resolve => { releaseClaim = resolve; });
          }
          return claimed;
        },
      },
    });
    const starting = stoppingScheduler.start();
    await waitFor(() => !!heldClaim,'claim held across scheduler stop');
    const stopping = stoppingScheduler.stop();
    releaseClaim();
    await Promise.all([starting,stopping]);
    assert.equal(unexpectedRuns,0);
    assert.deepEqual(await queryOne(pool,'SELECT state,lease_owner,worker_generation FROM mail_engine_jobs WHERE id=?',[stoppedJob.id]),
      {state:'queued',lease_owner:null,worker_generation:null});
    await assert.rejects(runtime.assertFence({jobId:heldClaim.id,accountId:identities.C.id,
      workerId:'stopped-claim',generation:Number(heldClaim.worker_generation)},pool),{code:'MAIL_WORKER_FENCED'});
    const replacement = await runtime.claimDueJob({workerId:'replacement',kinds:['recent'],accountId:identities.C.id},pool);
    assert.equal(replacement.id,stoppedJob.id,'shutdown retains the accepted job identity');
    await runtime.completeJob({jobId:replacement.id,accountId:identities.C.id,workerId:'replacement',
      generation:Number(replacement.worker_generation)},pool);
    const mem = process.memoryUsage();
    console.log('RESPONSIVENESS_EVIDENCE '+JSON.stringify({fixture:{accounts:3,initialHistoricalUids:260,
      uidWindow:128,heldBodyJobs:2,arrivals:peer.arrivalCount},latencyMs:ms,
      historyWindows:cHistory.map(s=>({through:s.through,upper:s.upper,currentUpper:s.currentUpper})),
      recentThrough:Number(cursors.find(c=>c.stream==='recent').covered_through),
      observedArrivals:observed.n,heapUsedBytes:mem.heapUsed,rssBytes:mem.rss,
      providerCommands:peer.commands.length,confirmedOperations:ops.length,
      transientDeadlockRetries:transientDeadlocks,errors:issues.length}));
  });
