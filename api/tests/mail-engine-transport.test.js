'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { connectImap } = require('../src/services/mail-imap-client');
const { guardImapConnection, closeImapConnection } = require('../src/services/mail-imap-guard');
const { selectMailbox, fetchMetadataWindow, fetchRawMessage, setFlag, nativeMove } = require('../src/services/mail-engine/transport');

async function peer({ move = true, condstore = true, reply = 'tagged', uidvalidity = 9, raw = Buffer.from([0, 255, 128, 13, 10, 0x3d, 0x20, 0x0a]), stall = false, metadata = 'normal', highest = '9007199254740993123', itemModseq = '9007199254740993123' } = {}) {
  const commands = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.write('* OK local strict peer\r\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString('latin1');
      let i;
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const m = /^([0-9A-F]+) (.*)$/.exec(line);
        if (!m) continue;
        const [, tag, cmd] = m; commands.push(cmd);
        const ok = (body = 'done') => socket.write(`${tag} OK ${body}\r\n`);
        if (cmd === 'CAPABILITY') { socket.write(`* CAPABILITY IMAP4rev1 UIDPLUS${move ? ' MOVE' : ''}${condstore ? ' CONDSTORE ENABLE' : ''}\r\n`); ok(); }
        else if (cmd.startsWith('LOGIN ')) ok();
        else if (cmd === 'ENABLE CONDSTORE') { socket.write('* ENABLED CONDSTORE\r\n'); ok(); }
        else if (cmd.startsWith('LIST ')) { socket.write('* LIST (\\Noselect) "/" ""\r\n'); ok(); }
        else if (cmd.startsWith('LSUB ')) ok();
        else if (/^(SELECT|EXAMINE) "?(INBOX|Filed)"?$/.test(cmd)) {
          socket.write(`* FLAGS (\\Seen \\Flagged)\r\n* 2 EXISTS\r\n* OK [UIDVALIDITY ${uidvalidity}] valid\r\n* OK [UIDNEXT 106] next\r\n* OK [HIGHESTMODSEQ ${highest}] highest\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged)] flags\r\n`);
          ok(`[${cmd.startsWith('EXAMINE') ? 'READ-ONLY' : 'READ-WRITE'}] selected`);
        } else if (/^UID FETCH (\d+):(\d+) /.test(cmd)) {
          assert.match(cmd, /^UID FETCH \d+:\d+ \(UID FLAGS INTERNALDATE MODSEQ\)$/);
          if (metadata !== 'empty') {
            const uid = metadata === 'wrong' ? 106 : 103;
            socket.write(`* 1 FETCH (UID ${uid} FLAGS (\\Seen $custom) MODSEQ (${itemModseq}) INTERNALDATE "29-Sep-2026 12:00:00 +0000")\r\n`);
            if (metadata === 'duplicate') socket.write(`* 2 FETCH (UID ${uid} FLAGS (\\Seen) MODSEQ (9007199254740993123) INTERNALDATE "29-Sep-2026 12:00:00 +0000")\r\n`);
          }
          ok();
        } else if (/^UID FETCH 103 /.test(cmd)) {
          assert.match(cmd, /^UID FETCH 103 \(UID BODY\.PEEK\[\] MODSEQ\)$/);
          // Announce a body above the 32 MiB ceiling and never send it.
          if (metadata === 'oversized') { socket.write('* 1 FETCH (UID 103 BODY[] {33554433}\r\n'); continue; }
          socket.write(Buffer.concat([Buffer.from(`* 1 FETCH (UID 103 FLAGS (\\Seen) MODSEQ (9007199254740993123) INTERNALDATE "29-Sep-2026 12:00:00 +0000" BODY[] {${raw.length}}\r\n`, 'ascii'), raw, Buffer.from(')\r\n', 'ascii')])); ok();
        } else if (cmd.startsWith('UID MOVE')) {
          assert.equal(cmd, 'UID MOVE 103 "Filed"');
          if (stall) continue;
          const code = { tagged: '9 103 207', untagged: '9 103 207', both: '9 103 207', conflict: '9 103 207', mismatch: '9 104 207', malformed: '9 103 207:208', absent: null, no: '9 103 207', lost: '9 103 207' }[reply];
          if (reply === 'untagged' || reply === 'both' || reply === 'conflict') {
            socket.write(`* OK [COPYUID ${code}] moved\r\n* 1 EXPUNGE\r\n`);
          }
          if (reply === 'conflict') ok('[COPYUID 9 103 208] moved');
          else if (reply === 'no') socket.write(`${tag} NO [COPYUID ${code}] some moved\r\n`);
          else if (reply === 'lost') socket.destroy();
          else if (reply === 'tagged' || reply === 'mismatch' || reply === 'malformed') ok(`[COPYUID ${code}] moved`);
          else ok();
        } else if (cmd.startsWith('UID STORE')) {
          assert.match(cmd, /^UID STORE 103 \(UNCHANGEDSINCE 9007199254740993123\) [+-]FLAGS\.SILENT \(\\Seen\)$/);
          if (reply === 'modified-no') socket.write(`${tag} NO [MODIFIED 103] conflict\r\n`);
          else if (reply === 'modified-ok') ok('[MODIFIED 103] conflict');
          else if (!stall) ok();
        } else if (cmd === 'LOGOUT') { socket.write('* BYE goodbye\r\n'); ok(); }
        else { assert.fail(`Unexpected IMAP command: ${cmd}`); }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { commands, async connect({ timeoutMs = 1500, signal } = {}) {
    const connection = guardImapConnection(await connectImap({ imap: {
      host: '127.0.0.1', port: server.address().port, user: 'fixture', password: 'fixture',
      tls: false, keepalive: false, connTimeout: 1000, authTimeout: 1000, socketTimeout: 1000,
    } }), { timeoutMs, signal });
    return connection;
  }, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
async function setup(t, options, guarded) {
  const fixture = await peer(options); t.after(() => fixture.close());
  const connection = await fixture.connect(guarded); t.after(() => closeImapConnection(connection));
  const box = await selectMailbox(connection, { folder: 'INBOX' });
  return { fixture, connection, box };
}
test('an out-of-spec HIGHESTMODSEQ/MODSEQ (iCloud-style 0) degrades to no CONDSTORE instead of failing sync', async t => {
  const { connection, box } = await setup(t, { highest: '0', itemModseq: '0' });
  assert.equal(box.highestmodseq, null);
  assert.equal(box.capabilities.condstore, false);
  const result = await fetchMetadataWindow(connection, { folder: 'INBOX', uidvalidity: 9, startUid: 102, endUid: 105 });
  assert.deepEqual(result.items, [{ uid: 103, flags: ['\\Seen', '$custom'], modseq: null, gmailMsgId: null, internalDate: '2026-09-29T12:00:00.000Z' }]);
});
const moveRequest = { uid: 103, uidvalidity: 9, sourceFolder: 'INBOX', targetFolder: 'Filed' };
test('finite UID metadata uses real UID FETCH and keeps 64-bit MODSEQ lossless', async t => {
  const { fixture, connection, box } = await setup(t);
  assert.equal(box.highestmodseq, '9007199254740993123');
  const result = await fetchMetadataWindow(connection, { folder: 'INBOX', uidvalidity: 9, startUid: 102, endUid: 105 });
  assert.deepEqual(result.items, [{ uid: 103, flags: ['\\Seen', '$custom'], modseq: '9007199254740993123', gmailMsgId: null, internalDate: '2026-09-29T12:00:00.000Z' }]);
  assert.equal(result.complete, true);
  assert(fixture.commands.includes('UID FETCH 102:105 (UID FLAGS INTERNALDATE MODSEQ)'));
});
test('raw BODY.PEEK[] preserves non-UTF8 octets, NUL and CRLF as Buffer', async t => {
  const raw = Buffer.from([0, 255, 128, 13, 10, 0x3d, 0x20, 0x0a]);
  const { fixture, connection } = await setup(t, { raw });
  const result = await fetchRawMessage(connection, { folder: 'INBOX', uidvalidity: 9, uid: 103 });
  assert(Buffer.isBuffer(result.raw)); assert.deepEqual(result.raw, raw); assert.equal(result.bytes, raw.length);
  assert(fixture.commands.some(command => command.includes('BODY.PEEK[]')));
});
for (const reply of ['tagged', 'untagged', 'both', 'absent', 'malformed', 'mismatch', 'conflict', 'no']) {
  test(`actual-wire MOVE ${reply}: complete mapping or explicit uncertainty`, async t => {
    const { fixture, connection } = await setup(t, { reply });
    let fenced = 0;
    const result = await nativeMove(connection, moveRequest, { beforeDispatch: async () => { fenced++; } });
    assert.equal(fenced, 1);
    assert.equal(result.completion, reply === 'no' ? 'no' : 'ok');
    assert.equal(result.transmission, 'possible');
    assert.equal(result.mappingStatus, { absent: 'missing', mismatch: 'invalid', malformed: 'invalid', conflict: 'conflicting' }[reply] || 'valid');
    assert.deepEqual(result.mapping, ['absent', 'mismatch', 'malformed', 'conflict'].includes(reply) ? null :
      { uidvalidity: 9, sourceUids: [103], destinationUids: [207] });
    assert.deepEqual(fixture.commands.filter(cmd => /\b(?:MOVE|COPY|EXPUNGE)\b/.test(cmd)), ['UID MOVE 103 "Filed"']);
  });
}
test('native MOVE unsupported emits zero COPY/STORE/EXPUNGE commands', async t => {
  const { fixture, connection } = await setup(t, { move: false });
  const result = await nativeMove(connection, moveRequest, { beforeDispatch: () => assert.fail('unsupported must not dispatch') });
  assert.equal(result.transmission, 'not_sent'); assert.equal(result.completion, 'unsupported');
  assert(!fixture.commands.some(command => /\b(?:MOVE|COPY|STORE|EXPUNGE)\b/.test(command)));
});
test('MOVE lost acknowledgement after dispatch stays possible and cannot be replayed', async t => {
  const { fixture, connection } = await setup(t, { reply: 'lost' });
  const result = await nativeMove(connection, moveRequest, { beforeDispatch: async () => {} });
  assert.equal(result.completion, 'lost'); assert.equal(result.transmission, 'possible');
  assert.equal(fixture.commands.filter(command => command.startsWith('UID MOVE')).length, 1);
});
for (const reply of ['modified-ok', 'modified-no', 'tagged']) {
  test(`actual-wire conditional STORE ${reply} retains MODIFIED and correctly ordered decimal`, async t => {
    const { fixture, connection } = await setup(t, { reply });
    const result = await setFlag(connection, { uid: 103, uidvalidity: 9, sourceFolder: 'INBOX', flag: '\\Seen', value: true, modseq: '9007199254740993123' }, { beforeDispatch: async () => {} });
    assert.equal(result.modified, reply !== 'tagged');
    assert.equal(result.completion, reply === 'modified-no' ? 'no' : 'ok');
    assert(fixture.commands.includes('UID STORE 103 (UNCHANGEDSINCE 9007199254740993123) +FLAGS.SILENT (\\Seen)'));
  });
}
test('invalid inputs, wrong epoch and rejected fence send no mutation', async t => {
  const { fixture, connection } = await setup(t);
  await assert.rejects(nativeMove(connection, { ...moveRequest, uidvalidity: 10 }, { beforeDispatch: async () => {} }), /identity/);
  await assert.rejects(nativeMove(connection, { ...moveRequest, uid: 0 }, { beforeDispatch: async () => {} }), /Invalid UID/);
  await assert.rejects(nativeMove(connection, moveRequest), /durable beforeDispatch fence/);
  await assert.rejects(nativeMove(connection, moveRequest, { beforeDispatch: () => { throw new Error('fence failed'); } }), /fence failed/);
  await assert.rejects(fetchMetadataWindow(connection, { folder: 'INBOX', uidvalidity: 9, startUid: 1, endUid: 500 }), /budget/);
  assert(!fixture.commands.some(cmd => cmd.startsWith('UID MOVE')));
});
test('malformed out-of-range metadata cannot be reported as covered', async t => {
  const { connection } = await setup(t, { metadata: 'wrong' });
  await assert.rejects(fetchMetadataWindow(connection, { folder: 'INBOX', uidvalidity: 9, startUid: 102, endUid: 105 }), /out-of-range/);
});
test('empty UID range is an explicitly completed finite window', async t => {
  const { connection } = await setup(t, { metadata: 'empty' });
  const result = await fetchMetadataWindow(connection, { folder: 'INBOX', uidvalidity: 9, startUid: 102, endUid: 105 });
  assert.deepEqual(result.items, []); assert.equal(result.complete, true);
});
test('raw fetch byte ceiling aborts transport rather than publishing partial Buffer', async t => {
  const { connection } = await setup(t);
  await assert.rejects(fetchRawMessage(connection, { folder: 'INBOX', uidvalidity: 9, uid: 103, maxBytes: 3 }), { code: 'MAIL_IMAP_LIMIT' });
});
test('read-only mailbox uses EXAMINE and cannot dispatch MOVE', async t => {
  const { fixture, connection } = await setup(t);
  const box = await selectMailbox(connection, { folder: 'Filed', readOnly: true });
  assert.equal(box.readOnly, true);
  assert(fixture.commands.includes('EXAMINE Filed'));
  await assert.rejects(nativeMove(connection, { ...moveRequest, sourceFolder: 'Filed', targetFolder: 'INBOX' }, { beforeDispatch: async () => {} }), /identity\/permissions/);
  assert(!fixture.commands.some(cmd => cmd.startsWith('UID MOVE')));
});
test('MOVE deadline retains possible transmission; late reply cannot confirm', async t => {
  const { fixture, connection } = await setup(t, { stall: true }, { timeoutMs: 450 });
  const result = await nativeMove(connection, moveRequest, { beforeDispatch: async () => {} });
  assert.equal(result.completion, 'lost'); assert.equal(result.mappingStatus, 'missing');
  assert.equal(fixture.commands.filter(cmd => cmd.startsWith('UID MOVE')).length, 1);
});
test('aborted in-flight MOVE closes the connection and preserves uncertain transmission', async t => {
  const { fixture, connection } = await setup(t, { stall: true });
  const controller = new AbortController();
  const socket = connection.socket;
  const attempt = nativeMove(connection, moveRequest, { beforeDispatch: async () => {}, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fixture.commands.filter(cmd => cmd.startsWith('UID MOVE')).length, 1);
  controller.abort();
  const result = await attempt;
  assert.equal(result.transmission, 'possible'); assert.equal(result.completion, 'lost');
  assert.equal(socket.destroyed, true);
  assert.equal(connection.isClosed, true);
});
test('capability downgrade before fenced MOVE cannot enter library fallback', async t => {
  const { fixture, connection } = await setup(t);
  const result = await nativeMove(connection, moveRequest, { beforeDispatch: async () => {
    connection.capabilities.delete('MOVE');
  } });
  assert.equal(result.transmission, 'not_sent'); assert.equal(result.completion, 'unsupported');
  assert(!fixture.commands.some(cmd => /\b(?:MOVE|COPY|STORE|EXPUNGE)\b/.test(cmd)));
});
test('duplicate metadata UID is rejected; no partial window reported complete', async t => {
  const { connection } = await setup(t, { metadata: 'duplicate' });
  await assert.rejects(fetchMetadataWindow(connection, { folder: 'INBOX', uidvalidity: 9, startUid: 102, endUid: 105 }), /duplicate/);
});
test('a literal announced above the raw ceiling fails before it is buffered and closes the session', async t => {
  const { connection } = await setup(t, { metadata: 'oversized' });
  await assert.rejects(fetchRawMessage(connection, { folder: 'INBOX', uidvalidity: 9, uid: 103 }), { code: 'MAIL_IMAP_LIMIT' });
  assert.equal(connection.isClosed, true);
  await assert.rejects(selectMailbox(connection, { folder: 'INBOX' }), { code: 'MAIL_IMAP_LIMIT' });
});
