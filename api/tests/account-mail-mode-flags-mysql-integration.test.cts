'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MariaDB database ending in _test.
// Read and star after the import (MAIL_MODES.md): a Download account keeps
// what the person set in UniHub whatever another mail client changes at the
// provider later; a Sync account follows the provider. Real ImapFlow sockets
// against a synthetic peer, the real engine scan and body import, and the
// real mail change service. B-35.
process.env.ENCRYPTION_KEY ||= 'synthetic-mail-mode-flags-key';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs/promises') as typeof import('node:fs/promises');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { imapPeer } = require('./helpers/mail-peers.cts') as import('./helpers/mail-peers.cts').MailPeerHelpers;

const one = async (db: FixtureValue, sql: string, params: FixtureValue[] = []) => (await db.execute(sql, params))[0][0];

test('Download keeps read and star set in UniHub when the provider\'s flags change later; Sync follows the provider (B-35)', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 60000,
}, async t => {
  const uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-mode-flags-'));
  const previous = { raw: process.env.MAIL_RAW_STORAGE_ROOT, attachments: process.env.MAIL_ATTACHMENT_UPLOAD_ROOT };
  process.env.MAIL_RAW_STORAGE_ROOT = path.join(uploads, 'mail-raw');
  process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = path.join(uploads, 'attachments');
  t.after(async () => {
    for (const [name, value] of [['MAIL_RAW_STORAGE_ROOT', previous.raw], ['MAIL_ATTACHMENT_UPLOAD_ROOT', previous.attachments]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fs.rm(uploads, { recursive: true, force: true });
  });
  const pool = await withTestDatabase(t);
  const { connectImap } = require('../dist/src/services/mail-imap-client') as typeof import('../src/services/mail-imap-client');
  const { guardImapConnection, closeImapConnection } = require('../dist/src/services/mail-imap-guard') as typeof import('../src/services/mail-imap-guard');
  const { scanMailboxSlice } = require('../dist/src/services/mail-engine/sync') as typeof import('../src/services/mail-engine/sync');
  const { processBodySlice } = require('../dist/src/services/mail-engine/content') as typeof import('../src/services/mail-engine/content');
  const { mutateMessages } = require('../dist/src/services/mail-writebacks') as typeof import('../src/services/mail-writebacks');
  const peer = await imapPeer();
  const sessions: FixtureValue[] = [];
  t.after(async () => { for (const session of sessions) { try { closeImapConnection(session); } catch { /* closed */ } } await peer.close(); });

  const userId = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'owner@example.test', 'synthetic')", [userId]);
  const archive = { id: crypto.randomUUID(), user_id: userId, sync_mode: 'download' };
  const mirror = { id: crypto.randomUUID(), user_id: userId, sync_mode: 'sync' };
  for (const [account, address] of [[archive, 'archive@example.test'], [mirror, 'mirror@example.test']] as const) {
    await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider, sync_mode, is_active) VALUES (?, ?, ?, 'custom', ?, TRUE)",
      [account.id, userId, address, account.sync_mode]);
  }
  const folder = { folderName: 'INBOX', dbFolderName: 'inbox' };
  const connect = async (login: string) => {
    const session = guardImapConnection(await connectImap({ imap: { host: '127.0.0.1', port: peer.port, user: login, password: 'fixture-only',
      tls: false, keepalive: false, connTimeout: 1000, authTimeout: 1000, socketTimeout: 30000 } }), { timeoutMs: 30000 });
    sessions.push(session);
    return session;
  };
  const imap = { archive: await connect('archive'), mirror: await connect('mirror') };
  const scan = (login: 'archive' | 'mirror', stream: string) => scanMailboxSlice({ db: pool, connection: imap[login],
    account: login === 'archive' ? archive : mirror, folder, stream });
  const item = async (account: { id: string }, uid: number) => {
    const row = await one(pool, `SELECT e.id, e.is_read, e.is_starred, o.observed_flags FROM emails e
      JOIN mail_remote_occurrences o ON o.email_id = e.id AND o.uid = ? WHERE e.mail_account_id = ?`, [uid, account.id]);
    return { id: row.id as string, flags: [row.is_read, row.is_starred],
      provider: (typeof row.observed_flags === 'string' ? JSON.parse(row.observed_flags) : row.observed_flags) as string[] };
  };

  // Download: the import takes each message's flags from the provider once.
  const plain = peer.arrive('archive', 'Plain'), readThere = peer.arrive('archive', 'Read elsewhere', ['\\Seen']),
    starredThere = peer.arrive('archive', 'Starred elsewhere', ['\\Flagged']);
  const baseline = await scan('archive', 'recent');
  assert.equal(baseline.inserted, 3);
  assert.equal((await processBodySlice({ db: pool, connection: imap.archive, account: archive, folder, mailboxId: baseline.mailboxId })).processed, 3);
  assert.deepEqual((await item(archive, plain)).flags, [0, 0]);
  assert.deepEqual((await item(archive, readThere)).flags, [1, 0]);
  assert.deepEqual((await item(archive, starredThere)).flags, [0, 1]);

  // The person changes all three in UniHub; Download sends nothing to the server.
  for (const [uid, changes] of [[plain, { read: 1, star: 1 }], [readThere, { read: 0 }], [starredThere, { star: 0 }]] as const) {
    const changed = await mutateMessages(userId, [(await item(archive, uid)).id], changes);
    assert.equal(changed.sync_pending, false, 'a Download change stays local');
  }
  // Then another client changes them at the provider. The history sweep that
  // follows the first import revisits these UIDs, as a reconnect, an upgrade
  // revalidation or a new mailbox epoch's sweep does.
  peer.setFlags('archive', plain, ['\\Answered']);
  peer.setFlags('archive', readThere, ['\\Seen', '\\Flagged']);
  peer.setFlags('archive', starredThere, ['\\Seen', '\\Flagged']);
  const history = await scan('archive', 'history');
  assert.deepEqual([history.processed, 'updated' in history && history.updated], [3, 3], 'the sweep observed every message again');
  assert.deepEqual((await item(archive, plain)).flags, [1, 1], 'read and starred in UniHub stays read and starred');
  assert.deepEqual((await item(archive, readThere)).flags, [0, 0], 'marked unread in UniHub stays unread, not starred by the provider');
  assert.deepEqual((await item(archive, starredThere)).flags, [0, 0]);
  assert.deepEqual((await item(archive, readThere)).provider, ['\\Seen', '\\Flagged'], 'the provider\'s flags are still recorded as observed');
  // A later body pass changes nothing either.
  await processBodySlice({ db: pool, connection: imap.archive, account: archive, folder, mailboxId: baseline.mailboxId });
  assert.deepEqual((await item(archive, plain)).flags, [1, 1]);

  // Mail that arrives later is still imported with the provider's flags.
  const late = peer.arrive('archive', 'Arrived read', ['\\Seen', '\\Flagged']);
  assert.equal((await scan('archive', 'recent')).inserted, 1);
  await scan('archive', 'history');
  assert.deepEqual((await item(archive, late)).flags, [1, 1]);
  assert.deepEqual((await item(archive, readThere)).flags, [0, 0]);

  // Sync: read and star follow the provider, from every stream.
  const mirrored = peer.arrive('mirror', 'Mirrored');
  assert.equal((await scan('mirror', 'recent')).inserted, 1);
  assert.deepEqual((await item(mirror, mirrored)).flags, [0, 0]);
  peer.setFlags('mirror', mirrored, ['\\Seen', '\\Flagged']);
  await scan('mirror', 'history');
  assert.deepEqual((await item(mirror, mirrored)).flags, [1, 1], 'Sync follows a change made elsewhere');
  peer.setFlags('mirror', mirrored, ['\\Flagged']);
  await scan('mirror', 'flags');
  assert.deepEqual((await item(mirror, mirrored)).flags, [0, 1]);
  assert.deepEqual(peer.errors, []);
});
