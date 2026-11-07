import type { RowDataPacket } from 'mysql2/promise';
import { exportableBinItems, parseRefs } from './bin';
import type { ApiError, BackupPayload, BackupRow, BackupFile, ArchiveEnvelope, SqlExecutor } from '../types';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { finished } from 'stream/promises';
import { db } from '../state';
import { decrypt } from '../security/encryption';
import { encryptPortableCredentialBundle, decryptPortableCredentialBundle } from './backup-container';
import { inspectRecordingAudio } from './recording-audio';
import { BACKUP_VERSION, ZIP_BACKUP_FORMAT, ZIP_BACKUP_FORMAT_VERSION, ARCHIVE_LAYOUTS, getBackupProducer } from './backup-format';
import { CONTACTS_ENTRY, calendarEntries, readableArchivePaths, writeContactsVcf } from './backup-readable';
import { exportContacts } from './contacts-export';
import type { ExportContact } from './contacts-vcard-write';
import {
  SECTION_POLICIES,
  TABLE_POLICIES,
  FILE_POLICIES,
  CONTENT_FILE_POLICIES,
  ACCOUNT_ONLY_TABLES,
  normalizeBackupRequest,
} from './backup-catalog';
import {
  BACKUP_FILE_ROOTS,
  sha256File,
  normalizeRows,
  isPathUnderRoot,
  getBackupRowCounts,
  jsonBuffer,
  assertBackupMetadataSize,
} from './backup-common';
import { scopeBackupForImport } from './backup-validate';
import { photoPath, photosRoot } from './contact-photos';
import { rowKeyKind } from './calendar-overlays';
import { accountIdentity, backupContents, includedDownloadAccounts, keptEmailSql, localEventSql, overlayPayload, serverLinkedEmailSql, syncAccountSql } from './backup-classes';
import type { LeftOutKind } from './backup-classes';
import type { BackupContents } from '../contracts/backup';

type CheckCancelled = (() => Promise<unknown>) | null;
interface SnapshotRow extends BackupRow {
  id: string;
  encrypted_password?: string | null;
  encrypted_access_token?: string | null;
  encrypted_refresh_token?: string | null;
  filing_account_id?: string | null;
}
type SnapshotData = BackupPayload['data'] & { mail_accounts?: SnapshotRow[]; calendar_accounts?: SnapshotRow[]; bin_items?: SnapshotRow[] };
interface ExportFile extends BackupFile {
  kind: string;
  id: string;
  source_path?: string;
  size_bytes: number;
  sha256: string | null;
  data_base64?: string | null;
}
interface ExportBackup extends ArchiveEnvelope {
  account_only_sections?: string[];
  files: ExportFile[];
  warnings: string[];
  exported_at: string;
  portable_credentials: ReturnType<typeof encryptPortableCredentialBundle> | null;
  data: SnapshotData;
  contents: BackupContents;
  // The contacts as the snapshot read them, for the archive's vCard copy;
  // never part of backup.json.
  contact_cards?: ExportContact[];
}
interface BackupOptions {
  includeFileData?: boolean;
  // "Include downloaded mail" (backup-classes.ts); a policy or provider deletion can force it.
  includeDownloadMail?: boolean;
  // Where the archive's data document is written while the archive is made.
  workDirectory?: string;
  portableCredentialKey?: Buffer | null;
  checkCancelled?: CheckCancelled;
  sections?: unknown;
  mailAccountId?: string | null;
  // The UUID the envelope names (backup-envelope.ts), recorded in the manifest.
  backupUuid?: string | null;
  // Also read the contacts as vCard records in the snapshot (the archive's Contacts.vcf).
  contactCards?: boolean;
}
interface CredentialBundle {
  mail_accounts: { id: string; password: string }[];
  calendar_accounts: { id: string; password: string | null; access_token: string | null; refresh_token: string | null }[];
}

async function readBackupFileEntry({
  kind,
  id,
  storagePath,
  rootPath,
  includeData = true,
  checkCancelled = null,
}: { kind: string; id: string; storagePath: string | null | undefined; rootPath: string; includeData?: boolean; checkCancelled?: CheckCancelled }): Promise<ExportFile | null> {
  if (!storagePath || !isPathUnderRoot(storagePath, rootPath)) return null;
  try {
    const sourcePath = path.resolve(storagePath);
    const stat = await fs.promises.stat(sourcePath);
    if (!stat.isFile()) throw new Error('Backup source is not a regular file');
    const entry: ExportFile = {
      kind,
      id,
      filename: path.basename(sourcePath),
      sha256: await sha256File(sourcePath, checkCancelled),
      size_bytes: stat.size,
    };
    if (includeData) {
      entry.data_base64 = (await fs.promises.readFile(sourcePath)).toString('base64');
    } else {
      entry.source_path = sourcePath;
    }
    return entry;
  } catch (error) {
    if (checkCancelled) await checkCancelled();
    return {
      kind,
      id,
      filename: path.basename(storagePath),
      missing: true,
      sha256: null,
      size_bytes: 0,
      data_base64: null,
    };
  }
}

// Where a content-addressed file kind keeps the user's files.
const CONTENT_FILE_STORES: Readonly<Record<string, { root: () => string; path: (userId: string, sha: string) => string }>> = Object.freeze({
  contact_photo: { root: photosRoot, path: photoPath },
});

// A recording bin item's file under the bin's name; null for any other item.
function binRecordingFile(row: SnapshotRow) {
  let payload: Record<string, unknown> | null = null;
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload as Record<string, unknown>; } catch { payload = null; }
  const file = typeof payload?.bin_path === 'string' ? payload.bin_path : parseRefs(row.file_refs)[0];
  return file || null;
}
// The photo files (by SHA-256) of the contacts in the snapshot's bin.
function binPhotoHashes(data: SnapshotData) {
  return [...new Set(((data.bin_items || []) as SnapshotRow[]).filter(row => row.item_type === 'contact').flatMap(row => parseRefs(row.file_refs)).filter(ref => /^[0-9a-f]{64}$/.test(ref)))];
}

// Content-addressed files of the snapshot's rows, each archived once. A row
// whose files are missing or no longer match their names is left out of the
// archive with a warning: the picture is already lost, and the rest of the
// section stays restorable.
async function readContentFileEntries(userId: string, data: SnapshotData, includeData: boolean, checkCancelled: CheckCancelled) {
  const entries: ExportFile[] = [];
  const warnings: string[] = [];
  for (const [kind, policy] of Object.entries(CONTENT_FILE_POLICIES)) {
    const rows = (data[policy.table] as SnapshotRow[] | undefined) || [];
    if (!rows.length && !(kind === 'contact_photo' && binPhotoHashes(data).length)) continue;
    const store = CONTENT_FILE_STORES[kind];
    if (!store) throw new Error(`Unsupported backup file root: ${kind}`);
    const read = new Map<string, ExportFile | null>();
    const kept: SnapshotRow[] = [];
    for (const row of rows) {
      const files: (ExportFile | null)[] = [];
      for (const column of policy.columns) {
        const sha = String(row[column]);
        if (!read.has(sha)) {
          if (checkCancelled) await checkCancelled();
          let storagePath: string | null = null;
          try { storagePath = store.path(userId, sha); } catch { storagePath = null; }
          const entry = await readBackupFileEntry({ kind, id: sha, storagePath, rootPath: store.root(), includeData, checkCancelled });
          read.set(sha, entry && !entry.missing && entry.sha256 === sha ? entry : null);
        }
        files.push(read.get(sha)!);
      }
      if (files.every(Boolean)) kept.push(row);
    }
    const lost = rows.length - kept.length;
    data[policy.table] = kept;
    const named = new Set(kept.flatMap(row => policy.columns.map(column => String(row[column]))));
    // The photos of contacts in the bin, which their restore from the bin puts back.
    if (kind === 'contact_photo') {
      for (const sha of binPhotoHashes(data)) {
        if (!read.has(sha)) {
          if (checkCancelled) await checkCancelled();
          let storagePath: string | null = null;
          try { storagePath = store.path(userId, sha); } catch { storagePath = null; }
          const entry = await readBackupFileEntry({ kind, id: sha, storagePath, rootPath: store.root(), includeData, checkCancelled });
          read.set(sha, entry && !entry.missing && entry.sha256 === sha ? entry : null);
        }
        named.add(sha);
      }
    }
    for (const [sha, entry] of read) if (entry && named.has(sha)) entries.push({ ...entry, filename: `${sha}.jpg` });
    if (lost) warnings.push(`${lost} contact photo${lost === 1 ? ' is' : 's are'} not in this backup because the stored picture is missing or damaged.`);
  }
  return { entries, warnings };
}

async function writeBackupJsonFile(value: Record<string, unknown>, targetPath: string) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const stream = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
  let pending = '';
  let streamError: Error | null = null;
  stream.on('error', error => {
    streamError = error;
  });

  const flush = async () => {
    if (!pending) return;
    const chunk = pending;
    pending = '';
    if (!stream.write(chunk, 'utf8')) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          stream.off('drain', onDrain);
          stream.off('error', onError);
        };
        stream.once('drain', onDrain);
        stream.once('error', onError);
      });
    }
    if (streamError) throw streamError;
  };

  const append = async (text: string) => {
    pending += text;
    if (pending.length >= 1024 * 1024) await flush();
  };

  const writeArray = async (items: unknown[]) => {
    await append('[');
    for (let index = 0; index < items.length; index += 1) {
      if (index > 0) await append(',');
      await append(JSON.stringify(items[index]) ?? 'null');
    }
    await append(']');
  };

  try {
    await append('{');
    const topLevelEntries = Object.entries(value).filter(([, item]) => item !== undefined);
    for (let index = 0; index < topLevelEntries.length; index += 1) {
      if (index > 0) await append(',');
      const [key, item] = topLevelEntries[index];
      await append(`${JSON.stringify(key)}:`);
      if (key === 'data' && item && typeof item === 'object' && !Array.isArray(item)) {
        await append('{');
        const dataEntries = Object.entries(item).filter(([, dataItem]) => dataItem !== undefined);
        for (let dataIndex = 0; dataIndex < dataEntries.length; dataIndex += 1) {
          if (dataIndex > 0) await append(',');
          const [dataKey, dataItem] = dataEntries[dataIndex];
          await append(`${JSON.stringify(dataKey)}:`);
          if (Array.isArray(dataItem)) await writeArray(dataItem);
          else await append(JSON.stringify(dataItem) ?? 'null');
        }
        await append('}');
      } else if (Array.isArray(item)) {
        await writeArray(item);
      } else {
        await append(JSON.stringify(item) ?? 'null');
      }
    }
    await append('}\n');
    await flush();
    stream.end();
    await finished(stream);
  } catch (error) {
    stream.destroy();
    await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeArchiveFileEntry(file: ExportFile) {
  const { data_base64, source_path, ...metadata } = file;
  return metadata;
}

function assertBackupFilesComplete(backup: ExportBackup) {
  const files = new Map((backup.files || []).map(file => [`${file.kind}:${file.id}`, file]));
  const required = [
    ...(backup.data.email_attachments || []).map(row => `email_attachment:${row.id}`),
    ...(backup.data.recordings || []).map(row => `recording:${row.id}`),
    ...(backup.data.emails || []).filter(row => row.raw_storage_path || row.import_complete === true || row.import_complete === 1)
      .map(row => `raw_email:${row.id}`),
  ];
  const missing = required.filter(key => {
    const file = files.get(key);
    return !file || file.missing || !file.source_path || !file.sha256;
  });
  if (missing.length) {
    const error: ApiError = new Error(`Backup cannot be completed: ${missing.length} referenced file(s) in the selected sections are missing or unreadable (${missing.slice(0, 3).join(', ')}). Check storage access or export other sections.`);
    error.status = 409;
    throw error;
  }
}

// Per-account mail export: each mail table restricted to one account's rows.
// Shared folders and global sender rules stay included because the account's
// folder mappings and rule overrides refer to them. Command receipts are not
// account-scoped and are left out.
const ACCOUNT_MAIL_FILTERS: Readonly<Record<string, string>> = Object.freeze({
  mail_accounts: 'b.id = ?',
  mail_account_settings: 'b.mail_account_id = ?',
  // Templates belong to the person, not to one account.
  mail_templates: 'FALSE',
  mail_folders: '(b.mail_account_id = ? OR b.mail_account_id IS NULL)',
  mail_folder_remote_boxes: 'b.mail_account_id = ?',
  mail_sender_rules: '(b.mail_account_id = ? OR b.mail_account_id IS NULL)',
  emails: 'b.mail_account_id = ?',
  email_attachments: 'b.email_id IN (SELECT ae.id FROM emails ae WHERE ae.user_id = b.user_id AND ae.mail_account_id = ?)',
  mail_email_scores: 'b.email_id IN (SELECT se.id FROM emails se WHERE se.user_id = b.user_id AND se.mail_account_id = ?)',
  mail_folder_reconciliations: 'b.mail_account_id = ?',
  mail_folder_recovery_items: 'b.source_account_id = ?',
  mail_folder_rule_overrides: 'b.mail_account_id = ? AND (r.mail_account_id IS NULL OR r.mail_account_id = b.mail_account_id)',
  mail_remote_mailboxes: 'b.mail_account_id = ?',
  mail_remote_occurrences: 'b.mail_account_id = ?',
  mail_gmail_messages: 'b.mail_account_id = ?',
  mail_writebacks: 'b.mail_account_id = ?',
  mail_operation_attempts: 'b.mail_account_id = ?',
  mail_command_receipts: 'FALSE',
  mail_engine_quarantine: 'b.mail_account_id = ?',
});

// A kept Gmail item carries its X-GM-MSGID: the account's one mapping of the
// item, else the identity an earlier restore brought (a second backup before
// the first sync). A backup leaves the mapping table out for Sync accounts.
const GMAIL_IDENTITY_SQL = `COALESCE((SELECT IF(COUNT(*) = 1, MIN(g.gmail_msgid), NULL) FROM mail_gmail_messages g
    WHERE g.email_id = b.id AND g.user_id = b.user_id AND g.mail_account_id = b.mail_account_id), b.remote_gmail_msgid)`;

// Account settings keep only connections a restore can sign in with again:
// every mail account and the remote calendar accounts. Local calendars have
// nothing to download, so they belong to the complete Calendar section.
const ACCOUNT_ONLY_FILTERS: Readonly<Record<string, string>> = Object.freeze({
  mail_accounts: 'TRUE',
  calendar_accounts: "b.provider IN ('caldav', 'ics')",
});

// The rows of a section table a user backup keeps, by data class
// (backup-classes.ts): mirrored provider rows are left out. `included` are
// the Download-mode accounts whose mail the backup holds.
function classFilter(table: string, included: readonly string[]): { sql: string; params: string[] } | null {
  const event = (alias: string) => `EXISTS (SELECT 1 FROM calendar_events ce WHERE ce.id = ${alias}.event_id AND ce.user_id = ${alias}.user_id AND ${localEventSql('ce')})`;
  const email = (alias: string) => {
    const kept = keptEmailSql('ke', included);
    return { sql: `EXISTS (SELECT 1 FROM emails ke WHERE ke.id = ${alias}.email_id AND ke.user_id = ${alias}.user_id AND ${kept.sql})`, params: kept.params };
  };
  const accounts = included.length ? { sql: `b.mail_account_id IN (${included.map(() => '?').join(', ')})`, params: [...included] } : { sql: 'FALSE', params: [] };
  switch (table) {
    case 'calendar_events': return { sql: localEventSql('b'), params: [] };
    case 'calendar_event_subtasks': case 'calendar_event_attendees': return { sql: event('b'), params: [] };
    case 'calendar_event_external_refs': return { sql: 'FALSE', params: [] };
    case 'emails': return keptEmailSql('b', included);
    case 'email_attachments': case 'mail_email_scores': case 'mail_folder_recovery_items': return email('b');
    case 'mail_remote_mailboxes': case 'mail_remote_occurrences': case 'mail_gmail_messages': case 'mail_writebacks':
    case 'mail_operation_attempts': case 'mail_engine_quarantine': return accounts;
    default: return null;
  }
}

// UniHub's state on the person's synced tasks, as overlays keyed by the
// calendar and the task's UID and recurrence id: the restore applies them
// to the task the provider sends again. A pending overlay of an earlier
// restore is already among the rows (a second backup before the first sync
// keeps it); a live task replaces one of the same identity.
async function syncedTaskOverlays(connection: SqlExecutor, userId: string, pending: readonly BackupRow[]) {
  const [events] = await connection.execute<RowDataPacket[]>(`SELECT e.id, e.calendar_id, e.uid, e.title, e.start_time, e.todo_status, e.done_at, e.source_email_id, e.source_email_json,
      COALESCE(r.recurrence_id, '') AS recurrence_id, o.uid AS object_uid, a.provider, a.account_email, a.base_url, a.discovery_url
    FROM calendar_events e
    JOIN calendar_calendars c ON c.id = e.calendar_id AND c.user_id = e.user_id
    JOIN calendar_accounts a ON a.id = c.account_id AND a.user_id = e.user_id
    LEFT JOIN calendar_event_external_refs r ON r.event_id = e.id AND r.user_id = e.user_id
    LEFT JOIN calendar_remote_objects o ON o.id = r.remote_object_id AND o.user_id = e.user_id
    WHERE e.user_id = ? AND a.provider <> 'local'
    ORDER BY e.calendar_id, e.uid, recurrence_id, e.id`, [userId]);
  if (!events.length) return [...pending];
  const [subtasks] = await connection.execute<RowDataPacket[]>(`SELECT s.event_id, s.title, s.is_done, s.position FROM calendar_event_subtasks s
    JOIN calendar_events e ON e.id = s.event_id AND e.user_id = s.user_id
    WHERE s.user_id = ? AND NOT ${localEventSql('e')} ORDER BY s.event_id, s.position, s.id`, [userId]);
  const [attendees] = await connection.execute<RowDataPacket[]>(`SELECT t.event_id, t.email, t.display_name, t.response_status, t.is_organizer, t.optional_attendee, t.comment
    FROM calendar_event_attendees t JOIN calendar_events e ON e.id = t.event_id AND e.user_id = t.user_id
    WHERE t.user_id = ? AND NOT ${localEventSql('e')} ORDER BY t.event_id, t.created_at, t.id`, [userId]);
  const byEvent = new Map<string, BackupRow[]>(), attendeesByEvent = new Map<string, BackupRow[]>();
  for (const row of normalizeRows(subtasks)) byEvent.set(String(row.event_id), [...(byEvent.get(String(row.event_id)) || []), row]);
  for (const row of normalizeRows(attendees)) attendeesByEvent.set(String(row.event_id), [...(attendeesByEvent.get(String(row.event_id)) || []), row]);
  // The kind of key is part of the item's identity: a row id and a provider UID that agree as text are two items.
  const key = (row: BackupRow) => JSON.stringify([row.calendar_id, row.match_kind, row.uid, String(row.recurrence_id ?? '')]);
  const overlays = new Map<string, BackupRow>();
  // One set aside as failed travels as it is, beside whatever the item has now.
  for (const row of pending) overlays.set(row.failed_at != null ? `failed:${row.id}` : row.match_kind !== 'shape' ? key(row) : `pending:${row.id}`, row);
  for (const event of normalizeRows(events)) {
    const payload = overlayPayload(event, byEvent.get(String(event.id)) || [], attendeesByEvent.get(String(event.id)) || []);
    if (!payload) continue;
    const overlay = { id: crypto.randomUUID(), user_id: userId, calendar_id: event.calendar_id, account_identity: accountIdentity(event), uid: event.uid,
      recurrence_id: String(event.recurrence_id ?? ''), match_kind: rowKeyKind({ id: event.id, uid: event.uid, object_uid: event.object_uid }), shape_title: event.title ?? '', shape_start: event.start_time ?? null,
      payload: JSON.stringify(payload), created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), expires_at: null, failed_at: null, failure: null };
    overlays.set(key(overlay), overlay);
  }
  return [...overlays.values()];
}

// How many rows of each kind the backup leaves out, for its contents.
async function leftOutCounts(connection: SqlExecutor, userId: string, sections: readonly string[], included: readonly string[], mailAccountId: string | null) {
  const counts: Partial<Record<LeftOutKind, number>> = {};
  const count = async (sql: string, params: unknown[]) => Number((await connection.execute<RowDataPacket[]>(sql, params as string[]))[0][0].n) || 0;
  if (sections.includes('calendar')) counts.synced_events = await count(`SELECT COUNT(*) AS n FROM calendar_events b WHERE b.user_id = ? AND NOT ${localEventSql('b')}`, [userId]);
  if (sections.includes('mail')) {
    const account = mailAccountId === null ? '' : ' AND b.mail_account_id = ?';
    const scope = mailAccountId === null ? [] : [mailAccountId];
    counts.sync_mail = await count(`SELECT COUNT(*) AS n FROM emails b WHERE b.user_id = ?${account} AND ${syncAccountSql('b.mail_account_id')} AND ${serverLinkedEmailSql('b')}`, [userId, ...scope]);
    const kept = included.length ? ` AND b.mail_account_id NOT IN (${included.map(() => '?').join(', ')})` : '';
    counts.download_mail = await count(`SELECT COUNT(*) AS n FROM emails b WHERE b.user_id = ?${account} AND NOT ${syncAccountSql('b.mail_account_id')}${kept}`, [userId, ...scope, ...included]);
  }
  return counts;
}

async function readBackupSnapshot(userId: string, sections: unknown, checkCancelled: CheckCancelled, mailAccountId: string | null = null, includeDownloadMail = true,
  withContactCards = false): Promise<{ data: SnapshotData; contents: BackupContents; contactCards: ExportContact[] }> {
  const request = normalizeBackupRequest(sections);
  if (mailAccountId !== null && request.accountOnlySections.length) throw new Error('An account backup cannot also export account settings only');
  const connection = await db.getConnection();
  try {
    if (checkCancelled) await checkCancelled();
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    // An account backup (offered before switching that account to Sync) keeps its mail.
    const exportsMail = request.sections.includes('mail') && !request.accountOnlySections.includes('mail');
    const included = mailAccountId !== null ? [mailAccountId] : exportsMail ? await includedDownloadAccounts(userId, includeDownloadMail, connection) : [];
    const data: SnapshotData = {};
    for (const section of request.sections) {
      const accountOnly = request.accountOnlySections.includes(section);
      for (const table of accountOnly ? [ACCOUNT_ONLY_TABLES[section]] : SECTION_POLICIES[section].tables) {
        if (checkCancelled) await checkCancelled();
        const policy = TABLE_POLICIES[table];
        if (table === 'bin_items') {
          // The person's items still in the bin, of this section's modules (bin.ts).
          const items = await exportableBinItems(connection, userId, section);
          data.bin_items = [...(data.bin_items || []), ...normalizeRows(items.map(({ row }) => Object.fromEntries(policy.columns.map(column => [column, row[column]])) as RowDataPacket)) as SnapshotRow[]];
          continue;
        }
        const columns = policy.columns.map(column => table === 'emails' && column === 'remote_gmail_msgid' ? `${GMAIL_IDENTITY_SQL} AS remote_gmail_msgid` : `b.\`${column}\``).join(', ');
        let from = `${table === 'user' ? 'users' : table} b`;
        let where = table === 'user' ? 'b.id = ?' : 'b.user_id = ?';
        let params = [userId];
        if (table === 'mail_folder_remote_boxes') {
          from += ' JOIN mail_folders f ON f.id = b.folder_id JOIN mail_accounts a ON a.id = b.mail_account_id';
          where = 'f.user_id = ? AND a.user_id = ?'; params = [userId, userId];
        } else if (table === 'mail_folder_rule_overrides') {
          from += ' JOIN mail_sender_rules r ON r.id = b.rule_id JOIN mail_accounts a ON a.id = b.mail_account_id';
          where = 'r.user_id = ? AND a.user_id = ?'; params = [userId, userId];
        }
        if (table === 'recording_transcription_jobs') where += " AND b.status = 'completed'";
        if (accountOnly) where += ` AND ${ACCOUNT_ONLY_FILTERS[table]}`;
        if (mailAccountId !== null && SECTION_POLICIES.mail.tables.includes(table)) {
          const filter = ACCOUNT_MAIL_FILTERS[table];
          if (!filter) throw new Error(`No account filter for mail table ${table}`);
          where += ` AND ${filter}`;
          if (filter.includes('?')) params = [...params, mailAccountId];
        }
        const byClass = classFilter(table, included);
        if (byClass) { where += ` AND ${byClass.sql}`; params = [...params, ...byClass.params]; }
        const order = policy.keyColumns.map(column => `b.\`${column}\``).join(', ');
        const [rows] = await connection.execute<RowDataPacket[]>(`SELECT ${columns} FROM ${from} WHERE ${where} ORDER BY ${order}`, params);
        if (table === 'user' && !rows.length) throw new Error('User not found');
        data[table] = table === 'user' ? normalizeRows(rows)[0] : normalizeRows(rows);
      }
      if (section === 'calendar' && !accountOnly) data.calendar_overlay_restores = await syncedTaskOverlays(connection, userId, (data.calendar_overlay_restores || []) as BackupRow[]);
    }
    // Filing in another account is local organisation outside this export;
    // the restored copy is filed under its own account instead.
    if (mailAccountId !== null) {
      for (const email of data.emails || []) {
        if (email.filing_account_id && email.filing_account_id !== mailAccountId) email.filing_account_id = null;
      }
    }
    const complete = request.sections.filter(section => !request.accountOnlySections.includes(section));
    const counts = await leftOutCounts(connection, userId, complete, included, mailAccountId);
    // In the same snapshot as the rows: the vCard copy then holds exactly the
    // contacts backup.json holds, whatever changes meanwhile.
    const contactCards = withContactCards && data.contacts?.length
      ? await exportContacts(userId, data.contacts.map(row => String(row.id)), { executor: connection }) : [];
    await connection.commit();
    const contents = backupContents(complete, counts, { downloadMail: included.length > 0 && complete.includes('mail') });
    // Account settings hold only the connections.
    if (request.accountOnlySections.length && !contents.included.includes('config')) contents.included.push('config');
    return { data, contents, contactCards };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function buildBackupForUser(userId: string, {
  includeFileData = true,
  portableCredentialKey = null,
  checkCancelled = null,
  sections = 'full',
  mailAccountId = null,
  includeDownloadMail = true,
  contactCards: withContactCards = false,
}: BackupOptions = {}): Promise<ExportBackup> {
  const { data, contents, contactCards } = await readBackupSnapshot(userId, sections, checkCancelled, mailAccountId, includeDownloadMail, withContactCards);
  const { accountOnlySections } = normalizeBackupRequest(sections);
  const fileEntries = [];
  for (const [kind, policy] of Object.entries(FILE_POLICIES)) {
    const rootPath = (BACKUP_FILE_ROOTS as Readonly<Record<string, string>>)[kind];
    if (!Object.hasOwn(BACKUP_FILE_ROOTS, kind) || !rootPath) throw new Error(`Unsupported backup file root: ${kind}`);
    for (const row of (data[policy.table] as SnapshotRow[] | undefined) || []) {
      if (policy.table === 'bin_items' && row.item_type !== 'recording') continue;
      if (checkCancelled) await checkCancelled();
      const entry = await readBackupFileEntry({
        kind,
        id: row.id,
        storagePath: policy.table === 'bin_items' ? binRecordingFile(row) : row[policy.column] as string | null | undefined,
        rootPath,
        includeData: includeFileData,
        checkCancelled,
      });
      if (entry) fileEntries.push(entry);
    }
  }
  // A recording in the bin whose file is gone cannot come back; it is left out.
  const binFiles = new Set(fileEntries.filter(entry => entry.kind === 'recording_bin' && !entry.missing).map(entry => String(entry.id)));
  const binRecordingsLost = (data.bin_items || []).filter(row => row.item_type === 'recording' && !binFiles.has(String(row.id))).length;
  if (binRecordingsLost) {
    data.bin_items = (data.bin_items || []).filter(row => row.item_type !== 'recording' || binFiles.has(String(row.id)));
    for (let index = fileEntries.length - 1; index >= 0; index -= 1) if (fileEntries[index].kind === 'recording_bin' && fileEntries[index].missing) fileEntries.splice(index, 1);
  }
  const content = await readContentFileEntries(userId, data, includeFileData, checkCancelled);
  fileEntries.push(...content.entries);
  if (binRecordingsLost) content.warnings.push(`${binRecordingsLost} recording${binRecordingsLost === 1 ? '' : 's'} in the bin ${binRecordingsLost === 1 ? 'is' : 'are'} not in this backup because the file is missing.`);

  let portableCredentials = null;
  if (portableCredentialKey) {
    const credentialBundle: CredentialBundle = {
      mail_accounts: [],
      calendar_accounts: [],
    };
    for (const account of data.mail_accounts || []) {
      const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
      if (password !== null) {
        credentialBundle.mail_accounts.push({ id: account.id, password });
      }
      account.encrypted_password = null;
    }
    for (const account of data.calendar_accounts || []) {
      const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
      const accessToken = account.encrypted_access_token ? decrypt(account.encrypted_access_token) : null;
      const refreshToken = account.encrypted_refresh_token ? decrypt(account.encrypted_refresh_token) : null;
      if (password !== null || accessToken !== null || refreshToken !== null) {
        credentialBundle.calendar_accounts.push({
          id: account.id,
          password,
          access_token: accessToken,
          refresh_token: refreshToken,
        });
      }
      account.encrypted_password = null;
      account.encrypted_access_token = null;
      account.encrypted_refresh_token = null;
    }
    portableCredentials = encryptPortableCredentialBundle(credentialBundle, portableCredentialKey);
  }

  const backup: ExportBackup = {
    app: 'unihub',
    version: BACKUP_VERSION,
    producer: getBackupProducer(),
    exported_at: new Date().toISOString(),
    warnings: [
      'Backups can contain encrypted account credentials and private email content. Store them securely.',
      portableCredentialKey
        ? 'Account credentials are protected by this backup and can be re-encrypted by another UniHub server.'
        : 'Encrypted account credentials only restore on deployments using the same ENCRYPTION_KEY.',
      ...content.warnings,
    ],
    data,
    contents,
    files: fileEntries,
    portable_credentials: portableCredentials,
    ...(withContactCards ? { contact_cards: contactCards } : {}),
  };
  if (accountOnlySections.length) {
    backup.account_only_sections = accountOnlySections;
    backup.warnings.push('Account settings contain no mail or calendar content. A restore signs in again and downloads from the provider.');
  }
  return backup;
}

async function buildBackupArchiveEntriesForUser(userId: string, sections: unknown = 'full', {
  portableCredentialKey = null,
  checkCancelled = null,
  mailAccountId = null,
  includeDownloadMail = true,
  workDirectory = os.tmpdir(),
  backupUuid = null,
}: BackupOptions = {}) {
  const fullBackup = await buildBackupForUser(userId, {
    includeFileData: false,
    sections,
    mailAccountId,
    includeDownloadMail,
    portableCredentialKey,
    checkCancelled,
    contactCards: true,
  });
  const scopedBackup = scopeBackupForImport(fullBackup, sections) as ExportBackup & { import_sections: string[] };
  assertBackupFilesComplete(scopedBackup);
  if (portableCredentialKey && scopedBackup.portable_credentials) {
    const credentials = decryptPortableCredentialBundle(
      scopedBackup.portable_credentials,
      portableCredentialKey
    ) as CredentialBundle;
    const mailAccountIds = new Set((scopedBackup.data.mail_accounts || []).map(account => account.id));
    const calendarAccountIds = new Set((scopedBackup.data.calendar_accounts || []).map(account => account.id));
    scopedBackup.portable_credentials = encryptPortableCredentialBundle({
      mail_accounts: (credentials.mail_accounts || []).filter(item => mailAccountIds.has(item.id)),
      calendar_accounts: (credentials.calendar_accounts || []).filter(item => calendarAccountIds.has(item.id)),
    }, portableCredentialKey);
  }
  const archiveFiles = [];
  const fileEntries = [];
  const missingFiles = [];
  const layout = ARCHIVE_LAYOUTS[ZIP_BACKUP_FORMAT_VERSION];
  // Messages and recordings under readable names (backup-readable.ts).
  const archivePaths = readableArchivePaths(scopedBackup.data, (scopedBackup.files || []).filter(file => !file?.missing && file?.source_path && file.sha256));

  for (const file of scopedBackup.files || []) {
    if (checkCancelled) await checkCancelled();
    if (file?.missing) {
      missingFiles.push(`${file.kind}:${file.id}`);
      archiveFiles.push(normalizeArchiveFileEntry(file));
      continue;
    }
    if (!file?.source_path || !file.sha256) {
      missingFiles.push(`${file?.kind || 'unknown'}:${file?.id || 'unknown'}`);
      archiveFiles.push({ ...normalizeArchiveFileEntry(file), missing: true });
      continue;
    }
    if (file.kind === 'recording') {
      try {
        await inspectRecordingAudio(file.source_path);
      } catch {
        const error: ApiError = new Error(`Backup cannot include recording ${file.id}: the stored audio is unsupported or unreadable. The original file was kept unchanged; export other sections or repair this recording first.`);
        error.status = 409;
        throw error;
      }
    }
    const archivePath = archivePaths.get(`${file.kind}:${file.id}`)!;
    archiveFiles.push({
      ...normalizeArchiveFileEntry(file),
      archive_path: archivePath,
      sha256: file.sha256,
      size_bytes: file.size_bytes,
    });
    fileEntries.push({
      name: archivePath,
      filePath: file.source_path,
      expectedSha256: file.sha256,
      expectedSize: file.size_bytes,
    });
  }

  const backupPayload = {
    app: 'unihub',
    version: BACKUP_VERSION,
    producer: getBackupProducer(),
    format: ZIP_BACKUP_FORMAT,
    format_version: ZIP_BACKUP_FORMAT_VERSION,
    exported_at: scopedBackup.exported_at,
    warnings: scopedBackup.warnings,
    data: scopedBackup.data,
    contents: scopedBackup.contents,
    files: archiveFiles,
    portable_credentials: scopedBackup.portable_credentials || null,
    ...(scopedBackup.account_only_sections ? { account_only_sections: scopedBackup.account_only_sections } : {}),
  };
  // The export job writes it beside its archive, never in the system's
  // temporary directory (a small tmpfs on some hosts); other callers choose.
  const dataPath = path.join(workDirectory, `unihub-backup-data-${crypto.randomUUID()}.json.partial`);
  const contactsPath = path.join(workDirectory, `unihub-backup-contacts-${crypto.randomUUID()}.vcf.partial`);
  try {
    await writeBackupJsonFile(backupPayload, dataPath);
    const checksums: { generated_at: string; algorithm: string; entries: Record<string, string> } = {
      generated_at: new Date().toISOString(),
      algorithm: 'sha256',
      entries: {
        [layout.backup]: await sha256File(dataPath, checkCancelled),
      },
    };
    for (const file of archiveFiles) {
      if (file.archive_path && file.sha256) checksums.entries[file.archive_path] = file.sha256;
    }
    // Copies for other programs, never read by restore.
    const derivedEntries: { name: string; data?: Buffer; filePath?: string; cleanupAfterWrite?: boolean; expectedSha256?: string; expectedSize?: number }[] = [];
    const scopedContacts = new Set((scopedBackup.data.contacts || []).map(row => String(row.id)));
    const cards = (fullBackup.contact_cards || []).filter(card => scopedContacts.has(String(card.contact.id)));
    // The photos the archive itself holds (content-addressed, by SHA-256).
    const photoFiles = new Map((scopedBackup.files || []).filter(file => file.kind === 'contact_photo' && !file.missing && file.source_path)
      .map(file => [String(file.id), String(file.source_path)]));
    if (await writeContactsVcf(cards, photoFiles, contactsPath, checkCancelled)) {
      const sha256 = await sha256File(contactsPath, checkCancelled);
      derivedEntries.push({ name: CONTACTS_ENTRY, filePath: contactsPath, cleanupAfterWrite: true, expectedSha256: sha256, expectedSize: (await fs.promises.stat(contactsPath)).size });
    }
    if (Array.isArray(scopedBackup.data.calendar_events) && scopedBackup.data.calendar_events.length) {
      // All-day items are dates in the person's zone.
      const [zoneRows] = await db.execute<RowDataPacket[]>('SELECT timezone FROM users WHERE id = ?', [userId]);
      for (const entry of calendarEntries(scopedBackup.data, zoneRows[0]?.timezone)) derivedEntries.push(entry);
    }
    for (const entry of derivedEntries) {
      checksums.entries[entry.name] = entry.expectedSha256 || crypto.createHash('sha256').update(entry.data!).digest('hex');
    }

    const manifest = {
      app: 'unihub',
      version: BACKUP_VERSION,
      producer: getBackupProducer(),
      format: ZIP_BACKUP_FORMAT,
      format_version: ZIP_BACKUP_FORMAT_VERSION,
      ...(backupUuid ? { backup_uuid: backupUuid } : {}),
      exported_at: backupPayload.exported_at,
      sections: scopedBackup.import_sections,
      ...(backupPayload.account_only_sections ? { account_only_sections: backupPayload.account_only_sections } : {}),
      row_counts: getBackupRowCounts(backupPayload),
      // What the archive holds by data class, and what it left out (schema 7).
      contents: scopedBackup.contents,
      file_count: archiveFiles.filter(file => file.archive_path).length,
      derived_files: derivedEntries.map(entry => entry.name),
      missing_files: missingFiles,
      warnings: [
        ...(backupPayload.warnings || []),
        portableCredentialKey
          ? 'Mail/calendar credentials are portable only while this encrypted backup can be unlocked.'
          : 'Mail/calendar credentials are encrypted and only restore on deployments with the same ENCRYPTION_KEY.',
        'Mail server deletion is always disabled after restore.',
      ],
    };

    const manifestData = jsonBuffer(manifest);
    const checksumData = jsonBuffer(checksums);
    const dataSize = (await fs.promises.stat(dataPath)).size;
    assertBackupMetadataSize('manifest.json', manifestData.length);
    assertBackupMetadataSize('checksums.json', checksumData.length);
    assertBackupMetadataSize('data/backup.json', dataSize);
    return [
      { name: layout.manifest, data: manifestData },
      { name: layout.backup, filePath: dataPath, cleanupAfterWrite: true,
        expectedSha256: checksums.entries[layout.backup], expectedSize: dataSize },
      { name: layout.checksums, data: checksumData },
      ...fileEntries,
      ...derivedEntries,
    ];
  } catch (error) {
    await fs.promises.rm(dataPath, { force: true }).catch(() => {});
    await fs.promises.rm(contactsPath, { force: true }).catch(() => {});
    throw error;
  }
}

export {
  readBackupFileEntry,
  writeBackupJsonFile,
  assertBackupFilesComplete,
  buildBackupForUser,
  buildBackupArchiveEntriesForUser,
};
