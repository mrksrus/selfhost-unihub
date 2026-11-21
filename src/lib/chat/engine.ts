// Chat's engine on this device (the ChatEngine of types.ts). It keeps every
// message in the person's ChatStore and does all encryption: it fetches what
// the server's hints say changed, joins new groups from their Welcomes,
// decrypts, sends from an outbox in order (making a new group when the
// server says the chat's devices changed), keeps the person's sealed archive
// and restores from it after the passphrase. One tab per person runs the MLS
// device and talks to the server for it (a Web Lock); the others read the
// store, put what they send in the shared outbox and hear of changes through
// a BroadcastChannel.
import { AppLockRequired, hasCode } from '@/lib/api-error';
import { onAppEvent } from '@/lib/app-events';
import { chatApi, unreachable } from '@/lib/chat-api';
import type { ChatAccount, ChatConversation, ChatMember, ChatMessage, ChatNotify, ChatSender, ChatWelcome } from '../../../api/src/contracts/chat';
import { concat, fromBase64Url, toBase64Url } from './bytes';
import { startDevice, type ChatDevice } from './device';
import { createHistoryKey, unwrapHistoryKey, wrapHistoryKey } from './key-backup';
import { MlsError, MlsUnavailableError, type MlsDevice } from './mls';
import { open, seal, type SealKey } from './seal';
import { MAX_FILES, MAX_FILE_BYTES, PREVIEW_MAX_BYTES, downloadFile, fileRef, outgoingFiles, parseFiles, renewed, uploadExpired, uploadFile, type ChatFileRef, type OutgoingFile } from './files';
import { searchChats } from './search';
import { ChatStore } from './store';
import type {
  ChatDeliveryState, ChatEngine, ChatEngineSnapshot, ChatFileToSend, ChatReadiness, ChatThreadFile, ChatThreadItem, ChatThreadMessage, ChatThreadNotice,
} from './types';

export const MAX_TEXT = 8000;
const PREVIEW_CHARS = 160;
const FORMAT = 1;
const ARCHIVE_BATCH = 200;
const STALE_ATTEMPTS = 3;
const MAX_MENTIONS = 20;
const DAY = 86_400_000;
const PREFIX = 'unihub-chat:';

interface Person { id: string; name: string }

/** A message, an edit (`replaces`) or a device line as this device keeps it. */
interface Stored {
  id: string;
  conversation_id: string;
  /** A device or member line sits between two messages (a seq plus one half). */
  seq: number;
  kind: 'message' | ChatThreadNotice['kind'];
  replaces: string | null;
  sender_user_id: string | null;
  sender_name: string;
  text: string | null;
  reply_to: string | null;
  /** Absent in what was stored before mentions. */
  mentions?: string[];
  files?: ChatFileRef[];
  deleted: boolean;
  unreadable: boolean;
  created_at: string;
  /** Its copy is in the person's archive. */
  archived: boolean;
}

/** A message or an edit waiting to be sent, in send order. */
interface Outgoing {
  order?: number;
  id: string;
  conversation_id: string;
  text: string;
  reply_to: string | null;
  mentions?: string[];
  files?: OutgoingFile[];
  replaces: string | null;
  created_at: string;
  error: string | null;
  /** Encrypted for a group and maybe taken by the server already: sent again as it is while that group is current. */
  sealed: { group_id: string; ciphertext: string } | null;
}

interface Cursor {
  conversation_id: string;
  /** The last entry read. */
  seq: number;
  /** The groups whose state this device holds, oldest first. */
  groups: string[];
  /** The members of the newest of them, for the device line. */
  members: string[] | null;
}

/** Inside the MLS ciphertext; unknown fields are ignored. */
interface Content { text: string; reply_to: string | null; name: string; mentions?: string[]; files?: ChatFileRef[] }
/** Inside an archive copy: the ids are checked on restore, so a copy stored under another message is dropped. */
interface Copy extends Content { message_id: string; conversation_id: string; sender_user_id: string | null; replaces: string | null; created_at: string }

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const userOf = (memberName: string) => memberName.split('/')[0];
const nameOfChat = (conversation: ChatConversation) => conversation.kind === 'group' ? conversation.name : conversation.peer.name;
const ids = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= 64).slice(0, MAX_MENTIONS) : [];
const reason = (error: unknown) => error instanceof Error && error.message ? error.message : 'Chat could not start.';

function parseContent(bytes: Uint8Array): Content {
  const value = JSON.parse(decode(bytes)) as Partial<Content>;
  // Nothing in a message is longer than a person could have typed: its archive copy must fit too.
  if (typeof value.text !== 'string' || value.text.length > MAX_TEXT || typeof value.name !== 'string' || value.name.length > 255
    || (typeof value.reply_to === 'string' && value.reply_to.length > 64)) throw new SyntaxError('Not a chat message.');
  return { text: value.text, reply_to: typeof value.reply_to === 'string' ? value.reply_to : null, name: value.name, mentions: ids(value.mentions), files: parseFiles(value.files) };
}

/** A deleted or dropped message's previews go from the device too. */
const dropPreviews = (transaction: IDBTransaction, records: Stored[]) =>
  records.forEach(record => record.files?.forEach(file => file.preview && transaction.objectStore('previews').delete(file.preview.id)));

/** Puts a record unless the store holds a readable one and this one is not (a restore or another tab came first). */
function putRecord(transaction: IDBTransaction, record: Stored) {
  const messages = transaction.objectStore('messages');
  // A deleted message keeps no file names or keys; its previews go first, while the record still names them.
  if (record.deleted) { dropPreviews(transaction, [record]); messages.put({ ...record, files: undefined }); return; }
  if (record.text !== null) { messages.put(record); return; }
  const existing = messages.get(record.id);
  existing.onsuccess = () => { if ((existing.result as Stored | undefined)?.text == null) messages.put(record); };
}

class Engine implements ChatEngine {
  private readonly listeners = new Set<() => void>();
  private readonly stops: (() => void)[] = [];
  private readonly lock = new AbortController();
  private store: ChatStore | null = null;
  private device: ChatDevice | null = null;
  private channel: BroadcastChannel | null = null;
  private leading = false;
  private stopped = false;
  private problem: ChatReadiness | null = null;
  private loaded = false;
  private server: ChatConversation[] = [];
  private messages = new Map<string, Stored>();
  private outbox: Outgoing[] = [];
  private cursors = new Map<string, Cursor>();
  /** The archive was not read to its end (the connection broke off): a later sync reads it again. */
  private restorePending = false;
  /** undefined until read from the store or the server. */
  private account: ChatAccount | null | undefined;
  private historyKey: SealKey | null = null;
  private restoring: ChatEngineSnapshot['restore'] = null;
  private snap: ChatEngineSnapshot | null = null;
  private readonly threads = new Map<string, ChatThreadItem[]>();
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  /** What the server last said of people: senders, members and direct peers. */
  private readonly people = new Map<string, Pick<ChatSender, 'name' | 'active'>>();
  private readonly memberLists = new Map<string, ChatMember[]>();
  /** The chats whose members a sync reads again (null: all of them): every message is a hint on every member's device. */
  private readonly membersDue = new Set<string | null>();
  private readonly membersLoading = new Set<string>();
  private readonly catchingUp = new Set<string>();
  /** Chats this page made or opened: a list fetched just before is not a reason to drop them. */
  private readonly started = new Set<string>();
  /** One sender key pair for this page's previews, so each recipient device costs one key agreement. */
  private previewFrom: Promise<CryptoKeyPair> | null = null;
  /** The running uploads by message, to cancel; each file's progress while it uploads. */
  private readonly uploads = new Map<string, AbortController>();
  private readonly progress = new Map<string, number>();
  private readonly previewLoads = new Map<string, Promise<Blob>>();

  constructor(private readonly me: Person) {}

  // --- Life ------------------------------------------------------------------------------

  async start() {
    try {
      this.store = await ChatStore.open(this.me.id);
      if (this.stopped) { this.store.close(); return; }
      await this.load();
      this.channel = new BroadcastChannel(`${PREFIX}${this.me.id}`);
      this.channel.onmessage = ({ data }) => {
        if (data === 'changed') void this.load().catch(() => undefined);
        if (data === 'flush' && this.leading) void this.flush().catch(() => undefined);
      };
      const later = (id: string | null = null) => void this.sync(id).catch(() => undefined);
      this.stops.push(
        onAppEvent('unihub:chat-changed', later),
        onAppEvent('unihub:chat-presence', ({ user_id, online }) => {
          this.server = this.server.map(item => item.kind === 'direct' && item.peer.user_id === user_id && item.peer.online !== null ? { ...item, peer: { ...item.peer, online } } : item);
          for (const [id, list] of this.memberLists) this.setMembers(id, list.map(member => member.user_id === user_id && member.online !== null ? { ...member, online } : member));
          this.changed(null);
        }),
      );
      const onOnline = () => { if (this.problem?.state === 'failed') this.restart(); else later(); };
      const onVisible = () => { if (document.visibilityState === 'visible') later(); };
      window.addEventListener('online', onOnline);
      document.addEventListener('visibilitychange', onVisible);
      this.stops.push(() => window.removeEventListener('online', onOnline), () => document.removeEventListener('visibilitychange', onVisible));
      later();
      // The tab that holds the lock runs the device; another takes over when it closes.
      if (!navigator.locks) { void this.lead(); return; }
      void navigator.locks.request(`${PREFIX}${this.me.id}`, { signal: this.lock.signal },
        () => new Promise<void>(release => { this.stops.push(release); void this.lead(); })).catch(() => undefined);
    } catch (error) {
      this.fail(error);
    }
  }

  stop() {
    this.stopped = true;
    this.lock.abort();
    this.uploads.forEach(upload => upload.abort());
    this.stops.forEach(stop => stop());
    this.channel?.close();
    this.device?.free();
    this.store?.close();
    this.listeners.clear();
  }

  private async lead() {
    this.leading = true;
    try {
      this.device = await startDevice(this.store!, this.me.id);
      if (this.stopped) return this.device.free();
      // A device enrolled again holds no group any more, and its cursors say so.
      this.cursors = new Map((await this.store!.all<Cursor>('cursors')).map(cursor => [cursor.conversation_id, cursor]));
      this.changed();
      await this.sync();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown) {
    if (this.stopped) return;
    this.problem = error instanceof MlsUnavailableError || (error instanceof Error && /browser storage/.test(error.message))
      ? { state: 'unsupported', reason: error.message }
      : { state: 'failed', reason: error instanceof AppLockRequired ? error.requirement.reason ?? 'Chat needs the app lock on this device. Set it up under Settings › Security.' : reason(error) };
    this.changed();
  }

  restart() {
    if (this.problem?.state !== 'failed' || this.stopped) return;
    this.problem = null;
    this.changed();
    if (this.leading && !this.device) void this.lead();
    else void this.sync().catch(error => this.fail(error));
  }

  /** Reads everything the device keeps (at the start, and when another tab changed it). */
  private async load() {
    const store = this.store!;
    const [messages, outbox, cursors, historyKey, account, restore] = await Promise.all([store.all<Stored>('messages'), store.all<Outgoing>('outbox'),
      store.all<Cursor>('cursors'), store.historyKey(), store.get<ChatAccount | null>('keys', 'account'), store.get<boolean>('keys', 'restore')]);
    this.restorePending = !!restore;
    this.messages = new Map(messages.map(record => [record.id, record]));
    this.outbox = outbox;
    this.cursors = new Map(cursors.map(cursor => [cursor.conversation_id, cursor]));
    this.historyKey = historyKey ?? null;
    if (account !== undefined) this.account = account;
    this.loaded = true;
    this.threads.clear();
    this.changed();
  }

  // --- Snapshots -------------------------------------------------------------------------

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Something changed: in one conversation's thread, in the snapshot only (null), or anywhere (undefined). */
  private changed(conversationId?: string | null) {
    if (this.stopped) return;
    if (conversationId) this.threads.delete(conversationId);
    else if (conversationId === undefined) this.threads.clear();
    this.snap = null;
    this.listeners.forEach(listener => listener());
  }

  private readiness(): ChatReadiness {
    if (this.problem) return this.problem;
    if (!this.loaded || this.account === undefined || (this.leading && !this.device)) return { state: 'starting' };
    if (!this.account) return { state: 'choose-passphrase' };
    return this.historyKey ? { state: 'ready' } : { state: 'enter-passphrase' };
  }

  snapshot(): ChatEngineSnapshot {
    this.snap ??= {
      readiness: this.readiness(),
      conversations: this.server.map(item => {
        const messages = this.thread(item.id)?.filter((entry): entry is ChatThreadMessage => entry.kind === 'message') ?? [];
        const last = messages.at(-1);
        return { id: item.id, kind: item.kind, name: nameOfChat(item),
          peer: item.kind === 'direct' ? item.peer : { user_id: null, name: item.name, can_write: true, reason: null, online: null, active: true },
          group: item.kind === 'group' ? { follows: item.follows, role: item.role, member_count: item.member_count, added_by: item.added_by } : null,
          unread: item.unread, mentioned: messages.some(entry => entry.mentions_me && entry.seq !== null && entry.seq > item.read_seq),
          catching_up: this.catchingUp.has(item.id), notify: item.notify, retention_days: item.retention_days, retention_from: item.retention_from,
          last_activity_at: item.last_activity_at, last_message: last ? { text: last.text, from_me: last.from_me, deleted: last.deleted } : null };
      }),
      holds_history_key: !!this.historyKey,
      restore: this.restoring,
    };
    return this.snap;
  }

  thread(conversationId: string): ChatThreadItem[] | null {
    if (!this.loaded) return null;
    let items = this.threads.get(conversationId);
    if (!items) this.threads.set(conversationId, items = this.build(conversationId));
    return items;
  }

  /** What the server last said of a person: a direct chat's peer, a member or a sender. */
  private person(userId: string | null, conversation?: ChatConversation) {
    if (!userId) return undefined;
    return this.people.get(userId) ?? (conversation?.kind === 'direct' && conversation.peer.user_id === userId ? conversation.peer : undefined);
  }

  private nameOf(userId: string | null, conversation?: ChatConversation) {
    return userId === this.me.id ? this.me.name : this.person(userId, conversation)?.name ?? 'Deleted person';
  }

  /** The other people of a group chat who can have received a message: active, reachable, there before it. */
  private recipients(conversationId: string, seq: number) {
    return this.memberLists.get(conversationId)?.filter(member => member.user_id !== this.me.id && member.active && !member.reason && member.joined_seq < seq) ?? [];
  }

  private delivery(conversation: ChatConversation | undefined, seq: number): ChatDeliveryState {
    if (conversation?.kind === 'group') {
      const others = this.recipients(conversation.id, seq);
      if (others.length && others.every(member => member.read_seq !== null && seq <= member.read_seq)) return 'read';
      return others.length && others.every(member => seq <= Math.max(member.delivered_seq, member.read_seq ?? 0)) ? 'delivered' : 'sent';
    }
    if (conversation?.peer_read_seq != null && seq <= conversation.peer_read_seq) return 'read';
    return conversation && seq <= conversation.peer_delivered_seq ? 'delivered' : 'sent';
  }

  private readBy(conversation: ChatConversation | undefined, seq: number): ChatThreadMessage['read_by'] {
    if (conversation?.kind !== 'group') return null;
    const counted = this.recipients(conversation.id, seq).filter(member => member.read_seq !== null);
    return counted.length ? { people: counted.filter(member => seq <= member.read_seq!).map(({ user_id, name }) => ({ user_id, name })), of: counted.length } : null;
  }

  private build(conversationId: string): ChatThreadItem[] {
    const conversation = this.server.find(item => item.id === conversationId);
    const records = [...this.messages.values()].filter(record => record.conversation_id === conversationId).sort((a, b) => a.seq - b.seq);
    const items: ChatThreadItem[] = [];
    const byId = new Map<string, ChatThreadMessage>();
    const quoted: [ChatThreadMessage, string][] = [];
    const message = (record: Stored | Outgoing, sending: Outgoing | null): ChatThreadMessage => {
      const sender = 'sender_user_id' in record ? record.sender_user_id : this.me.id;
      const known = this.person(sender, conversation);
      const fromMe = sender === this.me.id;
      const mentions = record.mentions ?? [];
      const seq = sending ? null : (record as Stored).seq;
      const item: ChatThreadMessage = {
        kind: 'message', id: record.id, seq, sender_user_id: sender,
        sender_name: fromMe ? this.me.name : known?.active ? known.name : (record as Stored).sender_name,
        // A deleted person's messages on this device still name them; in the chat with them the peer says they are gone.
        former_colleague: !fromMe && (!sender || known?.active === false || (conversation?.kind === 'direct' && conversation.peer.user_id === null)), from_me: fromMe, mentions, mentions_me: !fromMe && mentions.includes(this.me.id),
        text: record.text, files: 'deleted' in record && record.deleted ? [] : this.fileStates(record.files, sending),
        reply_to: null, edited: false, deleted: 'deleted' in record && record.deleted,
        unreadable: 'unreadable' in record && record.unreadable, created_at: record.created_at,
        delivery: !fromMe ? null : sending ? (sending.error ? 'failed' : 'sending') : this.delivery(conversation, seq!),
        read_by: fromMe && seq !== null ? this.readBy(conversation, seq) : null, edit_state: null, error: sending?.error ?? null,
      };
      if (record.reply_to) quoted.push([item, record.reply_to]);
      byId.set(item.id, item);
      return item;
    };
    for (const record of records) {
      if (record.kind !== 'message') {
        items.push({ kind: record.kind, id: record.id, user_id: record.sender_user_id, name: record.sender_name, created_at: record.created_at });
      } else if (record.replaces) {
        // An edit counts only from the message's own sender.
        const original = byId.get(record.replaces);
        if (original && !original.deleted && record.text !== null && original.sender_user_id === record.sender_user_id) Object.assign(original, { text: record.text, edited: true });
      } else {
        items.push(message(record, null));
      }
    }
    for (const entry of this.outbox.filter(item => item.conversation_id === conversationId)) {
      if (!entry.replaces) { items.push(message(entry, entry)); continue; }
      const original = byId.get(entry.replaces);
      if (original && !original.deleted) Object.assign(original, { text: entry.text, edited: true, edit_state: entry.error ? 'failed' : 'sending', error: entry.error });
    }
    for (const [item, id] of quoted) {
      const original = byId.get(id);
      item.reply_to = { id, sender_name: original?.sender_name ?? '', text: original && !original.deleted ? original.text : null };
    }
    return items;
  }

  private fileStates(files: (ChatFileRef | OutgoingFile)[] = [], sending: Outgoing | null): ChatThreadFile[] {
    return files.map(file => {
      const progress = this.progress.get(file.id);
      const state = !sending || (file as OutgoingFile).uploaded_at ? 'sent' : progress !== undefined ? 'uploading' : sending.error ? 'failed' : 'waiting';
      return { id: file.id, name: file.name, type: file.type, size: file.size, picture: file.preview ? { width: file.preview.width, height: file.preview.height } : null,
        voice_seconds: file.voice_seconds ?? null, state, progress: state === 'uploading' ? progress! : null, error: state === 'failed' ? sending!.error : null };
    });
  }

  // --- Reading ---------------------------------------------------------------------------

  /** `changed` is the conversation a hint named; without one, any may have changed. */
  sync(changed: string | null = null): Promise<void> {
    this.membersDue.add(changed);
    if (this.syncing) { this.syncAgain = true; return this.syncing; }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        await this.syncOnce();
      } while (this.syncAgain && !this.stopped);
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async syncOnce() {
    if (this.stopped || !this.store) return;
    try {
      await this.setAccount(await chatApi.account());
      await this.setConversations(await chatApi.conversations());
      if (!this.device) return;
      await this.dropGone();
      for (const conversation of this.server) await this.fetchConversation(conversation);
      const all = this.membersDue.delete(null);
      for (const id of this.memberLists.keys()) if ((this.membersDue.delete(id) || all) && this.server.some(item => item.id === id)) await this.loadMembers(id);
      this.channel?.postMessage('changed');
      await this.archiveHeld();
      await this.flush();
      if (this.restorePending && this.historyKey && !this.restoring) await this.restore().catch(() => undefined);
    } catch (error) {
      // The device must meet the person's app lock rule before Chat answers it.
      if (error instanceof AppLockRequired) this.fail(error);
      else if (!unreachable(error)) throw error;
    }
  }

  private async setConversations(conversations: ChatConversation[]) {
    const before = new Map(this.server.map(item => [item.id, JSON.stringify(item)]));
    this.server = conversations;
    for (const item of conversations) if (before.get(item.id) !== JSON.stringify(item)) this.changed(item.id);
    // A snapshot keeps its identity while nothing changed.
    if (before.size !== conversations.length) this.changed(null);
  }

  /** Drops what this device holds of chats no longer in the person's list: they left or were removed. */
  private async dropGone() {
    const listed = new Set(this.server.map(item => item.id));
    const gone = new Set([...this.cursors.keys(), ...[...this.messages.values()].map(record => record.conversation_id)].filter(id => !listed.has(id) && !this.started.has(id)));
    if (!gone.size) return;
    const groups = [...gone].flatMap(id => this.cursor(id).groups);
    const records = [...this.messages.values()].filter(record => gone.has(record.conversation_id));
    const outgoing = this.outbox.filter(entry => gone.has(entry.conversation_id));
    await this.device!.step(mls => groups.forEach(group => { try { mls.delete_group(encode(group)); } catch { /* not held */ } }), transaction => {
      dropPreviews(transaction, records);
      records.forEach(record => transaction.objectStore('messages').delete(record.id));
      outgoing.forEach(entry => transaction.objectStore('outbox').delete(entry.order!));
      gone.forEach(id => transaction.objectStore('cursors').delete(id));
    });
    records.forEach(record => this.messages.delete(record.id));
    this.outbox = this.outbox.filter(entry => !gone.has(entry.conversation_id));
    gone.forEach(id => { this.cursors.delete(id); this.memberLists.delete(id); });
    this.changed();
  }

  /** Deletes this device's copies older than the chat's retention, once its wait is over. */
  private async expire({ id, retention_days: days, retention_from: from }: ChatConversation) {
    if (!days || !from || Date.parse(from) > Date.now()) return;
    const old = [...this.messages.values()].filter(record => record.conversation_id === id && Date.parse(record.created_at) < Date.now() - days * DAY);
    if (!old.length) return;
    await this.store!.write([], transaction => {
      dropPreviews(transaction, old);
      old.forEach(record => transaction.objectStore('messages').delete(record.id));
    });
    old.forEach(record => this.messages.delete(record.id));
    this.changed(id);
  }

  private async loadMembers(conversationId: string) {
    this.setMembers(conversationId, await chatApi.members(conversationId));
  }

  private setMembers(conversationId: string, members: ChatMember[]) {
    for (const member of members) this.people.set(member.user_id, member);
    if (JSON.stringify(members) === JSON.stringify(this.memberLists.get(conversationId))) return;
    this.memberLists.set(conversationId, members);
    this.changed(conversationId);
  }

  private cursor(conversationId: string): Cursor {
    return this.cursors.get(conversationId) ?? { conversation_id: conversationId, seq: 0, groups: [], members: null };
  }

  /** One step of the device (or of the store alone) that also stores records and a cursor; memory follows once stored. */
  private async keep<T = undefined>(call: ((mls: MlsDevice) => T) | null, records: (result: T) => Stored[], cursor?: Cursor | ((result: T) => Cursor)): Promise<T> {
    let kept: Stored[] = [];
    let moved: Cursor | undefined;
    const writes = (transaction: IDBTransaction, result: T) => {
      kept = records(result);
      moved = typeof cursor === 'function' ? cursor(result) : cursor;
      kept.forEach(record => putRecord(transaction, record));
      if (moved) transaction.objectStore('cursors').put(moved);
    };
    const result = call ? await this.device!.step(call, writes) : await this.store!.write([], transaction => writes(transaction, undefined as T)).then(() => undefined as T);
    for (const record of kept) if (record.text !== null || record.deleted || this.messages.get(record.id)?.text == null) this.messages.set(record.id, record);
    if (moved) this.cursors.set(moved.conversation_id, moved);
    for (const id of new Set([...kept.map(record => record.conversation_id), ...moved ? [moved.conversation_id] : []])) this.changed(id);
    return result;
  }

  private async fetchConversation(conversation: ChatConversation) {
    let cursor = this.cursor(conversation.id);
    // A server restored to an earlier state: read it again from the start; what this device holds stays.
    if (conversation.last_seq < cursor.seq) await this.keep(null, () => [], cursor = { ...cursor, seq: 0 });
    const current = conversation.current_group_id;
    if (conversation.last_seq !== cursor.seq || (current && !cursor.groups.includes(current))) {
      try {
        for (let more = true; more;) {
          const page = await chatApi.messages(conversation.id, cursor.seq);
          page.senders.forEach(sender => this.people.set(sender.user_id, sender));
          // Who is still a member tells a person who left from one whose devices ended.
          if (page.welcomes.length && conversation.kind === 'group') await this.loadMembers(conversation.id).catch(() => undefined);
          if ((page.more || page.welcomes.length > 1) && !this.catchingUp.has(conversation.id)) { this.catchingUp.add(conversation.id); this.changed(null); }
          for (const welcome of page.welcomes) await this.join(conversation, welcome);
          for (const message of page.messages) await this.receive(conversation, message);
          cursor = this.cursor(conversation.id);
          more = page.more;
        }
      } finally {
        if (this.catchingUp.delete(conversation.id)) this.changed(null);
      }
    }
    await this.expire(conversation);
    // Every message of an older group was read: its state goes.
    const held = cursor.groups.indexOf(current ?? '');
    if (held > 0 && cursor.seq >= conversation.last_seq) {
      for (const group of cursor.groups.slice(0, held)) await this.device!.step(mls => mls.delete_group(encode(group))).catch(() => undefined);
      await this.keep(null, () => [], { ...cursor, groups: cursor.groups.slice(held) });
    }
    if (cursor.seq > conversation.delivered_seq) {
      await chatApi.marks(conversation.id, { delivered_seq: cursor.seq });
      conversation.delivered_seq = cursor.seq;
    }
  }

  /**
   * The lines of a group this device is now in, against the group before it:
   * devices added, and in a group chat people who joined or left (not a
   * member any more; a member whose devices all ended gets no line).
   */
  private lines(conversation: ChatConversation, groupId: string, members: string[], before: string[] | null, seq: number, at: string): Stored[] {
    if (!before) return [];
    // A page loaded after someone left knows only the members of now: their last message here still names them.
    const said = (userId: string) => [...this.messages.values()]
      .filter(record => record.conversation_id === conversation.id && record.sender_user_id === userId && record.text !== null)
      .sort((a, b) => b.seq - a.seq)[0]?.sender_name;
    const named = (userId: string) => userId === this.me.id ? this.me.name : this.person(userId, conversation)?.name ?? said(userId) ?? 'A former member';
    const line = (kind: Stored['kind'], key: string, userId: string): Stored => ({
      id: `${groupId}:${key}`, conversation_id: conversation.id, seq: seq + 0.5, kind, replaces: null, sender_user_id: userId,
      sender_name: named(userId), text: null, reply_to: null, deleted: false, unreadable: false, created_at: at, archived: true,
    });
    const [was, now] = [new Set(before.map(userOf)), new Set(members.map(userOf))];
    const stays = this.memberLists.get(conversation.id) ?? [];
    return [
      ...members.filter(name => !before.includes(name) && was.has(userOf(name))).map(name => line('device-added', name, userOf(name))),
      ...conversation.kind === 'group' ? [
        ...[...now].filter(user => !was.has(user)).map(user => line('joined', `${user}:joined`, user)),
        ...[...was].filter(user => !now.has(user) && !stays.some(member => member.user_id === user)).map(user => line('left', `${user}:left`, user)),
      ] : [],
    ];
  }

  private async join(conversation: ChatConversation, welcome: ChatWelcome) {
    const cursor = this.cursor(conversation.id);
    if (!cursor.groups.includes(welcome.group_id)) {
      try {
        await this.keep(mls => { mls.join(fromBase64Url(welcome.welcome)); return mls.members(encode(welcome.group_id)); },
          members => this.lines(conversation, welcome.group_id, members, cursor.members, cursor.seq, welcome.created_at),
          members => ({ ...cursor, groups: [...cursor.groups, welcome.group_id], members }));
      } catch (error) {
        // A Welcome this device cannot open costs its group; the next message from here makes one it is in.
        if (!(error instanceof MlsError)) throw error;
        return;
      }
    }
    await chatApi.joined(welcome.group_id);
  }

  private async receive(conversation: ChatConversation, message: ChatMessage) {
    const cursor = this.cursor(conversation.id);
    if (message.seq <= cursor.seq) return;
    const next = { ...cursor, seq: message.seq };
    const known = this.messages.get(message.id);
    const record: Stored = known ? { ...known, seq: message.seq } : {
      id: message.id, conversation_id: conversation.id, seq: message.seq, kind: 'message', replaces: message.replaces,
      sender_user_id: message.sender_user_id, sender_name: this.nameOf(message.sender_user_id, conversation), text: null, reply_to: null,
      deleted: message.ciphertext === null, unreadable: false, created_at: message.created_at, archived: false,
    };
    if (message.kind === 'delete') {
      const gone = [...this.messages.values()].filter(item => item.id === message.replaces || item.replaces === message.replaces);
      await this.keep(null, () => gone.map(item => ({ ...item, text: null, deleted: true })), next);
      await this.dropOutgoing(item => item.replaces === message.replaces);
      return;
    }
    // This device's own messages were stored when they were sent; MLS cannot open them here.
    if (record.deleted || known?.text != null || message.sender_chat_device_id === this.device!.id) {
      await this.keep(null, () => [{ ...record, unreadable: !record.deleted && record.text === null }], next);
      return;
    }
    try {
      await this.keep(mls => mls.decrypt(encode(message.group_id), fromBase64Url(message.ciphertext!)), plain => {
        const content = parseContent(plain);
        return [{ ...record, text: content.text, reply_to: content.reply_to, sender_name: content.name, mentions: content.mentions, files: content.files }];
      }, next);
    } catch (error) {
      // Not in its group, tampered with, or the module stopped on it: it costs only itself.
      if (!(error instanceof MlsError || error instanceof SyntaxError)) throw error;
      await this.keep(null, () => [{ ...record, unreadable: true }], next);
    }
  }

  // --- Sending ---------------------------------------------------------------------------

  send(conversationId: string, text: string, replyTo: string | null = null, mentions: string[] = [], files: ChatFileToSend[] = []) {
    if (mentions.length > MAX_MENTIONS) throw new Error(`A message mentions at most ${MAX_MENTIONS} people.`);
    if (files.length > MAX_FILES) throw new Error(`A message has at most ${MAX_FILES} files.`);
    if (files.some(file => file.blob.size > MAX_FILE_BYTES)) throw new Error('A file in a chat can be at most 100 MB.');
    const checked = this.checked(text, files.length);
    void (async () => this.enqueue({ id: crypto.randomUUID(), conversation_id: conversationId, text: checked, reply_to: replyTo, replaces: null,
      ...mentions.length ? { mentions } : {}, ...files.length ? { files: await outgoingFiles(files) } : {} }))().catch(error => this.fail(error));
  }

  edit(messageId: string, text: string) {
    const original = this.messages.get(messageId);
    if (!original || original.sender_user_id !== this.me.id || original.deleted) throw new Error('Only your own messages can be edited.');
    void this.enqueue({ id: crypto.randomUUID(), conversation_id: original.conversation_id, text: this.checked(text), reply_to: null, replaces: messageId })
      .catch(error => this.fail(error));
  }

  private checked(text: string, files = 0) {
    if ((!text.trim() && !files) || text.length > MAX_TEXT) throw new Error(`A message has 1 to ${MAX_TEXT.toLocaleString('en')} characters.`);
    return text;
  }

  private async enqueue(entry: Omit<Outgoing, 'created_at' | 'error' | 'sealed'>) {
    await this.store!.write([], transaction => {
      transaction.objectStore('outbox').add({ ...entry, created_at: new Date().toISOString(), error: null, sealed: null } satisfies Outgoing);
    });
    await this.outboxChanged(entry.conversation_id);
  }

  private async outboxChanged(conversationId?: string) {
    this.outbox = await this.store!.all<Outgoing>('outbox');
    this.changed(conversationId);
    if (this.leading) void this.flush().catch(() => undefined);
    else this.channel?.postMessage('flush');
  }

  private async dropOutgoing(match: (entry: Outgoing) => boolean) {
    const gone = this.outbox.filter(match);
    if (!gone.length) return;
    await this.store!.write([], transaction => gone.forEach(entry => transaction.objectStore('outbox').delete(entry.order!)));
    await this.outboxChanged(gone[0].conversation_id);
  }

  retry(messageId: string) {
    const entry = this.outbox.find(item => item.error && (item.id === messageId || item.replaces === messageId));
    if (!entry) return;
    void this.store!.write([], transaction => { transaction.objectStore('outbox').put({ ...entry, error: null }); })
      .then(() => this.outboxChanged(entry.conversation_id)).catch(error => this.fail(error));
  }

  /** Sends the outbox in order, one at a time; stops while the server cannot be reached. */
  private flush(): Promise<void> {
    if (this.flushing) { this.flushAgain = true; return this.flushing; }
    this.flushing = (async () => {
      do {
        this.flushAgain = false;
        if (!this.device || !this.account || this.stopped) return;
        this.outbox = await this.store!.all<Outgoing>('outbox');
        for (const entry of this.outbox.filter(item => !item.error)) {
          try {
            await this.deliver(entry);
          } catch (error) {
            if (unreachable(error) || this.stopped) return;
            await this.saveOutgoing({ ...entry, error: reason(error) });
          }
          this.outbox = await this.store!.all<Outgoing>('outbox');
          this.changed(entry.conversation_id);
          this.channel?.postMessage('changed');
        }
      } while (this.flushAgain);
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Stores an outbox entry again unless it was discarded meanwhile; false then. */
  private async saveOutgoing(entry: Outgoing) {
    let kept = false;
    await this.store!.write([], transaction => {
      const outbox = transaction.objectStore('outbox');
      const found = outbox.get(entry.order!);
      found.onsuccess = () => { if (found.result) { kept = true; outbox.put(entry); } };
    });
    return kept;
  }

  private setProgress(entry: Outgoing, fileId: string, part: number) {
    const rounded = Math.floor(part * 100) / 100;
    if (this.progress.get(fileId) === rounded) return;
    this.progress.set(fileId, rounded);
    this.changed(entry.conversation_id);
  }

  /** Uploads the files of a message that are not uploaded yet, in order; false when it was cancelled meanwhile. */
  private async uploadFiles(entry: Outgoing) {
    if (entry.files!.some(uploadExpired)) {
      entry.files = entry.files!.map(file => uploadExpired(file) ? renewed(file) : file);
      entry.sealed = null;
    }
    const cancel = new AbortController();
    this.uploads.set(entry.id, cancel);
    try {
      for (const file of entry.files!.filter(item => item.uploaded_at === null)) {
        this.setProgress(entry, file.id, 0);
        try {
          await uploadFile(entry.conversation_id, file, part => this.setProgress(entry, file.id, part), cancel.signal);
        } finally {
          this.progress.delete(file.id);
          this.changed(entry.conversation_id);
        }
        file.uploaded_at = Date.now();
        if (!await this.saveOutgoing(entry)) return false;
        this.changed(entry.conversation_id);
      }
      // Discarded in another tab: not posted.
      return await this.saveOutgoing(entry);
    } catch (error) {
      if (cancel.signal.aborted) return false;
      throw error;
    } finally {
      this.uploads.delete(entry.id);
    }
  }

  private async deliver(entry: Outgoing) {
    if (entry.files?.length && !await this.uploadFiles(entry)) return;
    let stale: string | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        const conversation = this.server.find(item => item.id === entry.conversation_id) ?? await this.reread(entry.conversation_id);
        const sealed = entry.sealed && entry.sealed.group_id === conversation.current_group_id && entry.sealed.group_id !== stale
          ? entry.sealed : await this.encrypt(entry, await this.groupFor(conversation, stale));
        entry.sealed = sealed;
        const content: Copy = { message_id: entry.id, conversation_id: entry.conversation_id, sender_user_id: this.me.id, replaces: entry.replaces,
          created_at: entry.created_at, text: entry.text, reply_to: entry.reply_to, name: this.me.name, mentions: entry.mentions, files: entry.files?.map(fileRef) };
        const from = await (this.previewFrom ??= crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']));
        const previews = entry.replaces ? [] : await Promise.all((await chatApi.devices(conversation.id))
          .filter(device => device.user_id !== this.me.id && device.preview)
          .map(async device => ({ chat_device_id: device.chat_device_id,
            sealed: toBase64Url(await seal({ publicKey: fromBase64Url(device.preview!.p256dh), auth: fromBase64Url(device.preview!.auth) },
              encode([...entry.text || entry.files?.map(file => file.name).join(', ') || ''].slice(0, PREVIEW_CHARS).join('')), from)) })));
        // Every file was uploaded before this post, which names their ids.
        const attachments = entry.files?.flatMap(file => file.preview ? [file.id, file.preview.id] : [file.id]);
        const posted = await chatApi.post(conversation.id, { id: entry.id, group_id: sealed.group_id, replaces: entry.replaces, format: FORMAT,
          ciphertext: sealed.ciphertext, archive: await this.sealCopy(content), previews, ...entry.mentions && !entry.replaces ? { mentions: entry.mentions } : {},
          ...attachments ? { attachments } : {} });
        await this.store!.write([], transaction => {
          transaction.objectStore('outbox').delete(entry.order!);
          transaction.objectStore('messages').put(this.sentRecord(entry, posted));
          entry.files?.forEach(file => file.preview && transaction.objectStore('previews').put(file.preview_blob, file.preview.id));
        });
        this.messages.set(entry.id, this.sentRecord(entry, posted));
        return;
      } catch (error) {
        // The server deleted an upload that waited too long: the next try uploads the files again.
        if (hasCode(error, 'CHAT_ATTACHMENT_INVALID') && entry.files) Object.assign(entry, { files: entry.files.map(renewed), sealed: null });
        if (!hasCode(error, 'CHAT_GROUP_STALE') || attempt === STALE_ATTEMPTS) throw error;
        // The chat's devices changed or another device made a group: read again, then use or make the current one.
        stale = entry.sealed?.group_id ?? null;
        await this.reread(entry.conversation_id);
      }
    }
  }

  private sentRecord(entry: Outgoing, posted: ChatMessage): Stored {
    return { id: entry.id, conversation_id: entry.conversation_id, seq: posted.seq, kind: 'message', replaces: entry.replaces,
      sender_user_id: this.me.id, sender_name: this.me.name, text: entry.text, reply_to: entry.reply_to, mentions: entry.mentions, files: entry.files?.map(fileRef), deleted: false,
      unreadable: false, created_at: posted.created_at, archived: true };
  }

  private async reread(conversationId: string) {
    await this.setConversations(await chatApi.conversations());
    const conversation = this.server.find(item => item.id === conversationId);
    if (!conversation) throw new Error('This chat is gone.');
    await this.fetchConversation(conversation);
    return conversation;
  }

  /** Encrypts at send time, in send order, and stores the ciphertext with the group's new state. */
  private async encrypt(entry: Outgoing, groupId: string) {
    const content: Content = { text: entry.text, reply_to: entry.reply_to, name: this.me.name, mentions: entry.mentions, files: entry.files?.map(fileRef) };
    return this.device!.step(mls => ({ group_id: groupId, ciphertext: toBase64Url(mls.encrypt(encode(groupId), encode(JSON.stringify(content)))) }),
      (transaction, sealed) => { transaction.objectStore('outbox').put({ ...entry, sealed }); });
  }

  /** The current group when this device is in it and the server did not just call it stale; else a new one. */
  private async groupFor(conversation: ChatConversation, stale: string | null) {
    const current = conversation.current_group_id;
    // A Welcome to the current group may wait for this device.
    if (current && current !== stale && !this.cursor(conversation.id).groups.includes(current)) await this.fetchConversation(conversation);
    if (current && current !== stale && this.cursor(conversation.id).groups.includes(current)) return current;
    const claimed = await chatApi.claimKeyPackages(conversation.id);
    if (conversation.kind === 'group' ? !claimed.length : !claimed.some(item => item.user_id !== this.me.id)) {
      throw new Error(conversation.kind === 'group' ? 'Nobody else in this chat can be written to yet.' : conversation.peer.reason ?? `${conversation.peer.name} cannot be written to yet.`);
    }
    if (conversation.kind === 'group') await this.loadMembers(conversation.id);
    const groupId = crypto.randomUUID();
    const before = this.cursor(conversation.id);
    const made = await this.keep(mls => {
      const welcome = mls.create_group(encode(groupId), concat(...claimed.map(item => fromBase64Url(item.key_package))));
      return { welcome, members: mls.members(encode(groupId)) };
    }, () => [], { ...before, groups: [...before.groups, groupId] });
    try {
      await chatApi.createGroup(conversation.id, { group_id: groupId, previous_group_id: current, welcome: toBase64Url(made.welcome),
        chat_device_ids: [this.device!.id!, ...claimed.map(item => item.chat_device_id)] });
    } catch (error) {
      // The server may have taken the group although its answer never came: it stays, and the next send asks.
      if (unreachable(error)) throw error;
      const now = this.cursor(conversation.id);
      await this.device!.step(mls => mls.delete_group(encode(groupId))).catch(() => undefined);
      await this.keep(null, () => [], { ...now, groups: now.groups.filter(group => group !== groupId) });
      throw error;
    }
    conversation.current_group_id = groupId;
    await this.keep(null, () => this.lines(conversation, groupId, made.members, before.members, before.seq, new Date().toISOString()),
      { ...this.cursor(conversation.id), members: made.members });
    return groupId;
  }

  async openConversation(userId: string) {
    const conversation = await chatApi.start(userId);
    this.started.add(conversation.id);
    if (!this.server.some(item => item.id === conversation.id)) await this.setConversations([conversation, ...this.server]);
    return conversation.id;
  }

  async createGroup(name: string, people: Parameters<ChatEngine['createGroup']>[1]) {
    const conversation = await chatApi.startGroup({ kind: 'group', name, ...people });
    this.started.add(conversation.id);
    await this.setConversations([conversation, ...this.server.filter(item => item.id !== conversation.id)]);
    return conversation.id;
  }

  candidates(query: string) {
    return chatApi.candidates(query);
  }

  members(conversationId: string) {
    if (!this.memberLists.has(conversationId) && !this.membersLoading.has(conversationId)) {
      this.membersLoading.add(conversationId);
      void this.loadMembers(conversationId).catch(() => undefined).finally(() => this.membersLoading.delete(conversationId));
    }
    return this.memberLists.get(conversationId) ?? null;
  }

  private async replace(conversation: ChatConversation) {
    await this.setConversations(this.server.map(item => item.id === conversation.id ? conversation : item));
  }

  async rename(conversationId: string, name: string) {
    await this.replace((await chatApi.rename(conversationId, name)).conversation);
  }

  async unfollow(conversationId: string) {
    await this.replace((await chatApi.unfollow(conversationId)).conversation);
  }

  async addMembers(conversationId: string, userIds: string[]) {
    this.setMembers(conversationId, await chatApi.addMembers(conversationId, userIds));
    void this.sync().catch(() => undefined);
  }

  async removeMember(conversationId: string, userId: string) {
    this.setMembers(conversationId, await chatApi.removeMember(conversationId, userId));
    void this.sync().catch(() => undefined);
  }

  async leave(conversationId: string) {
    await chatApi.leave(conversationId);
    this.started.delete(conversationId);
    await this.sync();
  }

  async setNotify(conversationId: string, notify: ChatNotify) {
    const answer = await chatApi.notify(conversationId, notify);
    const conversation = this.server.find(item => item.id === conversationId);
    if (conversation) await this.replace({ ...conversation, notify: answer.notify });
  }

  search(query: string) {
    return searchChats(query, this.server.map(item => ({ id: item.id, name: nameOfChat(item), items: this.thread(item.id) ?? [] })));
  }

  async delete(messageId: string) {
    if (this.outbox.some(item => item.id === messageId)) {
      this.uploads.get(messageId)?.abort();
      return this.dropOutgoing(item => item.id === messageId || item.replaces === messageId);
    }
    await chatApi.delete(messageId);
    const gone = [...this.messages.values()].filter(item => item.id === messageId || item.replaces === messageId);
    await this.keep(null, () => gone.map(item => ({ ...item, text: null, deleted: true })));
    await this.dropOutgoing(item => item.replaces === messageId);
    this.channel?.postMessage('changed');
    void this.sync().catch(() => undefined);
  }

  private fileOf(messageId: string, fileId: string): ChatFileRef | OutgoingFile {
    const record = this.messages.get(messageId);
    const files: (ChatFileRef | OutgoingFile)[] | undefined = record ? (record.deleted ? [] : record.files) : this.outbox.find(entry => entry.id === messageId)?.files;
    const file = files?.find(item => item.id === fileId);
    if (!file) throw new Error('This file is gone.');
    return file;
  }

  async openFile(messageId: string, fileId: string, { onProgress, signal }: { onProgress?: (part: number) => void; signal?: AbortSignal } = {}) {
    const file = this.fileOf(messageId, fileId);
    if ('blob' in file) return file.blob;
    const blob = await downloadFile(file, onProgress, signal);
    if (this.stopped) throw new Error('Chat was closed.');
    return blob;
  }

  async picturePreview(messageId: string, fileId: string) {
    const file = this.fileOf(messageId, fileId);
    if ('blob' in file) return file.preview_blob ?? null;
    if (!file.preview) return null;
    const { id, key } = file.preview;
    let loading = this.previewLoads.get(id);
    if (!loading) {
      this.previewLoads.set(id, loading = (async () => {
        const kept = await this.store!.get<Blob>('previews', id);
        if (kept) return kept;
        const blob = await downloadFile({ id, key, type: 'image/jpeg', size: 0 }, undefined, undefined, PREVIEW_MAX_BYTES);
        if (this.stopped) throw new Error('Chat was closed.');
        await this.store!.write([], transaction => { transaction.objectStore('previews').put(blob, id); });
        return blob;
      })());
      // Only calls at the same time share a fetch; the store keeps the result.
      void loading.catch(() => undefined).then(() => this.previewLoads.delete(id));
    }
    return loading;
  }

  markRead(conversationId: string) {
    if (document.visibilityState === 'hidden') return;
    const conversation = this.server.find(item => item.id === conversationId);
    const seq = this.cursor(conversationId).seq;
    if (!conversation || seq <= conversation.read_seq) return;
    this.server = this.server.map(item => item === conversation ? { ...item, read_seq: seq, unread: 0 } : item);
    this.changed(conversationId);
    void chatApi.marks(conversationId, { read_seq: seq }).catch(() => undefined);
  }

  // --- History key and archive -----------------------------------------------------------

  /** Takes the server's account; a new history key (started elsewhere) means sealing everything again. */
  private async setAccount(account: ChatAccount | null) {
    const before = this.account;
    const newKey = !!before && before.history_public !== account?.history_public;
    const dropKey = !!this.historyKey && toBase64Url(this.historyKey.publicKey) !== account?.history_public;
    const again = newKey ? [...this.messages.values()].filter(record => record.archived && record.kind === 'message').map(record => ({ ...record, archived: false })) : [];
    await this.keep(null, () => again, undefined).then(() => this.store!.write([], transaction => {
      transaction.objectStore('keys').put(account, 'account');
      if (dropKey) transaction.objectStore('keys').delete('history');
    }));
    this.account = account;
    if (dropKey) this.historyKey = null;
    if (before?.history_public !== account?.history_public || before === undefined) this.changed();
  }

  private async keepKey(key: SealKey, account: ChatAccount) {
    await this.store!.keepHistoryKey(key);
    this.historyKey = key;
    await this.setAccount(account);
    this.channel?.postMessage('changed');
    void this.sync().catch(() => undefined);
  }

  private sealCopy(copy: Copy) {
    return seal({ publicKey: fromBase64Url(this.account!.history_public), auth: new Uint8Array(16) }, encode(JSON.stringify(copy))).then(toBase64Url);
  }

  /** Uploads the archive copies of what this device holds and the archive lacks. */
  private async archiveHeld() {
    if (!this.account) return;
    const pending = [...this.messages.values()].filter(record => !record.archived && record.kind === 'message' && record.text !== null);
    for (let start = 0; start < pending.length && !this.stopped; start += ARCHIVE_BATCH) {
      const batch = pending.slice(start, start + ARCHIVE_BATCH);
      const copies = await Promise.all(batch.map(async record => ({ message_id: record.id, sealed: await this.sealCopy({
        message_id: record.id, conversation_id: record.conversation_id, sender_user_id: record.sender_user_id, replaces: record.replaces,
        created_at: record.created_at, text: record.text!, reply_to: record.reply_to, name: record.sender_name, mentions: record.mentions, files: record.files }) })));
      await chatApi.storeArchive(copies);
      await this.keep(null, () => batch.map(record => ({ ...(this.messages.get(record.id) ?? record), archived: true })));
    }
  }

  /** Reads the person's archive into the store; a copy whose ids are not its entry's is dropped. */
  private async restore() {
    this.restoring = { done: 0, total: null };
    this.changed();
    try {
      let cursor: string | null = null;
      do {
        const page = await chatApi.archive(cursor);
        const records: Stored[] = [];
        for (const entry of page.copies) {
          try {
            const copy = JSON.parse(decode(await open(this.historyKey!, fromBase64Url(entry.sealed)))) as Copy;
            if (copy.message_id !== entry.message_id || copy.conversation_id !== entry.conversation_id || typeof copy.text !== 'string') continue;
            records.push({ id: entry.message_id, conversation_id: entry.conversation_id, seq: entry.seq, kind: 'message', replaces: copy.replaces ?? null,
              sender_user_id: copy.sender_user_id ?? null, sender_name: String(copy.name ?? ''), text: copy.text, reply_to: copy.reply_to ?? null, mentions: ids(copy.mentions),
              files: parseFiles(copy.files),
              deleted: false, unreadable: false, created_at: String(copy.created_at ?? ''), archived: true });
          } catch {
            // A copy this key cannot open (sealed to an older key, or changed) is skipped.
          }
        }
        await this.keep(null, () => records.filter(record => this.messages.get(record.id)?.text == null));
        this.restoring = { done: this.restoring!.done + page.copies.length, total: page.cursor ? null : this.restoring!.done + page.copies.length };
        this.changed();
        cursor = page.cursor;
      } while (cursor && !this.stopped);
      if (!cursor) {
        await this.store!.write([], transaction => { transaction.objectStore('keys').delete('restore'); });
        this.restorePending = false;
      }
    } finally {
      this.restoring = null;
      this.changed();
      this.channel?.postMessage('changed');
    }
  }

  private async currentAccount() {
    const account = await chatApi.account();
    await this.setAccount(account);
    return account;
  }

  async choosePassphrase(passphrase: string) {
    const key = await createHistoryKey();
    try {
      await this.keepKey(key, await chatApi.createAccount(toBase64Url(key.publicKey), await wrapHistoryKey(key, passphrase)));
    } catch (error) {
      // Chosen on another device meanwhile: this one asks for that passphrase instead.
      if (hasCode(error, 'CHAT_ACCOUNT_EXISTS')) await this.currentAccount();
      throw error;
    }
  }

  async enterPassphrase(passphrase: string) {
    const account = await this.currentAccount();
    if (!account) throw new Error('Choose a chat passphrase first.');
    await this.keepKey(await unwrapHistoryKey(account, passphrase), account);
    await this.store!.write([], transaction => { transaction.objectStore('keys').put(true, 'restore'); });
    this.restorePending = true;
    await this.restore();
  }

  async changePassphrase(currentPassword: string, passphrase: string) {
    const key = this.historyKey;
    if (!key) throw new Error('This device does not hold your chat history key. Enter your chat passphrase first.');
    await this.keepKey(key, await chatApi.replaceKeyBackup(currentPassword, toBase64Url(key.publicKey), await wrapHistoryKey(key, passphrase)));
  }

  async startNewKey(currentPassword: string, passphrase: string) {
    const key = await createHistoryKey();
    await this.keepKey(key, await chatApi.newKey(currentPassword, toBase64Url(key.publicKey), await wrapHistoryKey(key, passphrase)));
  }
}

// --- One engine per page, for the signed-in person --------------------------------------

let current: { engine: Engine; userId: string; users: number } | null = null;

/** A new engine for a person on this page; the app takes the shared one through acquireChatEngine. */
export function startChatEngine(person: Person) {
  const engine = new Engine(person);
  void engine.start();
  return engine;
}

/** The engine of a person, started on first use; release it when done (the last release stops it). */
export function acquireChatEngine(person: Person): { engine: ChatEngine; release: () => void } {
  if (current?.userId !== person.id) {
    current?.engine.stop();
    current = { engine: startChatEngine(person), userId: person.id, users: 0 };
  }
  const held = current;
  held.users++;
  let released = false;
  return {
    engine: held.engine,
    release: () => {
      if (released) return;
      released = true;
      held.users--;
      // A page that remounts takes it again before this runs.
      setTimeout(() => {
        if (held.users || current !== held) return;
        held.engine.stop();
        current = null;
      });
    },
  };
}
