import type { TestContext } from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { FixtureValue } from './test-types.cts';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = require('node:http') as typeof import('node:http');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { seedPeople, PEOPLE } = require('./people.cts') as import('./people.cts').PeopleHelpers;

// The shared people with what the chat tests need: calls that check their
// status, chat devices with synthetic key packages (the server handles opaque
// bytes) that join Chat as a page does, synthetic messages, extra sign-ins
// and live streams.
const ANDROID_AGENT = 'Mozilla/5.0 (Linux; Android 16) UniHubAndroid/0.33.0 (33) UniHubBridge/3';

/** A history key: a real P-256 key, so a test opens the server's challenges as a device would. */
function historyKey() {
  const key = crypto.createECDH('prime256v1');
  key.generateKeys();
  return key;
}

/** RFC 8291 opening, as the page's seal.ts does it, with the history key's fixed auth secret. */
function openSealed(history: import('node:crypto').ECDH, sealed: string) {
  const data = Buffer.from(sealed, 'base64url');
  const salt = data.subarray(0, 16);
  const sender = data.subarray(21, 21 + data[20]);
  const record = data.subarray(21 + data[20]);
  const hkdf = (key: Buffer, ikm: Buffer, info: Buffer, length: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, key, info, length));
  const ikm = hkdf(Buffer.alloc(16), history.computeSecret(sender), Buffer.concat([Buffer.from('WebPush: info\0'), history.getPublicKey(), sender]), 32);
  const decipher = crypto.createDecipheriv('aes-128-gcm', hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12));
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  return padded.subarray(0, padded.lastIndexOf(2)).toString('base64url');
}

async function chatPeople(t: TestContext, pool: Pool) {
  const people = await seedPeople(t, pool);
  type Client = typeof people.clients.admin;
  const call = async (client: Client, method: string, url: string, body?: unknown, status = 200): Promise<FixtureValue> => {
    const reply = await client.request(method, url, body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 300)}`);
    return reply.body;
  };
  const refused = async (client: Client, method: string, url: string, body?: unknown) => {
    const reply = await client.request(method, url, body);
    return [reply.status, reply.body.code ?? null];
  };
  const random = (length: number) => crypto.randomBytes(length).toString('base64url');
  /** A Web Push key pair: the public part a device registers, the private part that opens what is sealed to it. */
  const pushKeys = () => {
    const ecdh = crypto.createECDH('prime256v1');
    const auth = random(16);
    return { ecdh, auth, keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth } };
  };
  // Each person's history key by its public half, as the passphrase would unwrap it on any of their devices.
  const historyKeys = new Map<string, import('node:crypto').ECDH>();
  const backup = () => ({ format: 1, salt: random(16), rounds: 600000, wrapped: random(60) });
  /** Sets Chat up (the first passphrase) with this history key, which joins the client's enrolled device; answers the reply. */
  const setUpChat = (client: Client, history = historyKey()) => {
    historyKeys.set(history.getPublicKey().toString('base64url'), history);
    return client.request('POST', '/api/chat/account', { history_public: history.getPublicKey().toString('base64url'), key_backup: backup() });
  };
  /** The opened challenge of the client's device, with the history key of its person's account. */
  const challenge = async (client: Client) => {
    const { account } = await call(client, 'GET', '/api/chat/account');
    const history = historyKeys.get(account?.history_public);
    assert.ok(history, 'an account this helper made');
    return openSealed(history, (await call(client, 'POST', '/api/chat/devices/current/challenge')).sealed);
  };
  /** Joins the client's waiting device: the person's first device sets Chat up, a later one proves the history key, as after the passphrase. */
  const join = async (client: Client) => {
    if (!(await call(client, 'GET', '/api/chat/account')).account) return assert.equal((await setUpChat(client)).status, 200, 'sets Chat up');
    await call(client, 'POST', '/api/chat/devices/current/proof', { value: await challenge(client) });
  };
  /** Enrols the client's device; it joins Chat unless `waiting`. */
  const enrol = async (client: Client, preview: { p256dh: string; auth: string } | null = pushKeys().keys, { waiting = false } = {}) => {
    const id = (await call(client, 'POST', '/api/chat/devices', { preview, key_packages: [random(313)], last_resort: random(313) })).chat_device_id as string;
    if (!waiting) await join(client);
    return id;
  };
  const signIn = async (who: keyof typeof PEOPLE, agent: string | null = null) => {
    const client = people.api.client();
    const reply = await client.request('POST', '/api/auth/signin', { email: PEOPLE[who].email, password: people.password, device: { key: random(32), kind: agent ? 'android' : 'web' } },
      agent ? { 'user-agent': agent } : {});
    assert.equal(reply.status, 200);
    return client;
  };
  const group = async (client: Client, conversation: string, previous: string | null, devices: string[], status = 200) => {
    const id = crypto.randomUUID();
    const body = await call(client, 'POST', `/api/chat/conversations/${conversation}/groups`, { group_id: id, previous_group_id: previous, welcome: random(900), chat_device_ids: devices }, status);
    return status === 200 ? id : body;
  };
  const message = (groupId: string, extra: Record<string, unknown> = {}) =>
    ({ id: crypto.randomUUID(), group_id: groupId, replaces: null, format: 1, ciphertext: random(402), archive: random(300), previews: [], ...extra });
  const send = async (client: Client, conversation: string, body: Record<string, unknown>) =>
    (await call(client, 'POST', `/api/chat/conversations/${conversation}/messages`, body)).message;

  /** A live stream (the page's or the phone's) whose frames are collected as they arrive. */
  const stream = (client: Client, path: string, agent: string | null = null) => new Promise<{ status: number; close(): void; next(type: string, timeout?: number): Promise<FixtureValue> }>((resolve, reject) => {
    const frames: { type: string; data: FixtureValue }[] = [];
    const waiting: (() => void)[] = [];
    const req = http.get(`${people.api.origin}${path}`, { headers: { cookie: client.cookie(), accept: 'text/event-stream', ...(agent ? { 'user-agent': agent } : {}) } }, res => {
      let buffer = '';
      let ended = false;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (let index; (index = buffer.indexOf('\n\n')) >= 0;) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) frames.push({ type, data: JSON.parse(data) });
        }
        waiting.splice(0).forEach(wake => wake());
      });
      res.on('end', () => { ended = true; waiting.splice(0).forEach(wake => wake()); });
      t.after(() => req.destroy());
      resolve({
        status: res.statusCode ?? 0,
        close: () => req.destroy(),
        async next(type: string, timeout = 5000) {
          const deadline = Date.now() + timeout;
          for (;;) {
            const found = frames.findIndex(frame => frame.type === type);
            if (found >= 0) return frames.splice(found, 1)[0].data;
            if (ended || Date.now() >= deadline) return null;
            await new Promise<void>(wake => { waiting.push(wake); setTimeout(wake, 100); });
          }
        },
      });
    });
    req.on('error', reject);
  });

  /** Waits until `read` answers what `settled` accepts; the server may still be closing a stream. */
  const until = async <T,>(read: () => Promise<T>, settled: (value: T) => boolean, what: string) => {
    const deadline = Date.now() + 10000;
    for (;;) {
      const value = await read();
      if (settled(value)) return value;
      assert.ok(Date.now() < deadline, `${what}: still ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };

  return { ...people, call, refused, random, pushKeys, enrol, join, setUpChat, challenge, historyKey, backup, signIn, group, message, send, stream, until, ANDROID_AGENT };
}

export type ChatHelpers = { chatPeople: typeof chatPeople };
module.exports = { chatPeople };
