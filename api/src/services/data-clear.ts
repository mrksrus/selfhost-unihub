import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { AuthRequest, SqlExecutor } from '../types';
import type { AdminClearModule } from '../contracts/admin-accounts';
import { db } from '../state';
import { conflict, forbidden } from '../http/errors';
import { withTransaction } from './transactions';
import { isModuleEnabled } from './module-settings';
import { isSectionRestoreActive } from './restore-locks';
import { assertAllowed } from './settings';
import { recordAudit } from './audit';
import type { PolicyActor } from './settings';

// Settings → Delete data: every item of one module, for good (no bin). The
// person's own routes (POST /api/settings/clear-*) and the administrator's
// path for them (POST /api/admin/users/:id/clear/:module) both come here.
// The request boundary checks the caller's module switch, restore lock and
// policies; for an administrator those are not the person's, so this checks
// the person's switch and restore lock itself, and the policies (data.clear,
// and for calendar and mail the accounts it removes) for the person's own
// requests. Clearing mail refuses, as purging one account does, while a
// provider change has an unresolved outcome (D41).

type ClearTarget = AdminClearModule;
interface ClearActor extends PolicyActor { req?: AuthRequest | null }
interface ClearResult { message: string; deleted: number; [key: string]: unknown }

const MODULE_OF: Readonly<Record<ClearTarget, string>> = { contacts: 'contacts', calendar: 'calendar', 'mail-accounts': 'mail', recordings: 'recordings' };
const POLICIES_OF = {
  contacts: ['data.clear'],
  calendar: ['data.clear', 'accounts.remove'],
  'mail-accounts': ['data.clear', 'accounts.remove', 'accounts.reset'],
  recordings: ['data.clear'],
} as const;
const CLEAR_TARGETS = Object.keys(MODULE_OF) as ClearTarget[];
const isClearTarget = (value: unknown): value is ClearTarget => typeof value === 'string' && Object.prototype.hasOwnProperty.call(MODULE_OF, value);

async function assertClearable(userId: string, target: ClearTarget, actor: ClearActor) {
  const module = MODULE_OF[target];
  if (!await isModuleEnabled(userId, module)) throw forbidden('MODULE_DISABLED', 'This module is disabled. Enable it in Settings.', { module });
  if (await isSectionRestoreActive(userId, module)) throw conflict('RESTORE_IN_PROGRESS', `Restore in progress for ${module}. This section is temporarily read-only.`);
  await assertAllowed(userId, POLICIES_OF[target], actor);
}

// The administrator's entry, in the transaction of the change where there is one.
function auditEntry(userId: string, target: ClearTarget, deleted: number, actor: ClearActor) {
  return { action: 'admin.data_cleared' as const, actorId: actor.adminId!, targetUserId: userId, req: actor.req ?? null, details: { module: target, deleted } };
}

async function clearContacts(userId: string, actor: ClearActor): Promise<ClearResult> {
  const deleted = await withTransaction(async cx => {
    const [result] = await cx.execute<ResultSetHeader>('DELETE FROM contacts WHERE user_id = ?', [userId]);
    if (actor.adminId) await recordAudit(auditEntry(userId, 'contacts', result.affectedRows || 0, actor), cx);
    return result.affectedRows || 0;
  });
  return { message: `Deleted ${deleted} contact(s)`, deleted };
}

async function clearCalendar(userId: string, actor: ClearActor): Promise<ClearResult> {
  const { deletedEvents, deletedSubtasks } = await withTransaction(async cx => {
    const [subtasks] = await cx.execute<ResultSetHeader>('DELETE FROM calendar_event_subtasks WHERE user_id = ?', [userId]);
    const [events] = await cx.execute<ResultSetHeader>('DELETE FROM calendar_events WHERE user_id = ?', [userId]);
    await cx.execute('DELETE FROM calendar_calendars WHERE user_id = ?', [userId]);
    await cx.execute('DELETE FROM calendar_accounts WHERE user_id = ?', [userId]);
    const counts = { deletedEvents: events.affectedRows || 0, deletedSubtasks: subtasks.affectedRows || 0 };
    if (actor.adminId) await recordAudit(auditEntry(userId, 'calendar', counts.deletedEvents + counts.deletedSubtasks, actor), cx);
    return counts;
  });
  const { ensureDefaultLocalCalendarForUser } = require('./calendar') as typeof import('./calendar');
  await ensureDefaultLocalCalendarForUser(userId);
  return { message: `Deleted ${deletedEvents} event(s) and ${deletedSubtasks} subtask(s)`, deleted: deletedEvents + deletedSubtasks };
}

const unresolvedOperations = () => conflict('MAIL_OPERATIONS_UNRESOLVED',
  'Provider changes have an unresolved outcome. Reconnect the accounts and let them finish before deleting.');

async function countUnresolved(userId: string, executor: SqlExecutor) {
  const { UNRESOLVED_OPERATION_SQL } = require('./mail-account-lifecycle') as typeof import('./mail-account-lifecycle');
  const [[row]] = await executor.execute<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM mail_writebacks WHERE user_id = ? AND ${UNRESOLVED_OPERATION_SQL}`, [userId]);
  return Number(row.count) || 0;
}

/**
 * Every mail account with UniHub's copy of its mail; the providers keep
 * theirs. Linked calendars stay, unlinked: one connected from mail finds a
 * mail account with its address again (its sync waits until then), and its
 * running work, which read a deleted login, stops.
 */
async function clearMailAccounts(userId: string, actor: ClearActor): Promise<ClearResult> {
  // Refused before any work stops, then checked again under the locks.
  if (await countUnresolved(userId, db)) throw unresolvedOperations();
  const mail = require('./mail') as typeof import('./mail');
  const [accounts] = await db.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM mail_accounts WHERE user_id = ? ORDER BY id', [userId]);
  for (const account of accounts) await mail.stopMailAccountWork(account.id, 'Mail accounts deleted');
  const { stopCalendarAccountWork, unlinkFromDeletedMail } = require('./calendar-sync') as typeof import('./calendar-sync');
  type Linked = RowDataPacket & { id: string; provider: string; provider_config: unknown; mail_account_id: string };
  const { deleted, linkedCalendars, attachments } = await withTransaction(async cx => {
    // Purge's order: the accounts, their messages (a command admits under
    // the message rows, so none escapes the check below), then the linked
    // calendars a sync could be linking meanwhile.
    await cx.execute('SELECT id FROM mail_accounts WHERE user_id = ? ORDER BY id FOR UPDATE', [userId]);
    await cx.execute('SELECT COUNT(*) AS count FROM emails WHERE user_id = ? FOR UPDATE', [userId]);
    const [linked] = await cx.execute<Linked[]>(`SELECT id, provider, provider_config, mail_account_id FROM calendar_accounts
      WHERE user_id = ? AND mail_account_id IS NOT NULL FOR UPDATE`, [userId]);
    if (await countUnresolved(userId, cx)) throw unresolvedOperations();
    const [files] = await cx.execute<(RowDataPacket & { storage_path: string | null })[]>('SELECT storage_path FROM email_attachments WHERE user_id = ?', [userId]);
    const [result] = await cx.execute<ResultSetHeader>('DELETE FROM mail_accounts WHERE user_id = ?', [userId]);
    for (const calendar of linked) await unlinkFromDeletedMail(cx, calendar, calendar.mail_account_id);
    if (actor.adminId) await recordAudit(auditEntry(userId, 'mail-accounts', result.affectedRows || 0, actor), cx);
    return { deleted: result.affectedRows || 0, linkedCalendars: linked, attachments: files };
  });
  const { publishCalendarChanged } = require('./realtime') as typeof import('./realtime');
  for (const calendar of linkedCalendars) {
    if (calendar.provider === 'caldav') stopCalendarAccountWork(calendar.id, 'unlinked');
    publishCalendarChanged(userId, calendar.id, 'status');
  }
  const fileResult = await mail.deleteStoredAttachmentFiles(attachments.map(row => row.storage_path));
  return {
    message: `Deleted ${deleted} mail account(s). Removed ${fileResult.deletedFiles} attachment file(s).`,
    deleted,
    deletedAttachmentFiles: fileResult.deletedFiles,
    failedAttachmentFiles: fileResult.failedFiles,
  };
}

async function clearRecordingsData(userId: string, actor: ClearActor): Promise<ClearResult> {
  const { clearRecordings } = require('./recordings') as typeof import('./recordings');
  const deleted = await clearRecordings(userId, actor.adminId ? (cx, count) => recordAudit(auditEntry(userId, 'recordings', count, actor), cx) : undefined);
  return { message: `Deleted ${deleted} recording(s)`, deleted };
}

/** Deletes every item of one module of the person; `actor.adminId` for the administrator's path. */
async function clearModuleData(userId: string, target: ClearTarget, actor: ClearActor = {}): Promise<ClearResult> {
  await assertClearable(userId, target, actor);
  switch (target) {
    case 'contacts': return clearContacts(userId, actor);
    case 'calendar': return clearCalendar(userId, actor);
    case 'mail-accounts': return clearMailAccounts(userId, actor);
    case 'recordings': return clearRecordingsData(userId, actor);
  }
}

export { clearModuleData, isClearTarget, CLEAR_TARGETS, MODULE_OF as CLEAR_MODULES };
export type { ClearTarget, ClearResult };
