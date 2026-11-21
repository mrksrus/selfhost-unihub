// The image's relay for calls on 127.0.0.1:3478, through a minimal STUN/TURN
// client (RFC 8489, RFC 8656). Run by container-smoke.sh:
//   RELAY_SECRET  the shared secret; unset: nothing may answer on 3478
//   RELAY_REFUSE  peers the relay must refuse: "ip" (permission) or "ip:port" (channel)
//   RELAY_ALLOW   peers it must accept
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';

interface Reply { type: number; attrs: Map<number, Buffer> }
const COOKIE = Buffer.from([0x21, 0x12, 0xa4, 0x42]);
const BINDING = 0x001, ALLOCATE = 0x003, PERMISSION = 0x008, CHANNEL = 0x009;
const USERNAME = 0x0006, INTEGRITY = 0x0008, ERROR = 0x0009, PEER = 0x0012, REALM = 0x0014, NONCE = 0x0015;
const RELAYED = 0x0016, TRANSPORT = 0x0019, MAPPED = 0x0020, CHANNEL_NUMBER = 0x000c;

function attribute(type: number, value: Buffer) {
  const out = Buffer.alloc(4 + Math.ceil(value.length / 4) * 4);
  out.writeUInt16BE(type, 0); out.writeUInt16BE(value.length, 2); value.copy(out, 4);
  return out;
}
function encode(method: number, id: Buffer, attrs: [number, Buffer][], key?: Buffer) {
  const body = Buffer.concat(attrs.map(([type, value]) => attribute(type, value)));
  const header = Buffer.alloc(20);
  header.writeUInt16BE(method, 0); header.writeUInt16BE(body.length + (key ? 24 : 0), 2);
  COOKIE.copy(header, 4); id.copy(header, 8);
  const message = Buffer.concat([header, body]);
  return key ? Buffer.concat([message, attribute(INTEGRITY, crypto.createHmac('sha1', key).update(message).digest())]) : message;
}
function decode(bytes: Buffer): Reply & { id: Buffer } {
  const attrs = new Map<number, Buffer>();
  for (let at = 20; at + 4 <= 20 + bytes.readUInt16BE(2);) {
    const length = bytes.readUInt16BE(at + 2);
    attrs.set(bytes.readUInt16BE(at), bytes.subarray(at + 4, at + 4 + length));
    at += 4 + Math.ceil(length / 4) * 4;
  }
  return { type: bytes.readUInt16BE(0), id: bytes.subarray(8, 20), attrs };
}
function ipBytes(ip: string) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  const words = (part: string) => part ? part.split(':').flatMap(word => {
    if (!word.includes('.')) return [parseInt(word, 16)];
    const [a, b, c, d] = word.split('.').map(Number);
    return [a! << 8 | b!, c! << 8 | d!];
  }) : [];
  const [head = '', tail] = ip.split('::');
  const all = tail === undefined ? words(head) : [...words(head), ...Array(8 - words(head).length - words(tail).length).fill(0), ...words(tail)];
  const out = Buffer.alloc(16); all.forEach((word, index) => out.writeUInt16BE(word, index * 2));
  return out;
}
// XOR-PEER-ADDRESS and friends: port and address masked with the cookie and the transaction id.
function xorAddress(ip: string, port: number, id: Buffer) {
  const raw = ipBytes(ip), mask = Buffer.concat([COOKIE, id]);
  const out = Buffer.alloc(4 + raw.length);
  out[1] = raw.length === 4 ? 1 : 2; out.writeUInt16BE(port ^ 0x2112, 2);
  raw.forEach((byte, index) => { out[4 + index] = byte ^ mask[index]!; });
  return out;
}
const errorCode = (reply: Reply) => { const value = reply.attrs.get(ERROR); return value ? value[2]! * 100 + value[3]! : 0; };

const socket = dgram.createSocket('udp4');
// Attributes are built per request: a peer address is masked with its transaction id.
function request(method: number, attrs: (id: Buffer) => [number, Buffer][], key?: Buffer, timeout = 3000) {
  const id = crypto.randomBytes(12);
  return new Promise<Reply | null>(resolve => {
    const timer = setTimeout(() => { socket.off('message', onMessage); resolve(null); }, timeout);
    function onMessage(bytes: Buffer) {
      const reply = decode(bytes);
      if (!reply.id.equals(id)) return;
      clearTimeout(timer); socket.off('message', onMessage); resolve(reply);
    }
    socket.on('message', onMessage);
    socket.send(encode(method, id, attrs(id), key), 3478, '127.0.0.1');
  });
}
const peer = (ip: string, port: number, id: Buffer): [number, Buffer] => [PEER, xorAddress(ip, port, id)];
const tcpOpen = () => new Promise<boolean>(resolve => {
  const connection = net.connect(3478, '127.0.0.1');
  connection.once('connect', () => { connection.destroy(); resolve(true); });
  connection.once('error', () => resolve(false));
});

const secret = process.env.RELAY_SECRET;
try {
  const binding = await request(BINDING, () => [], undefined, secret ? 3000 : 1500);
  if (!secret) {
    assert.equal(binding, null, 'Without a secret nothing may answer STUN on 3478');
    assert.equal(await tcpOpen(), false, 'Without a secret nothing may listen on TCP 3478');
    console.log('Relay off: nothing answers on UDP or TCP 3478');
  } else {
    assert(binding && binding.type === 0x0101 && binding.attrs.has(MAPPED), 'The relay must answer a STUN binding request');
    assert.equal(await tcpOpen(), true, 'The relay must listen on TCP 3478');
    const transport: [number, Buffer] = [TRANSPORT, Buffer.from([17, 0, 0, 0])];
    const challenge = await request(ALLOCATE, () => [transport]);
    assert(challenge && errorCode(challenge) === 401, 'An allocation without credentials must be challenged');
    const realm = challenge.attrs.get(REALM)!, nonce = challenge.attrs.get(NONCE)!;
    // The shared-secret scheme: user name "<expiry>:<id>", password base64(HMAC-SHA1(secret, user name)).
    const credentials = (key: string, expiry: number) => {
      const user = `${expiry}:relay-smoke`;
      const password = crypto.createHmac('sha1', key).update(user).digest('base64');
      const attrs: [number, Buffer][] = [[USERNAME, Buffer.from(user)], [REALM, realm], [NONCE, nonce]];
      return { attrs, key: crypto.createHash('md5').update(`${user}:${realm}:${password}`).digest() };
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [label, wrong] of [['a wrong secret', credentials('not-the-secret', now + 3600)], ['an expired user name', credentials(secret, now - 60)]] as const) {
      const refused = await request(ALLOCATE, () => [transport, ...wrong.attrs], wrong.key);
      assert(refused && errorCode(refused) === 401, `An allocation with ${label} must be refused, got ${refused && errorCode(refused)}`);
    }
    const valid = credentials(secret, now + 3600);
    const allocation = await request(ALLOCATE, () => [transport, ...valid.attrs], valid.key);
    assert(allocation && allocation.type === 0x0103 && allocation.attrs.has(RELAYED), `The allocation must succeed, got ${allocation && errorCode(allocation)}`);
    let channel = 0x4000;
    for (const target of (process.env.RELAY_REFUSE || '').split(/\s+/).filter(Boolean)) {
      const port = net.isIP(target) ? 0 : Number(target.slice(target.lastIndexOf(':') + 1));
      const ip = port ? target.slice(0, target.lastIndexOf(':')) : target;
      const reply = port
        ? await request(CHANNEL, id => [[CHANNEL_NUMBER, Buffer.from([channel >> 8, channel++ & 0xff, 0, 0])], peer(ip, port, id), ...valid.attrs], valid.key)
        : await request(PERMISSION, id => [peer(ip, 9, id), ...valid.attrs], valid.key);
      // An IPv6 peer on an IPv4 allocation may also fail as a family mismatch (443).
      assert(reply && (errorCode(reply) === 403 || (net.isIPv6(ip) && errorCode(reply) === 443)), `A relay to ${target} must be refused, got ${reply ? errorCode(reply) || 'success' : 'no answer'}`);
      console.log(`Relay to ${target} refused (${errorCode(reply)})`);
    }
    for (const ip of (process.env.RELAY_ALLOW || '').split(/\s+/).filter(Boolean)) {
      const reply = await request(PERMISSION, id => [peer(ip, 9, id), ...valid.attrs], valid.key);
      assert(reply && reply.type === 0x0108, `A relay to ${ip} must be allowed, got ${reply ? errorCode(reply) : 'no answer'}`);
      console.log(`Relay to ${ip} allowed`);
    }
    console.log('Relay answers STUN, refuses wrong and expired credentials, allocates with valid ones');
  }
} finally {
  socket.close();
}
