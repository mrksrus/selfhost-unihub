'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
// Conversations (0.24): threading headers on import over the IMAP wire, on
// the Sent copy and on reply drafts over the SMTP wire, the backfill of older
// mail from its raw files, and the conversation list through the real request
// handler with two people. Only loopback peers stand in for the providers.
process.env.TRUSTED_MAIL_HOSTS = 'localhost';
process.env.ENCRYPTION_KEY ||= 'synthetic-threading-test-key';
// Read once per process: every test's fresh database gets this first admin.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'thread-list-admin@example.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-thread-list-admin-password';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const net = require('node:net') as typeof import('node:net');
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { trySelfSigned, listen, smtpPeer } = require('./helpers/mail-peers.cts') as import('./helpers/mail-peers.cts').MailPeerHelpers;

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const localKey = (emailId: string) => sha(`unihub-email:${emailId}`);
const DAY = 86_400_000;

async function mailRoots(t: import('node:test').TestContext) {
  const uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-threads-'));
  const previous = { raw: process.env.MAIL_RAW_STORAGE_ROOT, attachments: process.env.MAIL_ATTACHMENT_UPLOAD_ROOT };
  process.env.MAIL_RAW_STORAGE_ROOT = path.join(uploads, 'mail-raw');
  process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = path.join(uploads, 'attachments');
  t.after(async () => {
    for (const [name, value] of [['MAIL_RAW_STORAGE_ROOT', previous.raw], ['MAIL_ATTACHMENT_UPLOAD_ROOT', previous.attachments]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fs.rm(uploads, { recursive: true, force: true });
  });
  return { raw: process.env.MAIL_RAW_STORAGE_ROOT };
}

function rawMessage({ id, subject, from = 'Alice <alice@example.test>', to = 'owner@example.test', date = new Date(), inReplyTo, references, extra }:
  { id?: string; subject: string; from?: string; to?: string; date?: Date; inReplyTo?: string; references?: string; extra?: string }) {
  return [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${date.toUTCString()}`, id ? `Message-ID: ${id}` : '',
    inReplyTo !== undefined ? `In-Reply-To: ${inReplyTo}` : '', references !== undefined ? `References: ${references}` : '', extra || '']
    .filter(Boolean).join('\r\n') + '\r\n\r\nbody\r\n';
}

// One INBOX per login, holding the raw messages the test adds.
async function startImapPeer() {
  const sockets = new Set<import('node:net').Socket>(), errors: string[] = [];
  const boxes = new Map<string, { mail: Map<number, string>; nextUid: number }>();
  const box = (login: string) => { if (!boxes.has(login)) boxes.set(login, { mail: new Map(), nextUid: 1 }); return boxes.get(login)!; };
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK synthetic threading peer\r\n');
    let input = '', chain = Promise.resolve(), login = '';
    const send = (value: string | Buffer) => { if (!socket.destroyed) socket.write(value); };
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
          if (cmd.startsWith('LOGIN ')) { login = /LOGIN "?([a-z]+)"? /.exec(cmd)?.[1] || ''; ok(); return; }
          if (cmd.startsWith('LSUB ')) { ok(); return; }
          const { mail, nextUid } = box(login);
          if (cmd.startsWith('LIST ')) { send('* LIST (\\Noselect) "/" ""\r\n'); ok(); return; }
          const selected = /^(SELECT|EXAMINE) "?INBOX"?$/.exec(cmd);
          if (selected) {
            send(`* FLAGS (\\Seen \\Flagged)\r\n* ${mail.size} EXISTS\r\n* OK [UIDVALIDITY 7] valid\r\n* OK [UIDNEXT ${nextUid}] next\r\n`);
            ok(`[${selected[1] === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] selected`); return;
          }
          const fetch = /^UID FETCH (\d+)(?::(\d+))? \(UID (?:FLAGS INTERNALDATE|(BODY\.PEEK\[\])) MODSEQ\)$/.exec(cmd);
          if (fetch) {
            const low = Number(fetch[1]), high = Number(fetch[2] || fetch[1]);
            for (const [uid, raw] of [...mail].filter(([uid]) => uid >= low && uid <= high).sort((a, b) => a[0] - b[0])) {
              if (fetch[3]) {
                const bytes = Buffer.from(raw, 'latin1');
                send(`* 1 FETCH (UID ${uid} FLAGS () MODSEQ (3) INTERNALDATE "29-Sep-2026 12:00:00 +0000" BODY[] {${bytes.length}}\r\n`);
                send(bytes);
                send(')\r\n');
              } else send(`* 1 FETCH (UID ${uid} FLAGS () MODSEQ (3) INTERNALDATE "29-Sep-2026 12:00:00 +0000")\r\n`);
            }
            ok(); return;
          }
          if (cmd === 'LOGOUT') { send('* BYE bye\r\n'); ok(); return; }
          throw new Error(`Unexpected IMAP command: ${cmd}`);
        }).catch(error => { errors.push(error.message); socket.destroy(); });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    errors,
    arrive(login: string, raw: string) { const b = box(login); const uid = b.nextUid++; b.mail.set(uid, raw); return uid; },
    port: (server.address() as import('node:net').AddressInfo).port,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('imported mail keeps In-Reply-To and References and joins its conversation, whatever the arrival order', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  await mailRoots(t);
  const pool = await withTestDatabase(t);
  const { connectImap } = require('../dist/src/services/mail-imap-client') as typeof import('../src/services/mail-imap-client');
  const { guardImapConnection, closeImapConnection } = require('../dist/src/services/mail-imap-guard') as typeof import('../src/services/mail-imap-guard');
  const { scanMailboxSlice } = require('../dist/src/services/mail-engine/sync') as typeof import('../src/services/mail-engine/sync');
  const { processBodySlice } = require('../dist/src/services/mail-engine/content') as typeof import('../src/services/mail-engine/content');
  const peer = await startImapPeer();
  const sessions: FixtureValue[] = [];
  t.after(async () => { for (const session of sessions) { try { closeImapConnection(session); } catch { /* closed */ } } await peer.close(); });

  const owner = crypto.randomUUID(), stranger = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'owner@example.test', 'x'), (?, 'stranger@example.test', 'x')", [owner, stranger]);
  const syncAccount = { id: crypto.randomUUID(), user_id: owner, sync_mode: 'sync' };
  const downloadAccount = { id: crypto.randomUUID(), user_id: owner, sync_mode: 'download' };
  const strangerAccount = crypto.randomUUID();
  for (const [id, userId, address, mode] of [[syncAccount.id, owner, 'owner@example.test', 'sync'], [downloadAccount.id, owner, 'archive@example.test', 'download'],
    [strangerAccount, stranger, 'stranger@example.test', 'download']]) {
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, ?, 'custom', ?, TRUE)", [id, userId, address, mode]);
  }
  // The stranger stores a message whose Message-ID the owner's mail names as root.
  await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, to_addresses, folder, thread_key)
    VALUES (?, ?, ?, '<shared-root@example.test>', 'Shared', 'someone@example.test', '[]', 'inbox', ?)`, [crypto.randomUUID(), stranger, strangerAccount, 'f'.repeat(64)]);

  const folder = { folderName: 'INBOX', dbFolderName: 'inbox' };
  const connect = async (login: string) => {
    const session = guardImapConnection(await connectImap({ imap: { host: '127.0.0.1', port: peer.port, user: login, password: 'fixture-only',
      tls: false, keepalive: false, connTimeout: 1000, authTimeout: 1000, socketTimeout: 30000 } }), { timeoutMs: 30000 });
    sessions.push(session);
    return session;
  };
  const imports = { owner: await connect('owner'), archive: await connect('archive') };
  // Discovery, then every body; bodies are imported newest UID first.
  const importNew = async (login: 'owner' | 'archive') => {
    const account = login === 'owner' ? syncAccount : downloadAccount;
    const scan = await scanMailboxSlice({ db: pool, connection: imports[login], account, folder, stream: 'recent' });
    for (let round = 0; round < 10; round++) {
      const slice = await processBodySlice({ db: pool, connection: imports[login], account, folder, mailboxId: scan.mailboxId });
      if (!slice.processed && !slice.deferred) break;
    }
  };
  const byId = async (messageId: string) => (await pool.execute<RowDataPacket[]>(
    'SELECT id, in_reply_to, references_header, thread_key, import_complete FROM emails WHERE user_id = ? AND message_id = ?', [owner, messageId]))[0][0];
  const conversation = sha('<root@example.test>');

  // A root and a reply naming it in References and In-Reply-To.
  const now = Date.now();
  peer.arrive('owner', rawMessage({ id: '<root@example.test>', subject: 'Quarterly plan', date: new Date(now - 5 * DAY) }));
  peer.arrive('owner', rawMessage({ id: '<a@example.test>', subject: 'Re: Quarterly plan', date: new Date(now - 4 * DAY),
    inReplyTo: '<root@example.test>', references: '<root@example.test>' }));
  await importNew('owner');
  assert.deepEqual(await byId('<a@example.test>'), { id: (await byId('<a@example.test>')).id, in_reply_to: '<root@example.test>',
    references_header: '<root@example.test>', thread_key: conversation, import_complete: 1 });
  assert.equal((await byId('<root@example.test>')).thread_key, conversation, 'the root is keyed by its own Message-ID');
  assert.equal((await byId('<root@example.test>')).in_reply_to, null);

  // A reply that names only its parent joins the parent's conversation, whose root lies further up.
  peer.arrive('owner', rawMessage({ id: '<b@example.test>', subject: 'Re: Quarterly plan', date: new Date(now - 3 * DAY), inReplyTo: '<a@example.test>' }));
  await importNew('owner');
  const b = await byId('<b@example.test>');
  assert.equal(b.in_reply_to, '<a@example.test>');
  assert.equal(b.references_header, null);
  assert.equal(b.thread_key, conversation);

  // A reply that arrives before the message it answers: the later parent takes it into the conversation.
  peer.arrive('owner', rawMessage({ id: '<d@example.test>', subject: 'Re: Quarterly plan', date: new Date(now - 2 * DAY),
    inReplyTo: '<a@example.test>', references: '<root@example.test> <a@example.test>' }));
  peer.arrive('owner', rawMessage({ id: '<c@example.test>', subject: 'Re: Quarterly plan', date: new Date(now - DAY), inReplyTo: '<d@example.test>' }));
  await importNew('owner');
  assert.equal((await byId('<d@example.test>')).references_header, '<root@example.test> <a@example.test>');
  assert.equal((await byId('<c@example.test>')).thread_key, conversation);

  // No threading headers: a reply prefix joins the latest same-subject message
  // of the same correspondent within 60 days; nothing else is merged.
  peer.arrive('owner', rawMessage({ id: '<old@example.test>', subject: 'Old topic', date: new Date(now - 90 * DAY) }));
  peer.arrive('owner', rawMessage({ id: '<f@example.test>', subject: 'Invoice', from: 'billing@vendor.example.test', date: new Date(now - 10 * DAY) }));
  await importNew('owner');
  peer.arrive('owner', rawMessage({ id: '<e@example.test>', subject: 'AW: Quarterly plan', date: new Date(now - 60_000) }));
  peer.arrive('owner', rawMessage({ id: '<g@example.test>', subject: 'Invoice', from: 'billing@vendor.example.test', date: new Date(now - 9 * DAY) }));
  peer.arrive('owner', rawMessage({ id: '<h@example.test>', subject: 'Re: Invoice', from: 'other@elsewhere.example.test', date: new Date(now - 8 * DAY) }));
  peer.arrive('owner', rawMessage({ id: '<i@example.test>', subject: 'Re: Old topic', date: new Date(now - 30_000) }));
  peer.arrive('owner', rawMessage({ subject: 'No message id' }));
  await importNew('owner');
  assert.equal((await byId('<e@example.test>')).thread_key, conversation, 'AW: joins the same correspondent\'s conversation');
  assert.equal((await byId('<g@example.test>')).thread_key, sha('<g@example.test>'), 'two "Invoice" mails without a prefix stay apart');
  assert.equal((await byId('<f@example.test>')).thread_key, sha('<f@example.test>'));
  assert.equal((await byId('<h@example.test>')).thread_key, sha('<h@example.test>'), 'a reply prefix from another correspondent joins nothing');
  assert.equal((await byId('<i@example.test>')).thread_key, sha('<i@example.test>'), 'a same-subject message older than 60 days is not joined');
  const [[anonymous]] = await pool.execute<RowDataPacket[]>("SELECT id, thread_key FROM emails WHERE user_id = ? AND subject = 'No message id'", [owner]);
  assert.equal(anonymous.thread_key, localKey(anonymous.id), 'without a Message-ID the message is its own conversation');

  // Header values are untrusted: malformed ids are dropped, References is
  // shortened to its first and latest ids, and the message is still stored.
  const many = Array.from({ length: 60 }, (_, index) => `<ref-${index}@example.test>`);
  peer.arrive('owner', rawMessage({ id: '<x@example.test>', subject: 'Re: Long chain', inReplyTo: 'garbage <not an id> <x-parent@example.test>',
    references: [`<${'l'.repeat(600)}@example.test>`, ...many].join('\r\n ') }));
  // The stranger's message with this root id lends nothing to the owner's mail.
  peer.arrive('owner', rawMessage({ id: '<y@example.test>', subject: 'Re: Shared', references: '<shared-root@example.test>' }));
  await importNew('owner');
  const x = await byId('<x@example.test>');
  assert.equal(x.import_complete, 1);
  assert.equal(x.in_reply_to, '<x-parent@example.test>');
  const kept = String(x.references_header).split(' ');
  assert.equal(kept.length, 40);
  assert.deepEqual([kept[0], kept[1], kept.at(-1)], ['<ref-0@example.test>', '<ref-21@example.test>', '<ref-59@example.test>']);
  assert.equal(x.thread_key, sha('<ref-0@example.test>'));
  assert.equal((await byId('<y@example.test>')).thread_key, sha('<shared-root@example.test>'), 'another user\'s key is never used');

  // Download mode stores the same headers; one person's accounts share conversations.
  peer.arrive('archive', rawMessage({ id: '<z@example.test>', subject: 'Re: Quarterly plan', to: 'archive@example.test',
    inReplyTo: '<c@example.test>', references: '<root@example.test> <a@example.test> <d@example.test> <c@example.test>' }));
  await importNew('archive');
  const z = await byId('<z@example.test>');
  assert.equal(z.in_reply_to, '<c@example.test>');
  assert.equal(z.thread_key, conversation);
  assert.deepEqual(peer.errors, []);
});

test('a Sent copy and a reply draft keep the conversation of the message they answer; a reply sent later from Drafts still carries its headers (B-10)', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  const cert = trySelfSigned('localhost');
  if (!cert) { t.skip('openssl unavailable'); return; }
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  await mailRoots(t);
  const pool = await withTestDatabase(t);
  const commands: string[] = [], messages: string[] = [];
  const smtp = await listen(smtpPeer(cert, commands, { messages }));
  t.after(smtp.close);
  const { encrypt } = require('../dist/src/security/encryption') as typeof import('../src/security/encryption');
  const drafts = require('../dist/src/routes/mail-drafts') as FixtureValue;

  const owner = crypto.randomUUID(), stranger = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'sender@example.test', 'x'), (?, 'other@example.test', 'x')", [owner, stranger]);
  const account = crypto.randomUUID(), strangerAccount = crypto.randomUUID();
  for (const [id, userId, address] of [[account, owner, 'sender@example.test'], [strangerAccount, stranger, 'other@example.test']]) {
    await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active, smtp_host, smtp_port, encrypted_password,
      allow_self_signed, trusted_smtp_fingerprint256) VALUES (?, ?, ?, 'custom', 'download', TRUE, 'localhost', ?, ?, TRUE, ?)`,
    [id, userId, address, smtp.port, encrypt('synthetic-password'), cert.fingerprint256]);
  }
  const conversation = sha('<root@example.test>');
  const parent = crypto.randomUUID();
  await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, to_addresses, folder,
      in_reply_to, references_header, thread_key)
    VALUES (?, ?, ?, '<p@example.test>', 'Plan', 'alice@example.test', '["sender@example.test"]', 'inbox', '<mid@example.test>',
      '<root@example.test> <mid@example.test>', ?)`, [parent, owner, account, conversation]);
  const call = (key: string, params: Record<string, string>, userId: string, body?: unknown) =>
    drafts[key]({ url: `/api/mail/drafts/${params.id ?? ''}`, params, headers: {} }, userId, body);
  const row = async (id: string) => (await pool.execute<RowDataPacket[]>('SELECT in_reply_to, references_header, thread_key FROM emails WHERE id = ?', [id]))[0][0];
  const chain = '<root@example.test> <mid@example.test> <p@example.test>';

  // A reply draft keeps the reply link; editing it later (opened from Drafts, without the link) keeps it.
  const created = await call('POST /api/mail/drafts', {}, owner, { account_id: account, to: 'alice@example.test', subject: 'Re: Plan',
    body: '<p>First thoughts</p>', in_reply_to_email_id: parent });
  assert.equal(created.error, undefined, created.error);
  const draftId = created.draft.id;
  assert.deepEqual(await row(draftId), { in_reply_to: '<p@example.test>', references_header: chain, thread_key: conversation });
  const edited = await call('PUT /api/mail/drafts/:id', { id: draftId }, owner, { body: '<p>Final answer</p>' });
  assert.equal(edited.error, undefined, edited.error);
  assert.deepEqual(await row(draftId), { in_reply_to: '<p@example.test>', references_header: chain, thread_key: conversation });

  // Another person cannot link a draft to the owner's message.
  const foreign = await call('POST /api/mail/drafts', {}, stranger, { account_id: strangerAccount, to: 'x@example.test', subject: 'Plan', body: '<p>x</p>', in_reply_to_email_id: parent });
  assert.deepEqual(await row(foreign.draft.id), { in_reply_to: null, references_header: null, thread_key: sha(`<draft-${foreign.draft.id}@unihub.local>`) });

  // Sent from Drafts without naming the parent: the wire and the Sent copy carry the kept threading.
  const sent = await call('POST /api/mail/drafts/:id/send', { id: draftId }, owner, undefined);
  assert.equal(sent.success, true, sent.error);
  assert.match(messages[0], /^In-Reply-To: <p@example\.test>$/m);
  assert.match(messages[0].replace(/\r\n[ \t]+/g, ' '), /^References: <root@example\.test> <mid@example\.test> <p@example\.test>$/m);
  const [[copy]] = await pool.execute<RowDataPacket[]>("SELECT id, in_reply_to, references_header, thread_key FROM emails WHERE user_id = ? AND folder = 'sent'", [owner]);
  assert.deepEqual({ ...copy, id: undefined }, { id: undefined, in_reply_to: '<p@example.test>', references_header: chain, thread_key: conversation });

  // A direct reply does the same; a new message starts its own conversation.
  const direct = await drafts['POST /api/mail/send']({ url: '/api/mail/send', params: {}, headers: {} }, owner,
    { account_id: account, to: 'alice@example.test', subject: 'Re: Plan', body: 'Agreed', in_reply_to_email_id: parent });
  assert.equal(direct.success, true, direct.error);
  assert.deepEqual(await row(direct.sent_copy_id), { in_reply_to: '<p@example.test>', references_header: chain, thread_key: conversation });
  const fresh = await drafts['POST /api/mail/send']({ url: '/api/mail/send', params: {}, headers: {} }, owner,
    { account_id: account, to: 'alice@example.test', subject: 'Lunch', body: 'Tomorrow?' });
  const [[freshCopy]] = await pool.execute<RowDataPacket[]>('SELECT message_id, in_reply_to, thread_key FROM emails WHERE id = ?', [fresh.sent_copy_id]);
  assert.deepEqual(freshCopy, { message_id: freshCopy.message_id, in_reply_to: null, thread_key: sha(freshCopy.message_id) });
  assert.doesNotMatch(messages[2], /^(In-Reply-To|References):/m);

  // Removing the reply link from a draft (now on another topic) removes its headers.
  const second = await call('POST /api/mail/drafts', {}, owner, { account_id: account, to: 'alice@example.test', subject: 'Re: Plan', body: '<p>x</p>', in_reply_to_email_id: parent });
  await call('PUT /api/mail/drafts/:id', { id: second.draft.id }, owner, { in_reply_to_email_id: null, subject: 'Another topic' });
  assert.deepEqual(await row(second.draft.id), { in_reply_to: null, references_header: null, thread_key: sha(`<draft-${second.draft.id}@unihub.local>`) });
});

test('the backfill threads older mail from the header part of its raw files, resumes in slices, waits for restores and changes nothing on a second run', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const roots = await mailRoots(t);
  const pool = await withTestDatabase(t);
  const { runMailThreadBackfill, resetMailThreadBackfill } = require('../dist/src/services/mail-thread-backfill') as typeof import('../src/services/mail-thread-backfill');
  resetMailThreadBackfill();

  const owner = crypto.randomUUID(), stranger = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'keeper@example.test', 'x'), (?, 'neighbour@example.test', 'x')", [owner, stranger]);
  const account = crypto.randomUUID(), strangerAccount = crypto.randomUUID();
  for (const [id, userId, address] of [[account, owner, 'keeper@example.test'], [strangerAccount, stranger, 'neighbour@example.test']]) {
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, ?, 'custom', 'download', TRUE)", [id, userId, address]);
  }
  const now = Date.now();
  // Mail stored before 0.24: no headers in the row, no thread_key.
  const legacy = async (userId: string, accountId: string, { messageId, subject, from = 'alice@example.test', to = '["keeper@example.test"]', raw, rawPath, format = 'exact_octets', ago = 0 }:
    { messageId: string | null; subject: string; from?: string; to?: string; raw?: string; rawPath?: string; format?: string; ago?: number }) => {
    const id = crypto.randomUUID();
    let stored: string | null = rawPath ?? null;
    if (raw !== undefined) {
      stored = path.join(roots.raw, userId, `${id}.eml`);
      await fs.mkdir(path.dirname(stored), { recursive: true });
      await fs.writeFile(stored, raw, 'latin1');
    }
    await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, to_addresses, folder, received_at,
        raw_storage_path, raw_format, import_complete) VALUES (?, ?, ?, ?, ?, ?, ?, 'inbox', ?, ?, ?, TRUE)`,
    [id, userId, accountId, messageId, subject, from, to, new Date(now - ago), stored, format]);
    return id;
  };
  const header = (lines: string[]) => `${lines.join('\r\n')}\r\n\r\nbody text that is never read\r\n`;
  const root = await legacy(owner, account, { messageId: '<l-root@example.test>', subject: 'Budget', ago: 5 * DAY,
    raw: header(['From: alice@example.test', 'Message-ID: <l-root@example.test>', 'Subject: Budget']) });
  // Folded References in an older normalized copy (LF line ends).
  const folded = await legacy(owner, account, { messageId: '<l-2@example.test>', subject: 'Re: Budget', ago: 4 * DAY, format: 'legacy_normalized',
    raw: 'From: alice@example.test\nIn-Reply-To: <l-root@example.test>\nReferences: <l-root@example.test>\n\t<l-1@example.test>\nSubject: Re: Budget\n\nbody\n' });
  const parentOnly = await legacy(owner, account, { messageId: '<l-3@example.test>', subject: 'Re: Budget', ago: 3 * DAY,
    raw: header(['From: alice@example.test', 'In-Reply-To: <l-2@example.test>', 'Subject: Re: Budget']) });
  // No raw file: the subject fallback, then its own Message-ID, then its row.
  const noFile = await legacy(owner, account, { messageId: '<l-4@example.test>', subject: 'AW: Budget', ago: 2 * DAY });
  const noId = await legacy(owner, account, { messageId: null, subject: 'Note to self' });
  // A path into another user's directory is never read.
  const theirFile = path.join(roots.raw, stranger, 'planted.eml');
  await fs.mkdir(path.dirname(theirFile), { recursive: true });
  await fs.writeFile(theirFile, header(['References: <planted@example.test>']));
  const planted = await legacy(owner, account, { messageId: '<l-6@example.test>', subject: 'Elsewhere', rawPath: theirFile });
  // Only the first 64 KiB are read: References after a huge header block is not seen.
  const huge = await legacy(owner, account, { messageId: '<l-7@example.test>', subject: 'Huge headers',
    raw: header([...Array.from({ length: 1200 }, (_, index) => `X-Filler-${index}: ${'f'.repeat(60)}`), 'References: <late@example.test>']) });
  const theirs = await legacy(stranger, strangerAccount, { messageId: '<n-1@example.test>', subject: 'Re: Budget', from: 'alice@example.test', to: '["neighbour@example.test"]',
    raw: header(['In-Reply-To: <l-root@example.test>']) });

  // Two replies with the same subject, correspondent and time: neither may wait for the other.
  const twinA = await legacy(owner, account, { messageId: '<t-1@example.test>', subject: 'Re: Twins', ago: DAY / 2 });
  const twinB = await legacy(owner, account, { messageId: '<t-2@example.test>', subject: 'Re: Twins', ago: DAY / 2 });

  const unkeyed = async () => Number((await pool.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM emails WHERE thread_key IS NULL'))[0][0].n);
  assert.equal(await unkeyed(), 10);
  // Slices of three rows: each run resumes where the last stopped.
  const first = await runMailThreadBackfill({}, { maxRows: 3, force: true });
  assert.equal(first.more, true);
  assert.equal(await unkeyed(), 10 - first.keyed);
  for (let run = 0; run < 20 && await unkeyed() > 0; run++) await runMailThreadBackfill({}, { maxRows: 3, force: true });
  assert.equal(await unkeyed(), 0);

  const state = async () => (await pool.execute<RowDataPacket[]>('SELECT id, in_reply_to, references_header, thread_key FROM emails ORDER BY id'))[0];
  const keyOf = async (id: string) => (await pool.execute<RowDataPacket[]>('SELECT in_reply_to, references_header, thread_key FROM emails WHERE id = ?', [id]))[0][0];
  const conversation = sha('<l-root@example.test>');
  assert.deepEqual(await keyOf(root), { in_reply_to: null, references_header: null, thread_key: conversation });
  assert.deepEqual(await keyOf(folded), { in_reply_to: '<l-root@example.test>', references_header: '<l-root@example.test> <l-1@example.test>', thread_key: conversation });
  assert.deepEqual(await keyOf(parentOnly), { in_reply_to: '<l-2@example.test>', references_header: null, thread_key: conversation });
  assert.equal((await keyOf(noFile)).thread_key, conversation, 'AW: without a file joins Budget by subject and correspondent');
  assert.equal((await keyOf(noId)).thread_key, localKey(noId));
  assert.deepEqual(await keyOf(planted), { in_reply_to: null, references_header: null, thread_key: sha('<l-6@example.test>') });
  assert.equal((await keyOf(huge)).thread_key, sha('<l-7@example.test>'));
  assert.equal((await keyOf(theirs)).thread_key, sha('<l-root@example.test>'), 'the neighbour\'s mail is threaded in their own mailbox');
  const [earlierTwin, laterTwin] = [twinA, twinB].sort();
  assert.equal((await keyOf(earlierTwin)).thread_key, sha(earlierTwin === twinA ? '<t-1@example.test>' : '<t-2@example.test>'));
  assert.equal((await keyOf(laterTwin)).thread_key, (await keyOf(earlierTwin)).thread_key, 'the twin with the larger id joins the other');

  // A second run finds nothing and changes nothing.
  const before = await state();
  const again = await runMailThreadBackfill({}, { force: true });
  assert.deepEqual({ keyed: again.keyed, more: again.more }, { keyed: 0, more: false });
  assert.deepEqual(await state(), before);

  // Mail restored from an older archive has no key again; while the mail
  // section is being restored the backfill leaves the user alone.
  await pool.execute('UPDATE emails SET in_reply_to = NULL, references_header = NULL, thread_key = NULL WHERE id = ?', [folded]);
  const job = crypto.randomUUID();
  await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, operation, requested_sections) VALUES (?, ?, 'running', 'restore', ?)", [job, owner, JSON.stringify(['mail'])]);
  const waiting = await runMailThreadBackfill({}, { force: true });
  assert.equal(waiting.skippedUsers, 1);
  assert.equal((await keyOf(folded)).thread_key, null);
  await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [job]);
  // A raw directory that is not there (an unmounted volume) is not taken for missing files.
  const ownDir = path.join(roots.raw, owner);
  await fs.rename(ownDir, `${ownDir}.away`);
  assert.equal((await runMailThreadBackfill({}, { force: true })).skippedUsers, 1);
  assert.equal((await keyOf(folded)).thread_key, null);
  await fs.rename(`${ownDir}.away`, ownDir);
  await runMailThreadBackfill({}, { force: true });
  assert.deepEqual(await state(), before);
});

test('the conversation list groups each person\'s own mail per view, pages stably, and opens a conversation for its owner only', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const owner = api.client(), stranger = api.client();
  assert.equal((await owner.request('POST', '/api/auth/signin', { email: 'thread-list-admin@example.test', password: 'synthetic-thread-list-admin-password' })).status, 200);
  assert.equal((await owner.request('PUT', '/api/admin/settings/signup-mode', { signup_mode: 'open' })).status, 200);
  assert.equal((await stranger.request('POST', '/api/auth/signup', { email: 'thread-list-person@example.test', password: 'synthetic-thread-list-person-password', full_name: 'Person' })).status, 200);
  const ownerId = ((await owner.request('GET', '/api/auth/me')).body.user as FixtureValue).id;
  const strangerId = ((await stranger.request('GET', '/api/auth/me')).body.user as FixtureValue).id;
  const ownerAccount = crypto.randomUUID(), strangerAccount = crypto.randomUUID();
  for (const [id, userId, address] of [[ownerAccount, ownerId, 'thread-list-admin@example.test'], [strangerAccount, strangerId, 'thread-list-person@example.test']]) {
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, ?, 'custom', 'download', TRUE)", [id, userId, address]);
  }
  const base = Date.UTC(2026, 9, 1, 12);
  const mail = async (userId: string, accountId: string, { key, folder = 'inbox', day, from, read = true, starred = false }:
    { key: string | null; folder?: string; day: number; from: string; read?: boolean; starred?: boolean }) => {
    const id = crypto.randomUUID();
    await pool.execute(`INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, folder, is_read, is_starred, received_at, thread_key)
      VALUES (?, ?, ?, ?, 'Subject', ?, ?, '[]', ?, ?, ?, ?, ?)`,
    [id, userId, accountId, `<${id}@example.test>`, from, from.split('@')[0], folder, read, starred, new Date(base + day * DAY), key]);
    return id;
  };
  const [k1, k2, k4, k5] = ['1', '2', '4', '5'].map(digit => digit.repeat(64));
  const first = await mail(ownerId, ownerAccount, { key: k1, day: 1, from: 'alice@example.test' });
  const reply = await mail(ownerId, ownerAccount, { key: k1, day: 3, from: 'bob@example.test', read: false });
  const sentCopy = await mail(ownerId, ownerAccount, { key: k1, folder: 'sent', day: 2, from: 'thread-list-admin@example.test' });
  const starred = await mail(ownerId, ownerAccount, { key: k2, day: 4, from: 'carol@example.test', read: false, starred: true });
  const unkeyed = await mail(ownerId, ownerAccount, { key: null, day: 2.5, from: 'dave@example.test' });
  await mail(ownerId, ownerAccount, { key: k4, folder: 'archive', day: 5, from: 'erin@example.test' });
  const oldest = await mail(ownerId, ownerAccount, { key: k5, day: 0, from: 'frank@example.test' });
  // The other person's message happens to share a conversation key.
  const theirs = await mail(strangerId, strangerAccount, { key: k1, day: 6, from: 'mallory@example.test', read: false });

  type Threads = { threads: FixtureValue[]; pagination: FixtureValue };
  const list = async (client: typeof owner, query: string) => {
    const reply = await client.request('GET', `/api/mail/threads?${query}`);
    assert.equal(reply.status, 200, String(reply.body.error));
    return reply.body as unknown as Threads;
  };
  const page1 = await list(owner, 'folder=inbox&limit=2&include_count=true');
  assert.deepEqual(page1.threads.map(thread => thread.latest.id), [starred, reply]);
  assert.deepEqual(page1.threads[1], { ...page1.threads[1], thread_key: k1, message_count: 2, unread_count: 1, total_count: 3, has_attachments: false, is_starred: false,
    participants: [{ address: 'bob@example.test', name: 'bob' }, { address: 'thread-list-admin@example.test', name: 'thread-list-admin' }, { address: 'alice@example.test', name: 'alice' }] });
  assert.equal(page1.threads[0].is_starred, true);
  assert.deepEqual({ total: page1.pagination.total, hasMore: page1.pagination.hasMore }, { total: 4, hasMore: true });

  // Mail arriving between two pages moves its conversation to the top without
  // shifting the next page: a cursor page lists only what came after.
  const late = await mail(ownerId, ownerAccount, { key: k5, day: 7, from: 'frank@example.test', read: false });
  const page2 = await list(owner, `folder=inbox&limit=2&cursor=${encodeURIComponent(page1.pagination.next_cursor)}`);
  assert.deepEqual(page2.threads.map(thread => thread.latest.id), [unkeyed]);
  assert.equal(page2.pagination.hasMore, false);
  assert.deepEqual((await list(owner, 'folder=inbox')).threads.map(thread => thread.latest.id), [late, starred, reply, unkeyed]);
  assert.deepEqual((await list(owner, 'folder=inbox&limit=2&offset=2')).threads.map(thread => thread.latest.id), [reply, unkeyed]);
  assert.deepEqual((await list(owner, 'folder=inbox&is_read=false')).threads.map(thread => [thread.latest.id, thread.message_count]), [[late, 1], [starred, 1], [reply, 1]]);
  assert.equal((await owner.request('GET', '/api/mail/threads?cursor=not-a-cursor')).status, 400);
  assert.equal((await list(owner, 'folder=inbox')).pagination.total, null, 'the view is counted only when asked');

  // Messages received in the same second: two conversations are paged one by
  // one without a gap or a repeat; one conversation is listed once.
  const sameSecond = 8;
  const [tieA, tieB] = [await mail(ownerId, ownerAccount, { key: null, day: sameSecond, from: 'gina@example.test' }),
    await mail(ownerId, ownerAccount, { key: null, day: sameSecond, from: 'hank@example.test' })].sort();
  const [pairA, pairB] = [await mail(ownerId, ownerAccount, { key: '6'.repeat(64), day: sameSecond, from: 'ivy@example.test' }),
    await mail(ownerId, ownerAccount, { key: '6'.repeat(64), day: sameSecond, from: 'jon@example.test' })].sort();
  const seen: string[] = [];
  let cursor = '';
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await list(owner, `folder=inbox&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    seen.push(...page.threads.map(thread => thread.latest.id));
    if (!page.pagination.hasMore) break;
    cursor = page.pagination.next_cursor;
  }
  assert.deepEqual(seen.slice(0, 3), [pairA, tieA, tieB].sort(), 'each conversation of that second once, by id; the pair by its first id');
  assert.ok(!seen.includes(pairB));
  assert.deepEqual(seen.slice(3), [late, starred, reply, unkeyed]);
  await pool.execute('DELETE FROM emails WHERE id IN (?, ?, ?, ?)', [tieA, tieB, pairA, pairB]);

  // The other person sees only their own message, counted alone.
  const theirList = await list(stranger, 'folder=inbox');
  assert.deepEqual(theirList.threads.map(thread => [thread.latest.id, thread.message_count, thread.total_count]), [[theirs, 1, 1]]);

  // The reader gets the whole conversation, every folder, oldest first; only its owner can open it.
  const opened = await owner.request('GET', `/api/mail/emails/${first}/thread`);
  assert.equal(opened.status, 200);
  assert.deepEqual((opened.body.messages as FixtureValue[]).map(row => row.id), [first, sentCopy, reply]);
  assert.equal((opened.body.messages as FixtureValue[])[0].raw_storage_path, undefined, 'no storage paths leave the server');
  assert.equal((await stranger.request('GET', `/api/mail/emails/${first}/thread`)).status, 404);
  assert.deepEqual(((await owner.request('GET', `/api/mail/emails/${oldest}/thread`)).body.messages as FixtureValue[]).map(row => row.id), [oldest, late]);

  // A conversation longer than the reader's limit: the newest messages are
  // shown, and an older message opened from the list is still among them.
  const k7 = '7'.repeat(64);
  const longStart = await mail(ownerId, ownerAccount, { key: k7, folder: 'archive', day: 0.5, from: 'kim@example.test' });
  const longRest: string[] = [];
  for (let index = 0; index < 200; index++) longRest.push(await mail(ownerId, ownerAccount, { key: k7, folder: 'archive', day: 10 + index / 1000, from: 'lee@example.test' }));
  const long = (await owner.request('GET', `/api/mail/emails/${longStart}/thread`)).body as { messages: FixtureValue[]; truncated: boolean };
  assert.equal(long.truncated, true);
  assert.equal(long.messages.length, 200);
  assert.equal(long.messages[0].id, longStart, 'the opened message first, as the oldest');
  assert.equal(long.messages[199].id, longRest[199]);
  await pool.execute('DELETE FROM emails WHERE thread_key = ?', [k7]);

  // The message list is unchanged: one row per message.
  const flat = await owner.request('GET', '/api/mail/emails?folder=inbox');
  assert.deepEqual((flat.body.emails as FixtureValue[]).map(row => row.id), [late, starred, reply, unkeyed, first, oldest]);
});
