import type { Socket } from 'node:net';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const net = require('node:net') as typeof import('node:net');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { chatPeople } = require('./helpers/chat.cts') as import('./helpers/chat.cts').ChatHelpers;

interface Frame { opcode: number; data: Buffer }

// A call's sound through UniHub, through the real request handler: Alex's
// calling device (Node's own WebSocket client) and Blair's answering desk (a
// raw socket that writes frames byte by byte where needed) pass frames both
// ways; everyone else is refused before the handshake. The relay's checks
// and timers run by calling its tick, never by waiting for them.
test('chat call media: who may open the socket, frames both ways, the frame reader, limits, replacement, endings and revocation', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients, groups, call, enrol, signIn, api, until } = await chatPeople(t, pool);
  const { manager: alex, member: blair, stranger: casey } = clients;
  type Client = typeof alex;
  const { callMedia } = require('../dist/src/services/call-media') as typeof import('../src/services/call-media');
  const defaults = { ...callMedia.config };
  t.after(() => Object.assign(callMedia.config, defaults));
  const port = Number(new URL(api.origin).port);
  const media = (id: string) => `/api/chat/calls/${id}/media`;

  /** A client frame: masked unless told otherwise. */
  const frame = (payload: Buffer, { opcode = 2, fin = true, mask = true } = {}) => {
    const length = payload.length < 126 ? [payload.length] : [126, payload.length >> 8, payload.length & 255];
    const key = crypto.randomBytes(4);
    const body = mask ? Buffer.from(payload.map((byte, index) => byte ^ key[index & 3])) : payload;
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | length[0], ...length.slice(1)]), mask ? key : Buffer.alloc(0), body]);
  };
  /** A WebSocket handshake on a raw socket: the refusal's status and code, or the open socket and the server's frames. */
  const raw = (client: Client | null, path: string, headers: Record<string, string> = {}) => new Promise<{
    status: number; code: string | null; socket: Socket; frames: Frame[]; next(opcode?: number, timeout?: number): Promise<Frame | null>; closed(): Promise<number | null>;
  }>(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setNoDelay(true);
    socket.on('error', () => {});
    const request = { host: `127.0.0.1:${port}`, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': crypto.randomBytes(16).toString('base64'),
      'sec-websocket-version': '13', ...(client ? { cookie: client.cookie() } : {}), ...headers };
    socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(request).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`);
    let buffer = Buffer.alloc(0);
    let status = 0;
    let ended = false;
    let closeCode: number | null = null;
    const frames: Frame[] = [];
    const waiting: (() => void)[] = [];
    const wake = () => waiting.splice(0).forEach(resume => resume());
    const wait = () => new Promise<void>(resume => { waiting.push(resume); setTimeout(resume, 100); });
    const open = {
      get status() { return status; }, code: null, socket, frames,
      async next(opcode = 2, timeout = 5000) {
        const deadline = Date.now() + timeout;
        for (;;) {
          const found = frames.findIndex(item => item.opcode === opcode);
          if (found >= 0) return frames.splice(found, 1)[0];
          if (ended || Date.now() >= deadline) return null;
          await wait();
        }
      },
      async closed() {
        const deadline = Date.now() + 5000;
        while (closeCode === null && !ended && Date.now() < deadline) await wait();
        return closeCode;
      },
    };
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!status) {
        const at = buffer.indexOf('\r\n\r\n');
        if (at < 0) return;
        status = Number(buffer.subarray(9, 12).toString());
        buffer = buffer.subarray(at + 4);
        if (status === 101) resolve(open);
      }
      while (status === 101 && buffer.length >= 2) {
        let [length, offset] = [buffer[1] & 0x7f, 2];
        if (length === 126) [length, offset] = [buffer.readUInt16BE(2), 4];
        if (buffer.length < offset + length) break;
        const data = buffer.subarray(offset, offset + length);
        frames.push({ opcode: buffer[0] & 0x0f, data });
        if ((buffer[0] & 0x0f) === 0x8) closeCode = data.readUInt16BE(0);
        buffer = buffer.subarray(offset + length);
      }
      wake();
    });
    socket.on('close', () => {
      ended = true;
      wake();
      // The refusal's body, chunked.
      const text = buffer.toString();
      if (status !== 101) resolve({ ...open, status, code: text.includes('{') ? JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).code ?? null : null });
    });
    t.after(() => socket.destroy());
  });
  /** Node's own WebSocket client, as a browser would open it. */
  const browser = (client: Client, path: string) => new Promise<{ ws: WebSocket; got: Buffer[]; closed(): Promise<number> }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`,
      // Node's client takes headers, which the DOM type leaves out.
      { headers: { cookie: client.cookie() } } as unknown as string[]);
    ws.binaryType = 'arraybuffer';
    const got: Buffer[] = [];
    let code: number | null = null;
    ws.onmessage = event => got.push(Buffer.from(event.data as ArrayBuffer));
    ws.onclose = event => { code = event.code; };
    ws.onerror = () => reject(new Error('the socket did not open'));
    ws.onopen = () => resolve({ ws, got, closed: () => until(async () => code, value => value !== null, 'the socket closes') as Promise<number> });
    t.after(() => ws.close());
  });
  const refusal = async (client: Client | null, path: string, headers: Record<string, string> = {}) => {
    const reply = await raw(client, path, headers);
    return [reply.status, reply.code];
  };

  await enrol(blair);
  const laptop = await signIn('member');
  await enrol(laptop);
  const tablet = await signIn('member');
  await enrol(tablet, undefined, { waiting: true });
  await enrol(alex);
  await enrol(casey);

  // ── The check: any signed-in device, even one waiting for Chat; a plain GET says the Upgrade was lost ──
  const check = await raw(tablet, '/api/chat/calls/check');
  assert.deepEqual([check.status, await check.closed()], [101, 1000]);
  assert.deepEqual([(await tablet.request('GET', '/api/chat/calls/check')).status, (await tablet.request('GET', '/api/chat/calls/check')).body.code], [426, 'CHAT_CALL_MEDIA_UPGRADE']);
  assert.deepEqual(await refusal(null, '/api/chat/calls/check'), [401, null]);

  // ── Refused before any 101: a ringing call, a stranger, a device that is not an end, a waiting one, a foreign page, a bad handshake ──
  const first = (await call(alex, 'POST', '/api/chat/calls', { user_id: ids.member })).call.id as string;
  assert.deepEqual(await refusal(alex, media(first)), [409, 'CHAT_CALL_NOT_ACTIVE']);
  await call(blair, 'POST', `/api/chat/calls/${first}/answer`);
  assert.deepEqual(await refusal(casey, media(first)), [404, 'CHAT_CALL_NOT_FOUND']);
  assert.deepEqual(await refusal(laptop, media(first)), [403, 'CHAT_CALL_DEVICE']);
  assert.deepEqual(await refusal(tablet, media(first)), [403, 'CHAT_DEVICE_WAITING']);
  assert.deepEqual(await refusal(alex, media(first), { origin: 'https://elsewhere.example' }), [403, null]);
  assert.deepEqual(await refusal(alex, media(first), { 'sec-websocket-version': '8' }), [400, 'CHAT_CALL_MEDIA_INVALID']);
  assert.deepEqual(await refusal(alex, '/api/chat/calls/current'), [400, null], 'only an upgrade route takes a WebSocket');
  assert.deepEqual([(await alex.request('GET', media(first))).status, (await alex.request('GET', media(first))).body.code], [426, 'CHAT_CALL_MEDIA_UPGRADE']);
  assert.equal(callMedia.stats().sockets, 0);

  // ── Alex's calling device and Blair's answering desk: frames both ways, unchanged ──
  const caller = await browser(alex, media(first));
  let callee = await raw(blair, media(first), { origin: api.origin });
  assert.equal(callee.status, 101);
  const sound = crypto.randomBytes(90);
  caller.ws.send(sound);
  assert.deepEqual((await callee.next())?.data, sound);
  callee.socket.write(frame(sound));
  await until(async () => caller.got.length, length => length === 1, 'Alex hears Blair');
  assert.deepEqual(caller.got.shift(), sound);
  // A 16-bit length, a frame split at every byte, the last byte allowed.
  const long = crypto.randomBytes(1024);
  for (const byte of frame(long)) { callee.socket.write(Buffer.from([byte])); await new Promise(resolve => setImmediate(resolve)); }
  await until(async () => caller.got.length, length => length === 1, 'the split frame arrives whole');
  assert.deepEqual(caller.got.shift(), long);
  caller.ws.send(long);
  assert.deepEqual((await callee.next())?.data, long);
  // Pings both ways: the server answers one, and sends its own on each tick.
  callee.socket.write(frame(Buffer.from('hi'), { opcode: 0x9 }));
  assert.deepEqual((await callee.next(0xa))?.data, Buffer.from('hi'));
  await callMedia.tick();
  assert.ok(await callee.next(0x9), 'the tick pings');
  assert.deepEqual([callMedia.stats().sockets, caller.ws.readyState], [2, WebSocket.OPEN], 'the tick keeps both ends');

  // ── A second socket of the desk replaces the first; then the reader's refusals, each on a fresh socket ──
  for (const [bytes, code] of [
    [frame(sound, { mask: false }), 1002], [frame(sound, { opcode: 0x1 }), 1003], [frame(sound, { fin: false }), 1003],
    [frame(crypto.randomBytes(1025)), 1009], [frame(Buffer.alloc(0), { opcode: 0x3 }), 1002],
  ] as [Buffer, number][]) {
    const next = await raw(blair, media(first));
    assert.equal(await callee.closed(), 4000);
    callee = next;
    callee.socket.write(bytes);
    assert.equal(await callee.closed(), code);
    callee = await raw(blair, media(first));
  }
  assert.equal(callMedia.stats().sockets, 2);

  // ── A flooding end is cut to its bursts ──
  callee.socket.write(Buffer.concat(Array.from({ length: 500 }, () => frame(sound))));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(caller.got.length >= 100 && caller.got.length <= 160, `${caller.got.length} of 500 frames forwarded`);
  caller.got.length = 0;

  // ── An end that pings without reading gets no pile of pongs ──
  callee.socket.pause();
  const pings = Buffer.concat(Array.from({ length: 4000 }, () => frame(crypto.randomBytes(125), { opcode: 0x9 })));
  for (let index = 0; index < 48; index++) callee.socket.write(pings);
  await until(async () => callee.socket.writableLength, length => length === 0, 'Blair has sent every ping');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(callMedia.stats().buffered <= 2048, `the API holds ${callMedia.stats().buffered} bytes of pongs`);
  callee.socket.resume();

  // ── A receiver that does not read gets drops, not the API's memory, and is closed after the grace ──
  Object.assign(callMedia.config, { rate: 1e9, burst: 1e9 });
  callee.socket.pause();
  const block = crypto.randomBytes(1000);
  for (let index = 0; index < 30000; index++) caller.ws.send(block);
  await until(async () => caller.ws.bufferedAmount, amount => amount === 0, 'Alex has sent it all');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(callMedia.stats().buffered <= 8192 + 1100, `the API holds ${callMedia.stats().buffered} bytes for the desk`);
  Object.assign(callMedia.config, { slowMs: 0 });
  await callMedia.tick();
  callee.socket.resume();
  assert.equal(await callee.closed(), 4001);
  Object.assign(callMedia.config, defaults);

  // ── At capacity a new end is refused; Alex's own reconnect is not ──
  Object.assign(callMedia.config, { maxSockets: 1 });
  assert.deepEqual(await refusal(blair, media(first)), [503, 'CHAT_CALL_MEDIA_BUSY']);
  const again = await browser(alex, media(first));
  assert.equal(await caller.closed(), 4000);
  Object.assign(callMedia.config, defaults);
  callee = await raw(blair, media(first));

  // ── Hanging up closes both, the relay forgets the call, and the ended call is refused ──
  await call(alex, 'POST', `/api/chat/calls/${first}/end`, {});
  assert.deepEqual([await callee.closed(), await again.closed()], [1000, 1000]);
  await until(async () => callMedia.stats(), stats => stats.calls === 0 && stats.sockets === 0, 'the relay is empty');
  assert.deepEqual(await refusal(alex, media(first)), [409, 'CHAT_CALL_ENDED']);

  // ── A group call of three: every frame to both others, unless its sender byte is not the sender's number ──
  await pool.execute("INSERT INTO org_group_members (group_id, user_id, role, added_by) VALUES (?, ?, 'member', ?)", [groups.support, ids.stranger, ids.admin]);
  const team = (await call(alex, 'POST', '/api/chat/conversations', { kind: 'group', name: 'Team', follow: { kind: 'group', id: groups.support } })).conversation.id;
  const group = (await call(alex, 'POST', '/api/chat/calls', { conversation_id: team })).call.id as string;
  assert.equal(callMedia.stats().sockets, 0);
  const alexIn = await browser(alex, media(group));
  assert.deepEqual(await refusal(blair, media(group)), [403, 'CHAT_CALL_DEVICE'], 'rung, not in it');
  await call(blair, 'POST', `/api/chat/calls/${group}/answer`);
  const caseySender = (await call(casey, 'POST', `/api/chat/calls/${group}/answer`)).call.members.find((member: { user_id: string }) => member.user_id === ids.stranger).sender;
  const blairIn = await raw(blair, media(group));
  const caseyIn = await browser(casey, media(group));
  const voiced = (sender: number) => Buffer.concat([Buffer.from([1, sender, 0, 0, 0, 0, 1]), crypto.randomBytes(80)]);
  const spoken = voiced(0);
  alexIn.ws.send(voiced(caseySender));
  alexIn.ws.send(spoken);
  assert.deepEqual((await blairIn.next())?.data, spoken, 'the frame as Casey is dropped, the next one passes');
  await until(async () => caseyIn.got.length, length => length === 1, 'Casey hears Alex');
  assert.deepEqual(caseyIn.got.shift(), spoken);
  const fromCasey = voiced(caseySender);
  caseyIn.ws.send(fromCasey);
  assert.deepEqual((await blairIn.next())?.data, fromCasey);
  await until(async () => alexIn.got.length, length => length === 1, 'Alex hears Casey');
  alexIn.got.length = 0;

  // ── Blair stops reading: Blair loses frames, Casey none, and the API holds at most one threshold per other end ──
  Object.assign(callMedia.config, { rate: 1e9, burst: 1e9 });
  blairIn.socket.pause();
  const loud = Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 1]), crypto.randomBytes(900)]);
  for (let index = 0; index < 3000; index++) alexIn.ws.send(loud);
  await until(async () => caseyIn.got.length, length => length === 3000, 'Casey gets every frame');
  assert.ok(callMedia.stats().buffered <= 2 * 8192 + 1100, `the API holds ${callMedia.stats().buffered} bytes for Blair`);
  Object.assign(callMedia.config, defaults);
  blairIn.socket.destroy();
  caseyIn.got.length = 0;

  // ── The stream budget: a room of three counts 6; a new end past the budget is refused, a reconnect is not ──
  await until(async () => callMedia.stats().sockets, sockets => sockets === 2, 'Blair is gone');
  Object.assign(callMedia.config, { maxStreams: 5 });
  assert.deepEqual(await refusal(blair, media(group)), [503, 'CHAT_CALL_MEDIA_BUSY']);
  const alexAgain = await browser(alex, media(group));
  assert.equal(await alexIn.closed(), 4000);
  Object.assign(callMedia.config, defaults);

  // ── Casey leaves: Casey's socket closes at once, the call goes on ──
  await call(casey, 'POST', `/api/chat/calls/${group}/end`, {});
  assert.equal(await caseyIn.closed(), 1000);
  assert.equal(alexAgain.ws.readyState, WebSocket.OPEN);
  await call(alex, 'POST', `/api/chat/calls/${group}/end`, {});
  await call(blair, 'POST', `/api/chat/calls/${group}/end`, {});
  assert.equal(await alexAgain.closed(), 1000);

  // ── Signing out closes that session's socket at once; a deactivated person's goes at the next check ──
  const second = (await call(alex, 'POST', '/api/chat/calls', { user_id: ids.member })).call.id as string;
  await call(blair, 'POST', `/api/chat/calls/${second}/answer`);
  const alexEnd = await browser(alex, media(second));
  const blairEnd = await raw(blair, media(second));
  await call(blair, 'POST', '/api/auth/signout', {});
  assert.equal(await blairEnd.closed(), 1008);
  await pool.execute('UPDATE users SET is_active = 0 WHERE id = ?', [ids.manager]);
  assert.equal(alexEnd.ws.readyState, WebSocket.OPEN, 'nothing told the relay yet');
  await callMedia.tick();
  assert.equal(await alexEnd.closed(), 1008);
});
