import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import crypto from 'crypto';
import { conflict } from '../http/errors';

// The account a change chose, as it was when the change read it. A change
// that reads an account, waits (discovery, a login test, a lock) and then
// writes or deletes it carries this snapshot into its final transaction and
// compares it there under the row's lock: another request that changed the
// account meanwhile (its login, password, server, mode) makes the stale one
// refuse with 409 ACCOUNT_CHANGED instead of overwriting or deleting what it
// never saw. One comparison of every column that makes the account what it
// is, so no path compares a chosen few and misses one. The stored password
// is part of it only through a digest of the whole snapshot; the snapshot
// itself holds no secret.

type AccountKind = 'calendar' | 'mail';

const COLUMNS: Readonly<Record<AccountKind, readonly string[]>> = {
  calendar: ['provider', 'base_url', 'discovery_url', 'account_email', 'username', 'encrypted_password'],
  mail: ['provider', 'email_address', 'username', 'imap_host', 'imap_port', 'smtp_host', 'smtp_port', 'encrypted_password',
    'sync_mode', 'delete_emails_on_server', 'is_active', 'disconnected_at'],
};
const TABLE: Readonly<Record<AccountKind, string>> = { calendar: 'calendar_accounts', mail: 'mail_accounts' };

interface AccountSnapshot {
  kind: AccountKind;
  id: string;
  /** A calendar account's mail link as seen; checked on its own, as some changes move it on purpose. */
  link: string | null;
  digest: string;
}

const value = (raw: unknown) => raw instanceof Date ? raw.toISOString() : raw ?? null;

function digestOf(kind: AccountKind, row: Record<string, unknown>) {
  const values = COLUMNS[kind].map(column => {
    if (!(column in row)) throw new Error(`An account snapshot needs ${column}: read the whole row`);
    return value(row[column]);
  });
  return crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

/** The snapshot of a row a change read (SELECT *). */
function accountSnapshot(kind: AccountKind, row: Record<string, unknown> & { id: string }): AccountSnapshot {
  return { kind, id: row.id, link: kind === 'calendar' ? (row.mail_account_id as string | null) ?? null : null, digest: digestOf(kind, row) };
}

const accountChanged = () => conflict('ACCOUNT_CHANGED', 'This account changed in the meantime. Try again.');

/**
 * Throws 409 ACCOUNT_CHANGED unless `row` (read under its lock) is the
 * account of `snapshot`: present, every identity column the same, and for a
 * calendar account a mail link the change allows (`links`, by default the
 * one it saw).
 */
function assertUnchanged(row: Record<string, unknown> | undefined, snapshot: AccountSnapshot, links: readonly (string | null)[] = [snapshot.link]) {
  if (!row || digestOf(snapshot.kind, row) !== snapshot.digest) throw accountChanged();
  if (snapshot.kind === 'calendar' && !links.includes((row.mail_account_id as string | null) ?? null)) throw accountChanged();
}

/** Locks the account's row on the change's connection and compares it (assertUnchanged); returns the row. */
async function lockUnchanged(cx: SqlExecutor, userId: string, snapshot: AccountSnapshot,
  { lock = 'update', links }: { lock?: 'update' | 'share'; links?: readonly (string | null)[] } = {}) {
  const [[row]] = await cx.execute<RowDataPacket[]>(
    `SELECT * FROM ${TABLE[snapshot.kind]} WHERE id = ? AND user_id = ? ${lock === 'update' ? 'FOR UPDATE' : 'LOCK IN SHARE MODE'}`, [snapshot.id, userId]);
  assertUnchanged(row, snapshot, links);
  return row;
}

export { accountSnapshot, assertUnchanged, lockUnchanged };
export type { AccountSnapshot, AccountKind };
