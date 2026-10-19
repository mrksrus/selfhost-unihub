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

async function createSession({ userId, token, expiresAt }: { userId: string; token: SessionToken; expiresAt: Date }, executor: SqlExecutor = db) {
  await executor.execute('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)', [userId, sessionKey(token), expiresAt]);
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
};
