import type { RowDataPacket } from 'mysql2/promise';
import type { AuthRequest, SqlExecutor } from '../types';
import type { InviteCheckResponse, SetupLink } from '../contracts/organisation';

import crypto from 'node:crypto';
import { db } from '../state';
import { MIN_PASSWORD_LENGTH } from '../config';
import { badRequest, notFound } from '../http/errors';
import { getAllowedOriginForRequest } from '../http/request';
import { recordAudit } from './audit';
import { assertCaller } from './caller-proof';
import { acknowledgeAtSignup, getEffectivePolicies, resolvePolicy } from './settings';
import { withTransaction } from './transactions';

// Setup links (0.30, Add person): an administrator adds a person, who sets
// their own password through a link. The link carries 32 random bytes in its
// fragment (/invite#<token>, never in a server or proxy log); only their
// SHA-256 is stored. One live link per person: a new one replaces it,
// revoking deletes it, using it marks it used, and it ends after 7 days. An
// unknown, used, expired or revoked link gets one answer, 404 INVITE_INVALID.
// A person who has a password already gets no link (resetting a password is
// the administrator's password reset). Installation state: an instance
// restore deletes every link (instance-restore.ts).

const LINK_DAYS = 7;
const invalid = () => notFound('INVITE_INVALID', 'This setup link is not valid any more. Ask your administrator for a new one.');
const hashOf = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const iso = (value: unknown) => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

/** The shortest password the person may set: their auth.password_min_length, never below the server's minimum. */
async function passwordMinimum(userId: string, executor: SqlExecutor = db): Promise<number> {
  return Math.max(MIN_PASSWORD_LENGTH, Number((await resolvePolicy(userId, 'auth.password_min_length', executor)).value));
}

async function assertPasswordLength(userId: string, password: string, executor: SqlExecutor = db) {
  const minimum = await passwordMinimum(userId, executor);
  if (password.length < minimum) throw badRequest('PASSWORD_TOO_SHORT', `Password must be at least ${minimum} characters`, { minimum });
}

// Shown once to copy. The page's own origin when the request came from it;
// else a path the page completes.
function linkFor(token: string, expiresAt: unknown, req: AuthRequest | null): SetupLink {
  const origin = req ? getAllowedOriginForRequest(req as Parameters<typeof getAllowedOriginForRequest>[0]) ?? '' : '';
  return { url: `${origin}/invite#${token}`, expires_at: iso(expiresAt) };
}

/**
 * In the caller's transaction, with the person's row locked: a new link for
 * a person without a password; an earlier link stops working.
 */
async function createSetupLink(cx: SqlExecutor, adminId: string, userId: string, req: AuthRequest | null = null): Promise<SetupLink> {
  const [[person]] = await cx.execute<RowDataPacket[]>('SELECT password_hash FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!person) throw notFound('USER_NOT_FOUND', 'User not found');
  if (person.password_hash) throw badRequest('ALREADY_SET_UP', 'This person has set their password. Reset it instead if they lost it.');
  const token = crypto.randomBytes(32).toString('base64url');
  await cx.execute(`INSERT INTO invites (id, user_id, token_hash, created_by, created_at, expires_at)
      VALUES (UUID(), ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL ${LINK_DAYS} DAY)
    ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), created_by = VALUES(created_by), created_at = VALUES(created_at),
      expires_at = VALUES(expires_at), used_at = NULL`, [userId, hashOf(token), adminId]);
  const [[row]] = await cx.execute<RowDataPacket[]>('SELECT expires_at FROM invites WHERE user_id = ?', [userId]);
  await recordAudit({ action: 'admin.setup_link_created', actorId: adminId, targetUserId: userId, req }, cx);
  return linkFor(token, row.expires_at, req);
}

/** POST /api/admin/users/:id/setup-link (users.manage): a new link; the earlier one stops working. */
async function renewSetupLink(adminId: string, userId: string, req: AuthRequest | null = null): Promise<SetupLink> {
  return withTransaction(async cx => {
    await assertCaller(cx);
    return createSetupLink(cx, adminId, userId, req);
  });
}

/** DELETE /api/admin/users/:id/setup-link (users.manage): the person's link stops working. */
async function revokeSetupLink(adminId: string, userId: string, req: AuthRequest | null = null): Promise<{ revoked: boolean }> {
  return withTransaction(async cx => {
    await assertCaller(cx);
    const [result] = await cx.execute<import('mysql2/promise').ResultSetHeader>('DELETE FROM invites WHERE user_id = ? AND used_at IS NULL', [userId]);
    if (result.affectedRows) await recordAudit({ action: 'admin.setup_link_revoked', actorId: adminId, targetUserId: userId, req }, cx);
    return { revoked: result.affectedRows > 0 };
  });
}

/** The people with a live link (for their status, "Invited"). */
async function peopleWithLiveLinks(executor: SqlExecutor = db): Promise<Set<string>> {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT user_id FROM invites WHERE used_at IS NULL AND expires_at > UTC_TIMESTAMP()');
  return new Set(rows.map(row => String(row.user_id)));
}

// The person a live link is for: active and still without a password.
async function personOfLink(token: unknown, executor: SqlExecutor, { lock = false } = {}) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalid();
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT i.user_id, i.expires_at, u.email, u.full_name FROM invites i JOIN users u ON u.id = i.user_id
    WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > UTC_TIMESTAMP() AND u.is_active = TRUE AND u.password_hash = ''${lock ? ' FOR UPDATE' : ''}`, [hashOf(token)]);
  if (!row) throw invalid();
  return { userId: String(row.user_id), email: String(row.email), fullName: row.full_name == null ? null : String(row.full_name), expiresAt: row.expires_at };
}

/** POST /api/auth/invite/check: who the link is for and the rules that will apply to them. */
async function checkInvite(input: unknown): Promise<InviteCheckResponse> {
  const person = await personOfLink((input as { token?: unknown } | null)?.token, db);
  const { rules, revision } = await getEffectivePolicies(person.userId);
  return { email: person.email, full_name: person.fullName, expires_at: iso(person.expiresAt), data_rules: rules, rules_revision: revision };
}

/**
 * POST /api/auth/invite/accept, with the password hashed by the route: sets
 * it, uses up the link and confirms the rules revision the page showed, in
 * one transaction; `open` then opens the session in it (routes/invites.ts).
 */
async function acceptInvite<T>(input: { token: unknown; password: string; passwordHash: string; fullName: string | null; rulesRevision: unknown },
  open: (cx: SqlExecutor, userId: string) => Promise<T>, req: AuthRequest | null = null): Promise<{ userId: string; session: T }> {
  return withTransaction(async cx => {
    const person = await personOfLink(input.token, cx, { lock: true });
    await assertPasswordLength(person.userId, input.password, cx);
    await cx.execute('UPDATE users SET password_hash = ?, full_name = COALESCE(?, full_name) WHERE id = ?', [input.passwordHash, input.fullName, person.userId]);
    await cx.execute('UPDATE invites SET used_at = UTC_TIMESTAMP() WHERE user_id = ?', [person.userId]);
    await acknowledgeAtSignup(person.userId, input.rulesRevision, cx);
    await recordAudit({ action: 'auth.setup_completed', actorId: person.userId, targetUserId: person.userId, req }, cx);
    return { userId: person.userId, session: await open(cx, person.userId) };
  });
}

/** For the route's early answer before the password is hashed: the link's person, or 404 INVITE_INVALID. */
async function inviteeOf(token: unknown): Promise<string> {
  return (await personOfLink(token, db)).userId;
}

export { passwordMinimum, assertPasswordLength, createSetupLink, renewSetupLink, revokeSetupLink, peopleWithLiveLinks, checkInvite, acceptInvite, inviteeOf };
