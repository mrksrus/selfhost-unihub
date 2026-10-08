'use strict';
// IMAP IDLE over a real loopback socket: the supervisor's session EXAMINEs
// INBOX, enters IDLE, and an untagged `* N EXISTS` pushed by the peer becomes a
// durable 'recent' job through ordinary admission. The wire never carries a
// fetching or mutating command.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
process.env.ENCRYPTION_KEY = 'mail-idle-protocol-test-only-key';
const { createIdleSupervisor } = require('../dist/src/services/mail-idle');
const { connectImap } = require('../dist/src/services/mail-imap-client');
const control = require('../dist/src/services/mail-sync-control');
const { getDb, setDb } = require('../dist/src/state');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await wait(5);
  }
}

// Commands this session may put on the wire: login negotiation, the read-only
// LIST/LSUB ImapFlow issues to resolve the delimiter and the mailbox before
// opening it, EXAMINE, IDLE, the DONE that ends it, keepalive and logout.
const ALLOWED = /^(CAPABILITY|LOGIN|AUTHENTICATE|ID|ENABLE|NAMESPACE|LIST|LSUB|EXAMINE|IDLE|DONE|NOOP|LOGOUT)\b/;

function peer() {
  const commands = [], sockets = new Set();
  let idling = null;
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK synthetic peer\r\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString('latin1');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (line === 'DONE') {
          commands.push('DONE');
          if (idling) { socket.write(`${idling} OK IDLE terminated\r\n`); idling = null; }
          continue;
        }
        const match = /^([0-9A-Za-z]+) (.*)$/.exec(line);
        if (!match) continue;
        const [, tag, cmd] = match;
        commands.push(cmd);
        if (cmd === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1 IDLE UIDPLUS\r\n');
        if (cmd.startsWith('EXAMINE')) {
          socket.write('* 3 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 4] ok\r\n* FLAGS (\\Seen)\r\n');
          socket.write(`${tag} OK [READ-ONLY] done\r\n`);
          continue;
        }
        if (cmd === 'IDLE') { idling = tag; socket.write('+ idling\r\n'); continue; }
        if (cmd === 'LOGOUT') socket.write('* BYE\r\n');
        socket.write(`${tag} OK done\r\n`);
      }
    });
  });
  return {
    commands,
    push: text => { for (const socket of sockets) socket.write(text); },
    get idling() { return !!idling; },
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}

test('`* N EXISTS` during IDLE enqueues a durable recent job for the account INBOX', async t => {
  const imap = peer();
  const port = await imap.listen();
  t.after(() => imap.close());
  const old = getDb(); t.after(() => setDb(old));
  setDb({ execute: async query => {
    if (query.includes('LEFT JOIN mail_engine_accounts')) return [[{ user_id: 'owner', sync_mode: 'sync' }]];
    if (query.includes('FROM user_settings')) return [[]];
    if (query.includes('FROM backup_restore_jobs')) return [[]];
    assert.fail(`Unexpected SQL: ${query}`);
  } });
  const jobs = [];
  const scheduler = { start: async () => {}, enqueue: async input => { jobs.push(input); return { id: `job-${jobs.length}` }; } };
  const supervisor = createIdleSupervisor({ debounceMs: 20, log: () => {}, pollMs: 60 * 60 * 1000,
    listEligible: async () => [{ accountId: 'acct-1', userId: 'owner', syncMode: 'sync', mailboxId: 'inbox-box',
      remoteName: 'INBOX', fingerprint: 'fp' }],
    connect: () => connectImap({ imap: { host: '127.0.0.1', port, user: 'fixture', password: 'fixture-secret', tls: false,
      keepalive: true, connTimeout: 2000, authTimeout: 2000, idleRestartMs: 60 * 1000 } }),
    enqueue: input => control.enqueueIdleRefresh(input, { scheduler }) });
  t.after(() => supervisor.stop());
  await supervisor.start();
  await until(() => imap.idling && supervisor.isHealthy('acct-1'));
  await until(() => jobs.length === 1); // catch-up refresh after EXAMINE
  imap.push('* 4 EXISTS\r\n');
  await until(() => jobs.length === 2);
  assert.deepEqual(jobs[1], { userId: 'owner', accountId: 'acct-1', mailboxId: 'inbox-box', kind: 'recent', priority: 10 });
  assert.ok(imap.commands.some(cmd => cmd.startsWith('EXAMINE')), 'INBOX is opened read-only');
  assert.ok(!imap.commands.some(cmd => cmd.startsWith('SELECT')));
  supervisor.stop();
  await wait(30);
  const unexpected = imap.commands.filter(cmd => !ALLOWED.test(cmd));
  assert.deepEqual(unexpected, [], 'no FETCH, STORE, MOVE, EXPUNGE, APPEND, CREATE or SELECT on the IDLE session');
  assert.equal(supervisor.isHealthy('acct-1'), false);
});

test('IDLE is re-issued after maxIdleTime on the same session (RFC 2177 re-IDLE)', async t => {
  const imap = peer();
  const port = await imap.listen();
  t.after(() => imap.close());
  let connects = 0;
  const supervisor = createIdleSupervisor({ debounceMs: 20, log: () => {}, pollMs: 60 * 60 * 1000,
    listEligible: async () => [{ accountId: 'acct-1', userId: 'owner', syncMode: 'sync', mailboxId: 'inbox-box',
      remoteName: 'INBOX', fingerprint: 'fp' }],
    connect: () => { connects++; return connectImap({ imap: { host: '127.0.0.1', port, user: 'fixture', password: 'fixture-secret',
      tls: false, keepalive: true, connTimeout: 2000, authTimeout: 2000, idleRestartMs: 100 } }); },
    enqueue: async () => {} });
  t.after(() => supervisor.stop());
  await supervisor.start();
  await until(() => imap.commands.filter(cmd => cmd === 'IDLE').length >= 3);
  assert.ok(imap.commands.filter(cmd => cmd === 'DONE').length >= 2);
  assert.equal(connects, 1, 'restarting IDLE needs no reconnect');
  assert.equal(supervisor.isHealthy('acct-1'), true);
});
