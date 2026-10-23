import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { escapeLike } from './sql';
import { ownedMailPath } from './mail-storage';

// Conversations (docs/MAIL_SYNC.md, Threads). A message's thread_key is the
// SHA-256 of its conversation's root Message-ID, per user:
//
// 1. The root is the first id of References, else the id of In-Reply-To.
//    When the root message is stored (same user) with a key, its key is used;
//    so a reply naming only its parent joins the parent's conversation even
//    when the parent's own root lies further up.
// 2. A message without either header whose subject starts with a reply or
//    forward prefix (Re:, AW:, Fwd:, WG:, ...) joins the most recent earlier
//    message of the user with the same subject (prefixes and list tags
//    removed) within SUBJECT_WINDOW_DAYS, when the two share a correspondent
//    other than the user's own accounts. A subject without a prefix never
//    joins anything: two unrelated "Invoice" mails stay apart.
// 3. Otherwise the message starts its own conversation: the hash of its own
//    Message-ID, or of its row id when it has none.
//
// The arrival order does not matter: storing a message whose key is not the
// hash of its own Message-ID moves the messages keyed by that hash (replies
// that arrived before it and named it as their root) into its conversation.
// Header values are untrusted: only well-formed ids are kept, each at most as
// long as the message_id column, and References is shortened as RFC 5322
// suggests (the first id and the most recent ones).

const MESSAGE_ID_MAX_CHARS = 500;
const REFERENCES_MAX_IDS = 40;
const REFERENCES_MAX_CHARS = 8000;
const SUBJECT_WINDOW_DAYS = 60;
// The subject fallback reads at most this many of the user's latest messages
// before the message, so a busy mailbox costs the same as a quiet one.
const SUBJECT_SCAN_ROWS = 2000;
const HEADER_READ_MAX_BYTES = 64 * 1024;
const HEADER_READ_CHUNK = 16 * 1024;

// msg-id (RFC 5322 3.6.4) in angle brackets: no whitespace, brackets or control characters.
// eslint-disable-next-line no-control-regex -- the control characters are what it excludes
const MESSAGE_ID = /<[^<>\s\x00-\x1f\x7f]{1,498}>/g;
const KEY = /^[0-9a-f]{64}$/;

/** Every well-formed message id in a header value (a string, or mailparser's array), in order, once each. */
function messageIds(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const entry of values) {
    if (typeof entry !== 'string') continue;
    for (const match of entry.slice(0, 200_000).match(MESSAGE_ID) || []) {
      if (match.length <= MESSAGE_ID_MAX_CHARS && !ids.includes(match)) ids.push(match);
    }
  }
  return ids;
}

/** One message id: the stored Message-ID, or the first id of a header value. */
function normalizeMessageId(value: unknown): string | null {
  return messageIds(typeof value === 'string' ? value.trim() : null)[0] ?? null;
}

/** The first id and the latest ones, within REFERENCES_MAX_IDS and REFERENCES_MAX_CHARS. */
function boundReferences(ids: readonly string[]): string[] {
  let kept = ids.length > REFERENCES_MAX_IDS ? [ids[0], ...ids.slice(ids.length - REFERENCES_MAX_IDS + 1)] : [...ids];
  while (kept.length > 1 && kept.join(' ').length > REFERENCES_MAX_CHARS) kept = [kept[0], ...kept.slice(2)];
  return kept;
}

interface ThreadHeaders { inReplyTo: string | null; references: string[] }
/** In-Reply-To (its first id) and References from untrusted header values. */
function threadHeaders({ inReplyTo, references }: { inReplyTo?: unknown; references?: unknown }): ThreadHeaders {
  return { inReplyTo: messageIds(inReplyTo)[0] ?? null, references: boundReferences(messageIds(references)) };
}
const storedReferences = (references: readonly string[]) => references.length ? references.join(' ') : null;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
/** The key of a conversation whose root has this Message-ID. */
function threadKeyFor(messageId: string) { return sha256(messageId); }
/** The key of a message that has no Message-ID: its own row. */
function localThreadKey(emailId: string) { return sha256(`unihub-email:${emailId}`); }
const validKey = (value: unknown): string | null => typeof value === 'string' && KEY.test(value) ? value : null;

const REPLY_PREFIXES = ['re', 'aw', 'antw', 'antwort', 'sv', 'vs', 'ref', 'réf', 'rif', 'res', 'wg', 'fw', 'fwd', 'tr', 'enc', 'odp', 'pd', 'ynt', 'ilt',
  '回复', '回覆', '答复', '转发', '轉寄', '返信', '転送'];
const PREFIX = new RegExp(`^(?:${REPLY_PREFIXES.join('|')})\\s*(?:\\[\\d+\\]|\\(\\d+\\))?\\s*[:：]\\s*`, 'iu');
const LIST_TAG = /^\[[^\]]{1,40}\]\s*/u;
/** The subject without reply/forward prefixes and list tags, lower case; prefixed says whether it had a reply or forward prefix. */
function normalizeSubject(subject: unknown) {
  let rest = String(subject ?? '').slice(0, 1000).replace(/\s+/g, ' ').trim();
  let prefixed = false;
  for (let round = 0; round < 20; round++) {
    const tag = LIST_TAG.exec(rest);
    if (tag) { rest = rest.slice(tag[0].length); continue; }
    const prefix = PREFIX.exec(rest);
    if (!prefix) break;
    rest = rest.slice(prefix[0].length);
    prefixed = true;
  }
  return { base: rest.toLowerCase(), prefixed };
}

/** Bare lower-case addresses of stored recipients ("Name <a@example.com>" or "a@example.com"), a JSON list or an array. */
function addressesOf(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    let list = value;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = [list]; } }
    for (const entry of Array.isArray(list) ? list : []) {
      if (typeof entry !== 'string') continue;
      const address = (/<([^<>\s]+@[^<>\s]+)>/.exec(entry)?.[1] ?? entry).trim().toLowerCase();
      if (address.includes('@') && address.length <= 320) out.add(address);
    }
  }
  return [...out];
}

interface ThreadInput {
  userId: string;
  emailId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  subject: string | null;
  receivedAt: Date;
  /** The message's sender and recipients (bare or "Name <address>"). */
  participants: string[];
}

/**
 * The thread_key of a message under the rule above. Null only when the subject
 * fallback found an earlier message whose own key is not known yet (mail from
 * before 0.24 that the backfill has not reached): the backfill keys it later.
 */
async function resolveThreadKey(executor: SqlExecutor, input: ThreadInput): Promise<string | null> {
  const own = normalizeMessageId(input.messageId);
  const root = input.references[0] ?? input.inReplyTo;
  if (root && root !== own) {
    const [stored] = await executor.execute<RowDataPacket[]>(`SELECT thread_key FROM emails
      WHERE user_id = ? AND message_id = ? AND id <> ? AND thread_key IS NOT NULL ORDER BY received_at, id LIMIT 1`,
    [input.userId, root, input.emailId]);
    return validKey(stored[0]?.thread_key) ?? threadKeyFor(root);
  }
  if (!root) {
    const joined = await subjectThread(executor, input);
    if (joined !== undefined) return joined;
  }
  return own ? threadKeyFor(own) : localThreadKey(input.emailId);
}

// undefined: no earlier message qualifies; null: one does, but has no key yet.
async function subjectThread(executor: SqlExecutor, input: ThreadInput): Promise<string | null | undefined> {
  const { base, prefixed } = normalizeSubject(input.subject);
  if (!prefixed || !base) return undefined;
  const [accounts] = await executor.execute<RowDataPacket[]>('SELECT email_address FROM mail_accounts WHERE user_id = ?', [input.userId]);
  const mine = new Set(accounts.map(row => String(row.email_address || '').toLowerCase()));
  const theirs = new Set(addressesOf(input.participants).filter(address => !mine.has(address)));
  if (!theirs.size) return undefined;
  const received = input.receivedAt instanceof Date && !Number.isNaN(input.receivedAt.getTime()) ? input.receivedAt : new Date();
  const since = new Date(received.getTime() - SUBJECT_WINDOW_DAYS * 86_400_000);
  const [candidates] = await executor.execute<RowDataPacket[]>(`SELECT recent.id, recent.subject, recent.thread_key FROM (
      SELECT id, subject, thread_key, received_at FROM emails
      WHERE user_id = ? AND received_at <= ? AND received_at >= ? AND id <> ? AND is_draft = FALSE
      ORDER BY received_at DESC, id DESC LIMIT ${SUBJECT_SCAN_ROWS}
    ) recent WHERE recent.subject LIKE ? ORDER BY recent.received_at DESC, recent.id DESC LIMIT 20`,
  [input.userId, received, since, input.emailId, `%${escapeLike(base)}%`]);
  const sameSubject = candidates.filter(row => normalizeSubject(row.subject).base === base);
  if (!sameSubject.length) return undefined;
  const [people] = await executor.execute<RowDataPacket[]>(`SELECT id, from_address, to_addresses, cc_addresses FROM emails
    WHERE user_id = ? AND id IN (${sameSubject.map(() => '?').join(', ')})`, [input.userId, ...sameSubject.map(row => row.id)]);
  const peopleOf = new Map(people.map(row => [row.id, addressesOf([row.from_address], row.to_addresses, row.cc_addresses)]));
  const match = sameSubject.find(row => (peopleOf.get(row.id) || []).some(address => theirs.has(address)));
  if (!match) return undefined;
  return validKey(match.thread_key);
}

/**
 * Moves the messages keyed by the hash of this message's own Message-ID (its
 * replies stored before it) into its conversation. Run in the transaction
 * that stores the message's key.
 */
async function adoptReplies(executor: SqlExecutor, { userId, messageId, threadKey }: { userId: string; messageId: string | null; threadKey: string | null }) {
  const own = normalizeMessageId(messageId);
  if (!own || !threadKey || threadKey === threadKeyFor(own)) return;
  await executor.execute('UPDATE emails SET thread_key = ? WHERE user_id = ? AND thread_key = ?', [threadKey, userId, threadKeyFor(own)]);
}

/**
 * In-Reply-To and References from the header part of a stored raw message,
 * reading at most HEADER_READ_MAX_BYTES. Both raw formats (exact octets and
 * legacy normalized text) are RFC 822 files. Null when the file is missing or
 * lies outside the owner's directory; a read error other than a missing file
 * is thrown so the caller can try again later.
 */
async function readRawThreadHeaders(storedPath: unknown, userId: string): Promise<ThreadHeaders | null> {
  const resolved = typeof storedPath === 'string' ? ownedMailPath('raw', storedPath, userId) : null;
  if (!resolved) return null;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < HEADER_READ_MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(HEADER_READ_CHUNK, HEADER_READ_MAX_BYTES - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      if (/\r?\n\r?\n/.test(buffer.subarray(0, bytesRead).toString('latin1'))) break;
    }
    return parseThreadHeaders(Buffer.concat(chunks).toString('latin1'));
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** In-Reply-To and References of a raw header block (the text before the first empty line). */
function parseThreadHeaders(text: string): ThreadHeaders {
  const end = text.search(/\r?\n\r?\n/);
  const block = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const header = (name: string) => {
    const match = new RegExp(`^${name}:(.*)$`, 'im').exec(block);
    return match ? match[1] : null;
  };
  return threadHeaders({ inReplyTo: header('In-Reply-To'), references: header('References') });
}

export {
  MESSAGE_ID_MAX_CHARS,
  SUBJECT_WINDOW_DAYS,
  HEADER_READ_MAX_BYTES,
  messageIds,
  normalizeMessageId,
  boundReferences,
  threadHeaders,
  storedReferences,
  threadKeyFor,
  localThreadKey,
  normalizeSubject,
  addressesOf,
  resolveThreadKey,
  adoptReplies,
  readRawThreadHeaders,
  parseThreadHeaders,
};
export type { ThreadHeaders, ThreadInput };
