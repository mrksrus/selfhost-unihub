// The in-memory delivery service that keeps the server's rules, shared by
// the engine tests. Import it before anything that imports the engine.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, expect, vi } from 'vitest';
import type { ChatAccount, ChatConversation, ChatMessage } from '../../api/src/contracts/chat';
import { startChatEngine } from '@/lib/chat/engine';
import { loadMls } from '@/lib/chat/mls';
import { seal } from '@/lib/chat/seal';
import { fromBase64Url, toBase64Url } from '@/lib/chat/bytes';
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

export interface Browser { userId: string; device: string; idb: IDBFactory; locks: Locks; offline: boolean; signedOut: boolean }
export const context = new AsyncLocalStorage<Browser>();
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

export const ALEX = 'alex';
export const BLAIR = 'blair';

// --- The delivery service -----------------------------------------------------------------

const PASSWORD = 'account password';
interface Device {
  id: string; user_id: string; device: string | null; packages: string[]; last_resort: string; preview: { p256dh: string; auth: string } | null;
  /** Every new device waits until it joins; `pair` is its request for an approval and, once approved, the sealed history key. */
  joined: boolean; challenge: string | null; pair: { public_key: string; sealed: string | null; at: number } | null;
}
// The routes a waiting device may use; every other chat route answers it 403 CHAT_DEVICE_WAITING.
const OPEN_TO_WAITING = ['GET /chat/account', 'POST /chat/account', 'POST /chat/account/new-key', 'POST /chat/devices', 'GET /chat/devices/current',
  'POST /chat/devices/current/key-packages', 'POST /chat/devices/current/challenge', 'POST /chat/devices/current/proof', 'POST /chat/devices/current/approval'];
const APPROVAL_MS = 10 * 60_000;
interface Conversation {
  id: string; people: string[]; current: string | null; last_seq: number; marks: Map<string, { read: number; delivered: number }>;
  /** A group chat's name and managers; a person's seq from which they read. */
  name?: string; managers?: string[]; joined: Map<string, number>; retention: { days: 30 | 90 | 180 | 365; from: string } | null;
}
interface Group { conversation: string; welcome: string | null; devices: Map<string, boolean> }

function deliveryService() {
  const names = new Map([[ALEX, 'Alex Example'], [BLAIR, 'Blair Example']]);
  const accounts = new Map<string, ChatAccount>();
  const devices = new Map<string, Device>();
  const conversations = new Map<string, Conversation>();
  const groups = new Map<string, Group>();
  const messages: (ChatMessage & { conversation_id: string })[] = [];
  const archive = new Map<string, { user: string; message: string; sealed: string }>();
  /** The mentions and previews posted with each message. */
  const posts = new Map<string, { mentions: string[] | undefined; previews: { chat_device_id: string; sealed: string }[]; attachments: string[] | undefined }>();
  /** Uploaded ciphertext by id; `message` once a post names it. */
  const attachments = new Map<string, { conversation: string; uploader: string; blob: Blob; message: string | null }>();
  const state = { fileLimitMb: 50, uploads: 0, downloads: 0, holdUploads: false, onHold: () => {}, onUpload: (() => {}) as (id: string) => void, ageDays: 0, forbidDelete: false, loseGroupAnswer: false, failArchive: false, refusedOffline: () => {}, groupGate: null as null | { waiting: number; size: number; open: () => void; opened: Promise<void> } };

  const ok = (data: unknown) => ({ data });
  const refuse = (status: number, code: string, details?: unknown) => ({ error: code, status, code, details });
  const valid = (people: string[]) => [...devices.values()].filter(device => device.device !== null && device.joined && people.includes(device.user_id));
  const name = (device: Device) => ({ id: device.device!, kind: 'web' as const, app_version: null, user_agent: null });
  const asking = (device: Device) => !device.joined && device.device !== null && !!device.pair && !device.pair.sealed && Date.now() - device.pair.at < APPROVAL_MS;
  const own = (browser: Browser) => [...devices.values()].find(device => device.device === `${browser.userId}:${browser.device}`);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every(item => b.includes(item));
  const stale = (conversation: Conversation) => refuse(409, 'CHAT_GROUP_STALE', { current_group_id: conversation.current });
  const current = (device: Device) => ({ chat_device_id: device.id, key_packages: device.packages.length, state: device.joined ? 'joined' : 'waiting',
    approval_requested_at: asking(device) ? new Date(device.pair!.at).toISOString() : null, sealed_key: null });
  const marksOf = (conversation: Conversation, userId: string) => conversation.marks.get(userId) ?? { read: 0, delivered: 0 };
  const view = (conversation: Conversation, userId: string): ChatConversation => {
    const mine = marksOf(conversation, userId);
    const joined = conversation.joined.get(userId) ?? 0;
    const entries = messages.filter(item => item.conversation_id === conversation.id);
    const base = {
      id: conversation.id, current_group_id: conversation.current, last_seq: conversation.last_seq,
      last_activity_at: entries.at(-1)?.created_at ?? null, read_seq: mine.read, delivered_seq: mine.delivered, joined_seq: joined,
      unread: entries.filter(item => item.kind === 'message' && !item.replaces && item.ciphertext && item.seq > Math.max(mine.read, joined) && item.sender_user_id !== userId).length,
      notify: 'all' as const, retention_days: conversation.retention?.days ?? null, retention_from: conversation.retention?.from ?? null,
    };
    if (conversation.name !== undefined) {
      return { ...base, kind: 'group', name: conversation.name, follows: null, role: conversation.managers!.includes(userId) ? 'manager' : 'member',
        member_count: conversation.people.length, added_by: null };
    }
    const peer = conversation.people.find(person => person !== userId)!;
    const theirs = marksOf(conversation, peer);
    return { ...base, kind: 'direct', peer: { user_id: peer, name: names.get(peer)!, can_write: valid([peer]).length > 0, reason: null, online: null, active: true },
      peer_read_seq: theirs.read, peer_delivered_seq: theirs.delivered };
  };
  const members = (conversation: Conversation) => ({ members: conversation.people.map(person => ({
    user_id: person, name: names.get(person)!, email: `${person}@example.com`, role: conversation.managers?.includes(person) ? 'manager' : 'member', active: true,
    reason: valid([person]).length ? null : accounts.has(person) ? 'is not signed in to Chat on any device' : 'has not set up Chat yet', online: null, read_seq: marksOf(conversation, person).read,
    delivered_seq: marksOf(conversation, person).delivered, joined_seq: conversation.joined.get(person) ?? 0,
  })) });
  /** Someone leaves or is removed: refused from now on, without their marks and archive copies of the chat. */
  const remove = (conversation: Conversation, person: string) => {
    conversation.people = conversation.people.filter(item => item !== person);
    conversation.marks.delete(person);
    for (const [id, copy] of archive) if (copy.user === person && messages.some(item => item.id === copy.message && item.conversation_id === conversation.id)) archive.delete(id);
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
    const key = `${method} ${conversationId ? `/chat/conversations/:id${rest?.replace(/^\/members\/.+/, '/members/:userId') ?? ''}` : route.replace(/\/chat\/(groups|messages|attachments)\/[^/]+/, '/chat/$1/:id')
      .replace(/^\/chat\/devices\/(?!current|approvals)[^/]+\//, '/chat/devices/:id/')}`;
    const target = route.split('/')[3];
    if (key.includes(' /chat/') && !OPEN_TO_WAITING.includes(key) && !mine?.joined) return refuse(403, 'CHAT_DEVICE_WAITING');
    const asked = devices.get(target);
    switch (key) {
      case 'GET /devices':
        return ok({ devices: [...devices.values()].filter(device => device.user_id === me && device.device !== null)
          .map(device => ({ ...name(device), current: device === mine, chat: true, chat_waiting: !device.joined, created_at: '2026-01-02T03:04:05.000Z' })) });
      case 'POST /chat/devices/current/challenge': {
        const value = crypto.getRandomValues(new Uint8Array(40));
        mine!.challenge = toBase64Url(value);
        return ok({ sealed: toBase64Url(await seal({ publicKey: fromBase64Url(accounts.get(me)!.history_public), auth: new Uint8Array(16) }, value)) });
      }
      case 'POST /chat/devices/current/proof':
        if (!mine!.challenge || body.value !== mine!.challenge) return refuse(403, 'CHAT_PROOF_INVALID');
        mine!.joined = true;
        return ok(current(mine!));
      case 'POST /chat/devices/current/approval':
        if (!mine!.joined) mine!.pair = { public_key: body.public_key as string, sealed: null, at: Date.now() };
        return ok(current(mine!));
      case 'GET /chat/devices/approvals':
        return ok({ approvals: [...devices.values()].filter(device => device.user_id === me && asking(device))
          .map(device => ({ chat_device_id: device.id, device: name(device), public_key: device.pair!.public_key, requested_at: new Date(device.pair!.at).toISOString() })) });
      case 'POST /chat/devices/:id/approve':
        if (asked?.user_id !== me || !asking(asked) || asked.pair!.public_key !== body.public_key) return refuse(404, 'CHAT_APPROVAL_NOT_FOUND');
        asked.joined = true;
        asked.pair!.sealed = body.sealed_key as string;
        return ok({ approved: true });
      case 'DELETE /chat/devices/:id/approval':
        if (asked?.user_id !== me || !asking(asked)) return refuse(404, 'CHAT_APPROVAL_NOT_FOUND');
        asked.pair = null;
        return ok({ dropped: true });
      case 'GET /chat/account': return ok({ account: accounts.get(me) ?? null });
      case 'POST /chat/account':
        if (accounts.has(me)) return refuse(409, 'CHAT_ACCOUNT_EXISTS');
        accounts.set(me, { ...body, updated_at: '' } as unknown as ChatAccount);
        if (mine) mine.joined = true;
        return ok({ account: accounts.get(me) });
      case 'PUT /chat/account/key-backup':
      case 'POST /chat/account/new-key':
        if (body.current_password !== PASSWORD) return refuse(403, 'PASSWORD_INCORRECT');
        if (key.endsWith('new-key')) {
          const others = valid([me]).filter(device => device !== mine);
          if (others.length) return refuse(409, 'CHAT_DEVICE_SIGNED_IN', { devices: others.map(name) });
          for (const [id, copy] of archive) if (copy.user === me) archive.delete(id);
          if (mine) mine.joined = true;
        }
        accounts.set(me, { history_public: body.history_public, key_backup: body.key_backup, updated_at: '' } as ChatAccount);
        return ok({ account: accounts.get(me) });
      case 'POST /chat/devices': {
        if (mine) mine.device = null;
        const device: Device = { id: crypto.randomUUID(), user_id: me, device: `${me}:${browser.device}`, packages: body.key_packages as string[],
          last_resort: body.last_resort as string, preview: body.preview as Device['preview'], joined: false, challenge: null, pair: null };
        devices.set(device.id, device);
        return ok(current(device));
      }
      case 'GET /chat/devices/current': {
        if (!mine) return refuse(404, 'CHAT_DEVICE_NOT_ENROLLED');
        const answer = { ...current(mine), sealed_key: mine.pair?.sealed ?? null };
        // The sealed key is handed out once.
        if (mine.pair?.sealed) mine.pair = null;
        return ok(answer);
      }
      case 'POST /chat/devices/current/key-packages':
        mine!.packages.push(...body.key_packages as string[]);
        return ok(current(mine!));
      case 'GET /chat/conversations':
        return ok({ conversations: [...conversations.values()].filter(item => item.people.includes(me)).map(item => view(item, me)) });
      case 'POST /chat/conversations': {
        if (body.kind === 'group') {
          const created: Conversation = { id: crypto.randomUUID(), people: [...new Set([me, ...body.user_ids as string[]])], current: null, last_seq: 0,
            marks: new Map(), name: body.name as string, managers: [me], joined: new Map(), retention: null };
          conversations.set(created.id, created);
          return ok({ conversation: view(created, me), created: true });
        }
        const people = [me, body.user_id as string].sort();
        let found = [...conversations.values()].find(item => same(item.people, people));
        if (!found) {
          found = { id: crypto.randomUUID(), people, current: null, last_seq: 0, marks: new Map(), joined: new Map(), retention: null };
          conversations.set(found.id, found);
        }
        return ok({ conversation: view(found, me), created: false });
      }
      case 'GET /chat/conversations/:id/members':
        return ok(members(conversation!));
      case 'POST /chat/conversations/:id/members':
        if (!conversation!.managers?.includes(me)) return refuse(403, 'CHAT_FORBIDDEN');
        // They read from the next group on; until then a post is stale anyway.
        for (const person of body.user_ids as string[]) if (!conversation!.people.includes(person)) {
          conversation!.people.push(person);
          conversation!.joined.set(person, conversation!.last_seq);
        }
        return ok(members(conversation!));
      case 'DELETE /chat/conversations/:id/members/:userId':
        if (!conversation!.managers?.includes(me)) return refuse(403, 'CHAT_FORBIDDEN');
        remove(conversation!, route.split('/').at(-1)!);
        return ok(members(conversation!));
      case 'POST /chat/conversations/:id/leave':
        remove(conversation!, me);
        return ok({ left: true });
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
        const mentions = body.mentions as string[] | undefined;
        if (mentions && (conversation!.name === undefined || mentions.length > 20 || mentions.some(person => person === me || !conversation!.people.includes(person)))) return refuse(400, 'CHAT_MENTION_INVALID');
        const attached = body.attachments as string[] | undefined;
        if (attached?.length && (body.replaces || attached.length > 20 || attached.some(id => {
          const file = attachments.get(id);
          return !file || file.uploader !== me || file.conversation !== conversation!.id || file.message;
        }))) return refuse(400, 'CHAT_ATTACHMENT_INVALID');
        posts.set(body.id as string, { mentions, previews: body.previews as { chat_device_id: string; sealed: string }[], attachments: attached });
        const message = { id: body.id as string, conversation_id: conversation!.id, seq: ++conversation!.last_seq, group_id: body.group_id as string,
          sender_user_id: me, sender_chat_device_id: mine!.id, kind: 'message' as const, replaces: body.replaces as string | null,
          format: body.format as number, ciphertext: body.ciphertext as string, created_at: new Date(Date.now() - state.ageDays * 86_400_000).toISOString() };
        messages.push(message);
        attached?.forEach(id => { attachments.get(id)!.message = message.id; });
        archive.set(`${me}:${message.id}`, { user: me, message: message.id, sealed: body.archive as string });
        return ok({ message });
      }
      case 'GET /chat/conversations/:id/messages': {
        const after = Math.max(Number(params.get('after')), conversation!.joined.get(me) ?? 0);
        const entries = messages.filter(item => item.conversation_id === conversation!.id && item.seq > after);
        const welcomes = [...groups].filter(([, group]) => group.conversation === conversation!.id && mine && group.devices.get(mine.id) === false && group.welcome)
          .map(([id, group]) => ({ group_id: id, welcome: group.welcome, created_at: '' }));
        const senders = [...new Set(entries.slice(0, 200).flatMap(item => item.sender_user_id ?? []))].map(user_id => ({ user_id, name: names.get(user_id)!, active: true }));
        return ok({ messages: entries.slice(0, 200), welcomes, senders, last_seq: conversation!.last_seq, more: entries.length > 200 });
      }
      case 'DELETE /chat/messages/:id': {
        if (state.forbidDelete) return refuse(403, 'POLICY_FORBIDS');
        const message = messages.find(item => item.id === target && item.sender_user_id === me && !item.replaces);
        if (!message) return refuse(404, 'CHAT_MESSAGE_NOT_FOUND');
        const at = conversations.get(message.conversation_id)!;
        for (const [id, file] of attachments) if (file.message === target) attachments.delete(id);
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
      case 'POST /chat/conversations/:id/attachments': {
        const id = params.get('id')!;
        const { blob, onProgress, signal } = body as { blob: Blob; onProgress?: (sent: number) => void; signal?: AbortSignal };
        const found = attachments.get(id);
        if (found) return found.uploader === me && found.conversation === conversation!.id ? ok({ attachment: { id } }) : refuse(409, 'CHAT_ATTACHMENT_EXISTS');
        if (state.holdUploads) state.onHold();
        if (state.holdUploads) await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))));
        if (blob.size > state.fileLimitMb * 1024 * 1024) {
          const reason = `Files in a chat can be at most ${state.fileLimitMb} MB.`;
          return { error: reason, status: 413, code: 'CHAT_FILE_TOO_LARGE', details: { limit_mb: state.fileLimitMb, reason } };
        }
        onProgress?.(blob.size);
        attachments.set(id, { conversation: conversation!.id, uploader: me, blob, message: null });
        state.uploads++;
        state.onUpload(id);
        return ok({ attachment: { id } });
      }
      case 'GET /chat/attachments/:id': {
        const file = attachments.get(target);
        const at = file && conversations.get(file.conversation);
        const sent = file?.message ? messages.find(item => item.id === file.message) : undefined;
        if (!file || !at?.people.includes(me) || (sent ? !sent.ciphertext || sent.seq <= (at.joined.get(me) ?? 0) : file.uploader !== me)) return refuse(404, 'CHAT_ATTACHMENT_NOT_FOUND');
        state.downloads++;
        return ok(file.blob);
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
  /** A day passes: the server deletes the uploads no message names. */
  const sweepUnsent = () => { for (const [id, file] of attachments) if (!file.message) attachments.delete(id); };
  return { names, devices, conversations, groups, messages, archive, posts, attachments, state, handle, sweepUnsent };
}

export let server = deliveryService();
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => server.handle('GET', url),
    post: (url: string, body?: Record<string, unknown>) => server.handle('POST', url, body),
    put: (url: string, body?: Record<string, unknown>) => server.handle('PUT', url, body),
    delete: (url: string) => server.handle('DELETE', url),
    uploadBlob: (url: string, blob: Blob, _type: string, _method: string, options: object) => server.handle('POST', url, { blob, ...options }),
    getStream: async (url: string) => {
      const answer = await server.handle('GET', url) as { data?: Blob; error?: string };
      if (!answer.data) throw new Error(answer.error);
      return answer.data.stream();
    },
  },
}));

// --- People, browsers and tabs -----------------------------------------------------------

export const PASSPHRASES = { [ALEX]: 'alex chat passphrase', [BLAIR]: 'blair chat passphrase' };
const tabs: { engine: ChatEngine & { stop(): void } }[] = [];

export interface Tab {
  browser: Browser;
  engine: ChatEngine & { stop(): void };
  /** Runs `act` as this browser, the engine's background work included. */
  as<T>(act: (engine: ChatEngine) => T): T;
}

export function tab(browser: Browser): Tab {
  const engine = context.run(browser, () => startChatEngine({ id: browser.userId, name: server.names.get(browser.userId)! }));
  tabs.push({ engine });
  return { browser, engine, as: act => context.run(browser, () => act(engine)) };
}

export const open = (userId: string, device: string) => tab({ userId, device, idb: new IDBFactory(), locks: new Locks(), offline: false, signedOut: false });

/** Resolves when `check` holds, tested at every change the engine announces. */
export function until(on: Tab, check: (engine: ChatEngine) => boolean) {
  return new Promise<void>(resolve => {
    if (check(on.engine)) return resolve();
    const stop = on.engine.subscribe(() => { if (check(on.engine)) { stop(); resolve(); } });
  });
}

export const settled = (on: Tab) => until(on, engine => engine.snapshot().readiness.state !== 'starting');
export const texts = (on: Tab, id: string) => (on.engine.thread(id) ?? []).filter((item): item is ChatThreadMessage => item.kind === 'message')
  .map(item => item.unreadable ? '(unreadable)' : item.deleted ? '(deleted)' : item.text);
export const message = (on: Tab, id: string, text: string) => (on.engine.thread(id) ?? []).find((item): item is ChatThreadMessage => item.kind === 'message' && item.text === text);

/** Sends and waits until the server took it. */
export async function send(on: Tab, conversationId: string, text: string) {
  on.as(engine => engine.send(conversationId, text));
  await until(on, () => message(on, conversationId, text)?.delivery !== 'sending' && !!message(on, conversationId, text));
  expect(message(on, conversationId, text)?.delivery).toBe('sent');
}

/** Alex and Blair, each on a first browser with a passphrase chosen, in one conversation. */
export async function pair() {
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

/** Loads the built MLS module where it exists, and gives each test a new service with Alex and Blair. */
export function chatDeliveryHooks() {
  beforeAll(async () => {
    if (!built && process.env.CI) throw new Error('CI must build Chat\'s MLS module before the tests.');
    if (built) await loadMls(readFileSync(module));
  });

  afterEach(() => {
    tabs.splice(0).forEach(({ engine }) => engine.stop());
    server = deliveryService();
  });
}
