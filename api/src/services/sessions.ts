import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor, StoredFlag } from '../types';

import crypto from 'node:crypto';
import { db } from '../state';

// The database keeps the SHA-256 of each session token in sessions.token, never
// the token itself: a copy of the table (a dump, a volume backup) signs no one
// in. Every query that names a session by its token goes through this file and
// hashes the presented token, so a raw token never reaches SQL.
type SessionToken = string;

function sessionKey(token: SessionToken) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

interface SessionRow extends RowDataPacket { id: string; user_id: string; expires_at: Date | string; is_active: StoredFlag }

interface NewSession { userId: string; token: SessionToken; expiresAt: Date; ipAddress?: string | null; userAgent?: string | null }

// The address and browser are shown to the user in Settings > Security so they
// can recognize a device and sign it out.
async function createSession({ userId, token, expiresAt, ipAddress = null, userAgent = null }: NewSession, executor: SqlExecutor = db) {
  await executor.execute('INSERT INTO sessions (user_id, token, expires_at, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)',
    [userId, sessionKey(token), expiresAt, ipAddress?.slice(0, 45) || null, userAgent?.slice(0, 512) || null]);
}

/** The session of this token with its user's active flag, expired or not; null when unknown. */
async function findSession(token: SessionToken, executor: SqlExecutor = db) {
  const [rows] = await executor.execute<SessionRow[]>(`SELECT s.id, s.user_id, s.expires_at, u.is_active
    FROM sessions s INNER JOIN users u ON u.id = s.user_id WHERE s.token = ? LIMIT 1`, [sessionKey(token)]);
  return rows[0] ?? null;
}

async function renewSession(token: SessionToken, expiresAt: Date, executor: SqlExecutor = db) {
  await executor.execute('UPDATE sessions SET expires_at = ? WHERE token = ? AND expires_at > UTC_TIMESTAMP()', [expiresAt, sessionKey(token)]);
}

/** The id of this user's live session for the token, or null. */
async function liveSessionId(userId: string, token: SessionToken | null, executor: SqlExecutor = db) {
  if (!token) return null;
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT id FROM sessions WHERE token = ? AND user_id = ? AND expires_at > UTC_TIMESTAMP()',
    [sessionKey(token), userId]);
  return rows.length ? String(rows[0].id) : null;
}

/** Locks the caller's own session row inside a transaction; false when it no longer exists. */
async function lockOwnSession(userId: string, token: SessionToken | null, connection: SqlExecutor) {
  if (!token) return false;
  const [rows] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM sessions WHERE user_id = ? AND token = ? FOR UPDATE', [userId, sessionKey(token)]);
  return rows.length > 0;
}

async function endSession(token: SessionToken, executor: SqlExecutor = db) {
  const [result] = await executor.execute<ResultSetHeader>('DELETE FROM sessions WHERE token = ?', [sessionKey(token)]);
  return result.affectedRows;
}

/** Signs the user out everywhere except the session of `exceptToken`. */
async function endOtherSessions(userId: string, exceptToken: SessionToken | null, executor: SqlExecutor = db) {
  const [result] = await executor.execute<ResultSetHeader>('DELETE FROM sessions WHERE user_id = ? AND token != ?',
    [userId, exceptToken ? sessionKey(exceptToken) : '']);
  return result.affectedRows;
}

interface ListedSession extends RowDataPacket { id: string; token: string; created_at: Date | string | null; expires_at: Date | string; ip_address: string | null; user_agent: string | null }

/**
 * The user's live sessions, newest first. A session renews at most once a day
 * by moving its expiry SESSION_DAYS ahead, so the last renewal is when it was
 * last used, to the day.
 */
async function listSessions(userId: string, currentToken: SessionToken | null, sessionDays: number, executor: SqlExecutor = db) {
  const current = currentToken ? sessionKey(currentToken) : null;
  const [rows] = await executor.execute<ListedSession[]>(`SELECT id, token, created_at, expires_at, ip_address, user_agent FROM sessions
    WHERE user_id = ? AND expires_at > UTC_TIMESTAMP() ORDER BY created_at DESC, id`, [userId]);
  return rows.map(row => ({
    id: row.id,
    current: row.token === current,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastActiveAt: new Date(new Date(row.expires_at).getTime() - sessionDays * 86_400_000).toISOString(),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  }));
}

/** Ends one of the user's sessions by id; returns its token hash (to close its streams) or null. */
async function endSessionById(userId: string, sessionId: string, executor: SqlExecutor = db) {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT token FROM sessions WHERE id = ? AND user_id = ?', [sessionId, userId]);
  if (!rows.length) return null;
  await executor.execute('DELETE FROM sessions WHERE id = ? AND user_id = ?', [sessionId, userId]);
  return String(rows[0].token);
}

async function endUserSessions(userId: string, executor: SqlExecutor = db) {
  const [result] = await executor.execute<ResultSetHeader>('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return result.affectedRows;
}

export {
  sessionKey,
  createSession,
  findSession,
  renewSession,
  liveSessionId,
  lockOwnSession,
  endSession,
  endOtherSessions,
  endUserSessions,
  listSessions,
  endSessionById,
};
