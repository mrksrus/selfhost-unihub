import type { RowDataPacket } from 'mysql2/promise';
import type { AuthRequest, SqlExecutor, StoredFlag } from '../types';
import fs from 'node:fs/promises';
import { ownedMailPath, realOwnedMailPath } from './mail-storage';
import { db } from '../state';
import { withMailAccountLock } from './mail-account-lock';
import { isSectionRestoreActive } from './restore-locks';
import { isModuleEnabled } from './module-settings';
import { publishCalendarChanged } from './realtime';
import { addressConfirmed } from './mail-account-mode';
import { UNRESOLVED, sqlStates } from './mail-engine/operation-states';
import { sqlList } from './mail-engine/job-kinds';
import { recordAudit } from './audit';
import { fileRemovalGate } from './file-removal-gate';
import { assertFinalStep } from './final-step';
import { accountSnapshot, assertUnchanged, storedAccountId } from './account-identity';
import { withPersonLock } from './person-lock';

type IdRow = RowDataPacket & { id: string };
interface CalendarCounts { calendar_accounts: number | string; calendar_events: number | string }

const fail = (message: string | null, status = 409) => Object.assign(new Error(message || ''), { status });
const enabled = (value: unknown) => value === true || value === 1 || value === '1';
// The request that asked, for the activity log's client address; adminId
// when an administrator acts for the person (routes/admin-people.ts): the
// entry then names them, and their password stands for the typed address.
interface Requested { req?: AuthRequest | null; adminId?: string }

const unresolved = `(state IN (${sqlList(UNRESOLVED)})
  OR (dispatched = TRUE AND status <> 'done' AND state NOT IN (${sqlStates('confirmed', 'rejected')})))`;

// `disconnecting`: the preview for "Disconnect and delete", which disconnects
// first, so a still connected account does not block it.
async function purgePreview(userId: string, accountId: string, executor: SqlExecutor = db, { disconnecting = false } = {}) {
  const [[account]] = await executor.execute<(RowDataPacket & { id: string; email_address: string; is_active: StoredFlag })[]>('SELECT id, email_address, is_active FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  if (!account) throw fail('Account not found', 404);
  const [[counts]] = await executor.execute<(RowDataPacket & { email_count: number | string; raw_count: number | string | null; recovered_elsewhere: number | string | null })[]>(`SELECT COUNT(*) AS email_count,
    SUM(raw_storage_path IS NOT NULL) AS raw_count,
    SUM(filing_account_id IS NOT NULL AND filing_account_id <> mail_account_id) AS recovered_elsewhere
    FROM emails WHERE mail_account_id = ? AND user_id = ?`, [accountId, userId]);
  const [[attachments]] = await executor.execute<(RowDataPacket & { attachment_count: number | string })[]>(`SELECT COUNT(*) AS attachment_count FROM email_attachments a
    JOIN emails e ON e.id = a.email_id AND e.user_id = a.user_id WHERE e.mail_account_id = ? AND e.user_id = ?`, [accountId, userId]);
  const [[operations]] = await executor.execute<(RowDataPacket & { unresolved_operations: number | string })[]>(`SELECT COUNT(*) AS unresolved_operations FROM mail_writebacks
    WHERE mail_account_id = ? AND user_id = ? AND ${unresolved}`, [accountId, userId]);
  const countCalendar = (column: 'id' | 'mail_account_id', id: string) => executor.execute<(RowDataPacket & CalendarCounts)[]>(`SELECT COUNT(DISTINCT ca.id) AS calendar_accounts, COUNT(ev.id) AS calendar_events
    FROM calendar_accounts ca LEFT JOIN calendar_calendars cc ON cc.account_id = ca.id AND cc.user_id = ca.user_id
    LEFT JOIN calendar_events ev ON ev.calendar_id = cc.id AND ev.user_id = ca.user_id
    WHERE ca.${column} = ? AND ca.user_id = ?`, [id, userId]).then(([[row]]) => row);
  let calendar = await countCalendar('mail_account_id', accountId);
  // A restored calendar is linked again only when its link is next read; until
  // then it is found by address and mark, and purging removes it too.
  if (!Number(calendar.calendar_accounts)) {
    const restored = await (require('./calendar-accounts') as typeof import('./calendar-accounts')).restoredMailCalendar(userId, account, executor);
    if (restored) calendar = await countCalendar('id', restored.id);
  }
  const calendarAccounts = Number(calendar.calendar_accounts) || 0;
  // Purging also removes the linked calendar: Calendar data changes only while
  // that module is on and no calendar restore is writing it.
  const calendarOff = calendarAccounts > 0 && !await isModuleEnabled(userId, 'calendar', executor);
  const calendarRestoring = calendarAccounts > 0 && await isSectionRestoreActive(userId, 'calendar', executor);
  const reason = enabled(account.is_active) && !disconnecting ? 'Disconnect this account before permanently removing its retained mail.'
    : calendarOff ? 'This account has a linked calendar and Calendar is turned off. Turn Calendar on to delete it with the account.'
    : calendarRestoring ? 'Calendar restore is in progress. Try again when it has finished.'
    : Number(counts.recovered_elsewhere) ? 'This account is the source of mail retained in another account.'
      : Number(operations.unresolved_operations) ? 'Provider changes have an unresolved outcome. Reconnect and reconcile them before purging.' : null;
  return { account_id: accountId, email_count: Number(counts.email_count), raw_count: Number(counts.raw_count) || 0,
    attachment_count: Number(attachments.attachment_count), unresolved_operations: Number(operations.unresolved_operations),
    calendar_accounts: calendarAccounts, calendar_events: Number(calendar.calendar_events) || 0,
    blocked: Boolean(reason), reason };
}

// Each under the person's lock (person-lock.ts), from the first read to the
// commit; an administrator's removal takes the person's lock too. Work is
// stopped first, with a pause of the change's own: refused, the change puts
// back the pause it replaced (mail-sync-control.ts stopOwnedMailAccountWork).
const mail = () => require('./mail') as typeof import('./mail');

async function disconnectAccount(userId: string, accountId: string, requested: Requested = {}) {
  return withPersonLock(userId, async () => disconnectNow(userId, await storedAccountId('mail', userId, accountId), requested));
}

async function disconnectNow(userId: string, accountId: string, { req = null, adminId }: Requested) {
  if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore is in progress');
  const [[owned]] = await db.execute<RowDataPacket[]>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  if (!owned) throw fail('Account not found', 404);
  // The account as this change found it: its credential goes only if it is still the one seen (account-identity.ts).
  const seen = accountSnapshot('mail', owned as RowDataPacket & { id: string });
  return withOwnedStop(accountId, 'Account disconnected', committed => withMailAccountLock(accountId, async () => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[account]] = await connection.execute<RowDataPacket[]>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
      if (!account) throw fail('Account not found', 404);
      await assertFinalStep(connection, { userId, policies: ['accounts.remove'], actor: { adminId }, modules: ['mail'] });
      assertUnchanged(account, seen);
      // Recorded with the change; disconnecting again changes nothing worth a record.
      if (!account.disconnected_at) {
        await recordAudit({ action: adminId ? 'admin.mail_account_removed' : 'mail.account_disconnected', actorId: adminId ?? userId, targetUserId: userId, req, details: { mail_account: accountId } }, connection);
      }
      await connection.execute(`UPDATE mail_accounts SET is_active = FALSE, encrypted_password = NULL,
        disconnected_at = UTC_TIMESTAMP(), sync_status = 'cancelled', delete_emails_on_server = FALSE,
        server_delete_enabled_at = NULL, server_delete_grace_until = NULL
        WHERE id = ? AND user_id = ?`, [accountId, userId]);
      await connection.execute(`UPDATE mail_server_messages SET delete_status = 'skipped', delete_error = 'Account disconnected'
        WHERE mail_account_id = ? AND user_id = ? AND delete_status IN ('pending', 'failed')`, [accountId, userId]);
      // Accepted intents and their uncertain attempts are preserved unchanged.
      // The inactive account is a durable scheduling/dispatch guard, not a purge.
      // Linked calendars are read before the commit, so stopping their work
      // afterwards needs no database and cannot fail.
      // Only CalDAV accounts use the mail login; a subscription goes on.
      const [linkedCalendars] = await connection.execute<IdRow[]>("SELECT id FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ? AND provider = 'caldav'", [userId, accountId]);
      await connection.commit();
      committed();
      // After the commit: a linked calendar's running sync or change stops now;
      // any that starts later finds the account disconnected.
      const { stopCalendarAccountWork, stopLinkedCalendarWork } = require('./calendar-sync') as typeof import('./calendar-sync');
      for (const row of linkedCalendars) stopCalendarAccountWork(row.id);
      // Read again: a restored calendar a sync linked after the read above is
      // stopped too (a sync linking it later reads the disconnected account).
      await stopLinkedCalendarWork(userId, accountId, connection).catch((error: Error) => console.error('[MAIL] Could not stop linked calendar work:', error.message));
      return { message: 'Account disconnected. Retained mail and operation history are still available.', disconnected: true, retained_mail: true };
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }));
}

// A change's own pause, for the change's whole life (mail-sync-control.ts
// stopOwnedMailAccountWork): whatever ends it before `committed()` (a
// refusal, a connection that could not be had, a lost one), the account's
// work goes on as before, on a connection of its own once the change's is
// back in the pool, and the change's error stays the answer.
async function withOwnedStop<T>(accountId: string, reason: string, work: (committed: () => void) => Promise<T>): Promise<T> {
  const pause = await mail().stopOwnedMailAccountWork(accountId, reason);
  let done = false;
  try { return await work(() => { done = true; }); }
  // Gone through, its pause stays as the account's fence; its turns end.
  finally { if (done) await mail().endOwnedMailAccountStop(pause); else await mail().releaseOwnedMailAccountStop(pause); }
}

async function removeUnreferencedRaw(userId: string, storagePaths: readonly (string | null)[], executor: SqlExecutor = db) {
  let deletedFiles = 0, failedFiles = 0;
  for (const stored of new Set(storagePaths.filter(Boolean))) {
    const resolved = ownedMailPath('raw', stored, userId);
    if (!resolved) { failedFiles++; continue; }
    try {
      const [[used]] = await executor.execute<RowDataPacket[]>('SELECT id FROM emails WHERE raw_storage_path = ? LIMIT 1', [stored]);
      if (used) continue;
      // realpath prevents a database path under the root escaping via a symlink.
      if (!await realOwnedMailPath('raw', stored, userId)) { failedFiles++; continue; }
      await fs.unlink(resolved);
      deletedFiles++;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failedFiles++; }
  }
  return { deletedFiles, failedFiles };
}

// The typed account address is checked here, not only by the dialog.
async function assertPurgeConfirmed(userId: string, accountId: string, confirmation: unknown, { adminId }: Requested = {}) {
  const [[owned]] = await db.execute<(RowDataPacket & { id: string; email_address: string })[]>('SELECT id, email_address FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  if (!owned) throw fail('Account not found', 404);
  if (!adminId && !addressConfirmed(owned, confirmation)) throw fail('Type the account email address to confirm permanent deletion.', 400);
}

async function purgeAccount(userId: string, accountId: string, confirmation: unknown, requested: Requested = {}) {
  return withPersonLock(userId, async () => purgeNow(userId, await storedAccountId('mail', userId, accountId), confirmation, requested));
}

async function purgeNow(userId: string, accountId: string, confirmation: unknown, { req = null, adminId }: Requested) {
  await assertPurgeConfirmed(userId, accountId, confirmation, { adminId });
  if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore is in progress');
  const initialPreview = await purgePreview(userId, accountId);
  if (initialPreview.blocked) throw fail(initialPreview.reason);
  return withOwnedStop(accountId, 'Account purging', committed => withMailAccountLock(accountId, async () => {
    const connection = await db.getConnection();
    let attachments: (RowDataPacket & { storage_path: string })[] = [], rawPaths: (string | null)[] = [];
    let preview: Awaited<ReturnType<typeof purgePreview>> | undefined, linkedCalendars: IdRow[] = [];
    try {
      await connection.beginTransaction();
      const [[account]] = await connection.execute<(RowDataPacket & { id: string; email_address: string })[]>('SELECT id, email_address FROM mail_accounts WHERE id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
      if (!account) throw fail('Account not found', 404);
      // The typed address confirmed this account: an address changed while
      // the work stopped no longer matches it.
      if (!adminId && !addressConfirmed(account, confirmation)) {
        throw Object.assign(new Error('This account changed in the meantime. Try again.'), { status: 409, code: 'ACCOUNT_CHANGED' });
      }
      // Admission locks item rows. Acquire them before the final unresolved-effect
      // check, preventing a concurrently accepted command from escaping the gate.
      const [messages] = await connection.execute<(IdRow & { raw_storage_path: string | null })[]>('SELECT id, raw_storage_path FROM emails WHERE mail_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
      [linkedCalendars] = await connection.execute<IdRow[]>('SELECT id FROM calendar_accounts WHERE mail_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
      // A restored calendar is linked again only when its link is next read;
      // until then it is found by address and mark, locked here so a link
      // meanwhile waits, and removed with the account.
      if (!linkedCalendars.length) {
        const restored = await (require('./calendar-accounts') as typeof import('./calendar-accounts')).restoredMailCalendar(userId, account, connection, { lock: true });
        if (restored) linkedCalendars = [restored as IdRow];
      }
      preview = await purgePreview(userId, accountId, connection);
      if (preview.blocked) throw fail(preview.reason);
      await assertFinalStep(connection, { userId, policies: ['accounts.remove', 'accounts.reset'], actor: { adminId },
        modules: linkedCalendars.length ? ['mail', 'calendar'] : ['mail'] });
      [attachments] = await connection.execute<(RowDataPacket & { storage_path: string })[]>(`SELECT a.storage_path FROM email_attachments a
        JOIN emails e ON e.id = a.email_id AND e.user_id = a.user_id WHERE e.mail_account_id = ? AND e.user_id = ?`, [accountId, userId]);
      rawPaths = messages.map(row => row.raw_storage_path);
      await connection.execute('DELETE FROM mail_engine_quarantine WHERE mail_account_id = ? AND user_id = ?', [accountId, userId]);
      // The linked calendar goes in the same transaction: either the account is
      // gone with all its local data, or nothing changed and purge can be retried.
      if (linkedCalendars.length) {
        const placeholders = linkedCalendars.map(() => '?').join(', ');
        const [calendars] = await connection.execute<IdRow[]>(`SELECT id FROM calendar_calendars WHERE user_id = ? AND account_id IN (${placeholders})`,
          [userId, ...linkedCalendars.map(row => row.id)]);
        await (require('./calendar-sync') as typeof import('./calendar-sync')).deleteCalendarsWithEvents(connection, userId, calendars.map(row => row.id));
        await connection.execute(`DELETE FROM calendar_accounts WHERE user_id = ? AND id IN (${placeholders})`, [userId, ...linkedCalendars.map(row => row.id)]);
      }
      await connection.execute('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
      await recordAudit({ action: adminId ? 'admin.mail_account_reset' : 'mail.account_purged', actorId: adminId ?? userId, targetUserId: userId, req,
        details: { mail_account: accountId, messages: preview.email_count, calendar_events: preview.calendar_events } }, connection);
      await connection.commit();
      committed();
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
    for (const row of linkedCalendars) publishCalendarChanged(userId, row.id, 'sync');
    const safeAttachments: string[] = [];
    for (const stored of new Set(attachments.map(row => row.storage_path).filter(Boolean))) {
      const [[used]] = await db.execute<RowDataPacket[]>('SELECT id FROM email_attachments WHERE storage_path = ? LIMIT 1', [stored]);
      if (!used) safeAttachments.push(stored);
    }
    // While an instance backup copies files, they go after it (the names are unique, so nothing can refer to them again).
    const removal = await fileRemovalGate.run(async () => ({
      files: await (require('./mail') as typeof import('./mail')).deleteStoredAttachmentFiles(safeAttachments),
      raw: await removeUnreferencedRaw(userId, rawPaths),
    }));
    const { files, raw } = removal === 'deferred'
      ? { files: { deletedFiles: 0, failedFiles: 0 }, raw: { deletedFiles: 0, failedFiles: 0 } } : removal;
    return { message: 'Disconnected account and its retained local mail and linked calendar permanently removed. Provider mail and events were not changed.', purged: true,
      email_count: preview!.email_count, deletedAttachmentFiles: files.deletedFiles, failedAttachmentFiles: files.failedFiles,
      deletedRawFiles: raw.deletedFiles, failedRawFiles: raw.failedFiles };
  }));
}

// One step for "Disconnect and delete": nothing changes when the purge is
// already blocked; a purge refused after the disconnect (an operation became
// unresolved meanwhile) leaves the account disconnected with its mail kept.
async function disconnectAndPurgeAccount(userId: string, accountId: string, confirmation: unknown, requested: Requested = {}) {
  return withPersonLock(userId, async () => disconnectAndPurgeNow(userId, await storedAccountId('mail', userId, accountId), confirmation, requested));
}

async function disconnectAndPurgeNow(userId: string, accountId: string, confirmation: unknown, requested: Requested) {
  await assertPurgeConfirmed(userId, accountId, confirmation, requested);
  if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore is in progress');
  const preview = await purgePreview(userId, accountId, db, { disconnecting: true });
  if (preview.blocked) throw fail(preview.reason);
  await disconnectNow(userId, accountId, requested);
  try { return await purgeNow(userId, accountId, confirmation, requested); }
  catch (error) {
    throw Object.assign(error as Error, { message: `The account was disconnected and its local mail kept: ${(error as Error).message}`, disconnected: true });
  }
}

export { purgePreview, disconnectAccount, purgeAccount, disconnectAndPurgeAccount, removeUnreferencedRaw, unresolved as UNRESOLVED_OPERATION_SQL };
