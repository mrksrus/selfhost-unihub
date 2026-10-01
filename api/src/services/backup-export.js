const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { finished } = require('stream/promises');
const { db } = require('../state');
const { decrypt } = require('../security/encryption');
const { encryptPortableCredentialBundle, decryptPortableCredentialBundle } = require('./backup-container');
const { inspectRecordingAudio } = require('./recording-audio');
const { BACKUP_VERSION, ZIP_BACKUP_FORMAT, ZIP_BACKUP_FORMAT_VERSION, getBackupProducer } = require('./backup-format');
const { SECTION_POLICIES, TABLE_POLICIES, FILE_POLICIES } = require('./backup-catalog');
const {
  BACKUP_FILE_ROOTS,
  sha256File,
  normalizeRows,
  isPathUnderRoot,
  getBackupArchivePath,
  getBackupRowCounts,
  jsonBuffer,
  assertBackupMetadataSize,
} = require('./backup-common');
const { normalizeBackupImportSections, scopeBackupForImport } = require('./backup-validate');

async function readBackupFileEntry({
  kind,
  id,
  storagePath,
  rootPath,
  includeData = true,
  checkCancelled = null,
}) {
  if (!storagePath || !isPathUnderRoot(storagePath, rootPath)) return null;
  try {
    const sourcePath = path.resolve(storagePath);
    const stat = await fs.promises.stat(sourcePath);
    if (!stat.isFile()) throw new Error('Backup source is not a regular file');
    const entry = {
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

async function writeBackupJsonFile(value, targetPath) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const stream = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
  let pending = '';
  let streamError = null;
  stream.on('error', error => {
    streamError = error;
  });

  const flush = async () => {
    if (!pending) return;
    const chunk = pending;
    pending = '';
    if (!stream.write(chunk, 'utf8')) {
      await new Promise((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (error) => {
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

  const append = async (text) => {
    pending += text;
    if (pending.length >= 1024 * 1024) await flush();
  };

  const writeArray = async (items) => {
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

function normalizeArchiveFileEntry(file) {
  const { data_base64, source_path, ...metadata } = file;
  return metadata;
}

function assertBackupFilesComplete(backup) {
  const files = new Map((backup.files || []).map(file => [`${file.kind}:${file.id}`, file]));
  const required = [
    ...(backup.data.email_attachments || []).map(row => `email_attachment:${row.id}`),
    ...(backup.data.recordings || []).map(row => `recording:${row.id}`),
    ...(backup.data.note_attachments || []).map(row => `note_attachment:${row.id}`),
    ...(backup.data.emails || []).filter(row => row.raw_storage_path || row.import_complete === true || row.import_complete === 1)
      .map(row => `raw_email:${row.id}`),
  ];
  const missing = required.filter(key => {
    const file = files.get(key);
    return !file || file.missing || !file.source_path || !file.sha256;
  });
  if (missing.length) {
    const error = new Error(`Backup cannot be completed: ${missing.length} referenced file(s) in the selected sections are missing or unreadable (${missing.slice(0, 3).join(', ')}). Check storage access or export other sections.`);
    error.status = 409;
    throw error;
  }
}

// Per-account mail export: each mail table restricted to one account's rows.
// Shared folders and global sender rules stay included because the account's
// folder mappings and rule overrides refer to them. Command receipts are not
// account-scoped and are left out.
const ACCOUNT_MAIL_FILTERS = Object.freeze({
  mail_accounts: 'b.id = ?',
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

async function readBackupSnapshot(userId, sections, checkCancelled, mailAccountId = null) {
  const connection = await db.getConnection();
  try {
    if (checkCancelled) await checkCancelled();
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const data = {};
    for (const section of normalizeBackupImportSections(sections)) {
      for (const table of SECTION_POLICIES[section].tables) {
        if (checkCancelled) await checkCancelled();
        const policy = TABLE_POLICIES[table];
        const columns = policy.columns.map(column => `b.\`${column}\``).join(', ');
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
        if (mailAccountId !== null && SECTION_POLICIES.mail.tables.includes(table)) {
          const filter = ACCOUNT_MAIL_FILTERS[table];
          if (!filter) throw new Error(`No account filter for mail table ${table}`);
          where += ` AND ${filter}`;
          if (filter.includes('?')) params = [...params, mailAccountId];
        }
        const order = policy.keyColumns.map(column => `b.\`${column}\``).join(', ');
        const [rows] = await connection.execute(`SELECT ${columns} FROM ${from} WHERE ${where} ORDER BY ${order}`, params);
        if (table === 'user' && !rows.length) throw new Error('User not found');
        data[table] = table === 'user' ? normalizeRows(rows)[0] : normalizeRows(rows);
      }
    }
    // Filing in another account is local organisation outside this export;
    // the restored copy is filed under its own account instead.
    if (mailAccountId !== null) {
      for (const email of data.emails || []) {
        if (email.filing_account_id && email.filing_account_id !== mailAccountId) email.filing_account_id = null;
      }
    }
    await connection.commit();
    return data;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function buildBackupForUser(userId, {
  includeFileData = true,
  portableCredentialKey = null,
  checkCancelled = null,
  sections = 'full',
  mailAccountId = null,
} = {}) {
  const data = await readBackupSnapshot(userId, sections, checkCancelled, mailAccountId);
  const fileEntries = [];
  for (const [kind, policy] of Object.entries(FILE_POLICIES)) {
    const rootPath = BACKUP_FILE_ROOTS[kind];
    if (!Object.hasOwn(BACKUP_FILE_ROOTS, kind) || !rootPath) throw new Error(`Unsupported backup file root: ${kind}`);
    for (const row of data[policy.table] || []) {
      if (checkCancelled) await checkCancelled();
      const entry = await readBackupFileEntry({
        kind,
        id: row.id,
        storagePath: row[policy.column],
        rootPath,
        includeData: includeFileData,
        checkCancelled,
      });
      if (entry) fileEntries.push(entry);
    }
  }

  let portableCredentials = null;
  if (portableCredentialKey) {
    const credentialBundle = {
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

  const backup = {
    app: 'unihub',
    version: BACKUP_VERSION,
    producer: getBackupProducer(),
    exported_at: new Date().toISOString(),
    warnings: [
      'Backups can contain encrypted account credentials and private email content. Store them securely.',
      portableCredentialKey
        ? 'Account credentials are protected by this backup and can be re-encrypted by another UniHub server.'
        : 'Encrypted account credentials only restore on deployments using the same ENCRYPTION_KEY.',
    ],
    data,
    files: fileEntries,
    portable_credentials: portableCredentials,
  };
  return backup;
}

async function buildBackupArchiveEntriesForUser(userId, sections = 'full', {
  portableCredentialKey = null,
  checkCancelled = null,
  mailAccountId = null,
} = {}) {
  const fullBackup = await buildBackupForUser(userId, {
    includeFileData: false,
    sections,
    mailAccountId,
    portableCredentialKey,
    checkCancelled,
  });
  const scopedBackup = scopeBackupForImport(fullBackup, sections);
  assertBackupFilesComplete(scopedBackup);
  if (portableCredentialKey && scopedBackup.portable_credentials) {
    const credentials = decryptPortableCredentialBundle(
      scopedBackup.portable_credentials,
      portableCredentialKey
    );
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
        const error = new Error(`Backup cannot include recording ${file.id}: the stored audio is unsupported or unreadable. The original file was kept unchanged; export other sections or repair this recording first.`);
        error.status = 409;
        throw error;
      }
    }
    const archivePath = getBackupArchivePath(file);
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
    files: archiveFiles,
    portable_credentials: scopedBackup.portable_credentials || null,
  };
  const dataPath = path.join(os.tmpdir(), `unihub-backup-data-${crypto.randomUUID()}.json`);
  try {
    await writeBackupJsonFile(backupPayload, dataPath);
    const checksums = {
      generated_at: new Date().toISOString(),
      algorithm: 'sha256',
      entries: {
        'data/backup.json': await sha256File(dataPath, checkCancelled),
      },
    };
    for (const file of archiveFiles) {
      if (file.archive_path && file.sha256) checksums.entries[file.archive_path] = file.sha256;
    }

    const manifest = {
      app: 'unihub',
      version: BACKUP_VERSION,
      producer: getBackupProducer(),
      format: ZIP_BACKUP_FORMAT,
      format_version: ZIP_BACKUP_FORMAT_VERSION,
      exported_at: backupPayload.exported_at,
      sections: scopedBackup.import_sections,
      row_counts: getBackupRowCounts(backupPayload),
      file_count: archiveFiles.filter(file => file.archive_path).length,
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
      { name: 'manifest.json', data: manifestData },
      { name: 'data/backup.json', filePath: dataPath, cleanupAfterWrite: true,
        expectedSha256: checksums.entries['data/backup.json'], expectedSize: dataSize },
      { name: 'checksums.json', data: checksumData },
      ...fileEntries,
    ];
  } catch (error) {
    await fs.promises.rm(dataPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  readBackupFileEntry,
  writeBackupJsonFile,
  assertBackupFilesComplete,
  buildBackupForUser,
  buildBackupArchiveEntriesForUser,
};
