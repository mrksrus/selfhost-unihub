const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../state');
const { MAIL_RAW_STORAGE_ROOT, DEFAULT_MAIL_SYNC_FETCH_LIMIT, normalizeSyncFetchLimit } = require('./mail');
const { RECORDINGS_ROOT } = require('./recordings');

const BACKUP_VERSION = 1;
const ATTACHMENTS_ROOT = '/app/uploads/attachments';
const ZIP_BACKUP_FORMAT = 'unihub-restorable-backup';
const ZIP_BACKUP_FORMAT_VERSION = 1;
const BACKUP_IMPORT_SECTIONS = new Set(['settings', 'contacts', 'calendar', 'mail', 'recordings']);
const BACKUP_CONFLICT_MODES = new Set(['keep_existing', 'replace', 'keep_both']);
const BACKUP_CALENDAR_MODES = new Set(['merge_same_name', 'copy']);
const BACKUP_CREDENTIAL_MODES = new Set(['keep_existing', 'restore']);
const BACKUP_IMPORT_SECTION_TABLES = {
  settings: new Set(['user', 'user_settings']),
  contacts: new Set(['contacts']),
  calendar: new Set([
    'calendar_accounts',
    'calendar_calendars',
    'calendar_events',
    'calendar_event_subtasks',
    'calendar_event_attendees',
    'calendar_event_external_refs',
  ]),
  mail: new Set([
    'mail_folders',
    'mail_sender_rules',
    'mail_accounts',
    'emails',
    'email_attachments',
    'mail_email_scores',
  ]),
  recordings: new Set(['recordings', 'recording_tags', 'recording_tag_links']),
};
const BACKUP_IMPORT_SECTION_FILE_KINDS = {
  mail: new Set(['email_attachment', 'raw_email']),
  recordings: new Set(['recording']),
};

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeSerializeDate(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeRows(rows) {
  return (rows || []).map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, safeSerializeDate(value)])
  ));
}

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeConflictMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return BACKUP_CONFLICT_MODES.has(normalized) ? normalized : 'keep_existing';
}

function normalizeCalendarMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return BACKUP_CALENDAR_MODES.has(normalized) ? normalized : 'merge_same_name';
}

function normalizeCredentialMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return BACKUP_CREDENTIAL_MODES.has(normalized) ? normalized : 'keep_existing';
}

function isPathUnderRoot(filePath, rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(filePath || '');
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
}

async function readBackupFileEntry({ kind, id, storagePath, rootPath }) {
  if (!storagePath || !isPathUnderRoot(storagePath, rootPath)) return null;
  try {
    const buffer = await fs.promises.readFile(path.resolve(storagePath));
    return {
      kind,
      id,
      filename: path.basename(storagePath),
      sha256: sha256Buffer(buffer),
      size_bytes: buffer.length,
      data_base64: buffer.toString('base64'),
    };
  } catch {
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

function sanitizeArchivePathPart(value) {
  return String(value || 'file')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160) || 'file';
}

function getBackupArchivePath(file) {
  const safeId = sanitizeArchivePathPart(file.id || crypto.randomUUID());
  const safeName = sanitizeArchivePathPart(file.filename || safeId);
  if (file.kind === 'raw_email') return `files/mail-raw/${safeId}-${safeName}`;
  if (file.kind === 'email_attachment') return `files/mail-attachments/${safeId}-${safeName}`;
  if (file.kind === 'recording') return `files/recordings/${safeId}-${safeName}`;
  return `files/other/${safeId}-${safeName}`;
}

function getBackupRowCounts(backup) {
  const data = backup?.data || {};
  const counts = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) counts[key] = value.length;
    else if (value && typeof value === 'object') counts[key] = 1;
  }
  return counts;
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeArchiveFileEntry(file) {
  const { data_base64, ...metadata } = file;
  return metadata;
}

async function buildBackupForUser(userId) {
  const [
    [userRows],
    [userSettings],
    [contacts],
    [calendarAccounts],
    [calendarCalendars],
    [calendarEvents],
    [calendarSubtasks],
    [calendarAttendees],
    [calendarRefs],
    [mailFolders],
    [mailSenderRules],
    [mailAccounts],
    [emails],
    [attachments],
    [mailEmailScores],
    [recordings],
    [recordingTags],
    [recordingTagLinks],
  ] = await Promise.all([
    db.execute('SELECT id, email, full_name, avatar_url, role, is_active, email_verified, timezone, created_at, updated_at FROM users WHERE id = ?', [userId]),
    db.execute('SELECT * FROM user_settings WHERE user_id = ? ORDER BY setting_key ASC', [userId]),
    db.execute('SELECT * FROM contacts WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM calendar_accounts WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM calendar_calendars WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM calendar_events WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM calendar_event_subtasks WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM calendar_event_attendees WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM calendar_event_external_refs WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM mail_folders WHERE user_id = ? ORDER BY position ASC', [userId]),
    db.execute('SELECT * FROM mail_sender_rules WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM emails WHERE user_id = ? ORDER BY received_at ASC', [userId]),
    db.execute('SELECT * FROM email_attachments WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM mail_email_scores WHERE user_id = ? ORDER BY scored_at ASC', [userId]),
    db.execute('SELECT * FROM recordings WHERE user_id = ? ORDER BY created_at ASC', [userId]),
    db.execute('SELECT * FROM recording_tags WHERE user_id = ? ORDER BY name ASC', [userId]),
    db.execute('SELECT * FROM recording_tag_links WHERE user_id = ? ORDER BY created_at ASC', [userId]),
  ]);

  if (!userRows.length) {
    throw new Error('User not found');
  }

  const fileEntries = [];
  for (const attachment of attachments || []) {
    const entry = await readBackupFileEntry({
      kind: 'email_attachment',
      id: attachment.id,
      storagePath: attachment.storage_path,
      rootPath: ATTACHMENTS_ROOT,
    });
    if (entry) fileEntries.push(entry);
  }
  for (const email of emails || []) {
    const entry = await readBackupFileEntry({
      kind: 'raw_email',
      id: email.id,
      storagePath: email.raw_storage_path,
      rootPath: MAIL_RAW_STORAGE_ROOT,
    });
    if (entry) fileEntries.push(entry);
  }
  for (const recording of recordings || []) {
    const entry = await readBackupFileEntry({
      kind: 'recording',
      id: recording.id,
      storagePath: recording.storage_path,
      rootPath: RECORDINGS_ROOT,
    });
    if (entry) fileEntries.push(entry);
  }

  const data = {
    user: normalizeRows(userRows)[0],
    user_settings: normalizeRows(userSettings),
    contacts: normalizeRows(contacts),
    calendar_accounts: normalizeRows(calendarAccounts),
    calendar_calendars: normalizeRows(calendarCalendars),
    calendar_events: normalizeRows(calendarEvents),
    calendar_event_subtasks: normalizeRows(calendarSubtasks),
    calendar_event_attendees: normalizeRows(calendarAttendees),
    calendar_event_external_refs: normalizeRows(calendarRefs),
    mail_folders: normalizeRows(mailFolders),
    mail_sender_rules: normalizeRows(mailSenderRules),
    mail_accounts: normalizeRows(mailAccounts),
    emails: normalizeRows(emails),
    email_attachments: normalizeRows(attachments),
    mail_email_scores: normalizeRows(mailEmailScores),
    recordings: normalizeRows(recordings),
    recording_tags: normalizeRows(recordingTags),
    recording_tag_links: normalizeRows(recordingTagLinks),
  };

  const backup = {
    app: 'unihub',
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    warnings: [
      'Backups can contain encrypted account credentials and private email content. Store them securely.',
      'Encrypted account credentials only restore on deployments using the same ENCRYPTION_KEY.',
    ],
    data,
    files: fileEntries,
  };
  backup.manifest_sha256 = sha256Buffer(Buffer.from(canonicalJson({ data, files: fileEntries }), 'utf8'));
  return backup;
}

async function buildBackupArchiveEntriesForUser(userId, sections = 'full') {
  const fullBackup = await buildBackupForUser(userId);
  const scopedBackup = scopeBackupForImport(fullBackup, sections);
  const archiveFiles = [];
  const fileEntries = [];
  const missingFiles = [];

  for (const file of scopedBackup.files || []) {
    if (file?.missing) {
      missingFiles.push(`${file.kind}:${file.id}`);
      archiveFiles.push(normalizeArchiveFileEntry(file));
      continue;
    }
    if (!file?.data_base64 || !file.sha256) {
      missingFiles.push(`${file?.kind || 'unknown'}:${file?.id || 'unknown'}`);
      archiveFiles.push({ ...normalizeArchiveFileEntry(file), missing: true });
      continue;
    }
    const buffer = Buffer.from(String(file.data_base64), 'base64');
    const archivePath = getBackupArchivePath(file);
    archiveFiles.push({
      ...normalizeArchiveFileEntry(file),
      archive_path: archivePath,
      sha256: sha256Buffer(buffer),
      size_bytes: buffer.length,
    });
    fileEntries.push({
      name: archivePath,
      data: buffer,
    });
  }

  const backupPayload = {
    app: 'unihub',
    version: BACKUP_VERSION,
    format: ZIP_BACKUP_FORMAT,
    format_version: ZIP_BACKUP_FORMAT_VERSION,
    exported_at: scopedBackup.exported_at,
    warnings: scopedBackup.warnings,
    data: scopedBackup.data,
    files: archiveFiles,
  };
  backupPayload.manifest_sha256 = sha256Buffer(Buffer.from(canonicalJson({ data: backupPayload.data, files: backupPayload.files }), 'utf8'));

  const dataBuffer = jsonBuffer(backupPayload);
  const checksums = {
    generated_at: new Date().toISOString(),
    algorithm: 'sha256',
    entries: {
      'data/backup.json': sha256Buffer(dataBuffer),
    },
  };
  for (const file of archiveFiles) {
    if (file.archive_path && file.sha256) checksums.entries[file.archive_path] = file.sha256;
  }

  const manifest = {
    app: 'unihub',
    version: BACKUP_VERSION,
    format: ZIP_BACKUP_FORMAT,
    format_version: ZIP_BACKUP_FORMAT_VERSION,
    exported_at: backupPayload.exported_at,
    sections: scopedBackup.import_sections,
    row_counts: getBackupRowCounts(backupPayload),
    file_count: archiveFiles.filter(file => file.archive_path).length,
    missing_files: missingFiles,
    warnings: [
      ...(backupPayload.warnings || []),
      'Mail/calendar credentials are encrypted and only restore on deployments with the same ENCRYPTION_KEY.',
      'Mail server deletion is always disabled after restore.',
    ],
  };

  return [
    { name: 'manifest.json', data: jsonBuffer(manifest) },
    { name: 'data/backup.json', data: dataBuffer },
    { name: 'checksums.json', data: jsonBuffer(checksums) },
    ...fileEntries,
  ];
}

function validateBackupPayload(backup, { fileBuffersByPath = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!backup || typeof backup !== 'object') {
    return { valid: false, errors: ['Backup must be a JSON object'], warnings };
  }
  if (backup.app !== 'unihub') errors.push('Backup app must be "unihub"');
  if (backup.version !== BACKUP_VERSION) errors.push(`Unsupported backup version: ${backup.version}`);
  if (!backup.data || typeof backup.data !== 'object') errors.push('Backup data section is missing');
  if (!Array.isArray(backup.files)) errors.push('Backup files section must be an array');

  if (Array.isArray(backup.files)) {
    for (const file of backup.files) {
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
      const buffer = fileBuffer || Buffer.from(String(file.data_base64), 'base64');
      const actualHash = sha256Buffer(buffer);
      if (actualHash !== file.sha256) {
        errors.push(`Checksum mismatch for file ${file.kind}:${file.id}`);
      }
    }
  }

  if (backup.manifest_sha256 && backup.data && Array.isArray(backup.files)) {
    const actualManifestHash = sha256Buffer(Buffer.from(canonicalJson({ data: backup.data, files: backup.files }), 'utf8'));
    if (actualManifestHash !== backup.manifest_sha256) {
      errors.push('Manifest checksum mismatch');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function countBackupRows(backup) {
  const data = backup?.data || {};
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, value.length])
  );
}

async function countRestoreConflicts(userId, backup) {
  const data = backup?.data || {};
  const conflicts = {};

  const contacts = data.contacts || [];
  let contactConflicts = 0;
  for (const contact of contacts) {
    const emails = [contact.email, contact.email2, contact.email3].map(normalizeIdentifier).filter(Boolean);
    if (contact.id) {
      const [rows] = await db.execute('SELECT id FROM contacts WHERE id = ? AND user_id = ? LIMIT 1', [contact.id, userId]);
      if (rows.length) { contactConflicts++; continue; }
    }
    for (const email of emails) {
      const [rows] = await db.execute(
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
    const [rows] = await db.execute(
      'SELECT id FROM mail_accounts WHERE user_id = ? AND (id = ? OR email_address = ?) LIMIT 1',
      [userId, account.id, account.email_address]
    );
    if (rows.length) mailAccountConflicts++;
  }
  if (mailAccountConflicts) conflicts.mail_accounts = mailAccountConflicts;

  const emails = data.emails || [];
  let emailConflicts = 0;
  for (const email of emails.slice(0, 500)) {
    const [rows] = await db.execute(
      'SELECT id FROM emails WHERE id = ? AND user_id = ? LIMIT 1',
      [email.id, userId]
    );
    if (rows.length) emailConflicts++;
  }
  if (emailConflicts) conflicts.emails = emailConflicts;

  const calendars = data.calendar_calendars || [];
  let calendarConflicts = 0;
  for (const calendar of calendars) {
    const [rows] = await db.execute(
      'SELECT id FROM calendar_calendars WHERE id = ? AND user_id = ? LIMIT 1',
      [calendar.id, userId]
    );
    if (rows.length) calendarConflicts++;
  }
  if (calendarConflicts) conflicts.calendars = calendarConflicts;

  const recordings = data.recordings || [];
  let recordingConflicts = 0;
  for (const recording of recordings) {
    const [rows] = await db.execute(
      'SELECT id FROM recordings WHERE id = ? AND user_id = ? LIMIT 1',
      [recording.id, userId]
    );
    if (rows.length) recordingConflicts++;
  }
  if (recordingConflicts) conflicts.recordings = recordingConflicts;

  return conflicts;
}

function normalizeBackupImportSections(sections) {
  if (!sections || sections === 'full') return Array.from(BACKUP_IMPORT_SECTIONS);
  const values = Array.isArray(sections) ? sections : String(sections).split(',');
  const normalized = new Set();
  for (const value of values) {
    const section = String(value || '').trim().toLowerCase();
    if (section === 'todo') normalized.add('calendar');
    else if (BACKUP_IMPORT_SECTIONS.has(section)) normalized.add(section);
  }
  return normalized.size > 0 ? Array.from(normalized) : Array.from(BACKUP_IMPORT_SECTIONS);
}

function scopeBackupForImport(backup, sections) {
  const normalizedSections = normalizeBackupImportSections(sections);
  const allowedTables = new Set();
  const allowedFileKinds = new Set();

  for (const section of normalizedSections) {
    for (const table of BACKUP_IMPORT_SECTION_TABLES[section] || []) allowedTables.add(table);
    for (const kind of BACKUP_IMPORT_SECTION_FILE_KINDS[section] || []) allowedFileKinds.add(kind);
  }

  const sourceData = backup?.data || {};
  const data = {};
  for (const [key, value] of Object.entries(sourceData)) {
    if (allowedTables.has(key)) data[key] = value;
  }

  const files = (backup?.files || []).filter(file => allowedFileKinds.has(file?.kind));
  return {
    ...backup,
    data,
    files,
    import_sections: normalizedSections,
  };
}

function overwriteUserId(row, userId) {
  return { ...row, user_id: userId };
}

function chooseTargetId(originalId, existingId, conflictMode, { canKeepBoth = true } = {}) {
  if (existingId && conflictMode === 'keep_both' && canKeepBoth) return crypto.randomUUID();
  return existingId || originalId;
}

function shouldWriteExisting(existingId, targetId, conflictMode) {
  if (!existingId) return true;
  if (targetId !== existingId) return true;
  return conflictMode === 'replace';
}

function isSameCalendarName(a, b) {
  return normalizeIdentifier(a) === normalizeIdentifier(b);
}

async function findExistingContactForRestore(connection, row, userId) {
  const [existingById] = await connection.execute('SELECT id FROM contacts WHERE id = ? AND user_id = ? LIMIT 1', [row.id, userId]);
  if (existingById.length) return existingById[0].id;

  const emails = [row.email, row.email2, row.email3].map(normalizeIdentifier).filter(Boolean);
  for (const email of emails) {
    const [existingByEmail] = await connection.execute(
      `SELECT id FROM contacts
       WHERE user_id = ?
         AND (LOWER(email) = ? OR LOWER(email2) = ? OR LOWER(email3) = ?)
       LIMIT 1`,
      [userId, email, email, email]
    );
    if (existingByEmail.length) return existingByEmail[0].id;
  }

  const firstName = normalizeIdentifier(row.first_name);
  const lastName = normalizeIdentifier(row.last_name);
  const phone = normalizeIdentifier(row.phone || row.phone2 || row.phone3);
  if (firstName || lastName || phone) {
    const [existingByName] = await connection.execute(
      `SELECT id FROM contacts
       WHERE user_id = ?
         AND LOWER(first_name) = ?
         AND COALESCE(LOWER(last_name), '') = ?
         AND (? = '' OR phone = ? OR phone2 = ? OR phone3 = ?)
       LIMIT 1`,
      [userId, firstName, lastName, phone, phone, phone, phone]
    );
    if (existingByName.length) return existingByName[0].id;
  }

  return null;
}

async function findExistingCalendarAccountForRestore(connection, row, userId) {
  const [existingById] = await connection.execute('SELECT id FROM calendar_accounts WHERE id = ? AND user_id = ? LIMIT 1', [row.id, userId]);
  if (existingById.length) return existingById[0].id;
  if ((row.provider || 'local') === 'local') {
    const [localAccounts] = await connection.execute(
      "SELECT id FROM calendar_accounts WHERE user_id = ? AND provider = 'local' ORDER BY created_at ASC LIMIT 1",
      [userId]
    );
    if (localAccounts.length) return localAccounts[0].id;
  }
  const [existingByIdentity] = await connection.execute(
    `SELECT id FROM calendar_accounts
     WHERE user_id = ?
       AND provider = ?
       AND COALESCE(account_email, '') = COALESCE(?, '')
       AND COALESCE(base_url, '') = COALESCE(?, '')
     LIMIT 1`,
    [userId, row.provider || 'local', row.account_email || null, row.base_url || null]
  );
  return existingByIdentity[0]?.id || null;
}

async function findExistingCalendarForRestore(connection, row, userId, targetAccountId, calendarMode) {
  const [existingById] = await connection.execute('SELECT id FROM calendar_calendars WHERE id = ? AND user_id = ? LIMIT 1', [row.id, userId]);
  if (existingById.length) return existingById[0].id;
  if (row.external_id) {
    const [existingByExternal] = await connection.execute(
      'SELECT id FROM calendar_calendars WHERE account_id = ? AND external_id = ? LIMIT 1',
      [targetAccountId, row.external_id]
    );
    if (existingByExternal.length) return existingByExternal[0].id;
  }
  if (calendarMode === 'merge_same_name') {
    const [existingByName] = await connection.execute(
      'SELECT id, name FROM calendar_calendars WHERE user_id = ? AND account_id = ?',
      [userId, targetAccountId]
    );
    const match = (existingByName || []).find(calendar => isSameCalendarName(calendar.name, row.name));
    if (match) return match.id;
  }
  return null;
}

async function findExistingCalendarEventForRestore(connection, row, userId, targetCalendarId) {
  const [existingById] = await connection.execute('SELECT id FROM calendar_events WHERE id = ? AND user_id = ? LIMIT 1', [row.id, userId]);
  if (existingById.length) return existingById[0].id;
  const [existingByShape] = await connection.execute(
    `SELECT id FROM calendar_events
     WHERE user_id = ?
       AND calendar_id <=> ?
       AND title = ?
       AND start_time = ?
       AND end_time = ?
     LIMIT 1`,
    [userId, targetCalendarId || null, row.title || 'Untitled Event', row.start_time, row.end_time]
  );
  return existingByShape[0]?.id || null;
}

async function findExistingEmailForRestore(connection, row, userId, targetMailAccountId) {
  const [existingById] = await connection.execute(
    'SELECT id FROM emails WHERE id = ? AND user_id = ? LIMIT 1',
    [row.id, userId]
  );
  if (existingById.length > 0) return existingById[0].id;

  if (row.message_id) {
    const [existingByMessageId] = await connection.execute(
      'SELECT id FROM emails WHERE user_id = ? AND mail_account_id = ? AND message_id = ? LIMIT 1',
      [userId, targetMailAccountId, row.message_id]
    );
    if (existingByMessageId.length > 0) return existingByMessageId[0].id;
  }

  if (row.source_folder && row.imap_uid !== null && row.imap_uid !== undefined) {
    const params = [userId, targetMailAccountId, row.source_folder, row.imap_uid];
    let query = `
      SELECT id
      FROM emails
      WHERE user_id = ?
        AND mail_account_id = ?
        AND source_folder = ?
        AND imap_uid = ?`;

    if (row.imap_uidvalidity !== null && row.imap_uidvalidity !== undefined) {
      query += ' AND (imap_uidvalidity = ? OR imap_uidvalidity IS NULL)';
      params.push(row.imap_uidvalidity);
    }

    query += ' ORDER BY created_at ASC LIMIT 1';
    const [existingByUid] = await connection.execute(query, params);
    if (existingByUid.length > 0) return existingByUid[0].id;
  }

  return null;
}

async function findExistingAttachmentForRestore(connection, row, userId, targetEmailId) {
  const [existingById] = await connection.execute(
    'SELECT id FROM email_attachments WHERE id = ? AND user_id = ? LIMIT 1',
    [row.id, userId]
  );
  if (existingById.length > 0) return existingById[0].id;

  if (row.content_id) {
    const [existingByContentId] = await connection.execute(
      'SELECT id FROM email_attachments WHERE user_id = ? AND email_id = ? AND content_id = ? LIMIT 1',
      [userId, targetEmailId, row.content_id]
    );
    if (existingByContentId.length > 0) return existingByContentId[0].id;
  }

  const [existingByMetadata] = await connection.execute(
    `SELECT id
     FROM email_attachments
     WHERE user_id = ?
       AND email_id = ?
       AND filename = ?
       AND COALESCE(size_bytes, 0) = ?
     LIMIT 1`,
    [userId, targetEmailId, row.filename || 'attachment', Number(row.size_bytes) || 0]
  );
  return existingByMetadata[0]?.id || null;
}

async function findExistingRecordingForRestore(connection, row, userId, restoredFilePath = null) {
  const [existingById] = await connection.execute('SELECT id FROM recordings WHERE id = ? AND user_id = ? LIMIT 1', [row.id, userId]);
  if (existingById.length) return existingById[0].id;

  if (restoredFilePath) {
    const size = Number(row.size_bytes) || 0;
    const [existingByFile] = await connection.execute(
      `SELECT id FROM recordings
       WHERE user_id = ?
         AND COALESCE(size_bytes, 0) = ?
         AND COALESCE(original_filename, '') = COALESCE(?, '')
       LIMIT 1`,
      [userId, size, row.original_filename || null]
    );
    if (existingByFile.length) return existingByFile[0].id;
  }

  const [existingByShape] = await connection.execute(
    `SELECT id FROM recordings
     WHERE user_id = ?
       AND LOWER(title) = ?
       AND COALESCE(recorded_at, created_at) = COALESCE(?, ?)
       AND COALESCE(size_bytes, 0) = ?
     LIMIT 1`,
    [userId, normalizeIdentifier(row.title || row.original_filename || 'Recording'), row.recorded_at || null, row.created_at || null, Number(row.size_bytes) || 0]
  );
  return existingByShape[0]?.id || null;
}

async function writeRestoredFile(userId, file, { fileBuffersByPath = null } = {}) {
  if (file.missing) return null;
  const buffer = file.archive_path && fileBuffersByPath
    ? fileBuffersByPath.get(file.archive_path)
    : file.data_base64 ? Buffer.from(String(file.data_base64), 'base64') : null;
  if (!buffer) return null;
  if (sha256Buffer(buffer) !== file.sha256) {
    throw new Error(`Checksum mismatch while restoring file ${file.kind}:${file.id}`);
  }
  const root = file.kind === 'raw_email'
    ? MAIL_RAW_STORAGE_ROOT
    : file.kind === 'recording' ? RECORDINGS_ROOT : ATTACHMENTS_ROOT;
  const targetDir = path.join(root, String(userId));
  const safeId = sanitizeArchivePathPart(file.id || crypto.randomUUID());
  const safeFilename = `${safeId}-${sanitizeArchivePathPart(file.filename || safeId)}`;
  await fs.promises.mkdir(targetDir, { recursive: true });
  let targetPath = path.join(targetDir, safeFilename);
  for (let attempt = 1; attempt < 100; attempt += 1) {
    try {
      await fs.promises.writeFile(targetPath, buffer, { flag: 'wx' });
      return targetPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const ext = path.extname(safeFilename);
      const base = ext ? safeFilename.slice(0, -ext.length) : safeFilename;
      targetPath = path.join(targetDir, `${base}-${attempt}${ext}`);
    }
  }
  await fs.promises.writeFile(targetPath, buffer, { flag: 'wx' });
  return targetPath;
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('Backup file is not a valid ZIP archive.');
  }
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error('Backup file is not a valid ZIP archive.');
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Backup ZIP central directory is invalid.');
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    offset += 46 + fileNameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (compressionMethod !== 0) {
      throw new Error(`Unsupported ZIP compression for ${name}. UniHub backups must use stored entries.`);
    }
    if (compressedSize !== uncompressedSize) {
      throw new Error(`Invalid ZIP size metadata for ${name}.`);
    }
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header for ${name}.`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new Error(`ZIP entry ${name} exceeds archive bounds.`);
    }
    entries.set(name, buffer.subarray(dataStart, dataEnd));
  }
  return entries;
}

function parseJsonZipEntry(entries, name) {
  const buffer = entries.get(name);
  if (!buffer) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`Backup ZIP contains invalid JSON at ${name}.`);
  }
}

function backupFromZipBuffer(buffer) {
  const entries = readZipEntries(buffer);
  const manifest = parseJsonZipEntry(entries, 'manifest.json');
  const checksums = parseJsonZipEntry(entries, 'checksums.json');
  const backup = parseJsonZipEntry(entries, 'data/backup.json');
  if (!manifest || !backup) {
    throw new Error('This ZIP is not a restorable UniHub backup. Create a new backup with the Backup buttons.');
  }
  if (manifest.app !== 'unihub' || backup.app !== 'unihub') {
    throw new Error('Backup app must be "unihub".');
  }
  if (manifest.format !== ZIP_BACKUP_FORMAT || backup.format !== ZIP_BACKUP_FORMAT) {
    throw new Error('This ZIP is not a restorable UniHub backup.');
  }
  if (checksums?.entries?.['data/backup.json']) {
    const actualDataHash = sha256Buffer(entries.get('data/backup.json'));
    if (actualDataHash !== checksums.entries['data/backup.json']) {
      throw new Error('Checksum mismatch for data/backup.json.');
    }
  }

  const fileBuffersByPath = new Map();
  for (const file of backup.files || []) {
    if (!file.archive_path) continue;
    const fileBuffer = entries.get(file.archive_path);
    if (!fileBuffer) {
      throw new Error(`Backup file is missing ${file.archive_path}.`);
    }
    if (checksums?.entries?.[file.archive_path] && sha256Buffer(fileBuffer) !== checksums.entries[file.archive_path]) {
      throw new Error(`Checksum mismatch for ${file.archive_path}.`);
    }
    fileBuffersByPath.set(file.archive_path, fileBuffer);
  }
  return { backup, manifest, checksums, fileBuffersByPath };
}

async function importBackupForUser(userId, backup, {
  mode = 'dry-run',
  sections = 'full',
  conflict_mode = 'keep_existing',
  calendar_mode = 'merge_same_name',
  credentials_mode = 'keep_existing',
  fileBuffersByPath = null,
} = {}) {
  const conflictMode = normalizeConflictMode(conflict_mode);
  const calendarMode = normalizeCalendarMode(calendar_mode);
  const credentialsMode = normalizeCredentialMode(credentials_mode);
  const validation = validateBackupPayload(backup, { fileBuffersByPath });
  const scopedBackup = scopeBackupForImport(backup, sections);
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
      conflicts,
      options: {
        conflict_mode: conflictMode,
        calendar_mode: calendarMode,
        credentials_mode: credentialsMode,
      },
    };
  }

  const data = scopedBackup.data || {};
  const restoredPaths = new Map();
  const createdRestorePaths = [];
  for (const file of scopedBackup.files || []) {
    const restoredPath = await writeRestoredFile(userId, file, { fileBuffersByPath });
    if (restoredPath) {
      restoredPaths.set(`${file.kind}:${file.id}`, restoredPath);
      createdRestorePaths.push(restoredPath);
    }
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const calendarAccountIdMap = new Map();
    const calendarIdMap = new Map();
    const calendarEventIdMap = new Map();
    const mailAccountIdMap = new Map();
    const emailIdMap = new Map();
    const recordingIdMap = new Map();
    const recordingTagIdMap = new Map();

    const backupUser = data.user;
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

    for (const setting of data.user_settings || []) {
      const row = overwriteUserId(setting, userId);
      if (conflictMode === 'keep_existing') {
        const [existingSetting] = await connection.execute(
          'SELECT setting_key FROM user_settings WHERE user_id = ? AND setting_key = ? LIMIT 1',
          [row.user_id, row.setting_key]
        );
        if (existingSetting.length) continue;
      }
      await connection.execute(
        `INSERT INTO user_settings (user_id, setting_key, setting_value)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
        [row.user_id, row.setting_key, row.setting_value]
      );
    }

    for (const folder of data.mail_folders || []) {
      const row = overwriteUserId(folder, userId);
      if (conflictMode === 'keep_existing') {
        const [existingFolder] = await connection.execute(
          'SELECT id FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1',
          [row.user_id, row.slug]
        );
        if (existingFolder.length) continue;
      }
      await connection.execute(
        `INSERT INTO mail_folders (id, user_id, slug, display_name, is_system, position)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), is_system = VALUES(is_system), position = VALUES(position)`,
        [row.id, row.user_id, row.slug, row.display_name, row.is_system ? 1 : 0, row.position || 0]
      );
    }

    for (const contact of data.contacts || []) {
      const row = overwriteUserId(contact, userId);
      const existingContactId = await findExistingContactForRestore(connection, row, userId);
      const targetContactId = chooseTargetId(row.id, existingContactId, conflictMode);
      if (!shouldWriteExisting(existingContactId, targetContactId, conflictMode)) continue;
      await connection.execute(
        `INSERT INTO contacts (id, user_id, first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes, avatar_url, is_favorite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE first_name = VALUES(first_name), last_name = VALUES(last_name), email = VALUES(email), email2 = VALUES(email2), email3 = VALUES(email3), phone = VALUES(phone), phone2 = VALUES(phone2), phone3 = VALUES(phone3), company = VALUES(company), job_title = VALUES(job_title), notes = VALUES(notes), avatar_url = VALUES(avatar_url), is_favorite = VALUES(is_favorite)`,
        [targetContactId, row.user_id, row.first_name || '', row.last_name || null, row.email || null, row.email2 || null, row.email3 || null, row.phone || null, row.phone2 || null, row.phone3 || null, row.company || null, row.job_title || null, row.notes || null, row.avatar_url || null, row.is_favorite ? 1 : 0]
      );
    }

    for (const account of data.calendar_accounts || []) {
      const row = overwriteUserId(account, userId);
      const existingAccountId = await findExistingCalendarAccountForRestore(connection, row, userId);
      const targetAccountId = chooseTargetId(row.id, existingAccountId, conflictMode, { canKeepBoth: true });
      calendarAccountIdMap.set(row.id, targetAccountId);
      if (!shouldWriteExisting(existingAccountId, targetAccountId, conflictMode)) continue;
      const shouldRestoreCredentials = !existingAccountId || credentialsMode === 'restore' || targetAccountId !== existingAccountId;
      const encryptedPassword = shouldRestoreCredentials ? row.encrypted_password || null : null;
      const encryptedAccessToken = shouldRestoreCredentials ? row.encrypted_access_token || null : null;
      const encryptedRefreshToken = shouldRestoreCredentials ? row.encrypted_refresh_token || null : null;
      await connection.execute(
        `INSERT INTO calendar_accounts
           (id, user_id, provider, account_email, display_name, username, encrypted_password, discovery_url, base_url,
            encrypted_access_token, encrypted_refresh_token, token_expires_at, provider_config, capabilities,
            is_active, sync_status, sync_error, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           account_email = VALUES(account_email),
           display_name = VALUES(display_name),
           username = VALUES(username),
           encrypted_password = CASE WHEN ? THEN VALUES(encrypted_password) ELSE encrypted_password END,
           discovery_url = VALUES(discovery_url),
           base_url = VALUES(base_url),
           encrypted_access_token = CASE WHEN ? THEN VALUES(encrypted_access_token) ELSE encrypted_access_token END,
           encrypted_refresh_token = CASE WHEN ? THEN VALUES(encrypted_refresh_token) ELSE encrypted_refresh_token END,
           token_expires_at = VALUES(token_expires_at),
           provider_config = VALUES(provider_config),
           capabilities = VALUES(capabilities),
           is_active = VALUES(is_active),
           sync_status = VALUES(sync_status),
           sync_error = VALUES(sync_error),
           last_synced_at = VALUES(last_synced_at)`,
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
          row.token_expires_at || null,
          row.provider_config ? (typeof row.provider_config === 'string' ? row.provider_config : JSON.stringify(row.provider_config)) : null,
          row.capabilities ? (typeof row.capabilities === 'string' ? row.capabilities : JSON.stringify(row.capabilities)) : null,
          row.is_active === false ? 0 : 1,
          row.sync_status || null,
          row.sync_error || null,
          row.last_synced_at || null,
          shouldRestoreCredentials ? 1 : 0,
          shouldRestoreCredentials ? 1 : 0,
          shouldRestoreCredentials ? 1 : 0,
        ]
      );
    }

    for (const calendar of data.calendar_calendars || []) {
      const row = overwriteUserId(calendar, userId);
      const targetAccountId = calendarAccountIdMap.get(row.account_id) || row.account_id;
      const existingCalendarId = await findExistingCalendarForRestore(connection, row, userId, targetAccountId, calendarMode);
      const canKeepBothCalendar = !(row.external_id && existingCalendarId);
      const targetCalendarId = chooseTargetId(row.id, existingCalendarId, conflictMode, { canKeepBoth: canKeepBothCalendar });
      calendarIdMap.set(row.id, targetCalendarId);
      if (!shouldWriteExisting(existingCalendarId, targetCalendarId, conflictMode)) continue;
      const calendarName = targetCalendarId !== existingCalendarId && conflictMode === 'keep_both' && existingCalendarId
        ? `${row.name || 'Calendar'} (Restored)`
        : row.name || 'Calendar';
      await connection.execute(
        `INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary, sync_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), external_id = VALUES(external_id), color = VALUES(color), is_visible = VALUES(is_visible), auto_todo_enabled = VALUES(auto_todo_enabled), read_only = VALUES(read_only), is_primary = VALUES(is_primary), sync_token = VALUES(sync_token)`,
        [targetCalendarId, row.user_id, targetAccountId, calendarName, row.external_id || null, row.color || '#22c55e', row.is_visible === false ? 0 : 1, row.auto_todo_enabled === false ? 0 : 1, row.read_only ? 1 : 0, row.is_primary ? 1 : 0, row.sync_token || null]
      );
    }

    for (const event of data.calendar_events || []) {
      const row = overwriteUserId(event, userId);
      const targetCalendarId = row.calendar_id ? calendarIdMap.get(row.calendar_id) || row.calendar_id : null;
      const existingEventId = await findExistingCalendarEventForRestore(connection, row, userId, targetCalendarId);
      const targetEventId = chooseTargetId(row.id, existingEventId, conflictMode);
      calendarEventIdMap.set(row.id, targetEventId);
      if (!shouldWriteExisting(existingEventId, targetEventId, conflictMode)) continue;
      await connection.execute(
        `INSERT INTO calendar_events (id, user_id, calendar_id, title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, todo_status, is_todo_only, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE calendar_id = VALUES(calendar_id), title = VALUES(title), description = VALUES(description), start_time = VALUES(start_time), end_time = VALUES(end_time), all_day = VALUES(all_day), location = VALUES(location), color = VALUES(color), recurrence = VALUES(recurrence), reminder_minutes = VALUES(reminder_minutes), reminders = VALUES(reminders), todo_status = VALUES(todo_status), is_todo_only = VALUES(is_todo_only), done_at = VALUES(done_at)`,
        [targetEventId, row.user_id, targetCalendarId, row.title || 'Untitled Event', row.description || null, row.start_time, row.end_time, row.all_day ? 1 : 0, row.location || null, row.color || '#22c55e', row.recurrence || null, row.reminder_minutes ?? null, row.reminders ? (typeof row.reminders === 'string' ? row.reminders : JSON.stringify(row.reminders)) : null, row.todo_status || null, row.is_todo_only ? 1 : 0, row.done_at || null]
      );
    }

    for (const subtask of data.calendar_event_subtasks || []) {
      const row = overwriteUserId(subtask, userId);
      const targetEventId = calendarEventIdMap.get(row.event_id) || row.event_id;
      const [existingSubtask] = await connection.execute(
        'SELECT id FROM calendar_event_subtasks WHERE id = ? AND user_id = ? LIMIT 1',
        [row.id, userId]
      );
      if (existingSubtask.length && conflictMode === 'keep_existing') continue;
      const targetSubtaskId = existingSubtask.length && conflictMode === 'keep_both' ? crypto.randomUUID() : row.id;
      await connection.execute(
        `INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE title = VALUES(title), is_done = VALUES(is_done), position = VALUES(position)`,
        [targetSubtaskId, targetEventId, row.user_id, row.title || '', row.is_done ? 1 : 0, row.position || 0]
      );
    }

    for (const attendee of data.calendar_event_attendees || []) {
      const row = overwriteUserId(attendee, userId);
      const targetEventId = calendarEventIdMap.get(row.event_id) || row.event_id;
      if (conflictMode === 'keep_existing') {
        const [existingAttendee] = await connection.execute(
          'SELECT id FROM calendar_event_attendees WHERE event_id = ? AND email = ? LIMIT 1',
          [targetEventId, row.email]
        );
        if (existingAttendee.length) continue;
      }
      const targetAttendeeId = conflictMode === 'keep_both' ? crypto.randomUUID() : row.id;
      await connection.execute(
        `INSERT INTO calendar_event_attendees (id, user_id, event_id, email, display_name, response_status, is_organizer, optional_attendee, comment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), response_status = VALUES(response_status), is_organizer = VALUES(is_organizer), optional_attendee = VALUES(optional_attendee), comment = VALUES(comment)`,
        [targetAttendeeId, row.user_id, targetEventId, row.email, row.display_name || null, row.response_status || 'needsAction', row.is_organizer ? 1 : 0, row.optional_attendee ? 1 : 0, row.comment || null]
      );
    }

    for (const ref of data.calendar_event_external_refs || []) {
      const row = overwriteUserId(ref, userId);
      const targetEventId = calendarEventIdMap.get(row.event_id) || row.event_id;
      const targetCalendarId = calendarIdMap.get(row.calendar_id) || row.calendar_id;
      const targetAccountId = calendarAccountIdMap.get(row.account_id) || row.account_id;
      if (conflictMode === 'keep_existing') {
        const [existingRef] = await connection.execute(
          'SELECT id FROM calendar_event_external_refs WHERE account_id = ? AND external_event_id = ? LIMIT 1',
          [targetAccountId, row.external_event_id]
        );
        if (existingRef.length) continue;
      }
      const targetRefId = conflictMode === 'keep_both' ? crypto.randomUUID() : row.id;
      await connection.execute(
        `INSERT INTO calendar_event_external_refs (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, external_etag, external_updated_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE event_id = VALUES(event_id), calendar_id = VALUES(calendar_id), provider = VALUES(provider), external_etag = VALUES(external_etag), external_updated_at = VALUES(external_updated_at), last_synced_at = VALUES(last_synced_at)`,
        [targetRefId, row.user_id, targetEventId, targetCalendarId, targetAccountId, row.provider, row.external_event_id, row.external_etag || null, row.external_updated_at || null, row.last_synced_at || null]
      );
    }

    for (const account of data.mail_accounts || []) {
      const row = overwriteUserId(account, userId);
      const [existingByEmail] = await connection.execute(
        'SELECT id FROM mail_accounts WHERE user_id = ? AND email_address = ? LIMIT 1',
        [userId, row.email_address]
      );
      const [existingById] = existingByEmail.length
        ? [existingByEmail]
        : await connection.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [row.id, userId]);
      const targetAccountId = existingById[0]?.id || row.id;
      mailAccountIdMap.set(row.id, targetAccountId);
      const syncFetchLimit = normalizeSyncFetchLimit(row.sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT) || DEFAULT_MAIL_SYNC_FETCH_LIMIT;

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
               trusted_imap_fingerprint256 = ?, trusted_smtp_fingerprint256 = ?, is_active = ?, last_synced_at = ?,
               delete_emails_on_server = FALSE, server_delete_enabled_at = NULL,
               server_delete_grace_until = NULL, server_delete_last_run_at = NULL
           WHERE id = ? AND user_id = ?`,
          [row.email_address, row.display_name || null, row.provider || 'custom', row.username || row.email_address, row.imap_host || null, row.imap_port || 993, row.smtp_host || null, row.smtp_port || 587, shouldRestoreCredentials ? 1 : 0, row.encrypted_password || null, syncFetchLimit, row.allow_self_signed ? 1 : 0, row.trusted_imap_fingerprint256 || null, row.trusted_smtp_fingerprint256 || null, row.is_active === false ? 0 : 1, row.last_synced_at || null, targetAccountId, userId]
        );
      } else {
        await connection.execute(
          `INSERT INTO mail_accounts
             (id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
              smtp_host, smtp_port, encrypted_password, sync_fetch_limit, delete_emails_on_server,
              server_delete_enabled_at, server_delete_grace_until, server_delete_last_run_at,
              allow_self_signed, trusted_imap_fingerprint256, trusted_smtp_fingerprint256, is_active, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
          [targetAccountId, row.user_id, row.email_address, row.display_name || null, row.provider || 'custom', row.username || row.email_address, row.imap_host || null, row.imap_port || 993, row.smtp_host || null, row.smtp_port || 587, row.encrypted_password || null, syncFetchLimit, row.allow_self_signed ? 1 : 0, row.trusted_imap_fingerprint256 || null, row.trusted_smtp_fingerprint256 || null, row.is_active === false ? 0 : 1, row.last_synced_at || null]
        );
      }
    }

    for (const rule of data.mail_sender_rules || []) {
      const row = overwriteUserId(rule, userId);
      const targetMailAccountId = row.mail_account_id ? mailAccountIdMap.get(row.mail_account_id) || row.mail_account_id : null;
      const [existingRule] = await connection.execute(
        `SELECT id FROM mail_sender_rules
         WHERE user_id = ?
           AND mail_account_id <=> ?
           AND match_type = ?
           AND match_value = ?
           AND target_folder = ?
         LIMIT 1`,
        [row.user_id, targetMailAccountId, row.match_type, row.match_value, row.target_folder || 'inbox']
      );
      if (existingRule.length && conflictMode === 'keep_existing') continue;
      const targetRuleId = existingRule.length && conflictMode === 'keep_both' ? crypto.randomUUID() : row.id;
      await connection.execute(
        `INSERT INTO mail_sender_rules (id, user_id, mail_account_id, match_type, match_value, target_folder, priority, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE mail_account_id = VALUES(mail_account_id), match_type = VALUES(match_type), match_value = VALUES(match_value), target_folder = VALUES(target_folder), priority = VALUES(priority), is_active = VALUES(is_active)`,
        [targetRuleId, row.user_id, targetMailAccountId, row.match_type, row.match_value, row.target_folder || 'inbox', row.priority || 100, row.is_active === false ? 0 : 1]
      );
    }

    for (const email of data.emails || []) {
      const row = overwriteUserId(email, userId);
      const targetMailAccountId = mailAccountIdMap.get(row.mail_account_id) || row.mail_account_id;
      const existingEmailId = await findExistingEmailForRestore(connection, row, userId, targetMailAccountId);
      const targetEmailId = chooseTargetId(row.id, existingEmailId, conflictMode);
      emailIdMap.set(row.id, targetEmailId);
      const rawPath = restoredPaths.get(`raw_email:${row.id}`) || null;
      if (!shouldWriteExisting(existingEmailId, targetEmailId, conflictMode)) continue;
      await connection.execute(
        `INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, body_text, body_html, folder, source_folder, imap_uid, imap_uidvalidity, raw_storage_path, raw_sha256, is_read, is_starred, is_draft, has_attachments, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE subject = VALUES(subject), from_address = VALUES(from_address), from_name = VALUES(from_name), to_addresses = VALUES(to_addresses), cc_addresses = VALUES(cc_addresses), bcc_addresses = VALUES(bcc_addresses), body_text = VALUES(body_text), body_html = VALUES(body_html), folder = VALUES(folder), source_folder = VALUES(source_folder), imap_uid = VALUES(imap_uid), imap_uidvalidity = VALUES(imap_uidvalidity), raw_storage_path = VALUES(raw_storage_path), raw_sha256 = VALUES(raw_sha256), is_read = VALUES(is_read), is_starred = VALUES(is_starred), is_draft = VALUES(is_draft), has_attachments = VALUES(has_attachments), received_at = VALUES(received_at)`,
        [targetEmailId, row.user_id, targetMailAccountId, row.message_id || null, row.subject || null, row.from_address || 'unknown', row.from_name || null, typeof row.to_addresses === 'string' ? row.to_addresses : JSON.stringify(row.to_addresses || []), row.cc_addresses ? (typeof row.cc_addresses === 'string' ? row.cc_addresses : JSON.stringify(row.cc_addresses)) : null, row.bcc_addresses ? (typeof row.bcc_addresses === 'string' ? row.bcc_addresses : JSON.stringify(row.bcc_addresses)) : null, row.body_text || null, row.body_html || null, row.folder || 'inbox', row.source_folder || null, row.imap_uid || null, row.imap_uidvalidity || null, rawPath, rawPath ? row.raw_sha256 || null : null, row.is_read ? 1 : 0, row.is_starred ? 1 : 0, row.is_draft ? 1 : 0, row.has_attachments ? 1 : 0, row.received_at || new Date()]
      );
    }

    for (const attachment of data.email_attachments || []) {
      const row = overwriteUserId(attachment, userId);
      const targetEmailId = emailIdMap.get(row.email_id) || row.email_id;
      const existingAttachmentId = await findExistingAttachmentForRestore(connection, row, userId, targetEmailId);
      const targetAttachmentId = chooseTargetId(row.id, existingAttachmentId, conflictMode);
      const storagePath = restoredPaths.get(`email_attachment:${row.id}`) || null;
      if (!shouldWriteExisting(existingAttachmentId, targetAttachmentId, conflictMode)) continue;
      await connection.execute(
        `INSERT INTO email_attachments (id, email_id, user_id, filename, content_type, size_bytes, storage_path, content_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE filename = VALUES(filename), content_type = VALUES(content_type), size_bytes = VALUES(size_bytes), storage_path = VALUES(storage_path), content_id = VALUES(content_id)`,
        [targetAttachmentId, targetEmailId, row.user_id, row.filename || 'attachment', row.content_type || 'application/octet-stream', row.size_bytes || 0, storagePath, row.content_id || null]
      );
    }

    for (const score of data.mail_email_scores || []) {
      const row = overwriteUserId(score, userId);
      const targetEmailId = emailIdMap.get(row.email_id) || row.email_id;
      if (conflictMode === 'keep_existing') {
        const [existingScore] = await connection.execute(
          'SELECT id FROM mail_email_scores WHERE email_id = ? AND score_version = ? LIMIT 1',
          [targetEmailId, row.score_version || 'v1']
        );
        if (existingScore.length) continue;
      }
      const targetScoreId = conflictMode === 'keep_both' ? crypto.randomUUID() : row.id;
      await connection.execute(
        `INSERT INTO mail_email_scores
           (id, email_id, user_id, score_version, total_score, risk_level, spf_result, dkim_result, dmarc_result,
            language_risk_score, sender_reputation_score, source_risk_score, classifier_confidence, reasons, metadata, scored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           total_score = VALUES(total_score),
           risk_level = VALUES(risk_level),
           spf_result = VALUES(spf_result),
           dkim_result = VALUES(dkim_result),
           dmarc_result = VALUES(dmarc_result),
           language_risk_score = VALUES(language_risk_score),
           sender_reputation_score = VALUES(sender_reputation_score),
           source_risk_score = VALUES(source_risk_score),
           classifier_confidence = VALUES(classifier_confidence),
           reasons = VALUES(reasons),
           metadata = VALUES(metadata),
           scored_at = VALUES(scored_at)`,
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
          row.scored_at || new Date(),
        ]
      );
    }

    for (const recording of data.recordings || []) {
      const row = overwriteUserId(recording, userId);
      const storagePath = restoredPaths.get(`recording:${row.id}`);
      if (!storagePath) continue;
      const existingRecordingId = await findExistingRecordingForRestore(connection, row, userId, storagePath);
      const targetRecordingId = chooseTargetId(row.id, existingRecordingId, conflictMode);
      recordingIdMap.set(row.id, targetRecordingId);
      if (!shouldWriteExisting(existingRecordingId, targetRecordingId, conflictMode)) continue;
      await connection.execute(
        `INSERT INTO recordings
           (id, user_id, title, description, original_filename, content_type, size_bytes, duration_seconds, storage_path, source, category, recorded_at, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           title = VALUES(title),
           description = VALUES(description),
           original_filename = VALUES(original_filename),
           content_type = VALUES(content_type),
           size_bytes = VALUES(size_bytes),
           duration_seconds = VALUES(duration_seconds),
           storage_path = VALUES(storage_path),
           source = VALUES(source),
           category = VALUES(category),
           recorded_at = VALUES(recorded_at),
           metadata = VALUES(metadata)`,
        [
          targetRecordingId,
          row.user_id,
          row.title || row.original_filename || 'Recording',
          row.description || null,
          row.original_filename || null,
          row.content_type || 'application/octet-stream',
          Number(row.size_bytes) || 0,
          row.duration_seconds ?? null,
          storagePath,
          row.source || 'imported',
          row.category || 'none',
          row.recorded_at || row.created_at || new Date(),
          row.metadata ? (typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata)) : null,
          row.created_at || new Date(),
        ]
      );
    }

    for (const tag of data.recording_tags || []) {
      const row = overwriteUserId(tag, userId);
      if (!row.name) continue;
      const [existingByName] = await connection.execute(
        'SELECT id FROM recording_tags WHERE user_id = ? AND name = ? LIMIT 1',
        [userId, row.name]
      );
      const targetTagId = existingByName[0]?.id || row.id;
      recordingTagIdMap.set(row.id, targetTagId);
      if (existingByName.length && conflictMode === 'keep_existing') continue;
      await connection.execute(
        `INSERT INTO recording_tags (id, user_id, name, color)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE color = VALUES(color)`,
        [targetTagId, row.user_id, row.name, row.color || null]
      );
    }

    for (const link of data.recording_tag_links || []) {
      const row = overwriteUserId(link, userId);
      if (!recordingIdMap.has(row.recording_id) || !recordingTagIdMap.has(row.tag_id)) continue;
      const targetRecordingId = recordingIdMap.get(row.recording_id);
      const targetTagId = recordingTagIdMap.get(row.tag_id);
      await connection.execute(
        `INSERT INTO recording_tag_links (recording_id, tag_id, user_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
        [targetRecordingId, targetTagId, row.user_id]
      );
    }

    await connection.commit();
    return {
      dry_run: false,
      valid: true,
      warnings: validation.warnings,
      counts,
      import_sections: scopedBackup.import_sections,
      restored_files: restoredPaths.size,
      conflicts,
      options: {
        conflict_mode: conflictMode,
        calendar_mode: calendarMode,
        credentials_mode: credentialsMode,
      },
    };
  } catch (error) {
    await connection.rollback();
    await Promise.all(createdRestorePaths.map(filePath => fs.promises.rm(filePath, { force: true }).catch(() => {})));
    throw error;
  } finally {
    connection.release();
  }
}

async function importBackupZipBufferForUser(userId, buffer, options = {}) {
  const { backup, manifest, fileBuffersByPath } = backupFromZipBuffer(buffer);
  const sections = options.sections || manifest.sections || 'full';
  return importBackupForUser(userId, backup, {
    ...options,
    sections,
    fileBuffersByPath,
  });
}

module.exports = {
  BACKUP_VERSION,
  ZIP_BACKUP_FORMAT,
  ZIP_BACKUP_FORMAT_VERSION,
  sha256Buffer,
  canonicalJson,
  validateBackupPayload,
  countBackupRows,
  normalizeBackupImportSections,
  scopeBackupForImport,
  buildBackupForUser,
  buildBackupArchiveEntriesForUser,
  readZipEntries,
  backupFromZipBuffer,
  importBackupForUser,
  importBackupZipBufferForUser,
};
