// How the Chat screens read the engine, and the words they share.
import { useCallback, useSyncExternalStore } from 'react';
import { format, isThisYear, isToday, isYesterday } from 'date-fns';
import type { ChatConversationSummary, ChatDeviceName, ChatEngine, ChatEngineSnapshot, ChatMember, ChatThreadItem, ChatThreadMessage } from '@/lib/chat/types';
import { deviceLabel } from '@/lib/devices-api';
import { MIN_PASSPHRASE_LENGTH } from '@/lib/chat/key-backup';

const never = () => () => {};

function useEngineStore<T>(engine: ChatEngine | null, read: () => T): T {
  const subscribe = useCallback((notify: () => void) => (engine ? engine.subscribe(notify) : never()), [engine]);
  return useSyncExternalStore(subscribe, read);
}

/** The engine's snapshot, read again whenever the engine says something changed; null without an engine. */
export function useChatSnapshot(engine: ChatEngine | null): ChatEngineSnapshot | null {
  return useEngineStore(engine, () => (engine ? engine.snapshot() : null));
}

/** A conversation's items; null until the device's store was read. */
export function useChatThread(engine: ChatEngine, conversationId: string): ChatThreadItem[] | null {
  return useEngineStore(engine, () => engine.thread(conversationId));
}

/** A chat's people; null while they load and after a load that failed (asking again tries again). */
export function useChatMembers(engine: ChatEngine, conversationId: string): ChatMember[] | null {
  return useEngineStore(engine, () => engine.members(conversationId));
}

/** The person's devices by name, as Settings › Security › Devices lists them. */
export const deviceNames = (devices: ChatDeviceName[]) => devices.map(deviceLabel).join(', ');

/** The longest message the server takes. */
export const MAX_MESSAGE_LENGTH = 8000;

export const chatHref = (conversationId: string) => `/chat?c=${encodeURIComponent(conversationId)}`;

export const messageTime = (iso: string) => format(new Date(iso), 'HH:mm');

/** A conversation's last activity in its row: the time today, then "Yesterday", then the date. */
export function listTime(iso: string) {
  const date = new Date(iso);
  if (isToday(date)) return format(date, 'HH:mm');
  if (isYesterday(date)) return 'Yesterday';
  return format(date, isThisYear(date) ? 'd MMM' : 'd MMM yyyy');
}

/** The heading over a day's messages. */
export function dayLabel(iso: string) {
  const date = new Date(iso);
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, isThisYear(date) ? 'EEEE d MMMM' : 'd MMMM yyyy');
}

/** The second line of a conversation's row. */
export function lastMessageLine({ last_message: last }: ChatConversationSummary) {
  if (!last) return 'No messages yet';
  if (last.deleted) return 'Message deleted';
  if (last.text === null) return 'Message could not be read';
  // A message without text carries files.
  if (!last.text) return last.from_me ? 'You sent a file' : 'File';
  return last.from_me ? `You: ${last.text}` : last.text;
}

/** How far an own message got, once the server has it: "Read by 3 of 7" in a group chat, where the people who read it are known. */
export function deliveryLabel({ delivery, read_by: readBy }: ChatThreadMessage) {
  if (readBy?.people.length) return `Read by ${readBy.people.length} of ${readBy.of}`;
  return delivery === 'sent' ? 'Sent' : delivery === 'delivered' ? 'Delivered' : delivery === 'read' ? 'Read' : null;
}

/** A length in minutes and seconds: of a voice message, or of the recording so far. */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

const LINK = /(https?:\/\/[^\s<>"]+[^\s<>".,:;!?)\]}'])/g;

/**
 * A message's text in pieces: plain text, the web addresses in it, and
 * "@name" for each of `people`. Nothing else becomes a link or a mention.
 */
export function textParts<P extends { name: string }>(text: string, people: P[] = []): { text: string; href?: string; mention?: P }[] {
  // The longest name first: "@Alex Example" is not a mention of an "Alex" who is in the chat too.
  const names = people.map(person => person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length);
  const mention = names.length ? new RegExp(`(@(?:${names.join('|')}))(?![\\p{L}\\p{N}])`, 'gu') : null;
  // split() with one capture group puts the addresses, and then the mentions, at the odd places.
  return text.split(LINK).flatMap((part, index) => (index % 2 ? [{ text: part, href: part }]
    : !mention ? [{ text: part }]
    // Not inside a word: the "@" of a mail address mentions nobody.
    : part.split(mention).map((piece, at, pieces) => (at % 2 && !/[\p{L}\p{N}]$/u.test(pieces[at - 1]) ? { text: piece, mention: people.find(person => piece === `@${person.name}`) } : { text: piece }))))
    .filter(part => part.text);
}

/** A passphrase's characters as the engine counts them. */
export const passphraseLength = (passphrase: string) => [...passphrase.normalize('NFC')].length;

/**
 * A rough hint, not a measure: 0 while too short, then weak, fair or strong.
 * Length counts most; one repeated character or one kind of character keeps
 * a short passphrase weak.
 */
export function passphraseStrength(passphrase: string): { level: 0 | 1 | 2 | 3; hint: string } {
  const length = passphraseLength(passphrase);
  const missing = MIN_PASSPHRASE_LENGTH - length;
  if (missing > 0) return { level: 0, hint: length ? `${missing} more character${missing === 1 ? '' : 's'}` : `At least ${MIN_PASSPHRASE_LENGTH} characters` };
  const kinds = [/\p{Ll}/u, /\p{Lu}/u, /\d/, /[^\p{L}\d]/u].filter(kind => kind.test(passphrase)).length;
  if (new Set(passphrase.toLowerCase()).size < 6 || (length < 16 && kinds < 2)) return { level: 1, hint: 'Weak. Make it longer, or use several unrelated words.' };
  if (length >= 20 && kinds >= 2) return { level: 3, hint: 'Strong.' };
  return { level: 2, hint: 'Fair. Longer is stronger: four or more unrelated words work well.' };
}
