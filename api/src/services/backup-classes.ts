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
import { SETTLED } from './mail-engine/operation-states';
import { overlayAttendee, parseOverlayState } from './calendar-overlays';

// Row classes as SQL on a row alias. A local calendar belongs to an account
// of the UniHub provider; an event without a calendar is local too.
const localEventSql = (event: string) => `(${event}.calendar_id IS NULL OR EXISTS (SELECT 1 FROM calendar_calendars class_c
  JOIN calendar_accounts class_a ON class_a.id = class_c.account_id AND class_a.user_id = class_c.user_id
  WHERE class_c.id = ${event}.calendar_id AND class_c.user_id = ${event}.user_id AND class_a.provider = 'local'))`;
// A Sync-mode message is the provider's copy, which a re-sync brings back,
// only on the evidence the Sync policy (mail-sync-policy.ts) acts on: a
// present occurrence in an active mailbox of the same UIDVALIDITY, and none
// of what that policy never removes (a draft, Legacy mail, mail filed in
// another account, an unsettled provider change). A copy marked missing at
// the provider, or one only historical IMAP ids point at, is UniHub's own.
// providerCopyIds applies the same rule to an archive's rows.
const UNSETTLED_SQL = SETTLED.map(state => `'${state}'`).join(', ');
const serverLinkedEmailSql = (email: string) => `(COALESCE(${email}.is_draft, FALSE) = FALSE AND COALESCE(${email}.is_legacy, FALSE) = FALSE
  AND COALESCE(${email}.remote_missing, FALSE) = FALSE AND COALESCE(${email}.filing_account_id, ${email}.mail_account_id) = ${email}.mail_account_id
  AND NOT EXISTS (SELECT 1 FROM mail_writebacks class_w WHERE class_w.email_id = ${email}.id AND class_w.user_id = ${email}.user_id
    AND (class_w.state IS NULL OR class_w.state NOT IN (${UNSETTLED_SQL})))
  AND EXISTS (SELECT 1 FROM mail_remote_occurrences class_o JOIN mail_remote_mailboxes class_mb ON class_mb.id = class_o.mailbox_id
      AND class_mb.user_id = class_o.user_id AND class_mb.mail_account_id = class_o.mail_account_id AND class_mb.state = 'active' AND class_mb.uidvalidity = class_o.uidvalidity
    WHERE class_o.email_id = ${email}.id AND class_o.user_id = ${email}.user_id AND class_o.mail_account_id = ${email}.mail_account_id AND class_o.presence = 'present'))`;

const asRows = (value: unknown) => Array.isArray(value) ? value as BackupRow[] : [];
const flag = (value: unknown) => value === true || value === 1 || value === '1';
/** The archive's Sync-mode messages that are the provider's copy, by the rule of serverLinkedEmailSql. */
function providerCopyIds(data: Record<string, unknown>, syncAccounts: ReadonlySet<string>) {
  const mailboxes = new Map(asRows(data.mail_remote_mailboxes).map(row => [String(row.id), row]));
  const live = new Set<string>();
  for (const row of asRows(data.mail_remote_occurrences)) {
    const mailbox = mailboxes.get(String(row.mailbox_id));
    if (row.presence === 'present' && mailbox && mailbox.state === 'active' && String(mailbox.uidvalidity) === String(row.uidvalidity)
      && String(mailbox.mail_account_id) === String(row.mail_account_id)) live.add(`${row.email_id}|${row.mail_account_id}`);
  }
  const unsettled = new Set(asRows(data.mail_writebacks).filter(row => row.state == null || !SETTLED.includes(String(row.state))).map(row => String(row.email_id)));
  return new Set(asRows(data.emails).filter(row => syncAccounts.has(String(row.mail_account_id)) && !flag(row.is_draft) && !flag(row.is_legacy) && !flag(row.remote_missing)
    && (row.filing_account_id == null || String(row.filing_account_id) === String(row.mail_account_id)) && !unsettled.has(String(row.id))
    && live.has(`${row.id}|${row.mail_account_id}`)).map(row => String(row.id)));
}
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
  synced_events: { section: 'calendar' as const, what: 'CalDAV and subscription events', reason: 'They download again from the provider after the accounts reconnect; UniHub\'s ToDo state, subtasks and replies of synced items are in the backup.' },
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
const toMysqlDate = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');

// The ToDo states a task can have (contracts/tasks.ts). The column is free
// text, so a value outside them is left out rather than written into an
// archive its reader would refuse.
const TODO_STATUSES: ReadonlySet<string> = new Set(['done', 'changed', 'time_moved', 'cancelled']);

// UniHub's own state on a task, as an overlay payload in the overlay owner's
// form (calendar-overlays.ts); null when there is none. A value outside what
// the overlay reader (backup-overlays.ts) accepts is left out, so converting
// an older archive never writes a state its own restore would refuse.
function overlayPayload(event: BackupRow, subtasks: readonly BackupRow[], attendees: readonly BackupRow[] = []) {
  return parseOverlayState({ todo_status: event.todo_status, done_at: event.done_at, source_email_id: event.source_email_id, source_email_json: event.source_email_json,
    subtasks: subtasks.map(row => ({ title: String(row.title ?? ''), is_done: !!row.is_done, position: Number(row.position) || 0 })),
    attendees: attendees.map(row => overlayAttendee({ ...row, is_organizer: row.is_organizer ? 1 : 0, optional_attendee: row.optional_attendee ? 1 : 0 })) });
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
    const subtasks = asRows(data.calendar_event_subtasks), attendees = asRows(data.calendar_event_attendees);
    const overlays = asRows(data.calendar_overlay_restores);
    for (const event of syncedEvents) {
      const own = (row: BackupRow) => String(row.event_id) === String(event.id);
      const payload = overlayPayload(event, subtasks.filter(own), attendees.filter(own));
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

  // A kept Gmail item takes its X-GM-MSGID from the archive's mapping, as a
  // schema 7 backup carries it on the item (remote_gmail_msgid).
  const gmailIds = new Map<string, string[]>();
  for (const row of asRows(data.mail_gmail_messages)) {
    const key = `${row.mail_account_id}:${row.email_id}`;
    gmailIds.set(key, [...(gmailIds.get(key) || []), String(row.gmail_msgid)]);
  }
  for (const email of asRows(data.emails)) {
    const ids = gmailIds.get(`${email.mail_account_id}:${email.id}`);
    if (ids?.length === 1 && email.remote_gmail_msgid == null) email.remote_gmail_msgid = ids[0];
  }
  const syncAccounts = new Set(asRows(data.mail_accounts).filter(row => row.sync_mode === 'sync').map(row => String(row.id)));
  if (syncAccounts.size) {
    const mirrored = providerCopyIds(data, syncAccounts);
    if (mirrored.size) {
      for (const id of mirrored) removedFiles.add(`raw_email:${id}`);
      for (const row of asRows(data.email_attachments)) if (mirrored.has(String(row.email_id))) removedFiles.add(`email_attachment:${row.id}`);
      data.emails = asRows(data.emails).filter(row => !mirrored.has(String(row.id)));
      for (const table of ['email_attachments', 'mail_email_scores', 'mail_folder_recovery_items']) {
        if (data[table] !== undefined) data[table] = asRows(data[table]).filter(row => !mirrored.has(String(row.email_id)));
      }
      counts.sync_mail = mirrored.size;
    }
    // A folder reconciliation marker stays: it is UniHub's record of folder
    // moves already made, which a sync after the restore must not repeat.
    for (const table of ['mail_remote_mailboxes', 'mail_remote_occurrences', 'mail_gmail_messages', 'mail_writebacks', 'mail_operation_attempts', 'mail_engine_quarantine']) {
      if (data[table] !== undefined) data[table] = asRows(data[table]).filter(row => !syncAccounts.has(String(row.mail_account_id)));
    }
  }
  if (removedFiles.size) backup.files = backup.files.filter(file => !removedFiles.has(`${file.kind}:${file.id}`));

  return { counts, downloadMail: asRows(data.emails).some(row => !syncAccounts.has(String(row.mail_account_id))) };
}

// What a review of an archive before data schema 7 says first: it was read
// under today's rule, and holds nothing of what 0.28 added.
const OLD_ARCHIVE_NOTE = 'This backup was made before 0.28: what providers hold was left out when it was read, as a new backup leaves it out, and it has no bin.';

const DATA_CLASSES = new Set<BackupDataClass>(['local', 'local-by-policy', 'mirror', 'org', 'config', 'installation', 'ciphertext']);
const text = (value: unknown, limit = 300) => typeof value === 'string' && value.trim() ? value.slice(0, limit) : null;

/**
 * What a restore says the archive holds, for the restored sections: an
 * older archive's from the class filter, a schema 7 archive's from its own
 * (untrusted) document, kept only in the shape UniHub writes.
 */
function archivedContents(backup: ArchiveEnvelope, sections: readonly string[], oldArchive: ReturnType<typeof filterOldArchive>, accountOnly = false): BackupContents {
  let contents: BackupContents;
  if (oldArchive) {
    contents = backupContents(sections, oldArchive.counts, { downloadMail: oldArchive.downloadMail });
    contents.notes.unshift(OLD_ARCHIVE_NOTE);
  }
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
  TODO_STATUSES,
};
export type { LeftOutKind };
