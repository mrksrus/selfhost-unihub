// What a user backup holds, by data class (F2, docs/DATA_RECOVERY.md). A
// backup carries UniHub's own data: local items, configuration, UniHub's
// state on synced tasks (as overlays) and Download-mode mail by the person's
// choice or a policy. Provider data (events of CalDAV and ICS calendars,
// Sync-mode mail with a server copy and its provider evidence) is a mirror:
// it downloads again after the accounts reconnect, so it is left out of new
// archives (backup-export.ts) and of older ones on import (filterOldArchive).
import type { RowDataPacket } from 'mysql2/promise';
import type { ArchiveEnvelope, BackupRow, SqlExecutor } from '../types';
import type { BackupContents, BackupDataClass, BackupLeftOut, BackupSectionId, DownloadMailChoice } from '../contracts/backup';
import crypto from 'node:crypto';
import { db } from '../state';
import { resolvePolicy } from './settings';

// Row classes as SQL on a row alias. A local calendar belongs to an account
// of the UniHub provider; an event without a calendar is local too.
const localEventSql = (event: string) => `(${event}.calendar_id IS NULL OR EXISTS (SELECT 1 FROM calendar_calendars class_c
  JOIN calendar_accounts class_a ON class_a.id = class_c.account_id AND class_a.user_id = class_c.user_id
  WHERE class_c.id = ${event}.calendar_id AND class_c.user_id = ${event}.user_id AND class_a.provider = 'local'))`;
// A Sync-mode message the provider holds: it has a server identity or an
// observed provider copy. A draft and UniHub's own copies without either are local.
const serverLinkedEmailSql = (email: string) => `(COALESCE(${email}.is_draft, FALSE) = FALSE AND (${email}.remote_uid IS NOT NULL OR ${email}.imap_uid IS NOT NULL
  OR EXISTS (SELECT 1 FROM mail_remote_occurrences class_o WHERE class_o.email_id = ${email}.id AND class_o.user_id = ${email}.user_id)))`;
const syncAccountSql = (accountId: string) => `EXISTS (SELECT 1 FROM mail_accounts class_m WHERE class_m.id = ${accountId} AND class_m.sync_mode = 'sync')`;

/**
 * A message a user backup keeps: a Download-mode one of an included account,
 * or a Sync-mode one without a server copy. `included` is a parameter list of
 * the included Download accounts' ids (an empty list includes none).
 */
function keptEmailSql(email: string, included: readonly string[]) {
  const download = included.length ? `${email}.mail_account_id IN (${included.map(() => '?').join(', ')})` : 'FALSE';
  return { sql: `((NOT ${syncAccountSql(`${email}.mail_account_id`)} AND ${download}) OR (${syncAccountSql(`${email}.mail_account_id`)} AND NOT ${serverLinkedEmailSql(email)}))`, params: [...included] };
}

/** "Include downloaded mail" as it applies to the person: forced by a policy, or for accounts that delete mail at the provider. */
async function downloadMailChoice(userId: string, executor: SqlExecutor = db): Promise<DownloadMailChoice> {
  const policy = await resolvePolicy(userId, 'backup.download_mail', executor);
  const [accounts] = await executor.execute<RowDataPacket[]>(
    "SELECT id FROM mail_accounts WHERE user_id = ? AND sync_mode <> 'sync' AND delete_emails_on_server = TRUE ORDER BY id", [userId]);
  const forcedAccounts = accounts.map(row => String(row.id));
  const always = policy.value === 'always';
  return {
    // Downloaded mail may be the only copy, so the choice starts on.
    value: true,
    forced: always,
    reason: always ? policy.reason : forcedAccounts.length ? 'Accounts that delete mail at the provider always include their downloaded mail.' : null,
    forced_account_ids: forcedAccounts,
  };
}

/** The Download-mode accounts whose mail an export includes. */
async function includedDownloadAccounts(userId: string, includeDownloadMail: boolean, executor: SqlExecutor = db) {
  const choice = await downloadMailChoice(userId, executor);
  if (!includeDownloadMail && !choice.forced) return choice.forced_account_ids;
  const [accounts] = await executor.execute<RowDataPacket[]>("SELECT id FROM mail_accounts WHERE user_id = ? AND sync_mode <> 'sync' ORDER BY id", [userId]);
  return accounts.map(row => String(row.id));
}

const SECTION_CLASSES: Readonly<Record<BackupSectionId, readonly BackupDataClass[]>> = Object.freeze({
  settings: ['config'], contacts: ['local'], calendar: ['local', 'config'], mail: ['local', 'config'], recordings: ['local'],
});

const LEFT_OUT = Object.freeze({
  synced_events: { section: 'calendar' as const, what: 'CalDAV and subscription events', reason: 'They download again from the provider after the accounts reconnect; UniHub\'s ToDo state and subtasks of synced tasks are in the backup.' },
  sync_mail: { section: 'mail' as const, what: 'Sync-mode mail', reason: 'It downloads again from the provider after the account signs in.' },
  download_mail: { section: 'mail' as const, what: 'Downloaded mail', reason: '"Include downloaded mail" was off.' },
});
type LeftOutKind = keyof typeof LEFT_OUT;

/** What an archive of these sections holds, with the counts of what it left out. */
function backupContents(sections: readonly string[], counts: Partial<Record<LeftOutKind, number>>, { downloadMail = false } = {}): BackupContents {
  const included = new Set<BackupDataClass>();
  for (const section of sections) for (const dataClass of SECTION_CLASSES[section as BackupSectionId] ?? []) included.add(dataClass);
  if (sections.includes('mail') && downloadMail) included.add('local-by-policy');
  const left_out: BackupLeftOut[] = (Object.keys(LEFT_OUT) as LeftOutKind[])
    .filter(kind => sections.includes(LEFT_OUT[kind].section) && Number(counts[kind]) > 0)
    .map(kind => ({ ...LEFT_OUT[kind], count: Number(counts[kind]) }));
  const notes: string[] = [];
  if (left_out.some(entry => entry.what !== LEFT_OUT.download_mail.what)) notes.push('Provider data is not in this backup; it downloads again after the accounts reconnect.');
  if (sections.includes('mail')) notes.push('Snoozes on Sync-mode mail are not kept; those messages come back unsnoozed.');
  return { included: [...included], left_out, notes };
}

const OVERLAY_SHAPE_DAYS = 30;
const asRows = (value: unknown) => Array.isArray(value) ? value as BackupRow[] : [];
const toMysqlDate = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');

// UniHub's own state on a task, as an overlay payload; null when there is none.
function overlayPayload(event: BackupRow, subtasks: readonly BackupRow[]) {
  const state = { todo_status: event.todo_status ?? null, done_at: event.done_at ?? null,
    source_email_id: event.source_email_id ?? null, source_email_json: event.source_email_json ?? null,
    subtasks: subtasks.map(row => ({ title: String(row.title ?? ''), is_done: !!row.is_done, position: Number(row.position) || 0 })) };
  return state.todo_status || state.done_at || state.source_email_id || state.source_email_json || state.subtasks.length ? state : null;
}

const accountIdentity = (account: BackupRow | undefined) => account ? [account.provider, account.account_email, account.base_url || account.discovery_url].map(value => String(value ?? '')).join('|') : '';

/**
 * Archives before data schema 7 carry mirrored rows. They are left out as a
 * new export leaves them out: events of CalDAV and ICS calendars with their
 * children (their UniHub state becomes overlays matched by title and start,
 * as these archives carry no UIDs), and Sync-mode mail with a server copy
 * with its files and the Sync accounts' provider evidence. Download-mode
 * mail stays, whatever today's policy says: it may be the only copy.
 */
function filterOldArchive(backup: ArchiveEnvelope, now = new Date()): { counts: Partial<Record<LeftOutKind, number>>; downloadMail: boolean } | null {
  if ((backup.source_backup_version ?? backup.version) >= 7) return null;
  const data = backup.data;
  const counts: Partial<Record<LeftOutKind, number>> = {};
  const removedFiles = new Set<string>();

  const accounts = new Map(asRows(data.calendar_accounts).map(row => [String(row.id), row]));
  const syncedCalendars = new Map<string, BackupRow>();
  for (const calendar of asRows(data.calendar_calendars)) {
    const account = accounts.get(String(calendar.account_id));
    if (account && account.provider !== 'local') syncedCalendars.set(String(calendar.id), account);
  }
  const syncedEvents = asRows(data.calendar_events).filter(event => syncedCalendars.has(String(event.calendar_id)));
  if (syncedEvents.length) {
    const removed = new Set(syncedEvents.map(event => String(event.id)));
    const subtasks = asRows(data.calendar_event_subtasks);
    const overlays = asRows(data.calendar_overlay_restores);
    for (const event of syncedEvents) {
      const payload = overlayPayload(event, subtasks.filter(row => String(row.event_id) === String(event.id)));
      if (!payload) continue;
      overlays.push({ id: crypto.randomUUID(), user_id: event.user_id, calendar_id: event.calendar_id, account_identity: accountIdentity(syncedCalendars.get(String(event.calendar_id))),
        uid: null, recurrence_id: '', match_kind: 'shape', shape_title: event.title ?? '', shape_start: event.start_time ?? null, payload: JSON.stringify(payload),
        created_at: toMysqlDate(now), expires_at: toMysqlDate(new Date(now.getTime() + OVERLAY_SHAPE_DAYS * 86400000)) });
    }
    data.calendar_overlay_restores = overlays;
    data.calendar_events = asRows(data.calendar_events).filter(event => !removed.has(String(event.id)));
    for (const table of ['calendar_event_subtasks', 'calendar_event_attendees', 'calendar_event_external_refs']) {
      if (data[table] !== undefined) data[table] = asRows(data[table]).filter(row => !removed.has(String(row.event_id)));
    }
    if (data.task_order !== undefined) data.task_order = asRows(data.task_order).filter(row => !removed.has(String(row.event_id)));
    counts.synced_events = removed.size;
  }

  const syncAccounts = new Set(asRows(data.mail_accounts).filter(row => row.sync_mode === 'sync').map(row => String(row.id)));
  if (syncAccounts.size) {
    const observed = new Set(asRows(data.mail_remote_occurrences).map(row => String(row.email_id)));
    const mirrored = new Set(asRows(data.emails).filter(row => syncAccounts.has(String(row.mail_account_id)) && !row.is_draft
      && (row.remote_uid != null || row.imap_uid != null || observed.has(String(row.id)))).map(row => String(row.id)));
    if (mirrored.size) {
      for (const id of mirrored) removedFiles.add(`raw_email:${id}`);
      for (const row of asRows(data.email_attachments)) if (mirrored.has(String(row.email_id))) removedFiles.add(`email_attachment:${row.id}`);
      data.emails = asRows(data.emails).filter(row => !mirrored.has(String(row.id)));
      for (const table of ['email_attachments', 'mail_email_scores', 'mail_folder_recovery_items']) {
        if (data[table] !== undefined) data[table] = asRows(data[table]).filter(row => !mirrored.has(String(row.email_id)));
      }
      counts.sync_mail = mirrored.size;
    }
    for (const table of ['mail_remote_mailboxes', 'mail_remote_occurrences', 'mail_gmail_messages', 'mail_writebacks', 'mail_operation_attempts', 'mail_engine_quarantine', 'mail_folder_reconciliations']) {
      if (data[table] !== undefined) data[table] = asRows(data[table]).filter(row => !syncAccounts.has(String(row.mail_account_id)));
    }
  }
  if (removedFiles.size) backup.files = backup.files.filter(file => !removedFiles.has(`${file.kind}:${file.id}`));

  return { counts, downloadMail: asRows(data.emails).some(row => !syncAccounts.has(String(row.mail_account_id))) };
}

const DATA_CLASSES = new Set<BackupDataClass>(['local', 'local-by-policy', 'mirror', 'org', 'config', 'installation', 'ciphertext']);
const text = (value: unknown, limit = 300) => typeof value === 'string' && value.trim() ? value.slice(0, limit) : null;

/**
 * What a restore says the archive holds, for the restored sections: an
 * older archive's from the class filter, a schema 7 archive's from its own
 * (untrusted) document, kept only in the shape UniHub writes.
 */
function archivedContents(backup: ArchiveEnvelope, sections: readonly string[], oldArchive: ReturnType<typeof filterOldArchive>, accountOnly = false): BackupContents {
  let contents: BackupContents;
  if (oldArchive) contents = backupContents(sections, oldArchive.counts, { downloadMail: oldArchive.downloadMail });
  else {
    const raw = (backup.contents && typeof backup.contents === 'object' ? backup.contents : {}) as Record<string, unknown>;
    const list = (value: unknown) => Array.isArray(value) ? value.slice(0, 50) : [];
    contents = {
      included: list(raw.included).filter((value): value is BackupDataClass => DATA_CLASSES.has(value as BackupDataClass)),
      left_out: list(raw.left_out).flatMap(entry => {
        const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const what = text(item.what), reason = text(item.reason);
        if (!sections.includes(item.section as string) || !what || !reason) return [];
        return [{ section: item.section as BackupSectionId, what, reason, ...(Number.isSafeInteger(item.count) && Number(item.count) >= 0 ? { count: Number(item.count) } : {}) }];
      }),
      notes: list(raw.notes).map(note => text(note)).filter((note): note is string => note !== null),
    };
  }
  if (accountOnly && !contents.included.includes('config')) contents.included.push('config');
  return contents;
}

export {
  archivedContents,
  localEventSql,
  serverLinkedEmailSql,
  syncAccountSql,
  keptEmailSql,
  downloadMailChoice,
  includedDownloadAccounts,
  backupContents,
  filterOldArchive,
  overlayPayload,
  accountIdentity,
  OVERLAY_SHAPE_DAYS,
};
export type { LeftOutKind };
