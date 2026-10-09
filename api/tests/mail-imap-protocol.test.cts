import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const net = (require('node:net') as typeof import('node:net'));
const { connectImap } = require('../dist/src/services/mail-imap-client');
const { guardImapConnection, closeImapConnection } = require('../dist/src/services/mail-imap-guard');
const { selectMailbox, fetchMetadataWindow, setFlag, nativeMove } = require('../dist/src/services/mail-engine/transport');

// Loopback protocol peer, not a mocked imap object: ImapFlow parser/queue ->
// socket -> tagged replies -> the production guard/transport.
async function peer({ conditional = true }: FixtureValue = {}) {
  const commands: FixtureValue[] = [], sockets = new Set<import('node:net').Socket>();
  const messages = new Map([
    [103, { flags: new Set<FixtureValue>(['$custom']), modseq: '295' }],
    [104, { flags: new Set<FixtureValue>(['\\Seen', '\\Flagged']), modseq: '111' }],
  ]);
  let rejectNext = false, makeTargetDuringConflict = false, modifiedAsNo = false, badNext = false;
  let holdStore = false, heldReply: FixtureValue;
  const server: FixtureValue = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('* OK [CAPABILITY IMAP4rev1] Local fixture ready\r\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      let newline;
      while ((newline = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 2);
        const match = /^([0-9A-F]+) (.+)$/.exec(line);
        if (!match) continue;
        const [, tag, cmd] = match;
        commands.push(cmd);
        const ok = (text = 'complete') => socket.write(`${tag} OK ${text}\r\n`);
        if (cmd === 'CAPABILITY') {
          socket.write(`* CAPABILITY IMAP4rev1${conditional ? ' CONDSTORE ENABLE' : ''} MOVE UIDPLUS\r\n`); ok();
        } else if (cmd.startsWith('LOGIN ')) ok();
        else if (cmd === 'ENABLE CONDSTORE') { socket.write('* ENABLED CONDSTORE\r\n'); ok(); }
        else if (cmd.startsWith('LIST ')) { socket.write('* LIST (\\Noselect) "/" ""\r\n'); ok(); }
        else if (cmd.startsWith('LSUB ')) ok();
        else if (cmd === 'SELECT INBOX') {
          socket.write('* FLAGS (\\Seen \\Flagged)\r\n* 2 EXISTS\r\n* OK [UIDVALIDITY 9] valid\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged \\*)] flags\r\n');
          ok('[READ-WRITE] selected');
        } else if (/^UID SEARCH UID \d+$/.test(cmd)) {
          const uid = Number(cmd.split(' ').at(-1));
          socket.write(`* SEARCH${messages.has(uid) ? ` ${uid}` : ''}\r\n`); ok();
        } else if (/^UID FETCH \d+(?::\d+)? /.test(cmd)) {
          const uid = Number((/^UID FETCH (\d+)/.exec as FixtureValue)(cmd)[1]);
          const message = messages.get(uid);
          if (message) {
            const flags = [...message.flags].join(' ');
            socket.write(`* ${uid === 103 ? 1 : 2} FETCH (UID ${uid} FLAGS (${flags})${conditional ? ` MODSEQ (${message.modseq})` : ''} INTERNALDATE "29-Sep-2026 12:00:00 +0000")\r\n`);
          }
          ok();
        } else if (cmd.startsWith('UID STORE ')) {
          const parsed = /^UID STORE (\d+) (?:\(UNCHANGEDSINCE (\d+)\) )?([+-])FLAGS\.SILENT \((\\Seen|\\Flagged)\)$/.exec(cmd);
          if (!parsed) { socket.write(`${tag} BAD malformed STORE\r\n`); continue; }
          const [, uidText, expected, direction, flag] = parsed;
          const uid = Number(uidText), message = messages.get(uid);
          if (!message || (conditional && !expected)) { socket.write(`${tag} BAD unsafe STORE\r\n`); continue; }
          if (badNext) {
            badNext = false;
            socket.write(`${tag} BAD rejected by provider\r\n`);
          } else if (rejectNext || (expected && expected !== message.modseq)) {
            rejectNext = false;
            if (makeTargetDuringConflict) {
              if (direction === '+') message.flags.add(flag); else message.flags.delete(flag);
              message.modseq = '296';
            }
            if (modifiedAsNo) socket.write(`${tag} NO [MODIFIED ${uid}] conditional write rejected\r\n`);
            else ok(`[MODIFIED ${uid}] conditional write rejected`);
          } else {
            if (direction === '+') message.flags.add(flag); else message.flags.delete(flag);
            message.modseq = String(BigInt(message.modseq) + 1n);
            if (holdStore) heldReply = ok;
            else ok();
          }
        } else if (/^UID MOVE 103 "Filed"$/.test(cmd)) ok('[COPYUID 9 103 207] moved');
        else if (cmd === 'LOGOUT') { socket.write('* BYE goodbye\r\n'); ok(); }
        else socket.write(`${tag} BAD unexpected command\r\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    commands, messages,
    rejectNext({ targetChanged = false, no = false }: FixtureValue = {}) {
      rejectNext = true; makeTargetDuringConflict = targetChanged; modifiedAsNo = no;
    },
    badNext() { badNext = true; },
    holdStore() { holdStore = true; },
    releaseStore() { heldReply?.(); },
    async connect(options?: FixtureValue) {
      const connection = guardImapConnection(await connectImap({ imap: {
        host: '127.0.0.1', port: server.address().port, user: 'fixture', password: 'fixture',
        tls: false, keepalive: false, connTimeout: 1000, authTimeout: 1000, socketTimeout: 1000,
      } }), options);
      return connection;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function readSource(connection: FixtureValue, box: FixtureValue) {
  const window = await fetchMetadataWindow(connection, { folder: 'INBOX', uidvalidity: box.uidvalidity, startUid: 103, endUid: 103 });
  return window.items[0];
}
// The durable worker's order (operations.applyFlag): read the source, fence the
// dispatch, send one UID-scoped delta, and read back only after a clean reply.
async function changeFlag(connection: FixtureValue, action: FixtureValue, value: FixtureValue, dispatches: FixtureValue) {
  const box = await selectMailbox(connection, { folder: 'INBOX' });
  const before = await readSource(connection, box);
  const modseq = connection.enabled.has('CONDSTORE') ? before.modseq : null;
  const result = await setFlag(connection, { uid: 103, uidvalidity: box.uidvalidity, sourceFolder: 'INBOX',
    flag: action === 'read' ? '\\Seen' : '\\Flagged', value: Boolean(value), modseq },
  { beforeDispatch: async () => dispatches.push(modseq) });
  const after = result.completion === 'ok' && !result.modified ? await readSource(connection, box) : null;
  return { ...result, after };
}
const fetches = (fixture: FixtureValue) => fixture.commands.filter((cmd: FixtureValue) => cmd.startsWith('UID FETCH ')).length;

test('real library serializes four UID-scoped conditional flag deltas and readback retains unrelated flags', async t => {
  const fixture: FixtureValue = await peer(); t.after(() => fixture.close());
  const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
  const dispatches: FixtureValue[] = [];
  for (const [action, value, base, verb, flag] of [
    ['read', 1, 0, '+', '\\Seen'], ['star', 1, 0, '+', '\\Flagged'],
    ['read', 0, 1, '-', '\\Seen'], ['star', 0, 1, '-', '\\Flagged'],
  ] as const) {
    const result = await changeFlag(connection, action, value, dispatches);
    assert.equal(result.completion, 'ok'); assert.equal(result.modified, false);
    assert.equal(result.after.flags.includes(flag), Boolean(value));
    const command = fixture.commands.filter((cmd: FixtureValue) => cmd.startsWith('UID STORE ')).at(-1);
    assert.equal(command, `UID STORE 103 (UNCHANGEDSINCE ${dispatches.at(-1)}) ${verb}FLAGS.SILENT (${flag})`);
  }
  assert.deepEqual(dispatches, ['295', '296', '297', '298']);
  assert.deepEqual([...fixture.messages.get(103).flags], ['$custom']);
  assert.deepEqual([...fixture.messages.get(104).flags].sort(), ['\\Flagged', '\\Seen']);
  assert.equal(fixture.commands.filter((cmd: FixtureValue) => cmd.startsWith('UID STORE ')).length, 4);
  assert(!fixture.commands.some((cmd: FixtureValue) => /\b(?:COPY|EXPUNGE)\b|(?:^| )FLAGS\.SILENT \(/.test(cmd)));
});

test('tagged OK MODIFIED is a conflict even if another actor reached the target before readback', async t => {
  const fixture: FixtureValue = await peer(); t.after(() => fixture.close());
  const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
  fixture.rejectNext({ targetChanged: true });
  const dispatches: FixtureValue[] = [];
  const result = await changeFlag(connection, 'read', 1, dispatches);
  assert.equal(result.modified, true); assert.equal(result.after, null);
  assert.deepEqual(dispatches, ['295']);
  assert.equal(fetches(fixture), 1, 'Do not mistake a conflicting third-party change for our successful write');
  assert.equal(fixture.commands.filter((cmd: FixtureValue) => cmd.startsWith('UID STORE ')).length, 1);
  assert(fixture.messages.get(103).flags.has('\\Seen'));
});

test('tagged NO MODIFIED also reports a conflict instead of treating it as a transient error', async t => {
  const fixture: FixtureValue = await peer(); t.after(() => fixture.close());
  const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
  fixture.rejectNext({ no: true });
  const result = await changeFlag(connection, 'star', 1, []);
  assert.equal(result.modified, true); assert.equal(result.completion, 'no');
  assert(!fixture.messages.get(103).flags.has('\\Flagged'));
});

test('queued conditional requests associate MODIFIED only with their own response', async t => {
  const fixture: FixtureValue = await peer(); t.after(() => fixture.close());
  const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
  const box = await selectMailbox(connection, { folder: 'INBOX' });
  fixture.rejectNext();
  const change = (flag: FixtureValue) => setFlag(connection, { uid: 103, uidvalidity: box.uidvalidity, sourceFolder: 'INBOX', flag, value: true, modseq: '295' },
    { beforeDispatch: async () => {} });
  const [first, second] = await Promise.all([change('\\Seen'), change('\\Flagged')]);
  assert.deepEqual([first.completion, first.modified], ['ok', true]);
  assert.deepEqual([second.completion, second.modified], ['ok', false]);
  assert(!fixture.messages.get(103).flags.has('\\Seen'));
  assert(fixture.messages.get(103).flags.has('\\Flagged'));
  assert.deepEqual(fixture.commands.filter((cmd: FixtureValue) => cmd.startsWith('UID STORE ')), [
    'UID STORE 103 (UNCHANGEDSINCE 295) +FLAGS.SILENT (\\Seen)',
    'UID STORE 103 (UNCHANGEDSINCE 295) +FLAGS.SILENT (\\Flagged)',
  ]);
});

test('tagged BAD preserves the provider protocol error and cannot confirm a local change', async t => {
  const fixture: FixtureValue = await peer(); t.after(() => fixture.close());
  const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
  fixture.badNext();
  const dispatches: FixtureValue[] = [];
  const result = await changeFlag(connection, 'read', 1, dispatches);
  assert.equal(result.completion, 'bad'); assert.equal(result.modified, false); assert.equal(result.after, null);
  assert.deepEqual(dispatches, ['295']);
  assert.equal(fetches(fixture), 1);
  assert(!fixture.messages.get(103).flags.has('\\Seen'));
});

test('large MODSEQ is kept as a decimal string on the actual wire', async t => {
  const fixture: FixtureValue = await peer(); t.after(() => fixture.close());
  fixture.messages.get(103).modseq = '9007199254740993123';
  const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
  const dispatches: FixtureValue[] = [];
  const result = await changeFlag(connection, 'star', 1, dispatches);
  assert.equal(result.completion, 'ok'); assert(result.after.flags.includes('\\Flagged'));
  assert.deepEqual(dispatches, ['9007199254740993123']);
  assert(fixture.commands.includes('UID STORE 103 (UNCHANGEDSINCE 9007199254740993123) +FLAGS.SILENT (\\Flagged)'));
});

test('native MOVE returns COPYUID destination and never triggers COPY/EXPUNGE', async t => {
  const fixture = await peer(); t.after(() => fixture.close());
  const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
  const box = await selectMailbox(connection, { folder: 'INBOX' });
  const result = await nativeMove(connection, { uid: 103, uidvalidity: box.uidvalidity, sourceFolder: 'INBOX', targetFolder: 'Filed' },
    { beforeDispatch: async () => {} });
  assert.equal(result.completion, 'ok'); assert.equal(result.mappingStatus, 'valid');
  assert.deepEqual(result.mapping, { uidvalidity: 9, sourceUids: [103], destinationUids: [207] });
  assert(fixture.commands.includes('UID MOVE 103 "Filed"'));
  assert(!fixture.commands.some(cmd => /\b(?:COPY|EXPUNGE)\b/.test(cmd)));
});

test('non-CONDSTORE server sends only UID-scoped delta, not SET FLAGS', async t => {
  const fixture: FixtureValue = await peer({ conditional: false }); t.after(() => fixture.close());
  const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
  const result = await changeFlag(connection, 'read', 1, []);
  assert.equal(result.completion, 'ok'); assert(result.after.flags.includes('\\Seen'));
  assert(fixture.commands.includes('UID STORE 103 +FLAGS.SILENT (\\Seen)'));
  assert.deepEqual([...fixture.messages.get(103).flags].sort(), ['$custom', '\\Seen']);
});

test('invalid UID/flag/modseq fail closed without dispatching wire commands', async t => {
  const fixture = await peer(); t.after(() => fixture.close());
  const connection = await fixture.connect(); t.after(() => closeImapConnection(connection));
  const box = await selectMailbox(connection, { folder: 'INBOX' });
  for (const [uid, flag, modseq, expected] of [[0, '\\Seen', '295', /Invalid UID/], [103, '\\Deleted', '295', /Unsupported flag/],
    [103, '\\Seen', '2) +FLAGS.SILENT (\\Deleted)', /Invalid MODSEQ/]] as const) {
    await assert.rejects(setFlag(connection, { uid, uidvalidity: box.uidvalidity, sourceFolder: 'INBOX', flag, value: true, modseq },
      { beforeDispatch: async () => assert.fail('invalid input must not reach the dispatch fence') }), expected);
  }
  assert(!fixture.commands.some(cmd => cmd.startsWith('UID STORE ')));
});

test('timed-out conditional wire command settles once as lost; late reply cannot confirm local state', async t => {
  const fixture = await peer(); t.after(() => fixture.close());
  const connection = await fixture.connect({ timeoutMs: 300 }); t.after(() => closeImapConnection(connection));
  const box = await selectMailbox(connection, { folder: 'INBOX' });
  const socket = connection.socket;
  fixture.holdStore();
  const result = await setFlag(connection, { uid: 103, uidvalidity: box.uidvalidity, sourceFolder: 'INBOX', flag: '\\Seen', value: true, modseq: '295' },
    { beforeDispatch: async () => {} });
  assert.deepEqual([result.transmission, result.completion, result.modified], ['possible', 'lost', false]);
  assert(fixture.commands.includes('UID STORE 103 (UNCHANGEDSINCE 295) +FLAGS.SILENT (\\Seen)'));
  assert.equal(socket.destroyed, true);
  fixture.releaseStore();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(fetchMetadataWindow(connection, { folder: 'INBOX', uidvalidity: box.uidvalidity, startUid: 103, endUid: 103 }));
  assert.equal(fixture.commands.filter(cmd => cmd.startsWith('UID FETCH ')).length, 0, 'no readback can follow a lost acknowledgement');
});

test('aborted conditional wire command cannot dispatch after cancellation', async t => {
  const fixture = await peer(); t.after(() => fixture.close());
  const controller = new AbortController();
  const connection = await fixture.connect({ signal: controller.signal }); t.after(() => closeImapConnection(connection));
  const box = await selectMailbox(connection, { folder: 'INBOX' });
  fixture.holdStore();
  const request = { uid: 103, uidvalidity: box.uidvalidity, sourceFolder: 'INBOX', flag: '\\Seen', value: true, modseq: '295' };
  const attempt = setFlag(connection, request, { beforeDispatch: async () => {}, signal: controller.signal });
  for (let i = 0; i < 50 && !fixture.commands.some(cmd => cmd.startsWith('UID STORE ')); i++) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  const result = await attempt;
  assert.deepEqual([result.transmission, result.completion], ['possible', 'lost']);
  fixture.releaseStore();
  await new Promise(resolve => setImmediate(resolve));
  const previous = fixture.commands.length;
  await assert.rejects(setFlag(connection, { ...request, value: false }, { beforeDispatch: async () => {} }));
  await assert.rejects(selectMailbox(connection, { folder: 'INBOX' }), { code: 'MAIL_SYNC_CANCELLED' });
  assert.equal(fixture.commands.length, previous);
});
