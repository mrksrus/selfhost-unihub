// Sync mode is a full mail client: the provider is the source of truth. This
// module owns the *local* consequences of that rule, kept apart from Download
// mode (which never removes local mail):
//
// - retention windows (per account, Sync only) decide which provider messages
//   are imported at all and which local copies are removed again;
// - local copies whose provider absence was proven are removed;
// - Gmail copies of one X-GM-MSGID are merged into one item;
// - a copy without any provider identity that duplicates a linked item is removed.
//
// Every destructive step requires mail_accounts.sync_policy_confirmed_at. It
// stays NULL for accounts upgraded from 0.12, so nothing is removed until the
// user confirms per account. All work runs in bounded, fenced, resumable
// 'prune' jobs (no provider connection), never in one large transaction.
import type { RowDataPacket, ResultSetHeader, ExecuteValues } from 'mysql2/promise';
import type { SqlExecutor, ApiError } from '../types';
import type { EngineJob } from '../types/mail-engine';
import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../state';

interface Account {
  id: string;
  user_id: string;
  sync_mode?: string | null;
  sync_window_days?: number | string | null;
  trash_window_days?: number | string | null;
  sync_policy_confirmed_at?: Date | string | null;
}
interface Mailbox { special_use?: string | null; remote_name: string }
interface Windows { sync: number | null; trash: number | null }
type Fence = (cx: SqlExecutor) => Promise<unknown>;

const MAIL_WINDOW_DAYS = Object.freeze([14, 30, 90, 180, 365]);
const DEFAULT_TRASH_WINDOW_DAYS = 30;
const PRUNE_BATCH = 200;
const PRUNE_PRIORITY = 80; // below every user-visible job, above nothing
const GMAIL_GROUP_BATCH = 50;
const GMAIL_GROUP_SCAN = 2000;
const SETTLED_OPERATION_STATES = Object.freeze(['confirmed', 'cancelled', 'superseded', 'rejected']);
const GMAIL_ALL_MAIL_NAMES = Object.freeze(['[Gmail]/All Mail', '[Google Mail]/All Mail']);
const GMAIL_TRASH_NAMES = Object.freeze(['[Gmail]/Trash', '[Gmail]/Spam', '[Google Mail]/Trash', '[Google Mail]/Spam']);
const GMAIL_HOSTS = Object.freeze(['imap.gmail.com', 'imap.googlemail.com']);
const SYNC_WARNING_GMAIL_ALL_MAIL_HIDDEN = 'gmail_all_mail_hidden';

const bool = (value: unknown) => value === true || value === 1 || value === '1';
const list = (values: readonly string[]) => values.map(value => `'${value.replace(/'/g, "''")}'`).join(',');
const fail = (message: string, status = 400, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...extra });

// undefined: not provided. null: all mail. Number: one of MAIL_WINDOW_DAYS.
// The browser sends "all" as an empty value.
function parseWindowDays(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || String(value).trim().toLowerCase() === 'all') return null;
  const text = String(value).trim();
  const days = /^[0-9]{1,4}$/.test(text) ? Number(text) : NaN;
  if (!MAIL_WINDOW_DAYS.includes(days)) throw fail(`${field} must be 14, 30, 90, 180 or 365 days, or empty for all mail.`);
  return days;
}
function storedWindows(account: Pick<Account, 'sync_window_days' | 'trash_window_days'> | null | undefined) {
  const days = (value: unknown) => value === null || value === undefined ? null : Number(value);
  return { sync: days(account?.sync_window_days), trash: days(account?.trash_window_days) };
}
function cutoff(days: number | null | undefined, now = Date.now()) {
  if (days === null || days === undefined) return null;
  return new Date(now - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}
function isTrashMailbox(mailbox: Mailbox) {
  return ['trash', 'junk'].includes(String(mailbox?.special_use || '').replace(/^\\/, '').toLowerCase())
    || GMAIL_TRASH_NAMES.includes(mailbox?.remote_name);
}
// Window that applies to one provider mailbox; Download mode has none.
function windowDaysFor(account: Account, mailbox: Mailbox) {
  if (account?.sync_mode !== 'sync') return null;
  const windows = storedWindows(account);
  return isTrashMailbox(mailbox) ? windows.trash : windows.sync;
}
function outsideWindow(account: Account, mailbox: Mailbox, internalDate: string | null, now = Date.now()) {
  const days = windowDaysFor(account, mailbox);
  if (days === null || !internalDate) return false; // unknown dates are never "old"
  const time = Date.parse(internalDate);
  return Number.isFinite(time) && time < now - days * 86400000;
}

// --- SQL building blocks (alias e = emails) --------------------------------
const TRASH_SQL = (alias: string) => `(LOWER(COALESCE(${alias}.special_use,'')) IN ('trash','junk') OR ${alias}.remote_name IN (${list(GMAIL_TRASH_NAMES)}))`;
const LIVE_FROM = `mail_remote_occurrences o JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id AND m.user_id = o.user_id
    AND m.mail_account_id = o.mail_account_id AND m.state = 'active' AND m.uidvalidity = o.uidvalidity`;
const LIVE_WHERE = `o.email_id = e.id AND o.user_id = e.user_id AND o.mail_account_id = e.mail_account_id AND o.presence = 'present'`;
// Four cutoff parameters: trash, trash, sync, sync.
const IN_WINDOW_SQL = `(CASE WHEN ${TRASH_SQL('m')} THEN (? IS NULL OR COALESCE(o.internal_date, e.received_at) >= ?)
    ELSE (? IS NULL OR COALESCE(o.internal_date, e.received_at) >= ?) END)`;
// Mail that is not this account's provider mail, or that a pending provider
// change still refers to, is never removed by policy.
const ELIGIBLE_SQL = `e.user_id = ? AND e.mail_account_id = ? AND COALESCE(e.is_draft, FALSE) = FALSE AND e.is_legacy = FALSE
  AND COALESCE(e.filing_account_id, e.mail_account_id) = e.mail_account_id
  AND NOT EXISTS (SELECT 1 FROM mail_writebacks w WHERE w.email_id = e.id AND w.user_id = e.user_id
    AND (w.state IS NULL OR w.state NOT IN (${list(SETTLED_OPERATION_STATES)})))`;
// Proven absence: no present (or ambiguous, quarantined) provider occurrence
// remains, and the item was seen missing. Items that never had a provider
// identity (local sent copies, drafts) do not qualify.
const ABSENT_SQL = `NOT EXISTS (SELECT 1 FROM mail_remote_occurrences k WHERE k.email_id = e.id AND k.user_id = e.user_id
    AND k.mail_account_id = e.mail_account_id AND k.presence IN ('present','quarantined'))
  AND (e.remote_missing = TRUE OR EXISTS (SELECT 1 FROM mail_remote_occurrences a WHERE a.email_id = e.id
    AND a.user_id = e.user_id AND a.mail_account_id = e.mail_account_id AND a.presence = 'absent'))`;
// Download accounts never sweep presence; their best local evidence of server
// absence is UniHub's own server deletion.
const SERVER_DELETED_SQL = `EXISTS (SELECT 1 FROM mail_server_messages s WHERE s.email_id = e.id AND s.user_id = e.user_id
    AND s.delete_status IN ('deleted','missing'))`;
// A copy that never had a provider identity (UniHub's own Sent copy, or mail
// kept from before the account used Sync) is a duplicate once a linked, fully
// downloaded item of the same message exists: same Message-ID, sender and
// subject, dated within a day of it. The linked item carries the server state.
// A copy without such a twin stays as local-only mail.
const UNLINKED_DUPLICATE_SQL = `e.remote_folder IS NULL AND e.remote_uid IS NULL AND e.remote_uidvalidity IS NULL
  AND e.message_id IS NOT NULL AND e.message_id <> ''
  AND NOT EXISTS (SELECT 1 FROM mail_remote_occurrences k WHERE k.email_id = e.id AND k.user_id = e.user_id)
  AND EXISTS (SELECT 1 FROM emails t WHERE t.user_id = e.user_id AND t.mail_account_id = e.mail_account_id AND t.id <> e.id
    AND t.received_at BETWEEN e.received_at - INTERVAL 1 DAY AND e.received_at + INTERVAL 1 DAY
    AND t.message_id = e.message_id AND LOWER(t.from_address) = LOWER(e.from_address) AND t.subject <=> e.subject
    AND t.import_complete = TRUE
    AND EXISTS (SELECT 1 FROM ${LIVE_FROM} WHERE o.email_id = t.id AND o.user_id = t.user_id
      AND o.mail_account_id = t.mail_account_id AND o.presence = 'present'))`;
const OUTSIDE_SQL = `EXISTS (SELECT 1 FROM ${LIVE_FROM} WHERE ${LIVE_WHERE})
  AND NOT EXISTS (SELECT 1 FROM ${LIVE_FROM} WHERE ${LIVE_WHERE} AND ${IN_WINDOW_SQL})`;
const ONLY_TRASH_SQL = `NOT EXISTS (SELECT 1 FROM ${LIVE_FROM} WHERE ${LIVE_WHERE} AND NOT ${TRASH_SQL('m')})`;
const windowParams = (windows: Windows) => {
  const trash = cutoff(windows.trash), sync = cutoff(windows.sync);
  return [trash, trash, sync, sync];
};

async function isGmailAccount(executor: SqlExecutor, userId: string, accountId: string) {
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT
      EXISTS (SELECT 1 FROM mail_gmail_messages g WHERE g.mail_account_id = a.id AND g.user_id = a.user_id) AS gmail_ids,
      LOWER(COALESCE(a.imap_host,'')) AS host
    FROM mail_accounts a WHERE a.id = ? AND a.user_id = ?`, [accountId, userId]);
  return !!row && (bool(row.gmail_ids) || GMAIL_HOSTS.includes(row.host));
}
// Gmail archives by removing the INBOX label; the message stays only in All
// Mail. Without a visible All Mail mailbox, absence from every synced label
// cannot be told apart from deletion, so such mail is kept.
async function gmailAllMailHidden(executor: SqlExecutor, userId: string, accountId: string) {
  if (!await isGmailAccount(executor, userId, accountId)) return false;
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT EXISTS (SELECT 1 FROM mail_remote_mailboxes m
      WHERE m.mail_account_id = ? AND m.user_id = ? AND m.state = 'active'
        AND (m.special_use = 'all' OR m.remote_name IN (${list(GMAIL_ALL_MAIL_NAMES)}))) AS visible`, [accountId, userId]);
  return !bool(row.visible);
}
async function syncWarnings(account: Account, executor: SqlExecutor = db) {
  if (account?.sync_mode !== 'sync') return [];
  return await gmailAllMailHidden(executor, account.user_id, account.id) ? [SYNC_WARNING_GMAIL_ALL_MAIL_HIDDEN] : [];
}

// Counts only, never content. mode=sync estimates what Sync with these windows
// would remove locally; mode=download removes nothing.
async function computeModeImpact(account: Account, { mode, syncWindowDays, trashWindowDays }: { mode?: string | null; syncWindowDays?: number | null; trashWindowDays?: number | null } = {}, executor: SqlExecutor = db) {
  if (!['sync', 'download'].includes(mode!)) throw fail('Mode must be sync or download.');
  if (mode === 'download') {
    return { mode, local_only: 0, outside_window: 0, outside_trash_window: 0, gmail_duplicates: 0, total_removals: 0,
      notes: ['Download mode deletes nothing locally. UniHub stops sending read, star, move and delete changes to the server; local copies stay as they are.'] };
  }
  const stored = storedWindows(account);
  const windows = { sync: syncWindowDays === undefined ? stored.sync : syncWindowDays,
    trash: trashWindowDays === undefined ? stored.trash : trashWindowDays };
  const owner = [account.user_id, account.id];
  const hidden = await gmailAllMailHidden(executor, account.user_id, account.id);
  const downloadNow = account.sync_mode !== 'sync';
  let localOnly = 0;
  if (!hidden) {
    const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM emails e WHERE ${ELIGIBLE_SQL}
      AND ((${ABSENT_SQL})${downloadNow ? ` OR ${SERVER_DELETED_SQL}` : ''})`, owner);
    localOnly = Number(row.n) || 0;
  }
  const params = windowParams(windows);
  const [[outside]] = await executor.execute<RowDataPacket[]>(`SELECT
      COALESCE(SUM(NOT (${ONLY_TRASH_SQL})), 0) AS regular, COALESCE(SUM(${ONLY_TRASH_SQL}), 0) AS trash
    FROM emails e WHERE ${ELIGIBLE_SQL} AND ${OUTSIDE_SQL}`, [...owner, ...params]);
  const [[duplicates]] = await executor.execute<RowDataPacket[]>(`SELECT COALESCE(SUM(n - 1), 0) AS n FROM (
      SELECT o.gmail_msgid, COUNT(DISTINCT o.email_id) AS n FROM mail_remote_occurrences o
      WHERE o.user_id = ? AND o.mail_account_id = ? AND o.gmail_msgid IS NOT NULL AND o.presence IN ('present','absent')
      GROUP BY o.gmail_msgid HAVING COUNT(DISTINCT o.email_id) > 1) duplicate_groups`, owner);
  const [[unlinked]] = await executor.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM emails e WHERE ${ELIGIBLE_SQL}
    AND ${UNLINKED_DUPLICATE_SQL}`, owner);
  const result = { total_removals: 0, mode, local_only: localOnly, outside_window: Number(outside.regular) || 0,
    outside_trash_window: Number(outside.trash) || 0, gmail_duplicates: Number(duplicates.n) || 0,
    local_duplicates: Number(unlinked.n) || 0 };
  result.total_removals = result.local_only + result.outside_window + result.outside_trash_window + result.gmail_duplicates
    + result.local_duplicates;
  const notes = ['Only local copies are removed. Mail on the server is not changed by this.'];
  if (downloadNow) notes.push('Messages deleted on the server since the last sync are not counted yet; Sync removes them too once it sees they are gone.');
  if (result.outside_window || result.outside_trash_window) notes.push('Messages older than the chosen windows stay on the server and are no longer kept locally.');
  if (result.gmail_duplicates) notes.push('Gmail copies of the same message (one per label) are merged into one message.');
  if (result.local_duplicates) notes.push('Local copies that are not linked to the server, such as UniHub\'s own copy of sent mail, are removed once the same message has been downloaded from the server.');
  if (hidden) notes.push('Gmail "All Mail" is not visible over IMAP. Mail missing from every synced label is kept as archived, because it may only be archived. Turn on "Show in IMAP" for All Mail in Gmail settings.');
  const [[pending]] = await executor.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM mail_writebacks WHERE user_id = ? AND mail_account_id = ?
    AND (state IS NULL OR state NOT IN (${list(SETTLED_OPERATION_STATES)}))`, owner);
  if (Number(pending.n)) notes.push('Messages with server changes still pending are kept until those changes settle.');
  return { ...result, notes };
}
// Shown on unconfirmed Sync accounts: what confirmation would remove.
async function pendingRemovals(account: Account, executor: SqlExecutor = db) {
  if (account?.sync_mode !== 'sync' || account.sync_policy_confirmed_at) return null;
  return (await computeModeImpact(account, { mode: 'sync' }, executor)).total_removals;
}

// --- Removal -----------------------------------------------------------------
function ownedFile(stored: string | null | undefined, root: string, userId: string) {
  if (!stored) return null;
  const base = path.resolve(root, String(userId));
  const resolved = path.resolve(stored);
  return resolved.startsWith(base + path.sep) ? resolved : null;
}
// After COMMIT: delete files no remaining row references, only inside this
// owner's directory of the attachment or raw-message root. A failure leaves an
// orphan file, never a row pointing at a missing file.
async function removeUnreferencedFiles({ userId, attachmentPaths = [], rawPaths = [] }: { userId: string; attachmentPaths?: (string | null | undefined)[]; rawPaths?: (string | null | undefined)[] }, executor: SqlExecutor = db) {
  const roots = { attachment: process.env.MAIL_ATTACHMENT_UPLOAD_ROOT || '/app/uploads/attachments',
    raw: process.env.MAIL_RAW_STORAGE_ROOT || '/app/uploads/mail-raw' };
  let deleted = 0, failed = 0;
  for (const [kind, paths, sql] of [
    ['attachment', attachmentPaths, 'SELECT id FROM email_attachments WHERE storage_path = ? LIMIT 1'],
    ['raw', rawPaths, 'SELECT id FROM emails WHERE raw_storage_path = ? LIMIT 1'],
  ] as [keyof typeof roots, (string | null | undefined)[], string][]) {
    for (const stored of new Set(paths.filter(Boolean))) {
      const resolved = ownedFile(stored, roots[kind], userId);
      if (!resolved) { failed++; continue; }
      try {
        const [used] = await executor.execute<RowDataPacket[]>(sql, [stored!]);
        if (used.length) continue;
        const real = await fs.realpath(resolved);
        const realBase = await fs.realpath(path.resolve(roots[kind], String(userId)));
        if (!real.startsWith(realBase + path.sep)) { failed++; continue; }
        await fs.unlink(real);
        deleted++;
      } catch (error) { if ((error as ApiError).code !== 'ENOENT') failed++; }
    }
  }
  return { deleted, failed };
}
async function deleteEmailRows(cx: SqlExecutor, { userId, accountId, ids }: { userId: string; accountId: string; ids: string[] }) {
  if (!ids.length) return { deleted: 0, attachmentPaths: [], rawPaths: [] };
  const marks = ids.map(() => '?').join(',');
  const [attachments] = await cx.execute<RowDataPacket[]>(`SELECT storage_path FROM email_attachments WHERE user_id = ? AND email_id IN (${marks})`, [userId, ...ids]);
  const [raws] = await cx.execute<RowDataPacket[]>(`SELECT raw_storage_path FROM emails WHERE user_id = ? AND mail_account_id = ? AND id IN (${marks})`, [userId, accountId, ...ids]);
  await cx.execute<RowDataPacket[]>(`DELETE FROM mail_engine_quarantine WHERE user_id = ? AND mail_account_id = ? AND source_table = 'emails' AND source_id IN (${marks})`,
    [userId, accountId, ...ids]);
  // Occurrences, Gmail ids, attachments, scores, settled operations and
  // recovery journal rows cascade with the item.
  const [result] = await cx.execute<ResultSetHeader>(`DELETE FROM emails WHERE user_id = ? AND mail_account_id = ? AND id IN (${marks})`, [userId, accountId, ...ids]);
  return { deleted: Number(result.affectedRows) || 0, attachmentPaths: attachments.map(row => row.storage_path),
    rawPaths: raws.map(row => row.raw_storage_path) };
}
// Select candidates outside a transaction, then recheck the same condition on
// locked rows: a concurrent observation can make an item present again.
async function removeMatching({ account, fence, conditionSql, params, limit = PRUNE_BATCH }: { account: Account; fence: Fence; conditionSql: string; params: ExecuteValues[]; limit?: number }) {
  const owner = [account.user_id, account.id];
  const [candidates] = await db.execute<RowDataPacket[]>(`SELECT e.id FROM emails e WHERE ${ELIGIBLE_SQL} AND ${conditionSql}
    ORDER BY e.id LIMIT ${Number(limit)}`, [...owner, ...params]);
  if (!candidates.length) return { removed: 0, candidates: 0 };
  const ids = candidates.map(row => row.id);
  const { withTransaction }: typeof import('./mail-engine/repository') = require('./mail-engine/repository');
  const outcome = await withTransaction(async cx => {
    await fence(cx);
    const marks = ids.map(() => '?').join(',');
    const [locked] = await cx.execute<RowDataPacket[]>(`SELECT e.id FROM emails e WHERE ${ELIGIBLE_SQL} AND e.id IN (${marks}) AND ${conditionSql}
      FOR UPDATE`, [...owner, ...ids, ...params]);
    return deleteEmailRows(cx, { userId: account.user_id, accountId: account.id, ids: locked.map(row => row.id) });
  }, db);
  await removeUnreferencedFiles({ userId: account.user_id, attachmentPaths: outcome.attachmentPaths, rawPaths: outcome.rawPaths });
  return { removed: outcome.deleted, candidates: ids.length };
}

// Gmail: one X-GM-MSGID is one message; its labels are occurrences. Copies
// imported per label before 0.12 are merged into one keeper item. Only
// X-GM-MSGID is proof; Message-ID headers and bodies never join items.
async function mergeGmailGroup({ account, fence, gmailMsgId }: { account: Account; fence: Fence; gmailMsgId: string }) {
  const userId = account.user_id, accountId = account.id;
  const { withTransaction }: typeof import('./mail-engine/repository') = require('./mail-engine/repository');
  const outcome = await withTransaction(async cx => {
    await fence(cx);
    const [occurrences] = await cx.execute<RowDataPacket[]>(`SELECT id, email_id, presence FROM mail_remote_occurrences
      WHERE user_id = ? AND mail_account_id = ? AND gmail_msgid = ? FOR UPDATE`, [userId, accountId, gmailMsgId]);
    const ids = [...new Set(occurrences.filter(row => ['present', 'absent'].includes(row.presence)).map(row => row.email_id))];
    if (ids.length < 2 || occurrences.some(row => row.presence === 'quarantined')) return null;
    const marks = ids.map(() => '?').join(',');
    const [items] = await cx.execute<RowDataPacket[]>(`SELECT e.id, e.import_complete, e.created_at FROM emails e
      WHERE ${ELIGIBLE_SQL} AND e.id IN (${marks}) FOR UPDATE`, [userId, accountId, ...ids]);
    if (items.length !== ids.length) return null; // filed elsewhere, legacy, draft or pending change: keep all
    // Every occurrence of a copy must carry this same id; otherwise the copies
    // are not proven to be the same message.
    const [foreign] = await cx.execute<RowDataPacket[]>(`SELECT id FROM mail_remote_occurrences WHERE user_id = ? AND mail_account_id = ?
      AND email_id IN (${marks}) AND (gmail_msgid IS NULL OR gmail_msgid <> ?) LIMIT 1`, [userId, accountId, ...ids, gmailMsgId]);
    if (foreign.length) return null;
    const [[mapped]] = await cx.execute<RowDataPacket[]>(`SELECT email_id FROM mail_gmail_messages WHERE mail_account_id = ? AND user_id = ? AND gmail_msgid = ? FOR UPDATE`,
      [accountId, userId, gmailMsgId]);
    const rank = (item: RowDataPacket) => [bool(item.import_complete) ? 0 : 1, item.id === mapped?.email_id ? 0 : 1, new Date(item.created_at).getTime() || 0];
    const keeper = [...items].sort((a, b) => {
      const left = rank(a), right = rank(b);
      for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
      return a.id < b.id ? -1 : 1;
    })[0].id;
    const losers = ids.filter(id => id !== keeper);
    const loserMarks = losers.map(() => '?').join(',');
    await cx.execute<RowDataPacket[]>(`UPDATE mail_remote_occurrences SET email_id = ? WHERE user_id = ? AND mail_account_id = ? AND email_id IN (${loserMarks})`,
      [keeper, userId, accountId, ...losers]);
    await cx.execute<RowDataPacket[]>(`UPDATE mail_writebacks SET email_id = ? WHERE user_id = ? AND mail_account_id = ? AND email_id IN (${loserMarks})`,
      [keeper, userId, accountId, ...losers]);
    await cx.execute<RowDataPacket[]>(`UPDATE mail_gmail_messages SET email_id = ? WHERE mail_account_id = ? AND user_id = ? AND email_id IN (${loserMarks})`,
      [keeper, accountId, userId, ...losers]);
    await cx.execute<RowDataPacket[]>(`INSERT INTO mail_gmail_messages (mail_account_id,gmail_msgid,user_id,email_id) VALUES (?,?,?,?)
      ON DUPLICATE KEY UPDATE email_id = VALUES(email_id)`, [accountId, gmailMsgId, userId, keeper]);
    // Read/star follow the server's latest observation of the message.
    const [[latest]] = await cx.execute<RowDataPacket[]>(`SELECT observed_flags FROM mail_remote_occurrences WHERE user_id = ? AND mail_account_id = ?
      AND email_id = ? AND presence = 'present' ORDER BY observed_at DESC, id LIMIT 1`, [userId, accountId, keeper]);
    const flags = latest ? (typeof latest.observed_flags === 'string' ? JSON.parse(latest.observed_flags) : latest.observed_flags) || [] : null;
    await cx.execute<RowDataPacket[]>(`UPDATE emails e SET e.is_read = COALESCE(?, e.is_read), e.is_starred = COALESCE(?, e.is_starred),
        e.remote_missing = NOT EXISTS (SELECT 1 FROM ${LIVE_FROM} WHERE ${LIVE_WHERE}),
        e.observation_revision = e.observation_revision + 1
      WHERE e.id = ? AND e.user_id = ? AND e.mail_account_id = ?`,
    [flags ? Number(flags.includes('\\Seen')) : null, flags ? Number(flags.includes('\\Flagged')) : null, keeper, userId, accountId]);
    await cx.execute<RowDataPacket[]>(`DELETE FROM mail_engine_quarantine WHERE user_id = ? AND mail_account_id = ? AND source_table = 'emails'
      AND source_id = ? AND reason = 'gmail_identity_conflict'`, [userId, accountId, keeper]);
    return deleteEmailRows(cx, { userId, accountId, ids: losers });
  }, db);
  if (!outcome) return 0;
  await removeUnreferencedFiles({ userId, attachmentPaths: outcome.attachmentPaths, rawPaths: outcome.rawPaths });
  return outcome.deleted;
}
async function mergeGmailDuplicates({ account, fence, signal }: { account: Account; fence: Fence; signal?: AbortSignal | null }) {
  let after = '', merged = 0, removed = 0, scanned = 0;
  while (merged < GMAIL_GROUP_BATCH && scanned < GMAIL_GROUP_SCAN) {
    const [groups] = await db.execute<RowDataPacket[]>(`SELECT o.gmail_msgid FROM mail_remote_occurrences o
      WHERE o.user_id = ? AND o.mail_account_id = ? AND o.gmail_msgid IS NOT NULL AND o.gmail_msgid > ?
        AND o.presence IN ('present','absent')
      GROUP BY o.gmail_msgid HAVING COUNT(DISTINCT o.email_id) > 1 ORDER BY o.gmail_msgid LIMIT 100`,
    [account.user_id, account.id, after]);
    if (!groups.length) break;
    for (const { gmail_msgid: id } of groups) {
      if (signal?.aborted) return { merged, removed, more: true };
      scanned++; after = id;
      const deleted = await mergeGmailGroup({ account, fence, gmailMsgId: id });
      if (deleted) { merged++; removed += deleted; }
      if (merged >= GMAIL_GROUP_BATCH || removed >= PRUNE_BATCH) return { merged, removed, more: true };
    }
    if (groups.length < 100) break;
  }
  return { merged, removed, more: false };
}

// Gmail without a visible All Mail: retained mail is filed as archived locally
// (non-destructive, also before confirmation).
async function fileRetainedAsArchived({ account, fence }: { account: Account; fence: Fence }) {
  const { withTransaction }: typeof import('./mail-engine/repository') = require('./mail-engine/repository');
  return withTransaction(async cx => {
    await fence(cx);
    const [result] = await cx.execute<ResultSetHeader>(`UPDATE emails e SET e.folder = 'archive', e.remote_missing = TRUE
      WHERE e.user_id = ? AND e.mail_account_id = ? AND COALESCE(e.is_draft, FALSE) = FALSE AND e.is_legacy = FALSE
        AND COALESCE(e.filing_account_id, e.mail_account_id) = e.mail_account_id
        AND COALESCE(e.folder, '') <> 'archive' AND ${ABSENT_SQL} LIMIT ${PRUNE_BATCH}`, [account.user_id, account.id]);
    return Number(result.affectedRows) || 0;
  }, db);
}

// One bounded slice of a 'prune' job. Returns more:true while work remains.
async function runPruneSlice({ account, job = null, signal = null, report = async () => {} }: { account: Account; job?: EngineJob | null; signal?: AbortSignal | null; report?: (progress: { phase: string; processed: number; total: null }) => Promise<unknown> }) {
  if (account?.sync_mode !== 'sync') return { processed: 0, removed: 0, more: false, skipped: 'download_mode' };
  const runtime: typeof import('./mail-engine/runtime') = require('./mail-engine/runtime');
  const fence = async (cx: SqlExecutor) => {
    if (job) await runtime.assertFence({ accountId: account.id, jobId: job.id, workerId: job.lease_owner!,
      generation: Number(job.worker_generation) }, cx);
  };
  const hidden = await gmailAllMailHidden(db, account.user_id, account.id);
  let filed = 0;
  if (hidden) {
    filed = await fileRetainedAsArchived({ account, fence });
    if (filed >= PRUNE_BATCH) return { processed: filed, filed, removed: 0, more: true };
  }
  if (!account.sync_policy_confirmed_at) return { processed: filed, filed, removed: 0, more: false, unconfirmed: true };
  const gmail = await mergeGmailDuplicates({ account, fence, signal });
  if (gmail.removed) await report({ phase: 'prune', processed: gmail.removed, total: null });
  if (gmail.more) return { processed: filed + gmail.removed, filed, merged: gmail.merged, removed: gmail.removed, more: true };
  let removed = gmail.removed;
  const unlinked = await removeMatching({ account, fence, conditionSql: `(${UNLINKED_DUPLICATE_SQL})`, params: [] });
  removed += unlinked.removed;
  if (unlinked.candidates >= PRUNE_BATCH) return { processed: filed + removed, filed, merged: gmail.merged, removed, more: true };
  if (!hidden) {
    const absent = await removeMatching({ account, fence, conditionSql: `(${ABSENT_SQL})`, params: [] });
    removed += absent.removed;
    if (absent.candidates >= PRUNE_BATCH) return { processed: filed + removed, filed, merged: gmail.merged, removed, more: true };
  }
  const windows = storedWindows(account);
  if (windows.sync !== null || windows.trash !== null) {
    const retention = await removeMatching({ account, fence, conditionSql: `(${OUTSIDE_SQL})`, params: windowParams(windows) });
    removed += retention.removed;
    if (retention.candidates >= PRUNE_BATCH) return { processed: filed + removed, filed, merged: gmail.merged, removed, more: true };
  }
  if (removed) await report({ phase: 'prune', processed: removed, total: null });
  return { processed: filed + removed, filed, merged: gmail.merged, removed, more: false };
}

async function enqueuePrune({ userId, accountId }: { userId: string; accountId: string }, executor: SqlExecutor = db) {
  return (require('./mail-engine/runtime') as typeof import('./mail-engine/runtime')).enqueueJob({ userId, accountId, kind: 'prune', priority: PRUNE_PRIORITY }, executor);
}

export {
  MAIL_WINDOW_DAYS,
  DEFAULT_TRASH_WINDOW_DAYS,
  PRUNE_BATCH,
  PRUNE_PRIORITY,
  SYNC_WARNING_GMAIL_ALL_MAIL_HIDDEN,
  parseWindowDays,
  storedWindows,
  isTrashMailbox,
  windowDaysFor,
  outsideWindow,
  gmailAllMailHidden,
  syncWarnings,
  computeModeImpact,
  pendingRemovals,
  runPruneSlice,
  enqueuePrune,
  removeUnreferencedFiles,
};
