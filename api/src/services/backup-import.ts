import type { RowDataPacket } from 'mysql2/promise';
import type { ArchiveEnvelope, ApiError, BackupRow, SqlExecutor } from '../types';
import type { ImportOptions, RestoreArchive, ImportResult, RestoredAccounts } from '../types/backup-restore';
import { sameProviderMailbox } from './mail-account-mode';
import { MAIL_WINDOW_DAYS, DEFAULT_TRASH_WINDOW_DAYS } from './mail-sync-policy';
import fs from 'fs';
import { db } from '../state';
import { DEFAULT_MAIL_SYNC_FETCH_LIMIT, normalizeSyncFetchLimit } from './mail';
import { resolveCalDavUrl } from '../security/caldav-transport';
import { accountCredentialScope } from './caldav';
import { chooseTargetId, writeOwnedRow, resolveOwnedReference, assertOwnedRelationship } from './backup-ownership';
import { inspectRecordingAudio } from './recording-audio';
import { normalizeBackupPayload } from './backup-format';
import { restoreMailRecovery, validateRestoredMailDestinations } from './backup-mail-recovery';
import { pauseMailRestore, restoreMailEngineEvidence } from './backup-mail-engine';
import { isModuleEnabled } from './module-settings';
import { SETTINGS, referenceKeys, restorableValue } from './settings';
import { normalizeSignature } from './mail-signature';
import { copyKey, copyNumber, isOrderKey, itemKey, keyBase } from './task-order';
import { lockMovesForRestore, settleMovesForRestore } from './calendar-move';
import {
  isFileRangeSource,
  normalizeMysqlDateTime,
  normalizeConflictMode,
  normalizeCalendarMode,
  normalizeCredentialMode,
} from './backup-common';
import {
  validateBackupPayload,
  validateBackupPayloadFromFileSources,
  countBackupRows,
  countRestoreConflicts,
  scopeBackupForImport,
} from './backup-validate';
import {
  prepareCredentialsForRestore,
  restoredCalendarLacksLogin,
  overwriteUserId,
  checkRestoredAccountPolicy,
  shouldWriteExisting,
  findExistingCalendarAccountForRestore,
  findExistingCalendarForRestore,
  findExistingCalendarEventForRestore,
  findExistingEmailForRestore,
  restoreMailFolderRemoteBox,
  remapRestoredInlineAttachments,
  findExistingAttachmentForRestore,
  findExistingRecordingForRestore,
  writeRestoredFile,
  writeRestoredContactPhoto,
} from './backup-restore-mapping';
import { backupFromZipBuffer, backupFromZipFile } from './backup-zip-reader';
import { restoreContactsSection } from './backup-contacts';
import { releasePhotoFiles, withContactPhotoLock } from './contact-photos';
import { log } from '../log';

const accountLabel = (row: BackupRow) => row.email_address || row.account_email || row.display_name || row.id;

// Account settings restore like a fresh sign-in: the first download starts now
// instead of waiting for the next scheduled pass. Both are already durable: the
// mail sync job was queued with the restore, and restored calendar accounts are
// pending, which the calendar pass treats as an owed first sync. This only
// starts them sooner. Failures stay visible on the account.
function startRestoredAccountSync(userId: string, { mailAccountIds, calendarAccountIds }: RestoredAccounts) {
  setImmediate(async () => {
    try {
      const mail = require('./mail') as typeof import('./mail');
      for (const accountId of mailAccountIds) await mail.scheduleMailAccountSync(accountId);
    } catch (error) {
      console.warn('[BACKUP RESTORE] Could not start mail sync for restored accounts:', (error as Error).message);
    }
    const { syncCalendarAccountInBackground } = require('./calendar-sync') as typeof import('./calendar-sync');
    for (const accountId of calendarAccountIds) syncCalendarAccountInBackground(accountId, { userId, reason: 'restore' });
  });
}

// An archive's email link is a UUID or nothing; the snapshot is JSON text.
function sourceEmailId(value: unknown) {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}
function sourceEmailJson(value: unknown) {
  if (value == null) return null;
  try { return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value); } catch { return null; }
}

const SETTING_KEYS = new Set(Object.keys(SETTINGS.user));

// The archived task's order key: its own, or its id before 0.27 (an id that
// is no valid key, which UniHub never writes, leaves the new id as the key).
function archivedOrderKey(row: BackupRow) {
  if (typeof row.order_key === 'string' && row.order_key) return row.order_key;
  return isOrderKey(String(row.id)) ? String(row.id) : null;
}

// Kept on the restored event unless it is the event's id anyway (services/task-order.ts).
function restoredOrderKey(row: BackupRow, targetId: string) {
  const key = archivedOrderKey(row);
  return key === null || key === targetId ? null : key;
}

// Distinct tasks must not share a key, or they tie for good. When a restored
// task's key is already another of the person's tasks' (a copy kept beside
// its original), every restored task of that key base is renumbered: in the
// archive's key order, after every key of that base the person already has.
// So the restored group keeps its own order and follows the tasks there
// before it.
async function separateCopyKeys(connection: SqlExecutor, userId: string, written: readonly { row: BackupRow; targetId: string }[]) {
  const restored = new Set(written.map(entry => entry.targetId));
  const groups = new Map<string, { key: string; targetId: string }[]>();
  for (const { row, targetId } of written) {
    const key = archivedOrderKey(row);
    if (key !== null) groups.set(keyBase(key), [...(groups.get(keyBase(key)) || []), { key, targetId }]);
  }
  for (const [base, entries] of groups) {
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT id, COALESCE(order_key, id) AS order_key FROM calendar_events WHERE user_id = ? AND (id = ? OR order_key = ? OR order_key LIKE ? ESCAPE '\\\\')",
      [userId, base, base, `${base.replace(/[\\%_]/g, '\\$&')}~%`]);
    const held = rows.filter(row => !restored.has(String(row.id))).map(row => String(row.order_key));
    const keys = entries.map(entry => entry.key);
    if (new Set(keys).size === keys.length && !keys.some(key => held.includes(key))) continue;
    let next = Math.max(0, ...held.map(key => copyNumber(key, base))) + 1;
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.targetId < b.targetId ? -1 : 1));
    for (const entry of entries) {
      await connection.execute('UPDATE calendar_events SET order_key = ? WHERE id = ? AND user_id = ?', [copyKey(base, next), entry.targetId, userId]);
      next += 1;
    }
  }
}
// Settings that name a record restored later in the run, by the section
// whose id map remaps them: each is held back and written after it.
const MAIL_REFERENCE_KEYS = new Set(referenceKeys('mail_account'));
const CALENDAR_REFERENCE_KEYS = new Set(referenceKeys('calendar', 'task_list'));

// The restored copy of the record, or the same record when it is still this
// user's (settings restored without its section); otherwise '' (UniHub's
// choice) rather than an id that names nothing.
async function restoredReference(connection: SqlExecutor, userId: string, table: 'mail_accounts' | 'calendar_calendars', archivedId: string, idMap: ReadonlyMap<string, string>) {
  const mapped = idMap.get(archivedId);
  if (mapped) return mapped;
  const [owned] = await connection.execute<RowDataPacket[]>(`SELECT id FROM ${table} WHERE id = ? AND user_id = ? LIMIT 1`, [archivedId, userId]);
  return owned.length ? archivedId : '';
}

async function writeRestoredReferences(connection: SqlExecutor, userId: string, references: ReadonlyMap<string, string>, table: 'mail_accounts' | 'calendar_calendars', idMap: ReadonlyMap<string, string>) {
  for (const [key, archivedId] of references) {
    await writeOwnedRow(connection, userId, 'user_settings',
      ['user_id', 'setting_key', 'setting_value'],
      [userId, key, await restoredReference(connection, userId, table, archivedId, idMap)],
      ['setting_value']
    );
  }
}

// Archives from before 0.24 carry no signature; the account keeps its own.
async function restoreSignature(connection: SqlExecutor, userId: string, accountId: string, row: BackupRow) {
  if (row.signature_html === undefined && row.signature_text === undefined) return;
  let signature;
  try { signature = normalizeSignature({ html: row.signature_html, text: row.signature_text }); } catch { return; }
  await connection.execute('UPDATE mail_accounts SET signature_html = ?, signature_text = ? WHERE id = ? AND user_id = ?',
    [signature.html, signature.text, accountId, userId]);
}

// A folder named by id follows its restored copy; one that names nothing of
// this user's is dropped from the list.
async function remapFolderRefs(connection: SqlExecutor, userId: string, text: string, folderIds: ReadonlyMap<string, string>) {
  const refs = JSON.parse(text) as string[];
  const kept: string[] = [];
  for (const ref of refs) {
    if (!ref.startsWith('folder:')) { kept.push(ref); continue; }
    const mapped = folderIds.get(ref.slice(7));
    if (mapped) { kept.push(`folder:${mapped}`); continue; }
    const [owned] = await connection.execute<RowDataPacket[]>('SELECT id FROM mail_folders WHERE id = ? AND user_id = ?', [ref.slice(7), userId]);
    if (owned.length) kept.push(ref);
  }
  return JSON.stringify([...new Set(kept)]);
}

// Threading headers and snooze state (0.24); older archives leave them as they are.
const EMAIL_HEADER_COLUMNS = ['in_reply_to', 'references_header', 'thread_key', 'snoozed_until', 'snooze_returned_at'] as const;
async function restoreEmailHeaders(connection: SqlExecutor, userId: string, emailId: string, row: BackupRow) {
  const present = EMAIL_HEADER_COLUMNS.filter(column => row[column] !== undefined);
  if (!present.length) return;
  const value = (column: typeof EMAIL_HEADER_COLUMNS[number]) => {
    const raw = row[column];
    if (raw == null || raw === '') return null;
    if (column === 'snoozed_until' || column === 'snooze_returned_at') return normalizeMysqlDateTime(raw as Parameters<typeof normalizeMysqlDateTime>[0]);
    if (column === 'thread_key') return typeof raw === 'string' && /^[0-9a-f]{64}$/.test(raw) ? raw : null;
    return String(raw).slice(0, column === 'in_reply_to' ? 998 : 65535);
  };
  await connection.execute(`UPDATE emails SET ${present.map(column => `${column} = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
    [...present.map(value), emailId, userId]);
}

async function importBackupForUser(userId: string, backup: ArchiveEnvelope, {
  mode = 'dry-run',
  sections = 'full',
  conflict_mode = 'keep_existing',
  calendar_mode = 'merge_same_name',
  credentials_mode = 'keep_existing',
  fileBuffersByPath = null,
  fileSourcesByPath = fileBuffersByPath,
  portableCredentialKey = null,
  checkCancelled = null,
  onProgress = null,
  restoreJobId = null,
  beforeCommit = null,
  startAccountSync = startRestoredAccountSync,
}: ImportOptions = {}): Promise<ImportResult> {
  const conflictMode = normalizeConflictMode(conflict_mode);
  const calendarMode = normalizeCalendarMode(calendar_mode);
  const credentialsMode = normalizeCredentialMode(credentials_mode);
  const validation = fileSourcesByPath && Array.from(fileSourcesByPath.values()).some(isFileRangeSource)
    ? await validateBackupPayloadFromFileSources(backup, fileSourcesByPath)
    : validateBackupPayload(backup, { fileBuffersByPath });
  // Verify the original hashes before migration changes the in-memory payload.
  if (validation.valid) backup = normalizeBackupPayload(backup);
  const scopedBackup = scopeBackupForImport(backup, sections) as RestoreArchive & { import_sections: string[] };
  // Sections that carry only account settings: restored accounts sign in
  // again and download from the provider instead of restoring content.
  const accountOnly = new Set((Array.isArray(scopedBackup.account_only_sections) ? scopedBackup.account_only_sections : [])
    .filter((section: unknown) => scopedBackup.import_sections.includes(section as string)));
  const accountOnlySections = scopedBackup.import_sections.filter(section => accountOnly.has(section));
  const counts = countBackupRows(scopedBackup);
  const conflicts = await countRestoreConflicts(userId, scopedBackup).catch(() => ({}));
  if (!validation.valid || mode !== 'apply') {
    return {
      dry_run: mode !== 'apply',
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      counts,
      import_sections: scopedBackup.import_sections,
      account_only_sections: accountOnlySections,
      conflicts,
      options: {
        conflict_mode: conflictMode,
        calendar_mode: calendarMode,
        credentials_mode: credentialsMode,
      },
    };
  }

  // Contact photo files are shared by content: their writes, the commit and
  // their release run alone among this user's photo changes (contact-photos.ts).
  const apply = async (): Promise<ImportResult> => {
    prepareCredentialsForRestore(scopedBackup, portableCredentialKey, validation.warnings);
    const data = scopedBackup.data || {};
    const restoredPaths: Map<string, string> = new Map();
    const createdRestorePaths: string[] = [];
    const scopedFiles = scopedBackup.files || [];
    // Contact photos: the files written (by name) and those this restore added.
    const photoFiles = new Set<string>();
    const createdPhotos: string[] = [];
    let releasedPhotos: string[] = [];
    const photoNames = new Set((Array.isArray(data.contact_photos) ? data.contact_photos as BackupRow[] : []).flatMap(row => [row.sha256, row.thumb_sha256].map(String)));
    const cleanupCreatedFiles = () => Promise.all([
      ...createdRestorePaths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => {})),
      releasePhotoFiles(userId, createdPhotos).catch(() => {}),
    ]);
    let connection;
    let commitAttempted = false;
    try {
      for (let fileIndex = 0; fileIndex < scopedFiles.length; fileIndex += 1) {
        const file = scopedFiles[fileIndex];
        if (checkCancelled) await checkCancelled();
        if (onProgress) {
          await onProgress('files', 40 + Math.round((fileIndex / Math.max(scopedFiles.length, 1)) * 5));
        }
        if (file.kind === 'contact_photo') {
          // Only a file a photo row of this archive names is written.
          if (!photoNames.has(String(file.id))) continue;
          const created = await writeRestoredContactPhoto(userId, file, { fileBuffersByPath, fileSourcesByPath, checkCancelled });
          if (created === null) continue;
          photoFiles.add(String(file.id));
          if (created) createdPhotos.push(String(file.id));
          continue;
        }
        const restoredPath = await writeRestoredFile(userId, file, {
          fileBuffersByPath,
          fileSourcesByPath,
          restoreJobId,
          checkCancelled,
        });
        if (restoredPath) {
          restoredPaths.set(`${file.kind}:${file.id}`, restoredPath);
          createdRestorePaths.push(restoredPath);
        }
      }

      connection = await db.getConnection();
      await connection.beginTransaction();
      // Account settings add new connections only; existing accounts and their
      // retained mail are not touched, so nothing needs pausing.
      if (scopedBackup.import_sections.includes('mail') && !accountOnly.has('mail')) {
        await pauseMailRestore(connection, userId);
      }
      const startMailAccountIds = [];
      const startCalendarAccountIds = [];
      const calendarAccountIdMap = new Map();
      const calendarIdMap = new Map();
      const calendarEventIdMap = new Map();
      // Email links of restored events, remapped once the mail section is in.
      const eventsWithSourceEmail = new Map<string, string>();
      const claimedCalendarEventIds = new Set<string>();
      // Events this restore wrote, with their archived row (for the order).
      const writtenCalendarEvents: { row: BackupRow; targetId: string }[] = [];
      const writtenCalendarIds = new Set<string>();
      const mailAccountIdMap = new Map();
      const mailFolderIdMap = new Map();
      const mailRuleIdMap = new Map();
      const writtenEmailIds = new Set<string>();
      const emailIdMap = new Map();
      const claimedEmailIds = new Set<string>();
      const claimedAttachmentIds = new Set<string>();
      const claimedRecordingIds = new Set<string>();
      const skippedRecordingIds = new Set<string>();
      const writtenEmailHtml = new Map();
      const attachmentIdsByEmail = new Map();
      const recordingIdMap = new Map();
      const recordingTagIdMap = new Map();
      const checkRestoreCancelled = async () => {
        if (checkCancelled) await checkCancelled();
      };
      const reportRestoreProgress = async (phase: string, progress: number) => {
        if (onProgress) await onProgress(phase, progress);
      };

      const backupUser = data.user;
      await reportRestoreProgress('settings', 46);
      if (backupUser && typeof backupUser === 'object' && conflictMode === 'replace') {
        await connection.execute(
          `UPDATE users
           SET full_name = COALESCE(?, full_name),
               avatar_url = ?,
               timezone = ?
           WHERE id = ?`,
          [backupUser.full_name || null, backupUser.avatar_url || null, backupUser.timezone || null, userId]
        );
      }

      const archivedMailReferences = new Map<string, string>();
      const archivedCalendarReferences = new Map<string, string>();
      for (const setting of data.user_settings || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(setting, userId);
        if (conflictMode === 'keep_existing') {
          const [existingSetting] = await connection.execute<RowDataPacket[]>(
            'SELECT setting_key FROM user_settings WHERE user_id = ? AND setting_key = ? LIMIT 1',
            [row.user_id, row.setting_key]
          );
          if (existingSetting.length) continue;
        }
        // Names a mail account or calendar, which may get a new ID below;
        // written after its section, with that section's id map.
        const settingKey = String(row.setting_key);
        if ((MAIL_REFERENCE_KEYS.has(settingKey) || CALENDAR_REFERENCE_KEYS.has(settingKey)) && row.setting_value) {
          if (restorableValue('user', settingKey, row.setting_value) === null) continue;
          (MAIL_REFERENCE_KEYS.has(settingKey) ? archivedMailReferences : archivedCalendarReferences).set(settingKey, String(row.setting_value));
          continue;
        }
        // A registry setting keeps only a value the registry accepts; other keys
        // (module and page choices) are checked by their owners when read.
        if (restorableValue('user', String(row.setting_key), row.setting_value) === null && SETTING_KEYS.has(String(row.setting_key))) continue;
        await writeOwnedRow(connection, userId, 'user_settings',
          ['user_id', 'setting_key', 'setting_value'],
          [row.user_id, row.setting_key, row.setting_value],
          ['setting_value']
        );
      }

      await reportRestoreProgress('contacts', 50);
      ({ releasedPhotos } = await restoreContactsSection(connection, userId, data, { conflictMode, warnings: validation.warnings, checkCancelled: checkRestoreCancelled,
        photoFiles, sourceVersion: scopedBackup.source_backup_version }));

      await reportRestoreProgress('calendar', 55);
      // Moves of tasks (calendar-move.ts): held until this commits, and those
      // the restore overtakes end below.
      const restoresCalendarContent = scopedBackup.import_sections.includes('calendar') && !accountOnly.has('calendar');
      const movesBefore = restoresCalendarContent ? await lockMovesForRestore(connection, userId) : null;
      const overwrittenEventIds = new Set<string>();
      for (const account of data.calendar_accounts || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(account, userId);
        const existingAccountId = await findExistingCalendarAccountForRestore(connection, row, userId);
        const targetAccountId = chooseTargetId(row.id, existingAccountId, conflictMode, { canKeepBoth: true });
        calendarAccountIdMap.set(row.id, targetAccountId);
        if (accountOnly.has('calendar')) {
          if (existingAccountId) {
            validation.warnings.push(`Calendar account ${accountLabel(row)} is already connected and was left unchanged.`);
            continue;
          }
          const accepted = await checkRestoredAccountPolicy(row, 'calendar', validation.warnings);
          // A mail calendar uses the login of its mail account (none of its own).
          const active = accepted && !restoredCalendarLacksLogin(row);
          if (accepted && !active) validation.warnings.push(`Calendar account ${accountLabel(row)} has no usable login in this backup. Sign in again in Calendar settings to start sync.`);
          await writeOwnedRow(connection, userId, 'calendar_accounts',
            ['id', 'user_id', 'provider', 'account_email', 'display_name', 'username', 'encrypted_password', 'discovery_url', 'base_url', 'encrypted_access_token', 'encrypted_refresh_token', 'token_expires_at', 'provider_config', 'capabilities', 'is_active', 'sync_status', 'sync_error', 'last_synced_at'],
            [
              targetAccountId, row.user_id, row.provider, row.account_email || null, row.display_name || null, row.username || null,
              row.encrypted_password || null, row.discovery_url || null, row.base_url || null,
              row.encrypted_access_token || null, row.encrypted_refresh_token || null, normalizeMysqlDateTime(row.token_expires_at),
              row.provider_config ? (typeof row.provider_config === 'string' ? row.provider_config : JSON.stringify(row.provider_config)) : null,
              row.capabilities ? (typeof row.capabilities === 'string' ? row.capabilities : JSON.stringify(row.capabilities)) : null,
              // Pending and never synced: the first sync is owed and the calendar
              // pass runs it even if this start is lost or Calendar is off now.
              active ? 1 : 0, active ? 'pending' : null, null, null,
            ],
            []
          );
          if (active) startCalendarAccountIds.push(targetAccountId);
          continue;
        }
        if (!shouldWriteExisting(existingAccountId, targetAccountId, conflictMode)) continue;
        await checkRestoredAccountPolicy(row, 'calendar', validation.warnings);
        const shouldRestoreCredentials = !existingAccountId || credentialsMode === 'restore' || targetAccountId !== existingAccountId;
        const encryptedPassword = shouldRestoreCredentials ? row.encrypted_password || null : null;
        const encryptedAccessToken = shouldRestoreCredentials ? row.encrypted_access_token || null : null;
        const encryptedRefreshToken = shouldRestoreCredentials ? row.encrypted_refresh_token || null : null;
        await writeOwnedRow(connection, userId, 'calendar_accounts',
          ['id', 'user_id', 'provider', 'account_email', 'display_name', 'username', 'encrypted_password', 'discovery_url', 'base_url', 'encrypted_access_token', 'encrypted_refresh_token', 'token_expires_at', 'provider_config', 'capabilities', 'is_active', 'sync_status', 'sync_error', 'last_synced_at'],
          [
            targetAccountId,
            row.user_id,
            row.provider || 'local',
            row.account_email || null,
            row.display_name || null,
            row.username || null,
            encryptedPassword,
            row.discovery_url || null,
            row.base_url || null,
            encryptedAccessToken,
            encryptedRefreshToken,
            normalizeMysqlDateTime(row.token_expires_at),
            row.provider_config ? (typeof row.provider_config === 'string' ? row.provider_config : JSON.stringify(row.provider_config)) : null,
            row.capabilities ? (typeof row.capabilities === 'string' ? row.capabilities : JSON.stringify(row.capabilities)) : null,
            row.is_active === false || row.is_active === 0 ? 0 : 1,
            row.sync_status || null,
            row.sync_error || null,
            normalizeMysqlDateTime(row.last_synced_at),
          ],
          ['account_email', 'display_name', 'username', 'encrypted_password', 'discovery_url', 'base_url', 'encrypted_access_token', 'encrypted_refresh_token', 'token_expires_at', 'provider_config', 'capabilities', 'is_active', 'sync_status', 'sync_error', 'last_synced_at'].filter(column => shouldRestoreCredentials || !['encrypted_password', 'encrypted_access_token', 'encrypted_refresh_token'].includes(column))
        );
      }

      for (const calendar of data.calendar_calendars || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(calendar, userId);
        const targetAccountId = await resolveOwnedReference(connection, userId, 'calendar_accounts', row.account_id, calendarAccountIdMap);
        if (row.external_id) {
          const [accounts] = await connection.execute<RowDataPacket[]>(
            'SELECT provider, discovery_url, base_url, provider_config FROM calendar_accounts WHERE id = ? AND user_id = ?', [targetAccountId, userId]
          );
          const account = accounts[0];
          if (account?.provider === 'caldav') {
            try {
              const scope = accountCredentialScope(account as Parameters<typeof accountCredentialScope>[0]);
              resolveCalDavUrl(row.external_id, account.base_url || account.discovery_url, scope);
            } catch (error) {
              await connection.execute('UPDATE calendar_accounts SET is_active = FALSE WHERE id = ? AND user_id = ?', [targetAccountId, userId]);
              validation.warnings.push(`Restored calendar account ${targetAccountId} is inactive: ${(error as Error).message}`);
            }
          }
        }
        const existingCalendarId = await findExistingCalendarForRestore(connection, row, userId, targetAccountId, calendarMode);
        const canKeepBothCalendar = !(row.external_id && existingCalendarId);
        const targetCalendarId = chooseTargetId(row.id, existingCalendarId, conflictMode, { canKeepBoth: canKeepBothCalendar });
        calendarIdMap.set(row.id, targetCalendarId);
        if (!shouldWriteExisting(existingCalendarId, targetCalendarId, conflictMode)) continue;
        writtenCalendarIds.add(targetCalendarId);
        const calendarName = targetCalendarId !== existingCalendarId && conflictMode === 'keep_both' && existingCalendarId
          ? `${row.name || 'Calendar'} (Restored)`
          : row.name || 'Calendar';
        await writeOwnedRow(connection, userId, 'calendar_calendars',
          ['id', 'user_id', 'account_id', 'name', 'external_id', 'color', 'is_visible', 'auto_todo_enabled', 'read_only', 'is_primary', 'sync_token'],
          [targetCalendarId, row.user_id, targetAccountId, calendarName, row.external_id || null, row.color || '#22c55e', row.is_visible === false || row.is_visible === 0 ? 0 : 1, row.auto_todo_enabled === false || row.auto_todo_enabled === 0 ? 0 : 1, row.read_only ? 1 : 0, row.is_primary ? 1 : 0, row.sync_token || null],
          ['name', 'external_id', 'color', 'is_visible', 'auto_todo_enabled', 'read_only', 'is_primary', 'sync_token']
        );
      }

      for (const setting of data.calendar_settings || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(setting, userId);
        const value = restorableValue('calendar', String(row.setting_key), row.setting_value);
        if (value === null) continue;
        const targetCalendarId = await resolveOwnedReference(connection, userId, 'calendar_calendars', row.calendar_id, calendarIdMap);
        if (conflictMode === 'keep_existing') {
          const [existing] = await connection.execute<RowDataPacket[]>('SELECT setting_key FROM calendar_settings WHERE calendar_id = ? AND setting_key = ? AND user_id = ?', [targetCalendarId, row.setting_key, userId]);
          if (existing.length) continue;
        }
        await writeOwnedRow(connection, userId, 'calendar_settings',
          ['calendar_id', 'user_id', 'setting_key', 'setting_value'],
          [targetCalendarId, row.user_id, row.setting_key, value],
          ['setting_value']
        );
      }

      for (const event of data.calendar_events || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(event, userId);
        const targetCalendarId = await resolveOwnedReference(connection, userId, 'calendar_calendars', row.calendar_id, calendarIdMap, { nullable: true });
        const existingEventId = await findExistingCalendarEventForRestore(connection, row, userId, targetCalendarId, claimedCalendarEventIds);
        const targetEventId = chooseTargetId(row.id, existingEventId, conflictMode);
        calendarEventIdMap.set(row.id, targetEventId);
        claimedCalendarEventIds.add(targetEventId);
        if (!shouldWriteExisting(existingEventId, targetEventId, conflictMode)) continue;
        if (existingEventId === targetEventId) overwrittenEventIds.add(targetEventId);
        // created_at and the order key too (0.27): a task without a date is
        // ordered by when it was made, and ties by the archived task's key.
        await writeOwnedRow(connection, userId, 'calendar_events',
          ['id', 'user_id', 'calendar_id', 'title', 'description', 'start_time', 'end_time', 'all_day', 'location', 'color', 'recurrence', 'reminder_minutes', 'reminders', 'todo_status', 'is_todo_only', 'done_at', 'source_email_id', 'source_email_json', 'created_at', 'order_key'],
          [targetEventId, row.user_id, targetCalendarId, row.title || 'Untitled Event', row.description ?? null, normalizeMysqlDateTime(row.start_time), normalizeMysqlDateTime(row.end_time), row.all_day ? 1 : 0, row.location || null, row.color || '#22c55e', row.recurrence || null, row.reminder_minutes ?? null, row.reminders ? (typeof row.reminders === 'string' ? row.reminders : JSON.stringify(row.reminders)) : null, row.todo_status || null, row.is_todo_only ? 1 : 0, normalizeMysqlDateTime(row.done_at), sourceEmailId(row.source_email_id), sourceEmailJson(row.source_email_json), normalizeMysqlDateTime(row.created_at, new Date()), restoredOrderKey(row, targetEventId)],
          ['calendar_id', 'title', 'description', 'start_time', 'end_time', 'all_day', 'location', 'color', 'recurrence', 'reminder_minutes', 'reminders', 'todo_status', 'is_todo_only', 'done_at', 'source_email_id', 'source_email_json', 'created_at', 'order_key']
        );
        writtenCalendarEvents.push({ row, targetId: targetEventId });
        if (sourceEmailId(row.source_email_id)) eventsWithSourceEmail.set(targetEventId, row.source_email_id);
      }

      await separateCopyKeys(connection, userId, writtenCalendarEvents);

      for (const subtask of data.calendar_event_subtasks || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(subtask, userId);
        const targetEventId = await resolveOwnedReference(connection, userId, 'calendar_events', row.event_id, calendarEventIdMap);
        let [existingSubtask] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM calendar_event_subtasks WHERE id = ? AND user_id = ? AND event_id = ? LIMIT 1',
          [row.id, userId, targetEventId]
        );
        if (!existingSubtask.length) {
          [existingSubtask] = await connection.execute<RowDataPacket[]>(
            'SELECT id FROM calendar_event_subtasks WHERE user_id = ? AND event_id = ? AND title = ? AND position = ? LIMIT 1',
            [userId, targetEventId, row.title || '', row.position || 0]
          );
        }
        if (existingSubtask.length && conflictMode === 'keep_existing') continue;
        const targetSubtaskId = chooseTargetId(row.id, existingSubtask[0]?.id, conflictMode);
        await writeOwnedRow(connection, userId, 'calendar_event_subtasks',
          ['id', 'event_id', 'user_id', 'title', 'is_done', 'position'],
          [targetSubtaskId, targetEventId, row.user_id, row.title || '', row.is_done ? 1 : 0, row.position || 0],
          ['title', 'is_done', 'position']
        );
      }

      for (const attendee of data.calendar_event_attendees || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(attendee, userId);
        const targetEventId = await resolveOwnedReference(connection, userId, 'calendar_events', row.event_id, calendarEventIdMap);
        const [existingAttendee] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM calendar_event_attendees WHERE event_id = ? AND email = ? AND user_id = ? LIMIT 1',
          [targetEventId, row.email, userId]
        );
        if (existingAttendee.length && conflictMode !== 'replace') continue;
        const targetAttendeeId = chooseTargetId(row.id, existingAttendee[0]?.id, conflictMode, { canKeepBoth: false });
        await writeOwnedRow(connection, userId, 'calendar_event_attendees',
          ['id', 'user_id', 'event_id', 'email', 'display_name', 'response_status', 'is_organizer', 'optional_attendee', 'comment'],
          [targetAttendeeId, row.user_id, targetEventId, row.email, row.display_name || null, row.response_status || 'needsAction', row.is_organizer ? 1 : 0, row.optional_attendee ? 1 : 0, row.comment || null],
          ['display_name', 'response_status', 'is_organizer', 'optional_attendee', 'comment']
        );
      }

      for (const ref of data.calendar_event_external_refs || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(ref, userId);
        const targetEventId = await resolveOwnedReference(connection, userId, 'calendar_events', row.event_id, calendarEventIdMap);
        const targetCalendarId = await resolveOwnedReference(connection, userId, 'calendar_calendars', row.calendar_id, calendarIdMap);
        const targetAccountId = await resolveOwnedReference(connection, userId, 'calendar_accounts', row.account_id, calendarAccountIdMap);
        await assertOwnedRelationship(connection, userId, 'calendar_events', targetEventId, 'calendar_id', targetCalendarId);
        await assertOwnedRelationship(connection, userId, 'calendar_calendars', targetCalendarId, 'account_id', targetAccountId);
        const [existingRef] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM calendar_event_external_refs WHERE account_id = ? AND external_event_id = ? AND user_id = ? LIMIT 1',
          [targetAccountId, row.external_event_id, userId]
        );
        if (existingRef.length && conflictMode !== 'replace') continue;
        const targetRefId = chooseTargetId(row.id, existingRef[0]?.id, conflictMode, { canKeepBoth: false });
        await writeOwnedRow(connection, userId, 'calendar_event_external_refs',
          ['id', 'user_id', 'event_id', 'calendar_id', 'account_id', 'provider', 'external_event_id', 'external_etag', 'external_updated_at', 'last_synced_at'],
          [targetRefId, row.user_id, targetEventId, targetCalendarId, targetAccountId, row.provider, row.external_event_id, row.external_etag || null, normalizeMysqlDateTime(row.external_updated_at), normalizeMysqlDateTime(row.last_synced_at)],
          ['event_id', 'calendar_id', 'provider', 'external_etag', 'external_updated_at', 'last_synced_at']
        );
      }

      if (movesBefore) await settleMovesForRestore(connection, userId, { overwrittenEventIds, before: movesBefore });

      // The hand order (0.27): a local task's row follows its restored event,
      // a synced one its calendar; the key is computed again from them. A
      // synced task's order matches its UID once the next sync links it.
      // The hand order. Keep existing and Keep both: a destination row wins
      // (a copy kept beside has its own key). Replace: the order becomes the
      // archive's, so a restored task or calendar that the archive has no
      // row for loses a destination row too (placed after the backup).
      const restoredOrderKeys = new Set<string>();
      for (const order of data.task_order || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(order, userId);
        const synced = typeof row.remote_uid === 'string' && row.remote_uid !== '';
        const target = synced
          ? { calendar_id: await resolveOwnedReference(connection, userId, 'calendar_calendars', row.calendar_id, calendarIdMap), event_id: null, remote_uid: row.remote_uid, recurrence_id: String(row.recurrence_id ?? '') }
          : { calendar_id: null, event_id: await resolveOwnedReference(connection, userId, 'calendar_events', row.event_id, calendarEventIdMap), remote_uid: null, recurrence_id: '' };
        const key = itemKey(target);
        if (conflictMode !== 'replace') {
          const [existingOrder] = await connection.execute<RowDataPacket[]>('SELECT item_key FROM task_order WHERE user_id = ? AND item_key = ?', [userId, key]);
          if (existingOrder.length) continue;
        }
        restoredOrderKeys.add(key);
        await writeOwnedRow(connection, userId, 'task_order',
          ['user_id', 'item_key', 'calendar_id', 'event_id', 'remote_uid', 'recurrence_id', 'sort_rank'],
          [userId, key, target.calendar_id, target.event_id, target.remote_uid, target.recurrence_id, Number(row.sort_rank)],
          ['calendar_id', 'event_id', 'remote_uid', 'recurrence_id', 'sort_rank']
        );
      }

      if (conflictMode === 'replace') {
        for (const { targetId } of writtenCalendarEvents) {
          const key = itemKey({ event_id: targetId });
          if (!restoredOrderKeys.has(key)) await connection.execute('DELETE FROM task_order WHERE user_id = ? AND item_key = ?', [userId, key]);
        }
        for (const calendarId of writtenCalendarIds) {
          const [rows] = await connection.execute<RowDataPacket[]>('SELECT item_key FROM task_order WHERE user_id = ? AND calendar_id = ?', [userId, calendarId]);
          for (const row of rows) {
            if (!restoredOrderKeys.has(String(row.item_key))) await connection.execute('DELETE FROM task_order WHERE user_id = ? AND item_key = ?', [userId, row.item_key]);
          }
        }
      }

      await writeRestoredReferences(connection, userId, archivedCalendarReferences, 'calendar_calendars', calendarIdMap);

      await reportRestoreProgress('mail', 70);
      for (const account of data.mail_accounts || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(account, userId);
        const [existingByEmail] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM mail_accounts WHERE user_id = ? AND email_address = ? LIMIT 1',
          [userId, row.email_address]
        );
        const [existingById] = existingByEmail.length
          ? [existingByEmail]
          : await connection.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [row.id, userId]);
        const targetAccountId = chooseTargetId(row.id, existingById[0]?.id, conflictMode, { canKeepBoth: false });
        mailAccountIdMap.set(row.id, targetAccountId);
        if (accountOnly.has('mail')) {
          if (existingById.length) {
            validation.warnings.push(`Mail account ${accountLabel(row)} is already connected and was left unchanged.`);
            continue;
          }
          const accepted = await checkRestoredAccountPolicy(row, 'mail', validation.warnings);
          const active = accepted && !!row.encrypted_password;
          if (accepted && !active) validation.warnings.push(`Mail account ${accountLabel(row)} has no usable password in this backup. Enter it in Mail settings to start sync.`);
          const syncMode = row.sync_mode === 'sync' ? 'sync' : 'download';
          const restoredWindow = (value: unknown, fallback: number | null) => value === undefined ? fallback
            : value === null ? null : MAIL_WINDOW_DAYS.includes(Number(value)) ? Number(value) : fallback;
          // Like a new sign-in: there is no local mail for this account yet, so
          // the Sync policy is confirmed (as on account creation) and the
          // provider's mail inside the saved windows downloads again.
          await connection.execute(
            `INSERT INTO mail_accounts
               (id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
                smtp_host, smtp_port, encrypted_password, sync_fetch_limit, sync_mode, sync_status, delete_emails_on_server,
                allow_self_signed, trusted_imap_fingerprint256, trusted_smtp_fingerprint256, is_active,
                sync_window_days, trash_window_days, sync_policy_confirmed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?, ?, ?, ?, ?, ${syncMode === 'sync' ? 'UTC_TIMESTAMP()' : 'NULL'})`,
            [targetAccountId, row.user_id, row.email_address, row.display_name || null, row.provider || 'custom', row.username || row.email_address,
              row.imap_host || null, row.imap_port || 993, row.smtp_host || null, row.smtp_port || 587, row.encrypted_password || null,
              normalizeSyncFetchLimit(row.sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT) || DEFAULT_MAIL_SYNC_FETCH_LIMIT,
              syncMode, syncMode === 'sync' ? 'pending' : 'idle', row.allow_self_signed ? 1 : 0,
              row.trusted_imap_fingerprint256 || null, row.trusted_smtp_fingerprint256 || null, active ? 1 : 0,
              restoredWindow(row.sync_window_days, null), restoredWindow(row.trash_window_days, DEFAULT_TRASH_WINDOW_DAYS)]
          );
          await restoreSignature(connection, userId, targetAccountId, row);
          if (active) {
            // The first download is queued in the restore transaction, so it is not
            // lost if the process stops right after the restore completes. It is
            // user initiated like a new account's, so it runs with background
            // sync off. With Mail disabled it waits, paused like the user's other
            // accounts, until Mail is turned on.
            const runtime = require('./mail-engine/runtime') as typeof import('./mail-engine/runtime');
            await runtime.enqueueJob({ userId, accountId: targetAccountId,
              kind: 'sync', priority: 5, manualRefresh: true }, connection);
            if (await isModuleEnabled(userId, 'mail', connection)) startMailAccountIds.push(targetAccountId);
            else await runtime.pauseAccount({ userId, accountId: targetAccountId, reason: 'Mail module disabled' }, connection);
          }
          continue;
        }
        if (existingById.length) {
          const [targets] = await connection.execute<RowDataPacket[]>('SELECT email_address, username, imap_host, imap_port FROM mail_accounts WHERE id = ? AND user_id = ?', [targetAccountId, userId]);
          if (targets.length && !sameProviderMailbox(targets[0] as Parameters<typeof sameProviderMailbox>[0], row)) {
            throw new Error('Cannot merge mail accounts with different provider mailbox identities. Restore into a separate user or resolve the conflicting account first.');
          }
        }
        const syncFetchLimit = normalizeSyncFetchLimit(row.sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT) || DEFAULT_MAIL_SYNC_FETCH_LIMIT;
        const policyAccepted = existingById.length && conflictMode === 'keep_existing'
          ? true : await checkRestoredAccountPolicy(row, 'mail', validation.warnings);

        if (existingById.length) {
          if (conflictMode === 'keep_existing') {
            await connection.execute(
              `UPDATE mail_accounts
               SET delete_emails_on_server = FALSE,
                   server_delete_enabled_at = NULL,
                   server_delete_grace_until = NULL,
                   server_delete_last_run_at = NULL
               WHERE id = ? AND user_id = ?`,
              [targetAccountId, userId]
            );
            continue;
          }
          const shouldRestoreCredentials = credentialsMode === 'restore';
          await connection.execute(
            `UPDATE mail_accounts
             SET email_address = ?, display_name = ?, provider = ?, username = ?, imap_host = ?, imap_port = ?,
                 smtp_host = ?, smtp_port = ?, encrypted_password = CASE WHEN ? THEN ? ELSE encrypted_password END,
                 sync_fetch_limit = ?, allow_self_signed = ?,
                 trusted_imap_fingerprint256 = ?, trusted_smtp_fingerprint256 = ?, is_active = COALESCE(?, is_active), last_synced_at = ?,
                 delete_emails_on_server = FALSE, server_delete_enabled_at = NULL,
                 server_delete_grace_until = NULL, server_delete_last_run_at = NULL
             WHERE id = ? AND user_id = ?`,
            [row.email_address, row.display_name || null, row.provider || 'custom', row.username || row.email_address, row.imap_host || null, row.imap_port || 993, row.smtp_host || null, row.smtp_port || 587, shouldRestoreCredentials ? 1 : 0, row.encrypted_password || null, syncFetchLimit, row.allow_self_signed ? 1 : 0, row.trusted_imap_fingerprint256 || null, row.trusted_smtp_fingerprint256 || null, !policyAccepted ? 0 : shouldRestoreCredentials ? (row.is_active === false || row.is_active === 0 ? 0 : 1) : null, normalizeMysqlDateTime(row.last_synced_at), targetAccountId, userId]
          );
        } else {
          await connection.execute(
            `INSERT INTO mail_accounts
               (id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
                smtp_host, smtp_port, encrypted_password, sync_fetch_limit, delete_emails_on_server,
                server_delete_enabled_at, server_delete_grace_until, server_delete_last_run_at,
                allow_self_signed, trusted_imap_fingerprint256, trusted_smtp_fingerprint256, is_active, last_synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
            [targetAccountId, row.user_id, row.email_address, row.display_name || null, row.provider || 'custom', row.username || row.email_address, row.imap_host || null, row.imap_port || 993, row.smtp_host || null, row.smtp_port || 587, row.encrypted_password || null, syncFetchLimit, row.allow_self_signed ? 1 : 0, row.trusted_imap_fingerprint256 || null, row.trusted_smtp_fingerprint256 || null, row.is_active === false || row.is_active === 0 ? 0 : 1, normalizeMysqlDateTime(row.last_synced_at)]
          );
        }
        // Windows are preserved (archives before 0.13.0: all mail, Trash 30 days).
        // The Sync removal policy is never restored as confirmed: restored local
        // copies must not be deleted until the user confirms again.
        const restoredWindow = (value: unknown, fallback: number | null) => value === undefined ? fallback
          : value === null ? null : MAIL_WINDOW_DAYS.includes(Number(value)) ? Number(value) : fallback;
        await connection.execute(
          `UPDATE mail_accounts SET sync_mode = ?, sync_status = ?, sync_window_days = ?, trash_window_days = ?,
             sync_policy_confirmed_at = NULL WHERE id = ? AND user_id = ?`,
          [row.sync_mode === 'sync' ? 'sync' : 'download', row.sync_mode === 'sync' ? 'pending' : 'idle',
            restoredWindow(row.sync_window_days, null), restoredWindow(row.trash_window_days, DEFAULT_TRASH_WINDOW_DAYS), targetAccountId, userId]
        );
        await restoreSignature(connection, userId, targetAccountId, row);
      }

      await writeRestoredReferences(connection, userId, archivedMailReferences, 'mail_accounts', mailAccountIdMap);

      for (const folder of data.mail_folders || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(folder, userId);
        const targetAccountId = await resolveOwnedReference(connection, userId, 'mail_accounts', row.mail_account_id, mailAccountIdMap, { nullable: true });
        const [existingFolder] = await connection.execute<RowDataPacket[]>(
          'SELECT id, mail_account_id FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1 FOR UPDATE',
          [row.user_id, row.slug]
        );
        // Slugs are unique per user. Reusing one across different account scopes
        // would hide imported messages or strand the destination's existing mail.
        if (existingFolder.length && (existingFolder[0].mail_account_id ?? null) !== targetAccountId) {
          throw new Error(`Mail folder "${row.display_name || row.slug}" (${row.slug}) belongs to a different account scope. Rename the conflicting folder before restoring this backup.`);
        }
        const targetFolderId = chooseTargetId(row.id, existingFolder[0]?.id, conflictMode, { canKeepBoth: false });
        mailFolderIdMap.set(row.id, targetFolderId);
        if (existingFolder.length && conflictMode !== 'replace') continue;
        await writeOwnedRow(connection, userId, 'mail_folders',
          ['id', 'user_id', 'slug', 'display_name', 'is_system', 'position', 'mail_account_id', 'special_use'],
          [targetFolderId, row.user_id, row.slug, row.display_name, row.is_system ? 1 : 0, row.position || 0, targetAccountId, row.special_use || null],
          ['display_name', 'is_system', 'position', 'mail_account_id', 'special_use']
        );
      }

      // After the folders: a folder named by id follows its restored folder.
      for (const setting of data.mail_account_settings || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(setting, userId);
        let value = restorableValue('mail_account', String(row.setting_key), row.setting_value);
        if (value === null) continue;
        const targetAccountId = await resolveOwnedReference(connection, userId, 'mail_accounts', row.mail_account_id, mailAccountIdMap);
        if (row.setting_key === 'notify_folders') value = await remapFolderRefs(connection, userId, value, mailFolderIdMap);
        if (conflictMode === 'keep_existing') {
          const [existing] = await connection.execute<RowDataPacket[]>('SELECT setting_key FROM mail_account_settings WHERE mail_account_id = ? AND setting_key = ? AND user_id = ?', [targetAccountId, row.setting_key, userId]);
          if (existing.length) continue;
        }
        await writeOwnedRow(connection, userId, 'mail_account_settings',
          ['mail_account_id', 'user_id', 'setting_key', 'setting_value'],
          [targetAccountId, row.user_id, row.setting_key, value],
          ['setting_value']
        );
      }

      for (const template of data.mail_templates || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(template, userId);
        // A template is known by its name (unique per user), so "keep both"
        // cannot apply; archive ids are never trusted.
        const name = String(row.name || 'Template').slice(0, 120);
        const [existing] = await connection.execute<RowDataPacket[]>('SELECT id FROM mail_templates WHERE user_id = ? AND name = ? ORDER BY created_at, id LIMIT 1', [userId, name]);
        const targetTemplateId = chooseTargetId(row.id, existing[0]?.id, conflictMode, { canKeepBoth: false });
        if (!shouldWriteExisting(existing[0]?.id, targetTemplateId, conflictMode)) continue;
        await writeOwnedRow(connection, userId, 'mail_templates',
          ['id', 'user_id', 'name', 'subject', 'body_html', 'body_text'],
          [targetTemplateId, row.user_id, name, row.subject ?? null, row.body_html ?? null, row.body_text ?? null],
          ['name', 'subject', 'body_html', 'body_text']
        );
      }

      for (const mapping of data.mail_folder_remote_boxes || []) {
        await checkRestoreCancelled();
        await restoreMailFolderRemoteBox(connection, userId, mapping, mailFolderIdMap, mailAccountIdMap, conflictMode, validation.warnings);
      }

      for (const rule of data.mail_sender_rules || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(rule, userId);
        const targetMailAccountId = await resolveOwnedReference(connection, userId, 'mail_accounts', row.mail_account_id, mailAccountIdMap, { nullable: true });
        const [existingRule] = await connection.execute<RowDataPacket[]>(
          `SELECT id FROM mail_sender_rules
           WHERE user_id = ?
             AND mail_account_id <=> ?
             AND match_type = ?
             AND match_value = ?
             AND target_folder = ?
           LIMIT 1`,
          [row.user_id, targetMailAccountId, row.match_type, row.match_value, row.target_folder || 'inbox']
        );
        const targetRuleId = chooseTargetId(row.id, existingRule[0]?.id, conflictMode);
        mailRuleIdMap.set(row.id, targetRuleId);
        if (existingRule.length && conflictMode === 'keep_existing') continue;
        await writeOwnedRow(connection, userId, 'mail_sender_rules',
          ['id', 'user_id', 'mail_account_id', 'match_type', 'match_value', 'target_folder', 'priority', 'is_active'],
          [targetRuleId, row.user_id, targetMailAccountId, row.match_type, row.match_value, row.target_folder || 'inbox', row.priority ?? 100, row.is_active === false || row.is_active === 0 ? 0 : 1],
          ['mail_account_id', 'match_type', 'match_value', 'target_folder', 'priority', 'is_active']
        );
      }

      for (const email of data.emails || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(email, userId);
        const targetMailAccountId = await resolveOwnedReference(connection, userId, 'mail_accounts', row.mail_account_id, mailAccountIdMap);
        const targetFilingAccountId = await resolveOwnedReference(connection, userId, 'mail_accounts', row.filing_account_id, mailAccountIdMap, { nullable: true });
        const existingEmailId = await findExistingEmailForRestore(connection, row, userId, targetMailAccountId, claimedEmailIds);
        const targetEmailId = chooseTargetId(row.id, existingEmailId, conflictMode);
        emailIdMap.set(row.id, targetEmailId);
        // Each source row represents one local copy, even if Message-ID repeats.
        claimedEmailIds.add(targetEmailId);
        const rawPath = restoredPaths.get(`raw_email:${row.id}`) || null;
        if (!shouldWriteExisting(existingEmailId, targetEmailId, conflictMode)) continue;
        if (!rawPath && row.raw_storage_path && existingEmailId === targetEmailId) {
          validation.warnings.push(`Kept the existing raw message for email ${row.id}; this backup has no restorable raw file.`);
        }
        writtenEmailIds.add(row.id);
        writtenEmailHtml.set(row.id, { targetEmailId, html: row.body_html || null });
        await writeOwnedRow(connection, userId, 'emails',
          ['id', 'user_id', 'mail_account_id', 'message_id', 'subject', 'from_address', 'from_name', 'to_addresses', 'cc_addresses', 'bcc_addresses', 'body_text', 'body_html', 'folder', 'source_folder', 'imap_uid', 'imap_uidvalidity', 'raw_storage_path', 'raw_sha256', 'is_read', 'is_starred', 'is_draft', 'has_attachments', 'received_at', 'import_complete', 'filing_account_id', 'is_legacy', 'remote_folder', 'remote_uid', 'remote_uidvalidity', 'remote_missing'],
          [targetEmailId, row.user_id, targetMailAccountId, row.message_id || null, row.subject || null, row.from_address || 'unknown', row.from_name || null, typeof row.to_addresses === 'string' ? row.to_addresses : JSON.stringify(row.to_addresses || []), row.cc_addresses ? (typeof row.cc_addresses === 'string' ? row.cc_addresses : JSON.stringify(row.cc_addresses)) : null, row.bcc_addresses ? (typeof row.bcc_addresses === 'string' ? row.bcc_addresses : JSON.stringify(row.bcc_addresses)) : null, row.body_text || null, row.body_html || null, row.folder || 'inbox', row.source_folder || null, row.imap_uid || null, row.imap_uidvalidity || null, rawPath, rawPath ? row.raw_sha256 || null : null, row.is_read ? 1 : 0, row.is_starred ? 1 : 0, row.is_draft ? 1 : 0, row.has_attachments ? 1 : 0, normalizeMysqlDateTime(row.received_at, new Date()), rawPath && (row.import_complete === true || row.import_complete === 1) ? 1 : 0, targetFilingAccountId, row.is_legacy ? 1 : 0, row.remote_folder ?? null, row.remote_uid ?? null, row.remote_uidvalidity ?? null, row.remote_missing ? 1 : 0],
          ['subject', 'from_address', 'from_name', 'to_addresses', 'cc_addresses', 'bcc_addresses', 'body_text', 'body_html', 'folder', 'source_folder', 'imap_uid', 'imap_uidvalidity', 'raw_storage_path', 'raw_sha256', 'is_read', 'is_starred', 'is_draft', 'has_attachments', 'received_at', 'import_complete', 'filing_account_id', 'is_legacy', 'remote_folder', 'remote_uid', 'remote_uidvalidity', 'remote_missing']
            .filter(column => rawPath || !['raw_storage_path', 'raw_sha256', 'import_complete'].includes(column))
        );
        await restoreEmailHeaders(connection, userId, targetEmailId, row);
        // A draft the restore wrote comes back unscheduled. A send of it that a
        // stopped process left 'sending' is never resumed with this content.
        await connection.execute("DELETE FROM mail_scheduled_sends WHERE email_id = ? AND user_id = ? AND status <> 'sending'", [targetEmailId, userId]);
        await connection.execute(`UPDATE mail_scheduled_sends SET status = 'unknown',
          last_error = 'A restore replaced this draft while it was being sent. Check Sent before sending it again.'
          WHERE email_id = ? AND user_id = ? AND status = 'sending'`, [targetEmailId, userId]);
      }

      for (const attachment of data.email_attachments || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(attachment, userId);
        const targetEmailId = await resolveOwnedReference(connection, userId, 'emails', row.email_id, emailIdMap);
        const existingAttachmentId = await findExistingAttachmentForRestore(connection, row, userId, targetEmailId, claimedAttachmentIds);
        const storagePath = restoredPaths.get(`email_attachment:${row.id}`) || null;
        const targetAttachmentId = !storagePath && existingAttachmentId
          ? existingAttachmentId : chooseTargetId(row.id, existingAttachmentId, conflictMode);
        claimedAttachmentIds.add(targetAttachmentId);
        if (!attachmentIdsByEmail.has(row.email_id)) attachmentIdsByEmail.set(row.email_id, new Map());
        attachmentIdsByEmail.get(row.email_id)!.set(row.id, targetAttachmentId);
        if (!storagePath && existingAttachmentId) {
          validation.warnings.push(`Kept existing attachment ${row.id}; this backup has no restorable attachment file.`);
          continue;
        }
        if (!storagePath) validation.warnings.push(`Attachment ${row.id} was restored as metadata only because its file is absent from this backup.`);
        if (!shouldWriteExisting(existingAttachmentId, targetAttachmentId, conflictMode)) continue;
        await writeOwnedRow(connection, userId, 'email_attachments',
          ['id', 'email_id', 'user_id', 'filename', 'content_type', 'size_bytes', 'storage_path', 'content_id'],
          [targetAttachmentId, targetEmailId, row.user_id, row.filename || 'attachment', row.content_type || 'application/octet-stream', row.size_bytes || 0, storagePath, row.content_id || null],
          ['filename', 'content_type', 'size_bytes', 'storage_path', 'content_id']
        );
      }

      for (const [sourceEmailId, email] of writtenEmailHtml) {
        const html = remapRestoredInlineAttachments(email.html, attachmentIdsByEmail.get(sourceEmailId));
        if (html !== email.html) {
          await connection.execute('UPDATE emails SET body_html = ? WHERE id = ? AND user_id = ?', [html, email.targetEmailId, userId]);
        }
      }

      for (const score of data.mail_email_scores || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(score, userId);
        const targetEmailId = await resolveOwnedReference(connection, userId, 'emails', row.email_id, emailIdMap);
        const [existingScore] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM mail_email_scores WHERE email_id = ? AND score_version = ? AND user_id = ? LIMIT 1',
          [targetEmailId, row.score_version || 'v1', userId]
        );
        if (existingScore.length && conflictMode !== 'replace') continue;
        const targetScoreId = chooseTargetId(row.id, existingScore[0]?.id, conflictMode, { canKeepBoth: false });
        await writeOwnedRow(connection, userId, 'mail_email_scores',
          ['id', 'email_id', 'user_id', 'score_version', 'total_score', 'risk_level', 'spf_result', 'dkim_result', 'dmarc_result', 'language_risk_score', 'sender_reputation_score', 'source_risk_score', 'classifier_confidence', 'reasons', 'metadata', 'scored_at'],
          [
            targetScoreId,
            targetEmailId,
            row.user_id,
            row.score_version || 'v1',
            Number(row.total_score) || 0,
            row.risk_level || null,
            row.spf_result || null,
            row.dkim_result || null,
            row.dmarc_result || null,
            row.language_risk_score ?? null,
            row.sender_reputation_score ?? null,
            row.source_risk_score ?? null,
            row.classifier_confidence ?? null,
            row.reasons ? (typeof row.reasons === 'string' ? row.reasons : JSON.stringify(row.reasons)) : null,
            row.metadata ? (typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata)) : null,
            normalizeMysqlDateTime(row.scored_at, new Date()),
          ],
          ['total_score', 'risk_level', 'spf_result', 'dkim_result', 'dmarc_result', 'language_risk_score', 'sender_reputation_score', 'source_risk_score', 'classifier_confidence', 'reasons', 'metadata', 'scored_at']
        );
      }

      await restoreMailRecovery(connection, userId, data as Parameters<typeof restoreMailRecovery>[2], {
        accountIds: mailAccountIdMap, folderIds: mailFolderIdMap, emailIds: emailIdMap,
        ruleIds: mailRuleIdMap, writtenEmailIds, conflictMode, checkCancelled: checkRestoreCancelled,
        normalizeDate: normalizeMysqlDateTime, warnings: validation.warnings,
      });
      if (scopedBackup.import_sections.includes('mail') && !accountOnly.has('mail')) await restoreMailEngineEvidence(connection, userId, data as Parameters<typeof restoreMailEngineEvidence>[2], {
        accountIds: mailAccountIdMap, emailIds: emailIdMap, writtenEmailIds, restoredPaths,
        checkCancelled: checkRestoreCancelled, warnings: validation.warnings,
      });
      if (scopedBackup.source_backup_version! >= 3) {
        await validateRestoredMailDestinations(connection, userId, [...writtenEmailIds].map(id => emailIdMap.get(id)!), checkRestoreCancelled);
      }
      // The archive's email id stays when mail was not restored (the task keeps
      // its own snapshot); a restored email that got a new id is followed.
      for (const [eventId, archivedEmailId] of eventsWithSourceEmail) {
        const targetEmailId = emailIdMap.get(archivedEmailId);
        if (targetEmailId && targetEmailId !== archivedEmailId) {
          await connection.execute('UPDATE calendar_events SET source_email_id = ? WHERE id = ? AND user_id = ? AND source_email_id = ?', [targetEmailId, eventId, userId, archivedEmailId]);
        }
      }

      await reportRestoreProgress('recordings', 90);
      for (const recording of data.recordings || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(recording, userId);
        const storagePath = restoredPaths.get(`recording:${row.id}`);
        const existingRecordingId = await findExistingRecordingForRestore(connection, row, userId, storagePath, claimedRecordingIds);
        if (!storagePath) {
          if (existingRecordingId) {
            recordingIdMap.set(row.id, existingRecordingId);
            claimedRecordingIds.add(existingRecordingId);
            validation.warnings.push(`Kept existing recording ${row.id}; this backup has no restorable audio file.`);
          } else {
            skippedRecordingIds.add(row.id);
            validation.warnings.push(`Skipped recording ${row.id} and its tag links because its audio file is absent from this backup.`);
          }
          continue;
        }
        const audio = await inspectRecordingAudio(storagePath);
        const targetRecordingId = chooseTargetId(row.id, existingRecordingId, conflictMode);
        recordingIdMap.set(row.id, targetRecordingId);
        claimedRecordingIds.add(targetRecordingId);
        if (!shouldWriteExisting(existingRecordingId, targetRecordingId, conflictMode)) continue;
        await writeOwnedRow(connection, userId, 'recordings',
          ['id', 'user_id', 'title', 'description', 'original_filename', 'content_type', 'size_bytes', 'duration_seconds', 'storage_path', 'source', 'category', 'recorded_at', 'metadata', 'created_at'],
          [
            targetRecordingId,
            row.user_id,
            row.title || row.original_filename || 'Recording',
            row.description || null,
            row.original_filename || null,
            audio.contentType,
            Number(row.size_bytes) || 0,
            row.duration_seconds ?? null,
            storagePath,
            row.source || 'imported',
            row.category || 'none',
            normalizeMysqlDateTime(row.recorded_at, row.created_at || new Date()),
            row.metadata ? (typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata)) : null,
            normalizeMysqlDateTime(row.created_at, new Date()),
          ],
          ['title', 'description', 'original_filename', 'content_type', 'size_bytes', 'duration_seconds', 'storage_path', 'source', 'category', 'recorded_at', 'metadata']
        );
      }

      for (const transcript of data.recording_transcription_jobs || []) {
        await checkRestoreCancelled();
        if (skippedRecordingIds.has(transcript.recording_id)) continue;
        const recordingId = await resolveOwnedReference(connection, userId, 'recordings', transcript.recording_id, recordingIdMap);
        const [existing] = await connection.execute<RowDataPacket[]>(
          "SELECT id FROM recording_transcription_jobs WHERE user_id = ? AND recording_id = ? AND status = 'completed' AND transcript_text <=> ? LIMIT 1",
          [userId, recordingId, transcript.transcript_text]);
        if (existing.length && conflictMode !== 'replace') continue;
        const id = chooseTargetId(transcript.id, existing[0]?.id, conflictMode, { canKeepBoth: false });
        await writeOwnedRow(connection, userId, 'recording_transcription_jobs',
          ['id', 'user_id', 'recording_id', 'status', 'provider', 'model', 'language', 'transcript_text', 'error', 'created_at', 'updated_at'],
          [id, userId, recordingId, 'completed', transcript.provider || null, transcript.model || null, transcript.language || null,
            transcript.transcript_text ?? null, null, normalizeMysqlDateTime(transcript.created_at, new Date()), normalizeMysqlDateTime(transcript.updated_at, new Date())],
          ['provider', 'model', 'language', 'transcript_text', 'error']);
      }

      for (const tag of data.recording_tags || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(tag, userId);
        if (!row.name) continue;
        const [existingByName] = await connection.execute<RowDataPacket[]>(
          'SELECT id FROM recording_tags WHERE user_id = ? AND name = ? LIMIT 1',
          [userId, row.name]
        );
        const targetTagId = chooseTargetId(row.id, existingByName[0]?.id, conflictMode, { canKeepBoth: false });
        recordingTagIdMap.set(row.id, targetTagId);
        if (existingByName.length && conflictMode === 'keep_existing') continue;
        await writeOwnedRow(connection, userId, 'recording_tags',
          ['id', 'user_id', 'name', 'color'],
          [targetTagId, row.user_id, row.name, row.color || null],
          ['color']
        );
      }

      for (const link of data.recording_tag_links || []) {
        await checkRestoreCancelled();
        const row = overwriteUserId(link, userId);
        if (skippedRecordingIds.has(row.recording_id)) continue;
        const targetRecordingId = await resolveOwnedReference(connection, userId, 'recordings', row.recording_id, recordingIdMap);
        const targetTagId = await resolveOwnedReference(connection, userId, 'recording_tags', row.tag_id, recordingTagIdMap);
        await writeOwnedRow(connection, userId, 'recording_tag_links',
          ['recording_id', 'tag_id', 'user_id'],
          [targetRecordingId, targetTagId, row.user_id],
          ['user_id']
        );
      }

      const result = {
        dry_run: false,
        valid: true,
        warnings: validation.warnings,
        counts,
        import_sections: scopedBackup.import_sections,
        account_only_sections: accountOnlySections,
        restored_files: restoredPaths.size + photoFiles.size,
        conflicts,
        options: {
          conflict_mode: conflictMode,
          calendar_mode: calendarMode,
          credentials_mode: credentialsMode,
        },
      };
      if (onProgress) await onProgress('commit', 99);
      if (scopedBackup.import_sections.includes('calendar')) {
        // A long restore can commit event timestamps older than the reminder scan
        // cursor. Visibility-only restores also leave event timestamps unchanged.
        await connection.execute('UPDATE notification_config SET reminder_revision = reminder_revision + 1 WHERE id = 1');
      }
      if (beforeCommit) await beforeCommit(connection, result);
      commitAttempted = true;
      await connection.commit();
      // Photo files the restored contacts replaced, and written ones no row took.
      await releasePhotoFiles(userId, [...releasedPhotos, ...createdPhotos])
        .catch(error => log.warn('backup', 'Contact photo files a restore no longer uses stay until the sweep', {}, error));
      if (startMailAccountIds.length || startCalendarAccountIds.length) {
        startAccountSync(userId, { mailAccountIds: startMailAccountIds, calendarAccountIds: startCalendarAccountIds });
      }
      return result;
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      if (commitAttempted) {
        // A lost COMMIT response does not prove rollback. Keep files that may now
        // be referenced by committed rows; the restore job reconciles its result.
        (error as ApiError & { backupCommitUncertain?: boolean }).backupCommitUncertain = true;
      } else {
        await cleanupCreatedFiles();
      }
      throw error;
    } finally {
      connection?.release();
    }
  };
  return scopedBackup.import_sections.includes('contacts') ? withContactPhotoLock(userId, apply) : apply();
}

async function importBackupZipBufferForUser(userId: string, buffer: Buffer, options: ImportOptions = {}) {
  const { backup, manifest, fileBuffersByPath } = backupFromZipBuffer(buffer);
  const sections = options.sections || manifest.sections || 'full';
  return importBackupForUser(userId, backup, {
    ...options,
    sections,
    fileBuffersByPath,
  });
}

async function importBackupZipFileForUser(userId: string, filePath: string, options: ImportOptions = {}) {
  const { backup, manifest, fileSourcesByPath } = await backupFromZipFile(filePath);
  const sections = options.sections || manifest.sections || 'full';
  return importBackupForUser(userId, backup, {
    ...options,
    sections,
    fileSourcesByPath,
  });
}

export {
  importBackupForUser,
  importBackupZipBufferForUser,
  importBackupZipFileForUser,
};
