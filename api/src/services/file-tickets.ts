import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { FileTicketKind, FileTicketResponse } from '../contracts/files';

import crypto from 'node:crypto';
import { db } from '../state';
import { JWT_SECRET } from '../config';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../http/errors';
import { attachmentFileForUser } from './mail-attachments';
import { isModuleEnabled } from './module-settings';
import { getActiveRestoreSections } from './restore-locks';
import { liveSessionId } from './sessions';

// Download tickets (F9). Whatever fetches a file outside the page (the Android
// app's Open with, Save and Share; later the system downloader and backup
// downloads) gets a ticket for that one file instead of the session cookie,
// which never leaves the WebView or browser.
//
// A ticket is bound to its user and to the session that asked for it. Until
// devices are records (F5, 0.29) the session is the device: ending it (signing
// out, "sign out everywhere", ending it in Settings) deletes its tickets with
// it (foreign key), and redemption checks again that it is live. The device id
// then takes the place of session_id, with the same cascade and check.
//
// Single use: redemption deletes the row before the file is sent, so a second
// request with the same URL is refused even while the first one streams. The
// answer therefore has no Range support (a resumed request would be a second
// use); the app fetches the whole file in one request and asks the page for a
// new ticket to retry. The URL must be used within TICKET_TTL_SECONDS of being
// issued, which only has to cover the hand-over from the page to the app.
//
// The database keeps an HMAC of each token under a key derived from the
// installation's signing secret, never the token: a copy of the table fetches
// nothing. The table is installation data: never exported or restored.

const TICKET_TTL_SECONDS = 60;
// Unused tickets one session may hold at a time; each action asks for one just before it is used.
const MAX_OPEN_TICKETS_PER_SESSION = 20;
const TICKET_PATH = '/api/files/tickets/';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

interface TicketFile { path: string; size: number; filename: string; contentType: string }
interface TicketKindPolicy {
  // The module whose switch gates the file, and the recovery section whose
  // running restore makes it unavailable; both are checked at issue and at use.
  module: string;
  restoreSection: string;
  /** The user's own file for this record, or null. */
  file(userId: string, resourceId: string): Promise<TicketFile | null>;
}

const KINDS: Readonly<Record<FileTicketKind, TicketKindPolicy>> = Object.freeze({
  'mail-attachment': { module: 'mail', restoreSection: 'mail', file: (userId: string, id: string) => attachmentFileForUser(userId, id) },
});

let ticketKey: Buffer | null = null;
function tokenHash(token: string) {
  ticketKey ??= Buffer.from(crypto.hkdfSync('sha256', String(JWT_SECRET), Buffer.alloc(0), 'unihub file tickets v1', 32));
  return crypto.createHmac('sha256', ticketKey).update(token).digest('hex');
}

const gone = () => new ApiError(410, 'TICKET_INVALID', 'This download link has expired or was already used. Try again from UniHub.');

function parseRequest(body: unknown): { kind: FileTicketKind; id: string } {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof input.kind !== 'string' || !Object.hasOwn(KINDS, input.kind)) throw badRequest('TICKET_KIND_INVALID', 'Unknown file kind');
  if (typeof input.id !== 'string' || !RESOURCE_ID_PATTERN.test(input.id)) throw badRequest('TICKET_ID_INVALID', 'Invalid file id');
  return { kind: input.kind as FileTicketKind, id: input.id };
}

// The same refusals the request boundary gives a route of this module.
async function assertAvailable(userId: string, policy: TicketKindPolicy) {
  if (!await isModuleEnabled(userId, policy.module)) {
    throw forbidden('MODULE_DISABLED', 'This module is disabled. Enable it in Settings.', { module: policy.module });
  }
  if ((await getActiveRestoreSections(userId)).has(policy.restoreSection)) {
    throw new ApiError(409, 'RESTORE_IN_PROGRESS', `Restore in progress for ${policy.restoreSection}. This section is temporarily read-only.`);
  }
}

/** Issues a ticket for one of the user's files, bound to the session that asks (its token). */
async function createFileTicket(userId: string, sessionToken: string | null, body: unknown, executor: SqlExecutor = db): Promise<FileTicketResponse> {
  const { kind, id } = parseRequest(body);
  const sessionId = await liveSessionId(userId, sessionToken, executor);
  if (!sessionId) throw unauthorized('SESSION_REQUIRED', 'Unauthorized');
  const policy = KINDS[kind];
  await assertAvailable(userId, policy);
  const file = await policy.file(userId, id);
  if (!file) throw notFound('FILE_NOT_FOUND', 'File not found');

  // Expired tickets are only ever left behind by this route; tidy a batch each time.
  await executor.execute('DELETE FROM file_tickets WHERE expires_at <= UTC_TIMESTAMP() LIMIT 500');
  const [[open]] = await executor.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM file_tickets WHERE session_id = ?', [sessionId]);
  if (Number(open.n) >= MAX_OPEN_TICKETS_PER_SESSION) throw new ApiError(429, 'TICKET_LIMIT', 'Too many downloads at once. Wait a minute and try again.');

  const token = crypto.randomBytes(32).toString('base64url');
  await executor.execute(`INSERT INTO file_tickets (id, token_hash, user_id, session_id, kind, resource_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ${TICKET_TTL_SECONDS} SECOND)`, [crypto.randomUUID(), tokenHash(token), userId, sessionId, kind, id]);
  return {
    url: TICKET_PATH + token,
    expires_at: new Date(Date.now() + TICKET_TTL_SECONDS * 1000).toISOString(),
    filename: file.filename,
    content_type: file.contentType,
    size: file.size,
  };
}

interface TicketRow extends RowDataPacket { id: string; user_id: string; kind: string; resource_id: string; fresh: number; live: number | null; is_active: number }

/**
 * Uses a ticket: the file to send, or a refusal. The ticket is gone afterwards
 * whatever the outcome. Everything a signed-in request would be checked for is
 * checked again here, for the ticket's user: the session is live, the user
 * active, the module on, no restore of its section running, the file theirs.
 */
async function redeemFileTicket(token: string, executor: SqlExecutor = db): Promise<TicketFile> {
  if (!TOKEN_PATTERN.test(token)) throw gone();
  const hash = tokenHash(token);
  const [rows] = await executor.execute<TicketRow[]>(`SELECT t.id, t.user_id, t.kind, t.resource_id, t.expires_at > UTC_TIMESTAMP() AS fresh,
      s.expires_at > UTC_TIMESTAMP() AS live, u.is_active
    FROM file_tickets t INNER JOIN users u ON u.id = t.user_id
    LEFT JOIN sessions s ON s.id = t.session_id AND s.user_id = t.user_id
    WHERE t.token_hash = ?`, [hash]);
  const ticket = rows[0];
  if (!ticket) throw gone();
  const [consumed] = await executor.execute<ResultSetHeader>('DELETE FROM file_tickets WHERE id = ? AND token_hash = ?', [ticket.id, hash]);
  // Another request used it in between.
  if (consumed.affectedRows !== 1) throw gone();
  if (!Number(ticket.fresh) || !Number(ticket.live) || !Number(ticket.is_active)) throw gone();
  const policy = Object.hasOwn(KINDS, ticket.kind) ? KINDS[ticket.kind as FileTicketKind] : null;
  if (!policy) throw gone();
  await assertAvailable(ticket.user_id, policy);
  const file = await policy.file(ticket.user_id, ticket.resource_id);
  if (!file) throw notFound('FILE_NOT_FOUND', 'File not found');
  return file;
}

export { createFileTicket, redeemFileTicket, TICKET_TTL_SECONDS, MAX_OPEN_TICKETS_PER_SESSION, TICKET_PATH };
export type { TicketFile };
