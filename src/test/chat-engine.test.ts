// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatAccount, ChatDirectConversation as ChatConversation, ChatMessage } from '../../api/src/contracts/chat';
import { startChatEngine } from '@/lib/chat/engine';
import { loadMls } from '@/lib/chat/mls';
import { ChatStore, wipeChatStores } from '@/lib/chat/store';
import type { ChatEngine, ChatThreadMessage } from '@/lib/chat/types';

// Chat's engine against an in-memory delivery service that keeps the
// server's rules (api/src/services/chat.ts). Each browser has its own
// IndexedDB, Web Locks and BroadcastChannels; its tabs share them. The MLS
// module is the built one where it exists (CI); elsewhere a stand-in that
// keeps its rules: a device reads only the groups it joined, never its own
// messages, and a key package opens one Welcome.

const { fakeMls } = vi.hoisted(() => {
  const text = (value: string) => new TextEncoder().encode(value);
  const str = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const parse = (bytes: Uint8Array) => { try { return JSON.parse(str(bytes)); } catch { throw 'refused: malformed'; } };
  class Device {
    values = new Map<string, Uint8Array>();
    saved = new Map<string, Uint8Array>();
    static create(name: Uint8Array) { const device = new Device(); device.values.set('identity', name); return device; }
    put(key: Uint8Array, value: Uint8Array) { this.values.set(str(key), value); this.saved.set(str(key), value); }
    changes() {
      const changed: { key: Uint8Array; value?: Uint8Array }[] = [...this.values].filter(([key, value]) => this.saved.get(key) !== value).map(([key, value]) => ({ key: text(key), value }));
      changed.push(...[...this.saved.keys()].filter(key => !this.values.has(key)).map(key => ({ key: text(key) })));
      this.saved = new Map(this.values);
      return changed;
    }
    get name() { const name = this.values.get('identity'); if (!name) throw 'no-identity: none'; return str(name); }
    key_package(lastResort: boolean) {
      const id = crypto.randomUUID();
      this.values.set(`kp:${id}`, text(lastResort ? 'last' : 'one'));
      return text(`${JSON.stringify({ name: this.name, id })}\n`);
    }
    group(id: Uint8Array) { const group = this.values.get(`g:${str(id)}`); if (!group) throw 'unknown-group: not joined'; return JSON.parse(str(group)); }
    create_group(id: Uint8Array, packages: Uint8Array) {
      const others = str(packages).split('\n').filter(Boolean).map(line => parse(text(line)));
      const group = { members: [this.name, ...others.map(item => item.name)], secret: crypto.randomUUID() };
      this.values.set(`g:${str(id)}`, text(JSON.stringify(group)));
      return text(JSON.stringify({ id: str(id), ...group, packages: others.map(item => item.id) }));
    }
    join(welcome: Uint8Array) {
      const { id, members, secret, packages } = parse(welcome);
      const used = (packages as string[]).find(item => this.values.has(`kp:${item}`));
      if (!used) throw 'refused: not for this device';
      if (str(this.values.get(`kp:${used}`)!) === 'one') this.values.delete(`kp:${used}`);
      this.values.set(`g:${id}`, text(JSON.stringify({ members, secret })));
      return text(id);
    }
    encrypt(id: Uint8Array, plain: Uint8Array) { return text(JSON.stringify({ secret: this.group(id).secret, sender: this.name, text: str(plain) })); }
    decrypt(id: Uint8Array, message: Uint8Array) {
      const group = this.group(id);
      const sealed = parse(message);
      if (sealed.secret !== group.secret || sealed.sender === this.name) throw 'refused: not readable here';
      return text(sealed.text);
    }
    members(id: Uint8Array) { return this.group(id).members; }
    delete_group(id: Uint8Array) { this.group(id); this.values.delete(`g:${str(id)}`); }
    free() {}
  }
  return { fakeMls: { Device } };
});
const module = path.resolve(__dirname, '../lib/chat/mls-module/chat_mls_bg.wasm');
const built = existsSync(module);

vi.mock('@/lib/chat/mls', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/chat/mls')>();
  if ((await import('node:fs')).existsSync(new URL('../lib/chat/mls-module/chat_mls_bg.wasm', import.meta.url))) return real;
  return {
    ...real,
    withMls: async <T,>(call: (mls: typeof fakeMls) => T) => {
      try {
        return call(fakeMls);
      } catch (error) {
        if (typeof error !== 'string') throw error;
        const [, kind, detail] = /^([a-z-]+): ([\s\S]*)$/.exec(error) ?? [];
        throw new real.MlsError(kind as never, detail);
      }
    },
  };
});

// --- One context per browser ------------------------------------------------------------

interface Browser { userId: string; device: string; idb: IDBFactory; locks: Locks; offline: boolean; signedOut: boolean }
const context = new AsyncLocalStorage<Browser>();
const here = () => {
  const browser = context.getStore();
  if (!browser) throw new Error('a call outside any browser');
  return browser;
};

/** Web Locks of one browser: exclusive, granted in request order. */
class Locks {
  private held = new Map<string, Promise<void>>();
  request(name: string, options: { signal?: AbortSignal }, grant: () => Promise<void>) {
    const before = this.held.get(name) ?? Promise.resolve();
    const run = AsyncLocalStorage.snapshot();
    const result = before.then(() => {
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return run(grant);
    });
    this.held.set(name, result.catch(() => undefined));
    return result;
  }
}

/** BroadcastChannel between the tabs of one browser. */
class Channel {
  static open = new Set<Channel>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  private run = AsyncLocalStorage.snapshot();
  private browser = here();
  constructor(private name: string) { Channel.open.add(this); }
  postMessage(data: unknown) {
    for (const other of Channel.open) {
      if (other !== this && other.name === this.name && other.browser === this.browser) queueMicrotask(() => other.run(() => other.onmessage?.({ data })));
    }
  }
  close() { Channel.open.delete(this); }
}

const defaultIdb = globalThis.indexedDB;
Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get: () => context.getStore()?.idb ?? defaultIdb });
Object.defineProperty(navigator, 'locks', { configurable: true, get: () => context.getStore()?.locks });
vi.stubGlobal('BroadcastChannel', Channel);
// The MLS module finds its randomness on `window` before `globalThis`.
vi.stubGlobal('window', Object.assign(new EventTarget(), { crypto: globalThis.crypto }));
vi.stubGlobal('document', { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });

// --- The delivery service -----------------------------------------------------------------

const PASSWORD = 'account password';
interface Device { id: string; user_id: string; device: string | null; packages: string[]; last_resort: string; preview: { p256dh: string; auth: string } | null }
interface Conversation { id: string; people: string[]; current: string | null; last_seq: number; marks: Map<string, { read: number; delivered: number }> }
interface Group { conversation: string; welcome: string | null; devices: Map<string, boolean> }

function deliveryService() {
  const names = new Map<string, string>();
  const accounts = new Map<string, ChatAccount>();
  const devices = new Map<string, Device>();
  const conversations = new Map<string, Conversation>();
  const groups = new Map<string, Group>();
  const messages: (ChatMessage & { conversation_id: string })[] = [];
  const archive = new Map<string, { user: string; message: string; sealed: string }>();
  const state = { forbidDelete: false, loseGroupAnswer: false, failArchive: false, refusedOffline: () => {}, groupGate: null as null | { waiting: number; size: number; open: () => void; opened: Promise<void> } };

  const ok = (data: unknown) => ({ data });
  const refuse = (status: number, code: string, details?: unknown) => ({ error: code, status, code, details });
  const valid = (people: string[]) => [...devices.values()].filter(device => device.device !== null && people.includes(device.user_id));
  const own = (browser: Browser) => [...devices.values()].find(device => device.device === `${browser.userId}:${browser.device}`);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every(item => b.includes(item));
  const stale = (conversation: Conversation) => refuse(409, 'CHAT_GROUP_STALE', { current_group_id: conversation.current });
  const view = (conversation: Conversation, userId: string): ChatConversation => {
    const peer = conversation.people.find(person => person !== userId)!;
    const mine = conversation.marks.get(userId) ?? { read: 0, delivered: 0 };
    const theirs = conversation.marks.get(peer) ?? { read: 0, delivered: 0 };
    const entries = messages.filter(item => item.conversation_id === conversation.id);
    return {
      id: conversation.id, kind: 'direct', current_group_id: conversation.current, last_seq: conversation.last_seq,
      peer: { user_id: peer, name: names.get(peer)!, can_write: valid([peer]).length > 0, reason: null, online: null },
      last_activity_at: entries.at(-1)?.created_at ?? null, read_seq: mine.read, delivered_seq: mine.delivered, joined_seq: 0,
      unread: entries.filter(item => item.kind === 'message' && !item.replaces && item.ciphertext && item.seq > mine.read && item.sender_user_id !== userId).length,
      peer_read_seq: theirs.read, peer_delivered_seq: theirs.delivered, notify: 'all', retention_days: null, retention_from: null,
    };
  };

  async function handle(method: string, url: string, body: Record<string, unknown> = {}) {
    const browser = here();
    if (browser.offline) {
      state.refusedOffline();
      return { error: 'You are offline.' };
    }
    if (browser.signedOut) return refuse(401, 'UNAUTHORIZED');
    const [route, query] = url.split('?');
    const params = new URLSearchParams(query);
    const me = browser.userId;
    const mine = own(browser);
    const [, conversationId, rest] = /^\/chat\/conversations\/([^/]+)(\/.*)?$/.exec(route) ?? [];
    const conversation = conversationId ? conversations.get(conversationId) : undefined;
    if (conversationId && !conversation?.people.includes(me)) return refuse(404, 'CONVERSATION_NOT_FOUND');
    const key = `${method} ${conversationId ? `/chat/conversations/:id${rest ?? ''}` : route.replace(/\/chat\/(groups|messages)\/[^/]+/, '/chat/$1/:id')}`;
    const target = route.split('/')[3];
    switch (key) {
      case 'GET /chat/account': return ok({ account: accounts.get(me) ?? null });
      case 'POST /chat/account':
        if (accounts.has(me)) return refuse(409, 'CHAT_ACCOUNT_EXISTS');
        accounts.set(me, { ...body, updated_at: '' } as unknown as ChatAccount);
        return ok({ account: accounts.get(me) });
      case 'PUT /chat/account/key-backup':
      case 'POST /chat/account/new-key':
        if (body.current_password !== PASSWORD) return refuse(403, 'PASSWORD_INCORRECT');
        if (key.endsWith('new-key')) for (const [id, copy] of archive) if (copy.user === me) archive.delete(id);
        accounts.set(me, { history_public: body.history_public, key_backup: body.key_backup, updated_at: '' } as ChatAccount);
        return ok({ account: accounts.get(me) });
      case 'POST /chat/devices': {
        if (mine) mine.device = null;
        const device: Device = { id: crypto.randomUUID(), user_id: me, device: `${me}:${browser.device}`, packages: body.key_packages as string[],
          last_resort: body.last_resort as string, preview: body.preview as Device['preview'] };
        devices.set(device.id, device);
        return ok({ chat_device_id: device.id, key_packages: device.packages.length });
      }
      case 'GET /chat/devices/current':
        return mine ? ok({ chat_device_id: mine.id, key_packages: mine.packages.length }) : refuse(404, 'CHAT_DEVICE_NOT_ENROLLED');
      case 'POST /chat/devices/current/key-packages':
        mine!.packages.push(...body.key_packages as string[]);
        return ok({ chat_device_id: mine!.id, key_packages: mine!.packages.length });
      case 'GET /chat/conversations':
        return ok({ conversations: [...conversations.values()].filter(item => item.people.includes(me)).map(item => view(item, me)) });
      case 'POST /chat/conversations': {
        const people = [me, body.user_id as string].sort();
        let found = [...conversations.values()].find(item => same(item.people, people));
        if (!found) {
          found = { id: crypto.randomUUID(), people, current: null, last_seq: 0, marks: new Map() };
          conversations.set(found.id, found);
        }
        return ok({ conversation: view(found, me), created: false });
      }
      case 'GET /chat/conversations/:id/devices':
        return ok({ devices: valid(conversation!.people).map(device => ({ chat_device_id: device.id, user_id: device.user_id, preview: device.preview, created_at: '' })) });
      case 'POST /chat/conversations/:id/key-packages':
        return ok({ key_packages: valid(conversation!.people).filter(device => device !== mine).map(device => ({
          chat_device_id: device.id, user_id: device.user_id, key_package: device.packages.shift() ?? device.last_resort, last_resort: false })) });
      case 'POST /chat/conversations/:id/groups': {
        const gate = state.groupGate;
        if (gate && ++gate.waiting === gate.size) gate.open();
        if (gate) await gate.opened;
        const ids = body.chat_device_ids as string[];
        if (conversation!.current !== body.previous_group_id || !same(ids, valid(conversation!.people).map(device => device.id))) return stale(conversation!);
        groups.set(body.group_id as string, { conversation: conversation!.id, welcome: body.welcome as string, devices: new Map(ids.map(id => [id, id === mine!.id])) });
        conversation!.current = body.group_id as string;
        // The group is made, but its answer never reaches the device, which is offline from here on.
        if (state.loseGroupAnswer) { state.loseGroupAnswer = false; browser.offline = true; state.refusedOffline(); return { error: 'You are offline.' }; }
        return ok({ group_id: body.group_id, current: true });
      }
      case 'POST /chat/groups/:id/joined': {
        const group = groups.get(target)!;
        group.devices.set(mine!.id, true);
        if ([...group.devices.values()].every(Boolean)) group.welcome = null;
        return ok({ joined: true });
      }
      case 'POST /chat/conversations/:id/messages': {
        const existing = messages.find(item => item.id === body.id);
        if (existing) return ok({ message: existing });
        if (conversation!.current !== body.group_id) return stale(conversation!);
        if (!same([...groups.get(body.group_id as string)!.devices.keys()], valid(conversation!.people).map(device => device.id))) return stale(conversation!);
        if (body.replaces && !messages.some(item => item.id === body.replaces && item.sender_user_id === me && item.ciphertext)) return refuse(404, 'CHAT_MESSAGE_NOT_FOUND');
        const message = { id: body.id as string, conversation_id: conversation!.id, seq: ++conversation!.last_seq, group_id: body.group_id as string,
          sender_user_id: me, sender_chat_device_id: mine!.id, kind: 'message' as const, replaces: body.replaces as string | null,
          format: body.format as number, ciphertext: body.ciphertext as string, created_at: new Date().toISOString() };
        messages.push(message);
        archive.set(`${me}:${message.id}`, { user: me, message: message.id, sealed: body.archive as string });
        return ok({ message });
      }
      case 'GET /chat/conversations/:id/messages': {
        const after = Number(params.get('after'));
        const entries = messages.filter(item => item.conversation_id === conversation!.id && item.seq > after);
        const welcomes = [...groups].filter(([, group]) => group.conversation === conversation!.id && mine && group.devices.get(mine.id) === false && group.welcome)
          .map(([id, group]) => ({ group_id: id, welcome: group.welcome, created_at: '' }));
        return ok({ messages: entries.slice(0, 200), welcomes, last_seq: conversation!.last_seq, more: entries.length > 200 });
      }
      case 'DELETE /chat/messages/:id': {
        if (state.forbidDelete) return refuse(403, 'POLICY_FORBIDS');
        const message = messages.find(item => item.id === target && item.sender_user_id === me && !item.replaces);
        if (!message) return refuse(404, 'CHAT_MESSAGE_NOT_FOUND');
        const at = conversations.get(message.conversation_id)!;
        for (const item of messages.filter(entry => entry.id === target || entry.replaces === target)) {
          item.ciphertext = null;
          for (const [id, copy] of archive) if (copy.message === item.id) archive.delete(id);
        }
        messages.push({ ...message, id: crypto.randomUUID(), seq: ++at.last_seq, kind: 'delete', replaces: target, ciphertext: null });
        return ok({ deleted: true, seq: at.last_seq });
      }
      case 'PUT /chat/conversations/:id/marks': {
        const marks = conversation!.marks.get(me) ?? { read: 0, delivered: 0 };
        marks.read = Math.max(marks.read, Number(body.read_seq ?? 0));
        marks.delivered = Math.max(marks.delivered, marks.read, Number(body.delivered_seq ?? 0));
        conversation!.marks.set(me, marks);
        return ok({ read_seq: marks.read, delivered_seq: marks.delivered });
      }
      case 'POST /chat/archive':
        for (const copy of body.copies as { message_id: string; sealed: string }[]) {
          if (messages.some(item => item.id === copy.message_id && item.ciphertext) && !archive.has(`${me}:${copy.message_id}`)) {
            archive.set(`${me}:${copy.message_id}`, { user: me, message: copy.message_id, sealed: copy.sealed });
          }
        }
        return ok({ stored: 0 });
      case 'GET /chat/archive':
        if (state.failArchive) { state.failArchive = false; return { error: 'You are offline.' }; }
        return ok({ cursor: null, copies: [...archive.values()].filter(copy => copy.user === me).map(copy => {
          const message = messages.find(item => item.id === copy.message)!;
          return { message_id: copy.message, sealed: copy.sealed, conversation_id: message.conversation_id, seq: message.seq };
        }).sort((a, b) => a.seq - b.seq) });
    }
    throw new Error(`no route ${key}`);
  }
  return { names, devices, conversations, groups, messages, archive, state, handle };
}

let server = deliveryService();
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => server.handle('GET', url),
    post: (url: string, body?: Record<string, unknown>) => server.handle('POST', url, body),
    put: (url: string, body?: Record<string, unknown>) => server.handle('PUT', url, body),
    delete: (url: string) => server.handle('DELETE', url),
  },
}));

// --- People, browsers and tabs -----------------------------------------------------------

const ALEX = 'alex';
const BLAIR = 'blair';
const PASSPHRASES = { [ALEX]: 'alex chat passphrase', [BLAIR]: 'blair chat passphrase' };
const tabs: { engine: ChatEngine & { stop(): void } }[] = [];

interface Tab {
  browser: Browser;
  engine: ChatEngine & { stop(): void };
  /** Runs `act` as this browser, the engine's background work included. */
  as<T>(act: (engine: ChatEngine) => T): T;
}

function tab(browser: Browser): Tab {
  const engine = context.run(browser, () => startChatEngine({ id: browser.userId, name: server.names.get(browser.userId)! }));
  tabs.push({ engine });
  return { browser, engine, as: act => context.run(browser, () => act(engine)) };
}

const open = (userId: string, device: string) => tab({ userId, device, idb: new IDBFactory(), locks: new Locks(), offline: false, signedOut: false });

/** Resolves when `check` holds, tested at every change the engine announces. */
function until(on: Tab, check: (engine: ChatEngine) => boolean) {
  return new Promise<void>(resolve => {
    if (check(on.engine)) return resolve();
    const stop = on.engine.subscribe(() => { if (check(on.engine)) { stop(); resolve(); } });
  });
}

const settled = (on: Tab) => until(on, engine => engine.snapshot().readiness.state !== 'starting');
const texts = (on: Tab, id: string) => (on.engine.thread(id) ?? []).filter((item): item is ChatThreadMessage => item.kind === 'message')
  .map(item => item.unreadable ? '(unreadable)' : item.deleted ? '(deleted)' : item.text);
const message = (on: Tab, id: string, text: string) => (on.engine.thread(id) ?? []).find((item): item is ChatThreadMessage => item.kind === 'message' && item.text === text);

/** Sends and waits until the server took it. */
async function send(on: Tab, conversationId: string, text: string) {
  on.as(engine => engine.send(conversationId, text));
  await until(on, () => message(on, conversationId, text)?.delivery !== 'sending' && !!message(on, conversationId, text));
  expect(message(on, conversationId, text)?.delivery).toBe('sent');
}

/** Alex and Blair, each on a first browser with a passphrase chosen, in one conversation. */
async function pair() {
  const alex = open(ALEX, 'a1');
  const blair = open(BLAIR, 'b1');
  for (const [on, person] of [[alex, ALEX], [blair, BLAIR]] as const) {
    await settled(on);
    expect(on.engine.snapshot().readiness).toEqual({ state: 'choose-passphrase' });
    await on.as(engine => engine.choosePassphrase(PASSPHRASES[person]));
  }
  const conversation = await alex.as(engine => engine.openConversation(BLAIR));
  await blair.as(engine => engine.sync());
  return { alex, blair, conversation };
}

beforeAll(async () => {
  if (!built && process.env.CI) throw new Error('CI must build Chat\'s MLS module before the tests.');
  if (built) await loadMls(readFileSync(module));
});

afterEach(() => {
  tabs.splice(0).forEach(({ engine }) => engine.stop());
  server = deliveryService();
  server.names.set(ALEX, 'Alex Example').set(BLAIR, 'Blair Example');
});
server.names.set(ALEX, 'Alex Example').set(BLAIR, 'Blair Example');

describe('the chat engine', { timeout: 60_000 }, () => {
  it('Alex and Blair write on three devices; a device added later reads new messages at once and old ones after the passphrase', async () => {
    const { alex, blair, conversation } = await pair();
    const blair2 = open(BLAIR, 'b2');
    await settled(blair2);
    expect(blair2.engine.snapshot().readiness.state).toBe('enter-passphrase');
    await blair2.as(engine => engine.enterPassphrase(PASSPHRASES[BLAIR]));

    await send(alex, conversation, 'hello blair');
    for (const on of [blair, blair2]) await on.as(engine => engine.sync());
    expect(texts(blair, conversation)).toEqual(['hello blair']);
    expect(texts(blair2, conversation)).toEqual(['hello blair']);
    expect(message(blair, conversation, 'hello blair')).toMatchObject({ from_me: false, sender_name: 'Alex Example', delivery: null });

    await send(blair2, conversation, 'hi alex, from my second browser');
    for (const on of [alex, blair]) await on.as(engine => engine.sync());
    expect(texts(alex, conversation)).toEqual(['hello blair', 'hi alex, from my second browser']);
    expect(message(blair, conversation, 'hi alex, from my second browser')?.from_me).toBe(true);
    // Each device fetched it, so the other person's devices delivered it.
    await alex.as(engine => engine.sync());
    expect(message(alex, conversation, 'hello blair')?.delivery).toBe('delivered');
    expect(blair.engine.snapshot().conversations[0]).toMatchObject({ peer: { name: 'Alex Example' }, last_message: { text: 'hi alex, from my second browser', from_me: true } });

    // Blair's third browser, after both wrote: new messages at once, the old ones with the passphrase.
    const blair3 = open(BLAIR, 'b3');
    await settled(blair3);
    await send(alex, conversation, 'blair has a new browser');
    await blair3.as(engine => engine.sync());
    expect(texts(blair3, conversation)).toEqual(['(unreadable)', '(unreadable)', 'blair has a new browser']);
    expect(alex.engine.thread(conversation)!.some(item => item.kind === 'device-added' && item.name === 'Blair Example')).toBe(true);

    // A copy put under another message's id is dropped on restore.
    const copies = [...server.archive.values()].filter(copy => copy.user === BLAIR);
    const [first, second] = [copies.find(copy => server.messages.find(item => item.id === copy.message)?.seq === 1)!, copies.find(copy => server.messages.find(item => item.id === copy.message)?.seq === 2)!];
    second.sealed = first.sealed;
    // The connection breaks while the history is read: the key is kept, and the next sync reads the history.
    server.state.failArchive = true;
    await expect(blair3.as(engine => engine.enterPassphrase(PASSPHRASES[BLAIR]))).rejects.toThrow();
    expect(texts(blair3, conversation)).toEqual(['(unreadable)', '(unreadable)', 'blair has a new browser']);
    await blair3.as(engine => engine.sync());
    expect(texts(blair3, conversation)).toEqual(['hello blair', '(unreadable)', 'blair has a new browser']);
    expect(blair3.engine.snapshot()).toMatchObject({ readiness: { state: 'ready' }, holds_history_key: true, restore: null });
  });

  it('a removed device reads nothing sent after; an edit and a delete reach every device; deleting is refused under the policy', async () => {
    const { alex, blair, conversation } = await pair();
    const blair2 = open(BLAIR, 'b2');
    await settled(blair2);
    await send(alex, conversation, 'to both browsers');
    await send(alex, conversation, 'to be deleted');
    for (const on of [blair, blair2]) await on.as(engine => engine.sync());
    expect(texts(blair2, conversation)).toEqual(['to both browsers', 'to be deleted']);

    const original = message(alex, conversation, 'to both browsers')!.id;
    alex.as(engine => engine.edit(original, 'to both browsers, edited'));
    await until(alex, () => message(alex, conversation, 'to both browsers, edited')?.edit_state === null);
    for (const on of [blair, blair2]) await on.as(engine => engine.sync());
    for (const on of [blair, blair2]) expect(message(on, conversation, 'to both browsers, edited')).toMatchObject({ id: original, edited: true });

    server.state.forbidDelete = true;
    const doomed = message(alex, conversation, 'to be deleted')!.id;
    await expect(alex.as(engine => engine.delete(doomed))).rejects.toMatchObject({ code: 'POLICY_FORBIDS' });
    server.state.forbidDelete = false;
    await alex.as(engine => engine.delete(doomed));
    await blair.as(engine => engine.sync());
    expect(texts(alex, conversation)).toEqual(['to both browsers, edited', '(deleted)']);
    expect(texts(blair, conversation)).toEqual(['to both browsers, edited', '(deleted)']);

    // Blair removes the second browser (Settings › Devices); it still holds its keys and, here, still reaches the server.
    [...server.devices.values()].find(device => device.device === `${BLAIR}:b2`)!.device = null;
    await send(alex, conversation, 'after the removal');
    for (const on of [blair, blair2]) await on.as(engine => engine.sync());
    expect(texts(blair, conversation).at(-1)).toBe('after the removal');
    expect(texts(blair2, conversation).at(-1)).toBe('(unreadable)');
  });

  it('two devices that make a group at once converge, and messages written offline arrive in order', async () => {
    const { alex, blair, conversation } = await pair();
    let open!: () => void;
    server.state.groupGate = { waiting: 0, size: 2, open: () => open(), opened: new Promise(resolve => { open = resolve; }) };
    alex.as(engine => engine.send(conversation, 'alex first'));
    blair.as(engine => engine.send(conversation, 'blair first'));
    await Promise.all([until(alex, () => message(alex, conversation, 'alex first')?.delivery === 'sent'),
      until(blair, () => message(blair, conversation, 'blair first')?.delivery === 'sent')]);
    server.state.groupGate = null;
    expect(server.groups.size).toBe(1);
    for (const on of [alex, blair]) await on.as(engine => engine.sync());
    expect(texts(alex, conversation).sort()).toEqual(['alex first', 'blair first']);
    expect(texts(blair, conversation).sort()).toEqual(['alex first', 'blair first']);

    const refused = new Promise<void>(resolve => { server.state.refusedOffline = resolve; });
    blair.browser.offline = true;
    for (const text of ['one', 'two', 'three']) blair.as(engine => engine.send(conversation, text));
    await refused;
    await until(blair, () => texts(blair, conversation).length === 5);
    expect(blair.engine.thread(conversation)!.slice(-3).map(item => (item as ChatThreadMessage).delivery)).toEqual(['sending', 'sending', 'sending']);
    blair.browser.offline = false;
    await blair.as(engine => engine.sync());
    await alex.as(engine => engine.sync());
    expect(texts(alex, conversation).slice(-3)).toEqual(['one', 'two', 'three']);
    expect(server.messages.slice(-3).map(item => item.seq)).toEqual([3, 4, 5]);
  });

  it('a group whose answer was lost is still read, and a device enrolled again writes first', async () => {
    const { alex, blair, conversation } = await pair();
    const lost = new Promise<void>(resolve => { server.state.refusedOffline = resolve; });
    server.state.loseGroupAnswer = true;
    alex.as(engine => engine.send(conversation, 'alex first'));
    await lost;
    await blair.as(engine => engine.sync());
    await send(blair, conversation, 'blair answers');
    alex.browser.offline = false;
    await alex.as(engine => engine.sync());
    await until(alex, () => message(alex, conversation, 'alex first')?.delivery === 'sent');
    await blair.as(engine => engine.sync());
    expect(texts(alex, conversation).sort()).toEqual(['alex first', 'blair answers']);
    expect(texts(blair, conversation).sort()).toEqual(['alex first', 'blair answers']);
    expect(server.groups.size).toBe(1);

    // Alex's device is removed (Settings › Devices, a restore); the same browser opens Chat again and writes first.
    alex.engine.stop();
    [...server.devices.values()].find(device => device.device === `${ALEX}:a1`)!.device = null;
    const again = tab(alex.browser);
    await settled(again);
    await send(again, conversation, 'from the device enrolled again');
    await blair.as(engine => engine.sync());
    expect(texts(blair, conversation).at(-1)).toBe('from the device enrolled again');
    expect(texts(again, conversation)).toEqual(expect.arrayContaining(['alex first', 'blair answers', 'from the device enrolled again']));
  });

  it('two tabs share one device without corrupting it, and sign-out leaves no store and no key', async () => {
    const { alex, blair, conversation } = await pair();
    const second = tab(alex.browser);
    await settled(second);
    // The second tab waits for the lock: it reads the store and sends through the first.
    second.as(engine => engine.send(conversation, 'from the second tab'));
    await until(second, () => message(second, conversation, 'from the second tab')?.delivery === 'sent');
    expect(message(alex, conversation, 'from the second tab')?.delivery).toBe('sent');

    // The first tab closes: the second takes the lock and goes on with the same device.
    alex.engine.stop();
    await send(second, conversation, 'the second tab took over');
    await blair.as(engine => engine.sync());
    expect(texts(blair, conversation)).toEqual(['from the second tab', 'the second tab took over']);
    expect([...server.devices.values()].filter(device => device.user_id === ALEX)).toHaveLength(1);

    // Another person's store in the same browser goes when Alex signs in; Alex's own at sign-out.
    await context.run(alex.browser, async () => (await ChatStore.open('casey')).close());
    second.engine.stop();
    await context.run(alex.browser, () => wipeChatStores(ALEX));
    expect((await alex.browser.idb.databases()).map(item => item.name)).toEqual([`unihub-chat:${ALEX}`]);
    await context.run(alex.browser, () => wipeChatStores());
    expect(await alex.browser.idb.databases()).toEqual([]);
    // A browser that cannot list its databases still deletes the store of the person who signs out.
    await context.run(alex.browser, async () => (await ChatStore.open(ALEX)).close());
    const listing = alex.browser.idb.databases;
    Object.defineProperty(alex.browser.idb, 'databases', { value: undefined, configurable: true });
    await context.run(alex.browser, () => wipeChatStores(undefined, [ALEX]));
    Object.defineProperty(alex.browser.idb, 'databases', { value: listing, configurable: true });
    expect(await alex.browser.idb.databases()).toEqual([]);
  });
});
