import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../types';

import fs from 'node:fs/promises';
import path from 'node:path';
import { db as defaultDb } from '../state';
import { canRunModule } from './access-policy';
import { withTransaction } from './transactions';
import { rawRoot } from './mail-storage';
import { log } from '../log';
import {
  adoptReplies,
  messageIds,
  readRawThreadHeaders,
  resolveThreadKey,
  storedReferences,
  threadHeaders,
} from './mail-threading';

// Mail stored before 0.24 has no threading headers and no thread_key. The
// worker owner fills them in the background (background-work.ts): from the
// header part of each message's raw file, or, without one, from what the row
// holds (services/mail-threading.ts has the rule).
//
// The rows still to do are their own progress marker: those of a user whose
// thread_key IS NULL, read in id order through idx_emails_user_thread, so a
// restart resumes where the work stopped and a row is never done twice; mail
// restored later from an older archive is picked up the same way. The cursor
// below only spreads one pass over several ticks. A message whose subject
// fallback waits on an earlier message without a key yet stays NULL until a
// later pass. Each write requires the row to be unkeyed still and its raw file
// unchanged, so it never overwrites what an import or restore wrote meanwhile.

const BATCH_ROWS = 200;
const TICK_MAX_ROWS = 600;
const TICK_MAX_MS = 5_000;
// After a tick that found nothing to do, the next ticks are skipped this long.
const IDLE_BACKOFF_MS = 5 * 60_000;

interface BackfillDeps {
  db: SqlExecutor;
  now: () => number;
  /** The mail module may work for this user now (enabled, no restore of its section). */
  mayRun: (userId: string) => Promise<boolean>;
  readHeaders: typeof readRawThreadHeaders;
}
interface BackfillState { cursors: Map<string, string>; idleUntil: number }
const state: BackfillState = { cursors: new Map(), idleUntil: 0 };
// A row whose file cannot be read is tried again each pass; it is logged once.
const reported = new Set<string>();

function defaultDeps(): BackfillDeps {
  return { db: defaultDb, now: Date.now, mayRun: userId => canRunModule(userId, 'mail'), readHeaders: readRawThreadHeaders };
}

interface PendingRow extends RowDataPacket {
  id: string;
  message_id: string | null;
  subject: string | null;
  received_at: Date;
  from_address: string | null;
  to_addresses: unknown;
  cc_addresses: unknown;
  raw_storage_path: string | null;
  in_reply_to: string | null;
  references_header: string | null;
}

/** One bounded slice of the backfill. Returns what it did; `more` when rows are left. */
async function runMailThreadBackfill(overrides: Partial<BackfillDeps> = {}, { maxRows = TICK_MAX_ROWS, maxMs = TICK_MAX_MS, force = false } = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const started = deps.now();
  const result = { keyed: 0, deferred: 0, skippedUsers: 0, more: false };
  if (!force && started < state.idleUntil) return result;
  const [users] = await deps.db.execute<RowDataPacket[]>('SELECT id FROM users ORDER BY id');
  let budget = maxRows;
  for (const { id: userId } of users) {
    if (budget <= 0 || deps.now() - started >= maxMs) { result.more = true; break; }
    const [[pending]] = await deps.db.execute<RowDataPacket[]>('SELECT 1 AS pending FROM emails WHERE user_id = ? AND thread_key IS NULL LIMIT 1', [userId]);
    if (!pending) { state.cursors.delete(userId); continue; }
    if (!await deps.mayRun(userId) || !await rawStorageReachable(deps.db, userId)) { result.skippedUsers++; continue; }
    result.more = true;
    while (budget > 0 && deps.now() - started < maxMs) {
      const after = state.cursors.get(userId) ?? '';
      const [rows] = await deps.db.execute<PendingRow[]>(`SELECT id, message_id, subject, received_at, from_address, to_addresses, cc_addresses,
          raw_storage_path, in_reply_to, references_header
        FROM emails WHERE user_id = ? AND thread_key IS NULL AND id > ? ORDER BY id LIMIT ${Math.min(BATCH_ROWS, budget)}`, [userId, after]);
      // The end of a pass: the next one starts again from the first unkeyed row.
      if (!rows.length) { state.cursors.delete(userId); break; }
      for (const row of rows) {
        budget--;
        state.cursors.set(userId, row.id);
        const keyed = await backfillRow(deps, userId, row).catch(error => {
          if (!reported.has(row.id) && reported.size < 10_000) {
            reported.add(row.id);
            log.warn('mail', 'Could not thread a stored message; it is tried again later', { userId, emailId: row.id }, error);
          }
          return false;
        });
        if (keyed) result.keyed++; else result.deferred++;
      }
      if (await deps.mayRun(userId) === false) break;
    }
  }
  if (!result.more && !result.skippedUsers) state.idleUntil = started + IDLE_BACKOFF_MS;
  return result;
}

// A volume that is not mounted looks like missing files; the user's raw
// directory must exist before a missing file counts as "no headers".
async function rawStorageReachable(db: SqlExecutor, userId: string) {
  const [[withRaw]] = await db.execute<RowDataPacket[]>(`SELECT 1 AS has_raw FROM emails
    WHERE user_id = ? AND thread_key IS NULL AND raw_storage_path IS NOT NULL LIMIT 1`, [userId]);
  if (!withRaw) return true;
  try {
    return (await fs.stat(path.join(rawRoot(), userId))).isDirectory();
  } catch {
    log.warn('mail', 'The raw mail directory of a user is not reachable; threading of their older mail waits', { userId });
    return false;
  }
}

async function backfillRow(deps: BackfillDeps, userId: string, row: PendingRow) {
  const stored = row.in_reply_to || row.references_header
    ? threadHeaders({ inReplyTo: row.in_reply_to, references: messageIds(row.references_header) })
    : row.raw_storage_path ? await deps.readHeaders(row.raw_storage_path, userId) : null;
  const headers = stored ?? { inReplyTo: null, references: [] };
  const threadKey = await resolveThreadKey(deps.db, { userId, emailId: row.id, messageId: row.message_id,
    inReplyTo: headers.inReplyTo, references: headers.references, subject: row.subject,
    receivedAt: new Date(row.received_at), participants: participantsOf(row) });
  if (!threadKey) return false;
  // The message's key and the adoption of its earlier-keyed replies commit
  // together: a pass stopped between them would leave the replies apart for
  // good, since later passes skip a message that has a key.
  const write = async (executor: SqlExecutor) => {
    const [updated] = await executor.execute<ResultSetHeader>(`UPDATE emails SET in_reply_to = COALESCE(in_reply_to, ?),
        references_header = COALESCE(references_header, ?), thread_key = ?
      WHERE id = ? AND user_id = ? AND thread_key IS NULL AND raw_storage_path <=> ?`,
    [headers.inReplyTo, storedReferences(headers.references), threadKey, row.id, userId, row.raw_storage_path]);
    if (updated.affectedRows !== 1) return false;
    await adoptReplies(executor, { userId, messageId: row.message_id, threadKey });
    return true;
  };
  const pool = deps.db as Partial<Pick<Pool, 'getConnection'>>;
  return typeof pool.getConnection === 'function' ? withTransaction(write, pool as Pick<Pool, 'getConnection'>) : write(deps.db);
}

function participantsOf(row: PendingRow) {
  const list = (value: unknown) => {
    try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []; }
    catch { return []; }
  };
  return [row.from_address || '', ...list(row.to_addresses), ...list(row.cc_addresses)].filter(Boolean);
}

/** Tests: forget the pass cursors and the idle pause. */
function resetMailThreadBackfill() {
  state.cursors.clear();
  reported.clear();
  state.idleUntil = 0;
}

export { runMailThreadBackfill, resetMailThreadBackfill, BATCH_ROWS, TICK_MAX_ROWS };
