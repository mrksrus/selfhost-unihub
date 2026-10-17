'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
// Requires an empty disposable MariaDB schema ending in _test. Real ImapFlow
// sockets against a synthetic peer; the real engine scan and body import; the
// real notification job with only the Web Push send replaced.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const net = (require('node:net') as typeof import('node:net'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

const one = async (db: FixtureValue, sql: string, params: FixtureValue[] = []) => (await db.execute(sql, params))[0][0];
const rows = async (db: FixtureValue, sql: string, params: FixtureValue[] = []) => (await db.execute(sql, params))[0];
const decode = (value: FixtureValue) => typeof value === 'string' ? JSON.parse(value) : value;

// One INBOX per login whose messages the test adds; every message has the same synthetic body.
async function startPeer() {
  const sockets = new Set<import('node:net').Socket>(), errors: FixtureValue[] = [];
  const boxes = new Map<string, { mail: Map<number, { flags: string[]; modseq: number; subject: string }>; nextUid: number }>();
  const box = (login: string) => { if (!boxes.has(login)) boxes.set(login, { mail: new Map(), nextUid: 1 }); return boxes.get(login)!; };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK synthetic notification peer\r\n');
    let input = '', chain = Promise.resolve(), login = '';
    const send = (value: string) => { if (!socket.destroyed) socket.write(value); };
    socket.on('data', chunk => {
      input += chunk.toString('latin1');
      let index;
      while ((index = input.indexOf('\r\n')) !== -1) {
        const line = input.slice(0, index); input = input.slice(index + 2);
        const match = /^([0-9A-F]+) (.*)$/.exec(line);
        if (!match) { errors.push(`unrecognized request shape: ${line.slice(0, 48)}`); socket.destroy(); break; }
        const [, tag, cmd] = match;
        chain = chain.then(async () => {
          const ok = (suffix?: string) => send(`${tag} OK ${suffix || 'done'}\r\n`);
          if (cmd === 'CAPABILITY') { send('* CAPABILITY IMAP4rev1 UIDPLUS MOVE CONDSTORE ENABLE\r\n'); ok(); return; }
          if (cmd === 'ENABLE CONDSTORE') { send('* ENABLED CONDSTORE\r\n'); ok(); return; }
          if (cmd.startsWith('LOGIN ')) { login = /LOGIN "?([a-z]+)"? /.exec(cmd)?.[1] || ''; assert(login); ok(); return; }
          if (cmd.startsWith('LSUB ')) { ok(); return; }
          const { mail, nextUid } = box(login);
          if (cmd.startsWith('LIST ')) { send('* LIST (\\Noselect) "/" ""\r\n'); ok(); return; }
          const selected = /^(SELECT|EXAMINE) "?INBOX"?$/.exec(cmd);
          if (selected) {
            send(`* FLAGS (\\Seen \\Flagged)\r\n* ${mail.size} EXISTS\r\n* OK [UIDVALIDITY 9] valid\r\n* OK [UIDNEXT ${nextUid}] next\r\n`);
            ok(`[${selected[1] === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] selected`); return;
          }
          const fetch = /^UID FETCH (\d+)(?::(\d+))? \(UID (?:FLAGS INTERNALDATE|(BODY\.PEEK\[\])) MODSEQ\)$/.exec(cmd);
          if (fetch) {
            const low = Number(fetch[1]), high = Number(fetch[2] || fetch[1]);
            for (const [uid, item] of [...mail].filter(([uid]) => uid >= low && uid <= high).sort((a, b) => a[0] - b[0])) {
              if (fetch[3]) {
                const raw = Buffer.from(`From: Fixture Sender <fixture@example.test>\r\nTo: owner@example.test\r\nSubject: ${item.subject}\r\nMessage-ID: <${uid}@example.test>\r\n\r\nbody\r\n`);
                send(`* 1 FETCH (UID ${uid} FLAGS (${item.flags.join(' ')}) MODSEQ (${item.modseq}) INTERNALDATE "29-Sep-2026 12:00:00 +0000" BODY[] {${raw.length}}\r\n`);
                if (!socket.destroyed) socket.write(raw);
                send(')\r\n');
              } else send(`* 1 FETCH (UID ${uid} FLAGS (${item.flags.join(' ')}) MODSEQ (${item.modseq}) INTERNALDATE "29-Sep-2026 12:00:00 +0000")\r\n`);
            }
            ok(); return;
          }
          if (cmd === 'LOGOUT') { send('* BYE bye\r\n'); ok(); return; }
          throw new Error(`Unexpected IMAP command: ${cmd}`);
        }).catch(e => { errors.push(e.message); socket.destroy(); });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    errors,
    arrive(login: string, subject: string, flags: string[] = []) { const b = box(login); const uid = b.nextUid++; b.mail.set(uid, { flags, modseq: 19, subject }); return uid; },
    port: (server.address() as import('node:net').AddressInfo).port,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r)); assert.deepEqual(errors, []); },
  };
}

test('real MariaDB + IMAP wire peer: new mail is announced after its content arrives, baselines and read mail are not',
  { skip: !process.env.MYSQL_TEST_HOST, timeout: 60000 }, async t => {
    assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Disposable schema only');
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'notify-bootstrap@example.test';
    process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-bootstrap-only';
    process.env.ENCRYPTION_KEY ||= 'mail-notification-test-key';
    const uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-notify-'));
    process.env.MAIL_RAW_STORAGE_ROOT = path.join(uploads, 'mail-raw');
    process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = path.join(uploads, 'attachments');
    const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
      database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 8 });
    const state = require('../dist/src/state') as typeof import('../src/state'), priorDb = state.getDb();
    const webPush = require('web-push');
    const originalSend = webPush.sendNotification;
    const sent: FixtureValue[] = [];
    webPush.sendNotification = async (_subscription: FixtureValue, payload: FixtureValue) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; };
    let ownsSchema = false, peer: Awaited<ReturnType<typeof startPeer>> | undefined, imap: FixtureValue;
    t.after(async () => {
      webPush.sendNotification = originalSend;
      try { if (imap) closeImapConnection(imap); } catch { /* closed */ }
      try { if (peer) await peer.close(); } finally {
        try {
          if (ownsSchema) {
            const cx = await pool.getConnection();
            try {
              await cx.query('SET FOREIGN_KEY_CHECKS=0');
              try { for (const table of (await cx.query<RowDataPacket[]>('SHOW TABLES'))[0]) {
                const name = Object.values(table)[0]; assert.match((name as string), /^[a-z_]+$/);
                await cx.query(`DROP TABLE \`${name}\``);
              } } finally { await cx.query('SET FOREIGN_KEY_CHECKS=1'); }
            } finally { cx.release(); }
          }
        } finally { state.setDb(priorDb); await pool.end(); await fs.rm(uploads, { recursive: true, force: true }); }
      }
    });
    assert.match((await one(pool, 'SELECT VERSION() AS version')).version, /MariaDB/);
    assert.equal((await pool.query<RowDataPacket[]>('SHOW TABLES'))[0].length, 0);
    ownsSchema = true; state.setDb(pool);
    await (require('../dist/src/services/database') as typeof import('../src/services/database')).ensureSchema();
    const { connectImap } = require('../dist/src/services/mail-imap-client') as typeof import('../src/services/mail-imap-client');
    const { guardImapConnection, closeImapConnection } = require('../dist/src/services/mail-imap-guard') as typeof import('../src/services/mail-imap-guard');
    const { scanMailboxSlice } = require('../dist/src/services/mail-engine/sync') as typeof import('../src/services/mail-engine/sync');
    const { processBodySlice } = require('../dist/src/services/mail-engine/content') as typeof import('../src/services/mail-engine/content');
    const notifications = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
    peer = await startPeer();

    // An owner with a signed-in browser that turned notifications on.
    const userId = crypto.randomUUID(), accountId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'owner@example.test', 'synthetic']);
    await pool.execute<ResultSetHeader>('INSERT INTO sessions (id,user_id,token,expires_at) VALUES (?,?,?,?)', [sessionId, userId, 'owner-session', new Date(Date.now() + 10 * 86400000)]);
    const keyBytes = Buffer.alloc(65, 1); keyBytes[0] = 4;
    await notifications.subscribe(userId, 'owner-session', { endpoint: 'https://fcm.googleapis.com/fcm/send/owner-browser',
      keys: { p256dh: keyBytes.toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } });
    const freshId = crypto.randomUUID();
    for (const [id, address] of [[accountId, 'owner@example.test'], [freshId, 'fresh@example.test']]) {
      await pool.execute<ResultSetHeader>(`INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active)
        VALUES (?,?,?,'custom','sync',TRUE)`, [id, userId, address]);
    }
    const account = { id: accountId, user_id: userId, sync_mode: 'sync' };
    const folder = { folderName: 'INBOX', dbFolderName: 'inbox' };
    const connect = async (login: string) => guardImapConnection(await connectImap({ imap: { host: '127.0.0.1', port: peer!.port, user: login, password: 'fixture-only',
      tls: false, keepalive: false, connTimeout: 1000, authTimeout: 1000, socketTimeout: 30000 } }), { timeoutMs: 30000 });
    imap = await connect('owner');
    const scan = (stream = 'recent') => scanMailboxSlice({ db: pool, connection: imap, account, folder, stream });
    const events = (ofAccount = accountId) => rows(pool, `SELECT e.source_id, e.payload, (SELECT COUNT(*) FROM notification_deliveries d WHERE d.event_id = e.id) AS deliveries
      FROM notification_events e JOIN emails m ON m.id = e.source_id AND m.user_id = e.user_id
      WHERE e.user_id = ? AND e.kind = 'mail' AND m.mail_account_id = ? ORDER BY e.created_at`, [userId, ofAccount]);
    const emailFor = (uid: number, ofAccount = accountId) => one(pool, 'SELECT e.id, e.subject, e.is_read, e.import_complete FROM emails e WHERE e.mail_account_id = ? AND e.remote_uid = ?', [ofAccount, uid]);

    // The mailbox already holds mail when the account is added: a baseline.
    for (const subject of ['history one', 'history two', 'history three']) peer.arrive('owner', subject);
    const baseline = await scan();
    assert.equal(baseline.inserted, 3);
    const bodies = await processBodySlice({ db: pool, connection: imap, account, folder, mailboxId: baseline.mailboxId });
    assert.equal(bodies.processed, 3);
    assert.equal((await emailFor(1)).subject, 'history one');
    assert.deepEqual(await events(), [], 'nothing in the mailbox before the first pass is announced');
    await scan('history'); await scan('flags');
    assert.deepEqual(await events(), [], 'nor by the sweeps that revisit it');

    // New mail: one unread, one the provider already shows as read.
    const unread = peer.arrive('owner', 'Dinner on Friday?'), read = peer.arrive('owner', 'already read elsewhere', ['\\Seen']);
    const arrival = await scan();
    assert.equal(arrival.inserted, 2);
    const held = await events();
    assert.deepEqual(held.map((e: FixtureValue) => [e.source_id, Number(e.deliveries), decode(e.payload).held]), [[(await emailFor(unread)).id, 0, true]],
      'the unread arrival is announced at once, held; a message read at the provider never is');
    await notifications.processNotificationJobs();
    assert.equal(sent.length, 0, `nothing is sent before the content arrives: ${JSON.stringify(sent)}`);

    const imported = await processBodySlice({ db: pool, connection: imap, account, folder, mailboxId: arrival.mailboxId });
    assert.equal(imported.processed, 2);
    assert.equal((await emailFor(unread)).import_complete, 1);
    const released = await events();
    assert.equal(released.length, 1);
    assert.equal(Number(released[0].deliveries), 1, 'the import queued its delivery');
    const payload = decode(released[0].payload);
    assert.equal(payload.held, undefined);
    assert.equal(payload.title, 'New Email');
    assert.equal(payload.body, 'Fixture Sender: Dinner on Friday?', 'with the sender and subject of the imported message');
    assert.equal(payload.url, `/mail?email=${(await emailFor(unread)).id}`);
    await notifications.processNotificationJobs();
    assert.deepEqual(sent.map(item => [item.kind, item.body]), [['mail', 'Fixture Sender: Dinner on Friday?']]);
    await scan(); await scan('flags');
    await processBodySlice({ db: pool, connection: imap, account, folder, mailboxId: arrival.mailboxId });
    await notifications.processNotificationJobs();
    assert.equal(sent.length, 1, 'later passes over the same mail announce nothing again');

    // Read in the browser between arrival and download: stays unsent.
    const quick = peer.arrive('owner', 'read before download');
    await scan();
    assert.equal((await events()).length, 2);
    await pool.execute<ResultSetHeader>('UPDATE emails SET is_read = TRUE WHERE mail_account_id = ? AND remote_uid = ?', [accountId, quick]);
    await processBodySlice({ db: pool, connection: imap, account, folder, mailboxId: arrival.mailboxId });
    await notifications.processNotificationJobs();
    const quickId = (await emailFor(quick)).id;
    const quiet = (await events()).find((e: FixtureValue) => e.source_id === quickId);
    assert.equal(Number(quiet.deliveries), 0);
    assert.equal(decode(quiet.payload).held, true, 'left held; it expires with the event');
    assert.equal(sent.length, 1);

    // Mail that a flags sweep meets before the recent pass is new mail too, once.
    const swept = peer.arrive('owner', 'seen by the sweep first');
    await scan('flags');
    const sweptId = (await emailFor(swept)).id;
    const bySweep = (await events()).filter((e: FixtureValue) => e.source_id === sweptId);
    assert.equal(bySweep.length, 1, 'held by the sweep');
    assert.equal(decode(bySweep[0].payload).held, true);
    await scan();
    await processBodySlice({ db: pool, connection: imap, account, folder, mailboxId: arrival.mailboxId });
    await notifications.processNotificationJobs();
    assert.deepEqual(sent.slice(1).map(item => item.body), ['Fixture Sender: seen by the sweep first']);
    assert.equal((await events()).filter((e: FixtureValue) => e.source_id === sweptId).length, 1, 'one event although two streams saw it');

    // An account whose INBOX is empty when it is added: its first message is new mail.
    const fresh = { id: freshId, user_id: userId, sync_mode: 'sync' };
    const freshImap = await connect('fresh');
    try {
      const empty = await scanMailboxSlice({ db: pool, connection: freshImap, account: fresh, folder, stream: 'recent' });
      assert.equal(empty.processed, 0);
      const first = peer.arrive('fresh', 'first ever');
      const seen = await scanMailboxSlice({ db: pool, connection: freshImap, account: fresh, folder, stream: 'recent' });
      assert.equal(seen.inserted, 1);
      assert.equal((await events(freshId)).length, 1, 'the empty first pass was the baseline');
      await processBodySlice({ db: pool, connection: freshImap, account: fresh, folder, mailboxId: empty.mailboxId });
      await notifications.processNotificationJobs();
      assert.equal(sent.at(-1)?.body, 'Fixture Sender: first ever');
      assert.equal(sent.at(-1)?.url, `/mail?email=${(await emailFor(first, freshId)).id}`);
    } finally { closeImapConnection(freshImap); }
    assert.equal(sent.length, 3);
    assert.deepEqual(peer.errors, []);
  });
