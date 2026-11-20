import type { TestContext } from 'node:test';
import type { Pool } from 'mysql2/promise';
import type { FixtureValue } from './test-types.cts';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = require('node:http') as typeof import('node:http');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { seedPeople, PEOPLE } = require('./people.cts') as import('./people.cts').PeopleHelpers;

// The shared people with what the chat tests need: calls that check their
// status, chat devices with synthetic key packages (the server handles opaque
// bytes), synthetic messages, extra sign-ins and live streams.
const ANDROID_AGENT = 'Mozilla/5.0 (Linux; Android 16) UniHubAndroid/0.33.0 (33) UniHubBridge/3';

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
  const enrol = async (client: Client, preview: { p256dh: string; auth: string } | null = pushKeys().keys) =>
    (await call(client, 'POST', '/api/chat/devices', { preview, key_packages: [random(313)], last_resort: random(313) })).chat_device_id as string;
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

  return { ...people, call, refused, random, pushKeys, enrol, signIn, group, message, send, stream, until, ANDROID_AGENT };
}

export type ChatHelpers = { chatPeople: typeof chatPeople };
module.exports = { chatPeople };
