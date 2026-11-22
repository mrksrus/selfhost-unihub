// What the Chat screens see of the engine (src/lib/chat/engine.ts fills it).
// The engine keeps every message on the device and does all encryption; the
// screens read snapshots and call actions. Snapshots keep their identity
// until something in them changes, so they can feed useSyncExternalStore.
import type {
  ChatCallEntry, ChatCandidatesResponse, ChatDeviceName, ChatFollow, ChatMember, ChatNotify, ChatPeer, ChatRetentionDays, ChatRole,
} from '../../../api/src/contracts/chat';

export type { ChatCallEntry, ChatCandidatesResponse, ChatDeviceName, ChatFollow, ChatMember, ChatNotify, ChatPeer, ChatRetentionDays, ChatRole };

/**
 * Whether Chat can be used on this device now:
 * - `starting`: the module loads, the device enrols or the store opens;
 * - `unsupported`: the browser has WebAssembly or storage switched off (`reason` says which);
 * - `choose-passphrase`: the person has no chat account yet (first Chat open); a device waits
 *   until then, and choosing the passphrase sets Chat up and joins it;
 * - `waiting`: the account exists and this device has not joined Chat, so it gets nothing of it. It joins with the
 *   passphrase (enterPassphrase) or an approval from one of `approvers`, the person's
 *   devices in Chat (askApproval; `code` is shown while the request is open, until `code_expires_at`, ten minutes);
 * - `enter-passphrase`: the device joined (before devices waited) but does not hold the history key;
 * - `ready`;
 * - `failed`: starting failed (`reason`); `restart()` tries again.
 */
export type ChatReadiness =
  | { state: 'starting' }
  | { state: 'unsupported'; reason: string }
  | { state: 'choose-passphrase' }
  | { state: 'waiting'; approvers: ChatDeviceName[]; code: string | null; code_expires_at: string | null }
  | { state: 'enter-passphrase' }
  | { state: 'ready' }
  | { state: 'failed'; reason: string };

/**
 * A waiting device of the person asks this one to let it into Chat; `code` is the one that device shows.
 * `device` is named from that device's own user agent, which it chooses; `signed_in_at` is when the server
 * saw it sign in (null when it is no longer in the device list).
 */
export interface ChatApprovalRequest { chat_device_id: string; device: ChatDeviceName; requested_at: string; code: string; signed_in_at: string | null }

/** The history being read from the archive after the passphrase; `total` is unknown until the server said it. */
export interface ChatRestoreProgress { done: number; total: number | null }

/** What a group chat is beyond its name. */
export interface ChatGroupSummary {
  /** null for a chat of chosen people. */
  follows: ChatFollow | null;
  role: ChatRole;
  member_count: number;
  /** Who added this person ("You were added by …"); null for its creator, in a followed chat, or once that person is gone. */
  added_by: string | null;
}

export interface ChatConversationSummary {
  id: string;
  kind: 'direct' | 'group';
  /** The chat's name: the other person's in a direct chat. */
  name: string;
  /** The other person of a direct chat. In a group chat the chat itself (user_id null, its name), so a screen made for direct chats still shows it. */
  peer: ChatPeer;
  /** null in a direct chat. */
  group: ChatGroupSummary | null;
  unread: number;
  /** An unread message mentions this person (the "@" mark). */
  mentioned: boolean;
  /** Several groups or pages are being read after a time away ("catching up"). */
  catching_up: boolean;
  notify: ChatNotify;
  /** Messages older than this many days are deleted, from retention_from on; both null while messages are kept. */
  retention_days: ChatRetentionDays | null;
  retention_from: string | null;
  last_activity_at: string | null;
  /** The newest message, for the list's second line; null in a new conversation. */
  last_message: { text: string | null; from_me: boolean; deleted: boolean } | null;
}

/**
 * An own message's way to the other person: `sending` while in the outbox,
 * `failed` when it was refused and waits for `retry()` (`error` says why),
 * then `sent`, `delivered` and `read` (read only when both have receipts on).
 */
export type ChatDeliveryState = 'sending' | 'failed' | 'sent' | 'delivered' | 'read';

/** A file to send: a picked file, a pasted picture or a voice message (with its length). */
export interface ChatFileToSend { blob: Blob; name: string; voice_seconds?: number }

/** A file of a message; openFile() fetches and decrypts it. */
export interface ChatThreadFile {
  id: string;
  name: string;
  /** Its type as the sender's browser named it; '' when unknown. */
  type: string;
  /** In bytes. */
  size: number;
  /** A picture with a preview (picturePreview()): the picture's size in pixels. null for other files. */
  picture: { width: number; height: number } | null;
  /** A voice message's length in seconds; null for other files. */
  voice_seconds: number | null;
  /**
   * An own file on its way: `waiting`, `uploading` (with `progress` from 0 to
   * 1), `failed` (`error` says why, e.g. "Files in a chat can be at most 50
   * MB."; retry() sends the message again), then `sent`. Received files are `sent`.
   */
  state: 'waiting' | 'uploading' | 'failed' | 'sent';
  progress: number | null;
  error: string | null;
}

export interface ChatThreadMessage {
  kind: 'message';
  id: string;
  /** null while it is in the outbox. */
  seq: number | null;
  /** null once the sender was deleted. */
  sender_user_id: string | null;
  /** The directory's name while the sender is active; afterwards the name the message carries. */
  sender_name: string;
  /** The sender was deleted or is deactivated. */
  former_colleague: boolean;
  from_me: boolean;
  /** The people the message mentions (user ids); their names are in the text as "@name". */
  mentions: string[];
  mentions_me: boolean;
  /** null when deleted or unreadable; '' for a message of files only. */
  text: string | null;
  /** Up to 10; none when deleted. */
  files: ChatThreadFile[];
  reply_to: { id: string; sender_name: string; text: string | null } | null;
  edited: boolean;
  deleted: boolean;
  /** It reached this device but could not be decrypted ("could not be read"); it costs only itself. */
  unreadable: boolean;
  created_at: string;
  /** Own messages only; null for the other person's. */
  delivery: ChatDeliveryState | null;
  /**
   * An own message in a group chat: who read it, of the other people with
   * read receipts on ("Read by 3 of 7"); null in a direct chat, for others'
   * messages, while receipts are off for this person, or before members().
   */
  read_by: { people: { user_id: string; name: string }[]; of: number } | null;
  /** An own edit still in the outbox (`sending`) or refused (`failed`, with `error`; `retry()` sends it again); the text shown is already the new one. */
  edit_state: 'sending' | 'failed' | null;
  error: string | null;
}

/**
 * A line between messages, worked out from the people of two groups:
 * `device-added` ("<name> added a device"), `joined`, or `left` (left or was
 * removed: the device cannot tell which).
 */
export interface ChatThreadNotice {
  kind: 'device-added' | 'joined' | 'left';
  id: string;
  user_id: string | null;
  name: string;
  created_at: string;
}

/** A call's line, written by the server when the call ended: who called whom, how it ended, when (`call`). */
export interface ChatThreadCall {
  kind: 'call';
  id: string;
  seq: number;
  call: ChatCallEntry;
  /** This person called. */
  from_me: boolean;
  created_at: string;
}

export type ChatThreadItem = ChatThreadMessage | ChatThreadNotice | ChatThreadCall;

/** A search hit on this device: a chat by its name (`message_id` null), or a message to open the thread at. */
export interface ChatSearchResult {
  conversation_id: string;
  chat_name: string;
  message_id: string | null;
  sender_name: string | null;
  created_at: string | null;
  /** The chat's name or the message's text. */
  line: string;
  /** Where the query is in `line`, as [start, end). */
  match: [number, number];
}

export interface ChatEngineSnapshot {
  readiness: ChatReadiness;
  /** Latest activity first. */
  conversations: ChatConversationSummary[];
  /** Whether this device holds the history key, so a new passphrase needs only the account password. */
  holds_history_key: boolean;
  restore: ChatRestoreProgress | null;
  /** Open requests to answer, latest first; only on a device that holds the history key, which it hands over. */
  approvals: ChatApprovalRequest[];
  /** startNewKey was refused while these devices are in Chat: the passphrase or an approval there, or signing them out first. */
  new_key_refused: ChatDeviceName[] | null;
}

export interface ChatEngine {
  /** Called whenever a snapshot or a thread changed; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  snapshot(): ChatEngineSnapshot;
  /** A conversation's items, oldest first; null until the device's store was read. */
  thread(conversationId: string): ChatThreadItem[] | null;

  /** Finds or makes the direct conversation with a person and returns its id. */
  openConversation(userId: string): Promise<string>;
  /** Makes a group chat of chosen people or following one organisation group (or everyone) and returns its id; rejects with the server's refusal. */
  createGroup(name: string, people: { user_ids: string[] } | { follow: { kind: 'group'; id: string } | { kind: 'everyone' } }): Promise<string>;
  /** People and organisation groups within reach for a new group chat or for adding to one. */
  candidates(query: string): Promise<ChatCandidatesResponse>;
  /** A chat's people with roles, reasons and marks, managers first; null until fetched (this call starts it), then read again when the chat changes. */
  members(conversationId: string): ChatMember[] | null;
  /** A manager's changes; each rejects with the server's refusal. */
  rename(conversationId: string, name: string): Promise<void>;
  addMembers(conversationId: string, userIds: string[]): Promise<void>;
  removeMember(conversationId: string, userId: string): Promise<void>;
  /** A followed chat becomes a chat of the people it has now. */
  unfollow(conversationId: string): Promise<void>;
  /** Leaves a group chat; it goes from this device's list and store. */
  leave(conversationId: string): Promise<void>;
  /** What the chat notifies this person of. */
  setNotify(conversationId: string, notify: ChatNotify): Promise<void>;
  /** Chats by name and messages by text on this device, chats first, then the newest messages. */
  search(query: string): ChatSearchResult[];
  /**
   * Puts a message in the outbox and returns at once; its delivery state
   * follows. Up to 8,000 characters (none when it has files); `mentions`: up
   * to 20 people of a group chat; `files`: up to 10 of any type, uploaded
   * before the message is posted.
   */
  send(conversationId: string, text: string, replyTo?: string | null, mentions?: string[], files?: ChatFileToSend[]): void;
  /** A file of a message, decrypted, as a Blob of its type (fetched again each time); `onProgress` gets 0 to 1. Rejects when it is gone or damaged. */
  openFile(messageId: string, fileId: string, options?: { onProgress?: (part: number) => void; signal?: AbortSignal }): Promise<Blob>;
  /** A picture's preview (JPEG), kept on this device once fetched; null for a file without one. */
  picturePreview(messageId: string, fileId: string): Promise<Blob | null>;
  /** A new text for one's own message. */
  edit(messageId: string, text: string): void;
  /** Deletes one's own message for both sides; rejects with the server's refusal (POLICY_FORBIDS). A message still in the outbox is discarded instead, its uploads cancelled ("Cancel"). */
  delete(messageId: string): Promise<void>;
  /** Sends a failed message again, with the files not uploaded yet. */
  retry(messageId: string): void;
  /** Moves the read mark to the newest message; call while the conversation is open and visible. */
  markRead(conversationId: string): void;
  /** Fetches what changed; the engine also does it on a hint, a reconnect and when the page shows. */
  sync(): Promise<void>;
  /** Starts again after `failed`. */
  restart(): void;

  /** The first passphrase (at least 12 characters): makes the history key and seals what the device holds. */
  choosePassphrase(passphrase: string): Promise<void>;
  /** Opens the history with the passphrase; rejects with WrongPassphraseError (key-backup.ts) for another one. */
  enterPassphrase(passphrase: string): Promise<void>;
  /** A new passphrase from a device that holds the key; the account password is asked, not the old passphrase. */
  changePassphrase(currentPassword: string, passphrase: string): Promise<void>;
  /** A new history key when no device holds the old one and its passphrase is forgotten: the archive sealed to the old key is lost. Refused while another device is in Chat (`new_key_refused`). */
  startNewKey(currentPassword: string, passphrase: string): Promise<void>;
  /** A waiting device asks the person's devices in Chat to approve it; asking again starts a new code and ten minutes. */
  askApproval(): Promise<void>;
  /** Lets a waiting device of the person in, handing it the history, while its request still shows `code`; rejects with "That request has ended…" otherwise, and on a device without the history key. */
  approve(chatDeviceId: string, code: string): Promise<void>;
  /** "This was not me": the request goes; the device keeps waiting and can be signed out from the device list. */
  dropApproval(chatDeviceId: string): Promise<void>;
}
