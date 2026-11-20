// What the Chat screens see of the engine (src/lib/chat/engine.ts fills it).
// The engine keeps every message on the device and does all encryption; the
// screens read snapshots and call actions. Snapshots keep their identity
// until something in them changes, so they can feed useSyncExternalStore.
import type { ChatPeer } from '../../../api/src/contracts/chat';

export type { ChatPeer };

/**
 * Whether Chat can be used on this device now:
 * - `starting`: the module loads, the device enrols or the store opens;
 * - `unsupported`: the browser has WebAssembly or storage switched off (`reason` says which);
 * - `choose-passphrase`: the person has no chat account yet (first Chat open);
 * - `enter-passphrase`: the account exists and this device does not hold the history key;
 * - `ready`;
 * - `failed`: starting failed (`reason`); `restart()` tries again.
 */
export type ChatReadiness =
  | { state: 'starting' }
  | { state: 'unsupported'; reason: string }
  | { state: 'choose-passphrase' }
  | { state: 'enter-passphrase' }
  | { state: 'ready' }
  | { state: 'failed'; reason: string };

/** The history being read from the archive after the passphrase; `total` is unknown until the server said it. */
export interface ChatRestoreProgress { done: number; total: number | null }

export interface ChatConversationSummary {
  id: string;
  peer: ChatPeer;
  unread: number;
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

export interface ChatThreadMessage {
  kind: 'message';
  id: string;
  /** null while it is in the outbox. */
  seq: number | null;
  /** null once the sender was deleted. */
  sender_user_id: string | null;
  sender_name: string;
  from_me: boolean;
  /** null when deleted or unreadable. */
  text: string | null;
  reply_to: { id: string; sender_name: string; text: string | null } | null;
  edited: boolean;
  deleted: boolean;
  /** It reached this device but could not be decrypted ("could not be read"); it costs only itself. */
  unreadable: boolean;
  created_at: string;
  /** Own messages only; null for the other person's. */
  delivery: ChatDeliveryState | null;
  error: string | null;
}

/** "<name> added a device": a device of someone in the chat joined it. */
export interface ChatThreadNotice {
  kind: 'device-added';
  id: string;
  user_id: string | null;
  name: string;
  created_at: string;
}

export type ChatThreadItem = ChatThreadMessage | ChatThreadNotice;

export interface ChatEngineSnapshot {
  readiness: ChatReadiness;
  /** Latest activity first. */
  conversations: ChatConversationSummary[];
  /** Whether this device holds the history key, so a new passphrase needs only the account password. */
  holds_history_key: boolean;
  restore: ChatRestoreProgress | null;
}

export interface ChatEngine {
  /** Called whenever a snapshot or a thread changed; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  snapshot(): ChatEngineSnapshot;
  /** A conversation's items, oldest first. */
  thread(conversationId: string): ChatThreadItem[];

  /** Finds or makes the direct conversation with a person and returns its id. */
  openConversation(userId: string): Promise<string>;
  /** Puts a message in the outbox and returns at once; its delivery state follows. Up to 8,000 characters. */
  send(conversationId: string, text: string, replyTo?: string | null): void;
  /** A new text for one's own message. */
  edit(messageId: string, text: string): void;
  /** Deletes one's own message for both sides; rejects with the server's refusal (POLICY_FORBIDS). */
  delete(messageId: string): Promise<void>;
  /** Sends a failed message again. */
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
  /** A new history key when no device holds the old one and its passphrase is forgotten: the archive sealed to the old key is lost. */
  startNewKey(currentPassword: string, passphrase: string): Promise<void>;
}
