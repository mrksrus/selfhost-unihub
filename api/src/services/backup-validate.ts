import type { RowDataPacket } from 'mysql2/promise';
import type { ArchiveEnvelope, BackupPayload, BackupFileSource } from '../types';
import fs from 'fs';
import { db } from '../state';
import { modulesFromValue } from './module-settings';
import { validateRestoreRows } from './backup-ownership';
import { AUDIO_HEADER_BYTES, identifyRecordingAudio } from './recording-audio';
import { validateBackupVersionFields } from './backup-format';
import {
  ACCOUNT_ONLY_TABLES,
  RETIRED_FILE_KINDS,
  RETIRED_TABLES,
  SECTION_POLICIES,
  TABLE_POLICIES,
  normalizeBackupSections,
} from './backup-catalog';
import {
  BACKUP_IMPORT_SECTION_TABLES,
  BACKUP_IMPORT_SECTION_FILE_KINDS,
  sha256Buffer,
  sha256FileSource,
  canonicalJson,
  normalizeIdentifier,
} from './backup-common';

// An account-settings section carries only its account table, and calendar
// account settings only remote connections; anything else is not a fresh
// sign-in and must be restored as a complete section instead.
function validateAccountOnlySections(backup: ArchiveEnvelope) {
  if (!Object.hasOwn(backup, 'account_only_sections')) return [];
  const sections = backup.account_only_sections;
  if (!Array.isArray(sections) || !sections.length || new Set(sections).size !== sections.length
      || sections.some(section => typeof section !== 'string' || !Object.hasOwn(ACCOUNT_ONLY_TABLES, section))) {
    return ['Backup account settings list is invalid'];
  }
  const errors: string[] = [];
  for (const section of sections as string[]) {
    for (const table of SECTION_POLICIES[section].tables) {
      const rows = backup.data?.[table];
      if (table !== ACCOUNT_ONLY_TABLES[section] && Array.isArray(rows) && rows.length) errors.push(`Account settings backup must not contain ${table} rows`);
    }
    if ((Array.isArray(backup.files) ? backup.files : []).some(file => SECTION_POLICIES[section].fileKinds.includes(file?.kind as string))) {
      errors.push(`Account settings backup must not contain ${section} files`);
    }
  }
  if (sections.includes('calendar') && (Array.isArray(backup.data?.calendar_accounts) ? backup.data.calendar_accounts : [])
    .some(row => !['caldav', 'ics'].includes(row?.provider as string))) {
    errors.push('Account settings backup may contain only CalDAV and subscription calendar accounts');
  }
  return errors;
}

function validateBackupPayload(backup: ArchiveEnvelope | null | undefined, {
  fileBuffersByPath = null,
  skipFileHashValidation = false,
}: { fileBuffersByPath?: ReadonlyMap<string, BackupFileSource> | null; skipFileHashValidation?: boolean } = {}) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!backup || typeof backup !== 'object') {
    return { valid: false, errors: ['Backup must be a JSON object'], warnings };
  }
  if (backup.app !== 'unihub') errors.push('Backup app must be "unihub"');
  const versionValidation = validateBackupVersionFields(backup);
  errors.push(...versionValidation.errors);
  warnings.push(...versionValidation.warnings);
  if (!backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) errors.push('Backup data section is missing');
  if (!Array.isArray(backup.files)) errors.push('Backup files section must be an array');
  for (const [table, rows] of Object.entries(backup.data || {})) {
    const policy = TABLE_POLICIES[table];
    if (!policy && Object.hasOwn(RETIRED_TABLES, table)) {
      if (Array.isArray(rows) && rows.length && !warnings.includes((RETIRED_TABLES as Readonly<Record<string, string>>)[table])) warnings.push((RETIRED_TABLES as Readonly<Record<string, string>>)[table]);
      continue;
    }
    if (!policy) { errors.push(`Unsupported backup table: ${table}`); continue; }
    if (backup.version >= 3) {
      for (const row of table === 'user' ? [rows] : Array.isArray(rows) ? rows : []) {
        for (const column of Object.keys(row || {})) {
          if (!policy.columns.includes(column)) errors.push(`Unsupported backup field: ${table}.${column}`);
        }
      }
    }
  }
  for (const file of Array.isArray(backup.files) ? backup.files : []) {
    if (RETIRED_FILE_KINDS.includes((file?.kind as string))) continue;
    if (!Object.values(SECTION_POLICIES).some(policy => policy.fileKinds.includes((file?.kind as string)))) errors.push(`Unsupported backup file kind: ${file?.kind}`);
  }
  errors.push(...validateRestoreRows(backup.data));
  errors.push(...validateAccountOnlySections(backup));
  for (const row of Array.isArray(backup.data?.user_settings) ? backup.data.user_settings : []) {
    if (row?.setting_key === 'module_preferences') {
      try { modulesFromValue(row.setting_value); } catch { errors.push('Backup has invalid module preferences.'); }
    }
  }

  if (Array.isArray(backup.files)) {
    for (const file of backup.files) {
      if (RETIRED_FILE_KINDS.includes((file?.kind as string))) continue;
      if (file?.missing) {
        warnings.push(`File ${file.kind}:${file.id} was missing when backup was created`);
        continue;
      }
      const fileBuffer = file?.archive_path && fileBuffersByPath
        ? fileBuffersByPath.get(file.archive_path)
        : null;
      if ((!file?.data_base64 && !fileBuffer) || !file.sha256) {
        errors.push(`File ${file?.kind || 'unknown'}:${file?.id || 'unknown'} is incomplete`);
        continue;
      }
      if (skipFileHashValidation) continue;
      if (fileBuffer && !Buffer.isBuffer(fileBuffer)) {
        errors.push(`File ${file?.kind || 'unknown'}:${file?.id || 'unknown'} has an invalid source`);
        continue;
      }
      const buffer = fileBuffer || Buffer.from(String(file.data_base64), 'base64');
      if (file.kind === 'recording' && !identifyRecordingAudio(buffer.subarray(0, AUDIO_HEADER_BYTES))) {
        errors.push(`Recording ${file.id} is not supported audio`);
      }
      const actualHash = sha256Buffer(buffer);
      if (actualHash !== file.sha256) {
        errors.push(`Checksum mismatch for file ${file.kind}:${file.id}`);
      }
    }
  }

  if (backup.version >= 3 && backup.data && Array.isArray(backup.files)) {
    const files = new Map();
    for (const file of backup.files) {
      const key = `${file?.kind}:${file?.id}`;
      if (files.has(key)) errors.push(`Duplicate backup file: ${key}`);
      files.set(key, file);
      if (file?.missing) errors.push(`Schema 3 backup is missing file: ${key}`);
    }
    const rows = (table: string): Record<string, unknown>[] => Array.isArray(backup.data[table]) ? backup.data[table] as Record<string, unknown>[] : [];
    const required = [
      ...rows('email_attachments').map(row => `email_attachment:${row.id}`),
      ...rows('recordings').map(row => `recording:${row.id}`),
      ...rows('emails').filter(row => row.raw_storage_path || row.import_complete === true || row.import_complete === 1).map(row => `raw_email:${row.id}`),
    ];
    for (const key of required) if (!files.has(key)) errors.push(`Schema 3 backup has no referenced file: ${key}`);
  }

  if (backup.manifest_sha256 && backup.data && Array.isArray(backup.files)) {
    const actualManifestHash = sha256Buffer(Buffer.from(canonicalJson({ data: backup.data, files: backup.files })!, 'utf8'));
    if (actualManifestHash !== backup.manifest_sha256) {
      errors.push('Manifest checksum mismatch');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

async function validateBackupPayloadFromFileSources(backup: ArchiveEnvelope, fileSourcesByPath: ReadonlyMap<string, BackupFileSource> | null | undefined) {
  const validation = validateBackupPayload(backup, {
    fileBuffersByPath: fileSourcesByPath,
    skipFileHashValidation: true,
  });
  if (!Array.isArray(backup?.files)) return validation;

  for (const file of backup.files) {
    if (file?.missing) continue;
    const source = file?.archive_path ? fileSourcesByPath?.get(file.archive_path) : null;
    if (!source || !file.sha256) continue;
    const actualHash = await sha256FileSource(source);
    if (actualHash !== file.sha256) {
      validation.errors.push(`Checksum mismatch for file ${file.kind}:${file.id}`);
    }
    if (file.kind === 'recording') {
      let header;
      if (Buffer.isBuffer(source)) header = source.subarray(0, AUDIO_HEADER_BYTES);
      else {
        const handle = await fs.promises.open(source.filePath, 'r');
        try {
          header = Buffer.alloc(Math.min(source.size, AUDIO_HEADER_BYTES));
          const { bytesRead } = await handle.read(header, 0, header.length, source.start);
          header = header.subarray(0, bytesRead);
        } finally { await handle.close(); }
      }
      if (!identifyRecordingAudio(header)) validation.errors.push(`Recording ${file.id} is not supported audio`);
    }
  }
  validation.valid = validation.errors.length === 0;
  return validation;
}

function countBackupRows(backup: ArchiveEnvelope | null | undefined) {
  const data = backup?.data || {};
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, (value as unknown[]).length])
  );
}

async function countRestoreConflicts(userId: string, backup: ArchiveEnvelope) {
  const data = backup?.data || {};
  const conflicts: Record<string, number> = {};

  const contacts = data.contacts || [];
  let contactConflicts = 0;
  for (const contact of contacts) {
    const emails = [contact.email, contact.email2, contact.email3].map(normalizeIdentifier).filter(Boolean);
    if (contact.id) {
      const [rows] = await db.execute<RowDataPacket[]>('SELECT id FROM contacts WHERE id = ? AND user_id = ? LIMIT 1', [contact.id!, userId]);
      if (rows.length) { contactConflicts++; continue; }
    }
    for (const email of emails) {
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT id FROM contacts WHERE user_id = ? AND (LOWER(email) = ? OR LOWER(email2) = ? OR LOWER(email3) = ?) LIMIT 1`,
        [userId, email, email, email]
      );
      if (rows.length) { contactConflicts++; break; }
    }
  }
  if (contactConflicts) conflicts.contacts = contactConflicts;

  const mailAccounts = data.mail_accounts || [];
  let mailAccountConflicts = 0;
  for (const account of mailAccounts) {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT id FROM mail_accounts WHERE user_id = ? AND (id = ? OR email_address = ?) LIMIT 1',
      [userId, account.id!, account.email_address!]
    );
    if (rows.length) mailAccountConflicts++;
  }
  if (mailAccountConflicts) conflicts.mail_accounts = mailAccountConflicts;

  const emails = data.emails || [];
  let emailConflicts = 0;
  for (const email of emails.slice(0, 500)) {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT id FROM emails WHERE id = ? AND user_id = ? LIMIT 1',
      [email.id!, userId]
    );
    if (rows.length) emailConflicts++;
  }
  if (emailConflicts) conflicts.emails = emailConflicts;

  const calendars = data.calendar_calendars || [];
  let calendarConflicts = 0;
  for (const calendar of calendars) {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT id FROM calendar_calendars WHERE id = ? AND user_id = ? LIMIT 1',
      [calendar.id!, userId]
    );
    if (rows.length) calendarConflicts++;
  }
  if (calendarConflicts) conflicts.calendars = calendarConflicts;

  const recordings = data.recordings || [];
  let recordingConflicts = 0;
  for (const recording of recordings) {
    const [rows] = await db.execute<RowDataPacket[]>(
      'SELECT id FROM recordings WHERE id = ? AND user_id = ? LIMIT 1',
      [recording.id!, userId]
    );
    if (rows.length) recordingConflicts++;
  }
  if (recordingConflicts) conflicts.recordings = recordingConflicts;

  return conflicts;
}

const normalizeBackupImportSections = normalizeBackupSections;

function scopeBackupForImport(backup: ArchiveEnvelope, sections: unknown) {
  const normalizedSections = normalizeBackupImportSections(sections);
  const allowedTables = new Set<string>();
  const allowedFileKinds = new Set<string>();

  for (const section of normalizedSections) {
    for (const table of BACKUP_IMPORT_SECTION_TABLES[section] || []) allowedTables.add(table);
    for (const kind of BACKUP_IMPORT_SECTION_FILE_KINDS[section] || []) allowedFileKinds.add(kind);
  }

  const sourceData = backup?.data || {};
  const data: BackupPayload['data'] = {};
  for (const [key, value] of Object.entries(sourceData)) {
    if (allowedTables.has(key)) data[key] = value;
  }

  const files = (backup?.files || []).filter(file => allowedFileKinds.has((file?.kind as string)));
  return {
    ...backup,
    data,
    files,
    import_sections: normalizedSections,
  };
}

export {
  validateBackupPayload,
  validateBackupPayloadFromFileSources,
  countBackupRows,
  countRestoreConflicts,
  normalizeBackupImportSections,
  scopeBackupForImport,
};
