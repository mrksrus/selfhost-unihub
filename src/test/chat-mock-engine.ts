// A ChatEngine with fixed data, for component tests and the reference
// pictures: the screens are built on the interface, and this fills it without
// encryption or a server. Actions change the data the way the engine would
// show them at once (a sent message is "sending", an edit is pending).
import { searchChats } from '@/lib/chat/search';
import type {
  ChatApprovalRequest, ChatCandidatesResponse, ChatConversationSummary, ChatDeviceName, ChatEngine, ChatEngineSnapshot, ChatFileToSend, ChatGroupSummary, ChatMember, ChatNotify, ChatPeer, ChatReadiness, ChatRestoreProgress,
  ChatThreadFile, ChatThreadItem, ChatThreadMessage,
} from '@/lib/chat/types';

export interface MockChatOptions {
  readiness?: ChatReadiness;
  conversations?: ChatConversationSummary[];
  /** null: the device's store was not read yet. */
  threads?: Record<string, ChatThreadItem[] | null>;
  restore?: ChatRestoreProgress | null;
  /** The people of the group chats; a chat without an entry stays "loading". */
  members?: Record<string, ChatMember[]>;
  /** The people within reach for a new group chat, and the groups that can be followed. */
  candidates?: ChatCandidatesResponse;
  /** delete() is refused with this sentence, as the server refuses under the rule against deleting for good. */
  deleteRefusal?: string;
  /** What openFile() answers per file id: the Blob, or a call that answers later or refuses. Any other file is an empty Blob. */
  files?: Record<string, Blob | (() => Promise<Blob>)>;
  /** Devices of the person that ask this one to let them into Chat. */
  approvals?: ChatApprovalRequest[];
  /** approve() is refused with this sentence, as for a request that ended. */
  approveRefusal?: string;
  /** The devices a new key was refused for. */
  newKeyRefused?: ChatDeviceName[];
}

export interface MockChatEngine extends ChatEngine {
  /** Every action called, with its arguments. */
  calls: [name: string, ...args: unknown[]][];
  /** Tells the subscribers, as the engine does after a change. */
  notify(): void;
  listeners(): number;
}

export const peer = (user_id: string | null, name: string, fields: Partial<ChatPeer> = {}): ChatPeer => ({ user_id, name, active: true, can_write: true, reason: null, online: null, ...fields });

/** A direct conversation's summary with the defaults of a chat that keeps its messages and notifies of all. */
export const direct = (fields: Pick<ChatConversationSummary, 'id' | 'peer' | 'unread' | 'last_activity_at' | 'last_message'>): ChatConversationSummary => ({
  kind: 'direct', name: fields.peer.name, group: null, mentioned: false, catching_up: false, notify: 'all', retention_days: null, retention_from: null, ...fields,
});

/** A group chat's summary; the engine gives it a peer that stands for the chat itself. */
export const group = (fields: Pick<ChatConversationSummary, 'id' | 'name' | 'unread' | 'last_activity_at' | 'last_message'> & Partial<ChatConversationSummary>, about: Partial<ChatGroupSummary> = {}): ChatConversationSummary => ({
  kind: 'group', peer: peer(null, fields.name), group: { follows: null, role: 'member', member_count: 3, added_by: null, ...about },
  mentioned: false, catching_up: false, notify: 'all', retention_days: null, retention_from: null, ...fields,
});

export const member = (user_id: string, name: string, fields: Partial<ChatMember> = {}): ChatMember => ({
  user_id, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, role: 'member', active: true, reason: null, online: null, read_seq: null, delivered_seq: 0, joined_seq: 0, ...fields,
});

export const message = (id: string, from_me: boolean, sender_name: string, created_at: string, text: string | null, fields: Partial<ChatThreadMessage> = {}): ChatThreadMessage => ({
  kind: 'message', id, seq: 1, sender_user_id: from_me ? 'user-ada' : `user-${sender_name.split(' ')[0].toLowerCase()}`, sender_name, from_me, text,
  former_colleague: false, mentions: [], mentions_me: false, read_by: null, files: [],
  reply_to: null, edited: false, deleted: false, unreadable: false, created_at, delivery: from_me ? 'read' : null, edit_state: null, error: null, ...fields,
});

export const file = (id: string, name: string, type: string, size: number, fields: Partial<ChatThreadFile> = {}): ChatThreadFile => ({
  id, name, type, size, picture: null, voice_seconds: null, state: 'sent', progress: null, error: null, ...fields,
});

// Every picture: a drawn sky over a floor, 32 by 24 px (PNG).
const PREVIEW = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAC5UlEQVR42rXNa8vSUAAA4P2cOe9TN9286/5FbjiHTpwyJ+rwgm4/51w453AiiCCIoAtFRMULERFBn7q93YM+5Z8YPN8f4erDn0QJL9//TpTw/N2vRAnP3v5MlPDkzY9ECY9ef0+U8ODqW6KE+6+uEyXce3GdKOHu86+JEu48+5Io4fbTz4kSbj3+lCjh5sOPiRJ+//2XqOQD8QYXBzxlcsni6SHP2Dw74jmH58e8MOFFl8tTXprxsscrc64suOpzdcmrAa+tuLbm+obXt7wR8uaOt/a8feCdI++eeO/M+xE3Yn4JmDhgKZNJFksPWcZm2RHLOSw/ZoUJK7pMnrLSjJU9VpkzZcFUn6lLVg1YbcW0NdM3rL5ljZA1d6y1Z+0D6xxZ98R6Z9aPmBGzS0DFAU2ZVLJoekgzNs2OaM6h+TEtTGjRpfKUlma07NHKnCoLqvpUXdJqQGsrqq2pvqH1LW2EtLmjrT1tH2jnSLsn2jvTfkSNmF4CIg5IyiSSRdJDkrFJdkRyDsmPSWFCii6Rp6Q0I2WPVOZEWRDVJ+qSVANSWxFtTfQNqW9JIyTNHWntSftAOkfSPZHemfQjYsTkEmBxgFMmliycHuKMjbMjnHNwfowLE1x0sTzFpRkue7gyx8oCqz5Wl7ga4NoKa2usb3B9ixshbu5wa4/bB9w54u4J9864H2EjxpcAiQOUMpFkofQQZWyUHaGcg/JjVJigoovkKSrNUNlDlTlSFkj1kbpE1QDVVkhbI32D6lvUCFFzh1p71D6gzhF1T6h3Rv0IGTG6BFAcwJQJJQumhzBjw+wI5hyYH8PCBBZdKE9haQbLHqzMobKAqg/VJawGsLaC2hrqG1jfwkYImzvY2sP2AXaOsHuCvTPsR9CI4SUA4gCkTCBZID0EGRtkRyDngPwYFCag6AJ5CkozUPZAZQ6UBVB9oC5BNQC1FdDWQN+A+hY0QtDcgdYetA+gcwTdE+idQT8CRgz+AxkZfks8A+eyAAAAAElFTkSuQmCC';

export function createMockChatEngine(options: MockChatOptions = {}): MockChatEngine {
  let conversations = options.conversations ?? [];
  const threads = new Map(Object.entries(options.threads ?? {}));
  const members = new Map(Object.entries(options.members ?? {}));
  const update = (id: string, fields: Partial<ChatConversationSummary>, about: Partial<ChatGroupSummary> = {}) => {
    conversations = conversations.map(item => (item.id === id ? { ...item, ...fields, group: item.group && { ...item.group, ...about } } : item));
    publish();
  };
  const subscribers = new Set<() => void>();
  const calls: MockChatEngine['calls'] = [];
  let snapshot: ChatEngineSnapshot;
  let sent = 0;
  let readiness = options.readiness ?? { state: 'ready' as const };
  let approvals = options.approvals ?? [];
  const publish = () => {
    snapshot = { readiness, conversations, holds_history_key: readiness.state === 'ready', restore: options.restore ?? null, approvals, new_key_refused: options.newKeyRefused ?? null };
    for (const subscriber of [...subscribers]) subscriber();
  };
  publish();
  const conversationOf = (messageId: string) => [...threads].find(([, items]) => items?.some(item => item.id === messageId))?.[0];
  const change = (messageId: string, fields: Partial<ChatThreadMessage>) => {
    const id = conversationOf(messageId);
    if (id) threads.set(id, threads.get(id)!.map(item => (item.id === messageId && item.kind === 'message' ? { ...item, ...fields } : item)));
    publish();
  };
  // A picture's bytes, for its preview and for the viewer; null for any other file.
  const drawn = (fileId: string) => ([...threads.values()].some(items => items?.some(item => item.kind === 'message' && item.files.some(entry => entry.id === fileId && entry.picture)))
    ? new Blob([Uint8Array.from(atob(PREVIEW), letter => letter.charCodeAt(0))], { type: 'image/png' }) : null);
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
    send: record('send', (conversationId: string, text: string, replyTo?: string | null, _mentions?: string[], files: ChatFileToSend[] = []) => {
      const items = threads.get(conversationId) ?? [];
      const quoted = items.find((item): item is ChatThreadMessage => item.kind === 'message' && item.id === replyTo);
      threads.set(conversationId, [...items, message(`local-${++sent}`, true, 'Ada Example', new Date().toISOString(), text, {
        files: files.map((item, index) => file(`local-${sent}-${index}`, item.name, item.blob.type, item.blob.size, { voice_seconds: item.voice_seconds ?? null, state: 'waiting' })),
        seq: null, delivery: 'sending', reply_to: quoted ? { id: quoted.id, sender_name: quoted.sender_name, text: quoted.text } : null,
      })]);
      conversations = conversations.map(conversation => (conversation.id === conversationId ? { ...conversation, last_message: { text, from_me: true, deleted: false } } : conversation));
      publish();
    }),
    edit: record('edit', (messageId: string, text: string) => change(messageId, { text, edited: true, edit_state: 'sending' })),
    delete: record('delete', async (messageId: string) => {
      if (options.deleteRefusal) throw new Error(options.deleteRefusal);
      change(messageId, { text: null, deleted: true, reply_to: null, files: [] });
    }),
    retry: record('retry', (messageId: string) => {
      const failed = threads.get(conversationOf(messageId) ?? '')?.find(item => item.id === messageId);
      change(messageId, failed?.kind === 'message' && failed.delivery === 'failed' ? { delivery: 'sending', error: null } : { edit_state: 'sending', error: null });
    }),
    markRead: record('markRead', (conversationId: string) => {
      conversations = conversations.map(conversation => (conversation.id === conversationId ? { ...conversation, unread: 0 } : conversation));
      publish();
    }),
    createGroup: record('createGroup', async (name: string, _people: unknown) => {
      conversations = [group({ id: 'chat-new', name, unread: 0, last_activity_at: null, last_message: null }, { role: 'manager' }), ...conversations];
      threads.set('chat-new', []);
      publish();
      return 'chat-new';
    }),
    candidates: record('candidates', async (query: string) => {
      const all = options.candidates ?? { people: [], groups: [], everyone: false };
      return { ...all, people: all.people.filter(person => `${person.full_name} ${person.email}`.toLowerCase().includes(query.toLowerCase())) };
    }),
    // Not recorded: the screens read it at every render.
    members: (conversationId: string) => members.get(conversationId) ?? null,
    rename: record('rename', async (conversationId: string, name: string) => update(conversationId, { name, peer: peer(null, name) })),
    addMembers: record('addMembers', async (conversationId: string, userIds: string[]) => {
      members.set(conversationId, [...members.get(conversationId) ?? [], ...userIds.map(id => member(id, options.candidates?.people.find(person => person.id === id)?.full_name ?? id))]);
      update(conversationId, {}, { member_count: members.get(conversationId)!.length });
    }),
    removeMember: record('removeMember', async (conversationId: string, userId: string) => {
      members.set(conversationId, (members.get(conversationId) ?? []).filter(entry => entry.user_id !== userId));
      update(conversationId, {}, { member_count: members.get(conversationId)!.length });
    }),
    unfollow: record('unfollow', async (conversationId: string) => update(conversationId, {}, { follows: null })),
    leave: record('leave', async (conversationId: string) => { conversations = conversations.filter(item => item.id !== conversationId); publish(); }),
    setNotify: record('setNotify', async (conversationId: string, notify: ChatNotify) => update(conversationId, { notify })),
    search: (query: string) => searchChats(query, conversations.map(item => ({ id: item.id, name: item.name, items: threads.get(item.id) ?? [] }))),
    openFile: record('openFile', async (_messageId: string, fileId: string) => {
      const answer = options.files?.[fileId];
      return typeof answer === 'function' ? answer() : answer ?? drawn(fileId) ?? new Blob();
    }),
    // Not recorded: a picture asks for it as it is drawn.
    picturePreview: async (_messageId: string, fileId: string) => drawn(fileId),
    sync: record('sync', async () => {}),
    restart: record('restart', () => {}),
    choosePassphrase: record('choosePassphrase', async (_passphrase: string) => { readiness = { state: 'ready' }; publish(); }),
    enterPassphrase: record('enterPassphrase', async (_passphrase: string) => { readiness = { state: 'ready' }; publish(); }),
    changePassphrase: record('changePassphrase', async (_password: string, _passphrase: string) => {}),
    startNewKey: record('startNewKey', async (_password: string, _passphrase: string) => { readiness = { state: 'ready' }; publish(); }),
    askApproval: record('askApproval', async () => {}),
    approve: record('approve', async (chatDeviceId: string, _code: string) => {
      approvals = approvals.filter(item => item.chat_device_id !== chatDeviceId);
      publish();
      if (options.approveRefusal) throw new Error(options.approveRefusal);
    }),
    dropApproval: record('dropApproval', async (chatDeviceId: string) => { approvals = approvals.filter(item => item.chat_device_id !== chatDeviceId); publish(); }),
  };
}

// --- The fixed conversations: every state the screens show ------------------------------

const BLAIR = peer('user-blair', 'Blair Example', { online: true });
const ALEX = 'Alex Example';
const ROBIN = 'Robin Example';
const FINLEY = 'Finley Example';
const KATHERINE = 'Katherine Johnson-Example of the Accounting Office';
const day = (date: string, time: string) => `2026-06-${date}T${time}:00.000Z`;
const mine = (id: string, at: string, text: string | null, fields: Partial<ChatThreadMessage> = {}) => message(id, true, 'Ada Example', at, text, fields);
const blairs = (id: string, at: string, text: string | null, fields: Partial<ChatThreadMessage> = {}) => message(id, false, BLAIR.name, at, text, fields);
const readBy = (...names: string[]) => ({ delivery: 'delivered' as const, read_by: { people: names.map(name => ({ user_id: `user-${name.split(' ')[0].toLowerCase()}`, name })), of: 3 } });

/** Ada's chats on Monday 15 June 2026, 09:30 UTC (the pictures' fixed time). */
export const CHAT_CONVERSATIONS: ChatConversationSummary[] = [
  group({ id: 'chat-planning', name: 'Warehouse planning', unread: 2, mentioned: true, last_activity_at: day('15', '09:26'), last_message: { text: '@Ada Example can you bring the stock list?', from_me: false, deleted: false } },
    { role: 'manager', member_count: 6 }),
  direct({ id: 'chat-blair', peer: BLAIR, unread: 2, last_activity_at: day('15', '09:24'), last_message: { text: 'Room 2 is free until ten.', from_me: false, deleted: false } }),
  direct({ id: 'chat-alex', peer: peer('user-alex', 'Alex Example'), unread: 0, last_activity_at: day('14', '16:12'), last_message: { text: 'I will send the numbers tomorrow.', from_me: true, deleted: false } }),
  direct({ id: 'chat-finley', peer: peer('user-finley', FINLEY), unread: 0, last_activity_at: day('13', '10:24'), last_message: { text: '', from_me: false, deleted: false } }),
  group({ id: 'chat-support', name: 'Support', unread: 0, notify: 'mentions', last_activity_at: day('12', '10:15'), last_message: { text: 'The new rota is in the calendar.', from_me: false, deleted: false } },
    { follows: { kind: 'group', id: 'grp-support', name: 'Support' }, member_count: 4 }),
  direct({ id: 'chat-katherine', peer: peer('user-katherine', KATHERINE, { can_write: false, reason: `${KATHERINE} has not set up Chat yet.` }),
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
  // A group chat: names and initials, a former colleague, mentions, who read, and the lines when people come and go.
  'chat-planning': [
    message('p1', false, ROBIN, day('12', '10:02'), 'The racks for aisle 4 arrive next week.', { sender_user_id: null, former_colleague: true }),
    { kind: 'left', id: 'pn1', user_id: null, name: ROBIN, created_at: day('12', '17:30') },
    { kind: 'joined', id: 'pn2', user_id: 'user-casey', name: 'Casey Example', created_at: day('14', '08:10') },
    blairs('p2', day('14', '08:15'), 'Welcome Casey! We plan the week here.'),
    blairs('p3', day('14', '08:16'), 'The delivery list is on the shared drive.'),
    message('p4', false, 'Casey Example', day('14', '08:30'), 'Thanks. I start with the returns.'),
    mine('p5', day('14', '09:02'), '@Blair Example who takes the late delivery on Thursday?', { mentions: ['user-blair'], ...readBy(BLAIR.name, ALEX, 'Casey Example') }),
    blairs('p6', day('14', '09:05'), 'I do. @Alex Example covers the gate.', { mentions: ['user-alex'] }),
    mine('p7', day('15', '09:10'), 'The count for aisle 2 is done.', readBy(BLAIR.name, ALEX)),
    message('p8', false, ALEX, day('15', '09:22'), 'Aisle 3 is next. I need about an hour.'),
    message('p9', false, ALEX, day('15', '09:26'), '@Ada Example can you bring the stock list?', { mentions: ['user-ada'], mentions_me: true }),
  ],
  'chat-support': [message('s1', false, BLAIR.name, day('12', '10:15'), 'The new rota is in the calendar.')],
  'chat-alex': [
    message('a1', false, 'Alex Example', day('14', '16:10'), 'Do you have the ticket numbers for May?'),
    mine('a2', day('14', '16:12'), 'I will send the numbers tomorrow.', { delivery: 'delivered' }),
  ],
  // Files: a picture with its preview, a PDF and another file, a voice message, and an own file on its way.
  'chat-finley': [
    message('f1', false, FINLEY, day('13', '10:02'), 'The gate after this morning\'s delivery.', { files: [file('file-gate', 'Gate 13 June.jpg', 'image/jpeg', 2_411_724, { picture: { width: 1600, height: 900 } })] }),
    message('f2', false, FINLEY, day('13', '10:05'), 'Delivery note and the plan for aisle 4.', { files: [file('file-note', 'Delivery note 4411.pdf', 'application/pdf', 188_416), file('file-stock', 'Stock list June.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 48_230)] }),
    message('f4', false, FINLEY, day('13', '10:24'), '', { files: [file('file-voice', 'Voice message.webm', 'audio/webm;codecs=opus', 233_472, { voice_seconds: 65 })] }),
    mine('f5', day('15', '09:28'), 'The plan as we discussed it.', { seq: null, delivery: 'sending', files: [file('file-plan', 'Site plan.pdf', 'application/pdf', 5_662_310, { state: 'uploading', progress: 0.4 })] }),
  ],
  'chat-katherine': [
    message('k1', false, KATHERINE, day('02', '11:40'), 'The year-end close is on the shared drive, under Finance, in the folder for this year.'),
  ],
  'chat-grace': [mine('g1', '2026-05-28T08:05:00.000Z', null, { deleted: true })],
  'chat-deleted': [message('d1', false, ROBIN, '2025-11-03T13:30:00.000Z', 'Thanks, that worked.', { sender_user_id: null, former_colleague: true })],
  'chat-drew': [],
};

/** Every way a member stands in a chat: the reader (who manages it), online, away, not in it yet, deactivated. */
export const CHAT_MEMBERS: Record<string, ChatMember[]> = {
  'chat-planning': [
    member('user-ada', 'Ada Example', { role: 'manager' }),
    member('user-alex', ALEX),
    member('user-blair', BLAIR.name, { online: true }),
    member('user-casey', 'Casey Example', { online: false, reason: 'Casey Example is not signed in to Chat on any device.' }),
    member('user-drew', 'Drew Example', { active: false, reason: 'Drew Example is deactivated.' }),
    member('user-katherine', KATHERINE, { reason: `${KATHERINE} has not set up Chat yet.` }),
  ],
  'chat-support': [member('user-blair', BLAIR.name, { role: 'manager', online: true }), member('user-ada', 'Ada Example'), member('user-alex', ALEX), member('user-grace', 'Grace Hopper', { reason: 'Chat is off for Grace Hopper.' })],
};

export const CHAT_CANDIDATES: ChatCandidatesResponse = {
  people: [{ id: 'user-alex', email: 'alex@example.com', full_name: ALEX, retention_days: null }, { id: 'user-blair', email: 'blair@example.com', full_name: BLAIR.name, retention_days: null }, { id: 'user-finley', email: 'finley@example.com', full_name: 'Finley Example', retention_days: null }],
  groups: [{ id: 'grp-support', name: 'Support' }],
  everyone: false,
};

/** The engine the pictures and most tests use: ready, with the fixed conversations. */
export const createFixtureChatEngine = (options: MockChatOptions = {}) =>
  createMockChatEngine({ conversations: CHAT_CONVERSATIONS, threads: CHAT_THREADS, members: CHAT_MEMBERS, candidates: CHAT_CANDIDATES, ...options });
