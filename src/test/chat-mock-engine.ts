// A ChatEngine with fixed data, for component tests and the reference
// pictures: the screens are built on the interface, and this fills it without
// encryption or a server. Actions change the data the way the engine would
// show them at once (a sent message is "sending", an edit is pending).
import type {
  ChatConversationSummary, ChatEngine, ChatEngineSnapshot, ChatPeer, ChatReadiness, ChatRestoreProgress, ChatThreadItem, ChatThreadMessage,
} from '@/lib/chat/types';

export interface MockChatOptions {
  readiness?: ChatReadiness;
  conversations?: ChatConversationSummary[];
  /** null: the device's store was not read yet. */
  threads?: Record<string, ChatThreadItem[] | null>;
  restore?: ChatRestoreProgress | null;
  /** delete() is refused with this sentence, as the server refuses under the rule against deleting for good. */
  deleteRefusal?: string;
}

export interface MockChatEngine extends ChatEngine {
  /** Every action called, with its arguments. */
  calls: [name: string, ...args: unknown[]][];
  /** Tells the subscribers, as the engine does after a change. */
  notify(): void;
  listeners(): number;
}

export const peer = (user_id: string | null, name: string, fields: Partial<ChatPeer> = {}): ChatPeer => ({ user_id, name, can_write: true, reason: null, online: null, active: true, ...fields });

/** A direct conversation's summary with the defaults of a chat that keeps its messages and notifies of all. */
export const direct = (fields: Pick<ChatConversationSummary, 'id' | 'peer' | 'unread' | 'last_activity_at' | 'last_message'>): ChatConversationSummary => ({
  kind: 'direct', name: fields.peer.name, group: null, mentioned: false, catching_up: false, notify: 'all', retention_days: null, retention_from: null, ...fields,
});

export const message = (id: string, from_me: boolean, sender_name: string, created_at: string, text: string | null, fields: Partial<ChatThreadMessage> = {}): ChatThreadMessage => ({
  kind: 'message', id, seq: 1, sender_user_id: from_me ? 'user-ada' : `user-${sender_name.split(' ')[0].toLowerCase()}`, sender_name, from_me, text,
  former_colleague: false, mentions: [], mentions_me: false, read_by: null,
  reply_to: null, edited: false, deleted: false, unreadable: false, created_at, delivery: from_me ? 'read' : null, edit_state: null, error: null, ...fields,
});

export function createMockChatEngine(options: MockChatOptions = {}): MockChatEngine {
  let conversations = options.conversations ?? [];
  const threads = new Map(Object.entries(options.threads ?? {}));
  const subscribers = new Set<() => void>();
  const calls: MockChatEngine['calls'] = [];
  let snapshot: ChatEngineSnapshot;
  let sent = 0;
  let readiness = options.readiness ?? { state: 'ready' as const };
  const publish = () => {
    snapshot = { readiness, conversations, holds_history_key: readiness.state === 'ready', restore: options.restore ?? null };
    for (const subscriber of [...subscribers]) subscriber();
  };
  publish();
  const conversationOf = (messageId: string) => [...threads].find(([, items]) => items?.some(item => item.id === messageId))?.[0];
  const change = (messageId: string, fields: Partial<ChatThreadMessage>) => {
    const id = conversationOf(messageId);
    if (id) threads.set(id, threads.get(id)!.map(item => (item.id === messageId && item.kind === 'message' ? { ...item, ...fields } : item)));
    publish();
  };
  const record = <A extends unknown[], R>(name: string, run: (...args: A) => R) => (...args: A) => { calls.push([name, ...args]); return run(...args); };

  return {
    calls,
    notify: publish,
    listeners: () => subscribers.size,
    subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    snapshot: () => snapshot,
    thread: id => threads.get(id) ?? null,
    openConversation: record('openConversation', async (userId: string) => {
      const found = conversations.find(conversation => conversation.peer.user_id === userId);
      if (!found) throw new Error('This person cannot be written to.');
      return found.id;
    }),
    send: record('send', (conversationId: string, text: string, replyTo?: string | null) => {
      const items = threads.get(conversationId) ?? [];
      const quoted = items.find((item): item is ChatThreadMessage => item.kind === 'message' && item.id === replyTo);
      threads.set(conversationId, [...items, message(`local-${++sent}`, true, 'Ada Example', new Date().toISOString(), text, {
        seq: null, delivery: 'sending', reply_to: quoted ? { id: quoted.id, sender_name: quoted.sender_name, text: quoted.text } : null,
      })]);
      conversations = conversations.map(conversation => (conversation.id === conversationId ? { ...conversation, last_message: { text, from_me: true, deleted: false } } : conversation));
      publish();
    }),
    edit: record('edit', (messageId: string, text: string) => change(messageId, { text, edited: true, edit_state: 'sending' })),
    delete: record('delete', async (messageId: string) => {
      if (options.deleteRefusal) throw new Error(options.deleteRefusal);
      change(messageId, { text: null, deleted: true, reply_to: null });
    }),
    retry: record('retry', (messageId: string) => {
      const failed = threads.get(conversationOf(messageId) ?? '')?.find(item => item.id === messageId);
      change(messageId, failed?.kind === 'message' && failed.delivery === 'failed' ? { delivery: 'sending', error: null } : { edit_state: 'sending', error: null });
    }),
    markRead: record('markRead', (conversationId: string) => {
      conversations = conversations.map(conversation => (conversation.id === conversationId ? { ...conversation, unread: 0 } : conversation));
      publish();
    }),
    createGroup: record('createGroup', async (_name: string, _people: unknown) => conversations[0]?.id ?? ''),
    candidates: record('candidates', async (_query: string) => ({ people: [], groups: [], everyone: false })),
    members: record('members', (_conversationId: string) => null),
    rename: record('rename', async (_conversationId: string, _name: string) => {}),
    addMembers: record('addMembers', async (_conversationId: string, _userIds: string[]) => {}),
    removeMember: record('removeMember', async (_conversationId: string, _userId: string) => {}),
    unfollow: record('unfollow', async (_conversationId: string) => {}),
    leave: record('leave', async (_conversationId: string) => {}),
    setNotify: record('setNotify', async (_conversationId: string, _notify: string) => {}),
    search: record('search', (_query: string) => []),
    sync: record('sync', async () => {}),
    restart: record('restart', () => {}),
    choosePassphrase: record('choosePassphrase', async (_passphrase: string) => { readiness = { state: 'ready' }; publish(); }),
    enterPassphrase: record('enterPassphrase', async (_passphrase: string) => { readiness = { state: 'ready' }; publish(); }),
    changePassphrase: record('changePassphrase', async (_password: string, _passphrase: string) => {}),
    startNewKey: record('startNewKey', async (_password: string, _passphrase: string) => { readiness = { state: 'ready' }; publish(); }),
  };
}

// --- The fixed conversations: every state the screens show ------------------------------

const BLAIR = peer('user-blair', 'Blair Example', { online: true });
const KATHERINE = 'Katherine Johnson-Example of the Accounting Office';
const day = (date: string, time: string) => `2026-06-${date}T${time}:00.000Z`;
const mine = (id: string, at: string, text: string | null, fields: Partial<ChatThreadMessage> = {}) => message(id, true, 'Ada Example', at, text, fields);
const blairs = (id: string, at: string, text: string | null, fields: Partial<ChatThreadMessage> = {}) => message(id, false, BLAIR.name, at, text, fields);

/** Ada's chats on Monday 15 June 2026, 09:30 UTC (the pictures' fixed time). */
export const CHAT_CONVERSATIONS: ChatConversationSummary[] = [
  direct({ id: 'chat-blair', peer: BLAIR, unread: 2, last_activity_at: day('15', '09:24'), last_message: { text: 'Room 2 is free until ten.', from_me: false, deleted: false } }),
  direct({ id: 'chat-alex', peer: peer('user-alex', 'Alex Example'), unread: 0, last_activity_at: day('14', '16:12'), last_message: { text: 'I will send the numbers tomorrow.', from_me: true, deleted: false } }),
  direct({ id: 'chat-katherine', peer: peer('user-katherine', KATHERINE, { can_write: false, reason: `${KATHERINE} has not opened UniHub since the update.` }),
    unread: 0, last_activity_at: day('02', '11:40'), last_message: { text: 'The year-end close is on the shared drive, under Finance, in the folder for this year.', from_me: false, deleted: false } }),
  direct({ id: 'chat-grace', peer: peer('user-grace', 'Grace Hopper', { can_write: false, reason: 'Chat is off for Grace Hopper.' }), unread: 0, last_activity_at: '2026-05-28T08:05:00.000Z', last_message: { text: null, from_me: true, deleted: true } }),
  direct({ id: 'chat-deleted', peer: peer(null, 'Deleted person', { can_write: false, reason: 'This person was deleted.' }), unread: 0, last_activity_at: '2025-11-03T13:30:00.000Z', last_message: { text: 'Thanks, that worked.', from_me: false, deleted: false } }),
  direct({ id: 'chat-drew', peer: peer('user-drew', 'Drew Example', { can_write: false, reason: 'Drew Example is deactivated.' }), unread: 0, last_activity_at: null, last_message: null }),
];

const supplier = mine('m1', day('12', '14:05'), 'Yes. They confirmed Thursday for the first batch.', { edited: true });
const plan = blairs('b4', day('14', '18:43'), 'Sorry, new phone. The plan is here: https://intranet.example.com/rota/june');

export const CHAT_THREADS: Record<string, ChatThreadItem[]> = {
  'chat-blair': [
    blairs('b1', day('12', '14:02'), 'Morning! Did the supplier answer about the delivery dates?'),
    supplier,
    blairs('b2', day('12', '14:06'), 'Thursday works. I will tell the warehouse.', { reply_to: { id: supplier.id, sender_name: supplier.sender_name, text: supplier.text } }),
    mine('m2', day('12', '14:09'), null, { deleted: true }),
    { kind: 'device-added', id: 'n1', user_id: BLAIR.user_id, name: BLAIR.name, created_at: day('14', '18:40') },
    blairs('b3', day('14', '18:41'), null, { unreadable: true }),
    plan,
    mine('m3', day('14', '19:10'), 'Got it, thanks.', { reply_to: { id: plan.id, sender_name: plan.sender_name, text: plan.text } }),
    mine('m4', day('15', '08:55'), 'I moved the stand-up to 09:45.', { edited: true, edit_state: 'sending' }),
    mine('m5', day('15', '09:01'), 'The room is booked until eleven.', { edited: true, edit_state: 'failed', error: 'Could not reach the UniHub API. The browser is online, but the server did not respond.' }),
    mine('m6', day('15', '09:05'), 'Agenda: rota, supplier, holidays.'),
    mine('m7', day('15', '09:12'), 'I will bring the printouts.', { delivery: 'delivered' }),
    mine('m8', day('15', '09:14'), 'Back in two minutes.', { delivery: 'sent' }),
    blairs('b5', day('15', '09:20'), 'Can you check the rota before the stand-up?'),
    blairs('b6', day('15', '09:24'), 'Room 2 is free until ten.'),
    mine('m9', day('15', '09:27'), 'On it.', { seq: null, delivery: 'sending' }),
    mine('m10', day('15', '09:28'), 'And the holiday list?', { seq: null, delivery: 'failed', error: 'No connection to the server.' }),
  ],
  'chat-alex': [
    message('a1', false, 'Alex Example', day('14', '16:10'), 'Do you have the ticket numbers for May?'),
    mine('a2', day('14', '16:12'), 'I will send the numbers tomorrow.', { delivery: 'delivered' }),
  ],
  'chat-katherine': [
    message('k1', false, KATHERINE, day('02', '11:40'), 'The year-end close is on the shared drive, under Finance, in the folder for this year.'),
  ],
  'chat-grace': [mine('g1', '2026-05-28T08:05:00.000Z', null, { deleted: true })],
  'chat-deleted': [message('d1', false, 'Deleted person', '2025-11-03T13:30:00.000Z', 'Thanks, that worked.', { sender_user_id: null })],
  'chat-drew': [],
};

/** The engine the pictures and most tests use: ready, with the fixed conversations. */
export const createFixtureChatEngine = (options: MockChatOptions = {}) => createMockChatEngine({ conversations: CHAT_CONVERSATIONS, threads: CHAT_THREADS, ...options });
