const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { finished } = require('stream/promises');
const { encrypt, decrypt } = require('../security/encryption');
const { decryptPortableCredentialBundle } = require('./backup-container');
const { MAIL_RAW_STORAGE_ROOT, validateMailHostPolicy } = require('./mail');
const { validateDavUrlPolicy } = require('./caldav');
const { resolveCalDavUrl } = require('../security/caldav-transport');
const { RECORDINGS_ROOT } = require('./recordings');
const { resolveOwnedReference } = require('./backup-ownership');
const {
  ATTACHMENTS_ROOT,
  sha256Buffer,
  isFileRangeSource,
  createFileRangeStream,
  canonicalJson,
  normalizeMysqlDateTime,
  normalizeIdentifier,
  sanitizeArchivePathPart,
} = require('./backup-common');

function prepareCredentialsForRestore(backup, portableCredentialKey, warnings) {
  const data = backup?.data || {};
  const portableBundle = backup?.portable_credentials;
  if (portableBundle) {
    if (!portableCredentialKey) {
      throw new Error('This backup contains protected portable credentials but no backup key is available.');
    }
    const credentials = decryptPortableCredentialBundle(portableBundle, portableCredentialKey);
    const mailById = new Map((credentials.mail_accounts || []).map(item => [item.id, item]));
    const calendarById = new Map((credentials.calendar_accounts || []).map(item => [item.id, item]));
    for (const account of data.mail_accounts || []) {
      const item = mailById.get(account.id);
      account.encrypted_password = item?.password !== null && item?.password !== undefined
        ? encrypt(item.password)
        : null;
      if (!account.encrypted_password) account.is_active = false;
    }
    for (const account of data.calendar_accounts || []) {
      const item = calendarById.get(account.id);
      account.encrypted_password = item?.password !== null && item?.password !== undefined
        ? encrypt(item.password)
        : null;
      account.encrypted_access_token = item?.access_token !== null && item?.access_token !== undefined
        ? encrypt(item.access_token)
        : null;
      account.encrypted_refresh_token = item?.refresh_token !== null && item?.refresh_token !== undefined
        ? encrypt(item.refresh_token)
        : null;
      if (
        account.provider !== 'local'
        && !account.encrypted_password
        && !account.encrypted_access_token
        && !account.encrypted_refresh_token
      ) {
        account.is_active = false;
      }
    }
    return;
  }

  let unavailableCredentials = 0;
  for (const account of data.mail_accounts || []) {
    if (!account.encrypted_password) {
      account.is_active = false;
      continue;
    }
    const password = decrypt(account.encrypted_password);
    if (password === null) {
      account.encrypted_password = null;
      account.is_active = false;
      unavailableCredentials += 1;
    } else {
      account.encrypted_password = encrypt(password);
    }
  }
  for (const account of data.calendar_accounts || []) {
    for (const field of ['encrypted_password', 'encrypted_access_token', 'encrypted_refresh_token']) {
      if (!account[field]) continue;
      const value = decrypt(account[field]);
      if (value === null) {
        account[field] = null;
        unavailableCredentials += 1;
      } else {
        account[field] = encrypt(value);
      }
    }
    if (
      account.provider !== 'local'
      && !account.encrypted_password
      && !account.encrypted_access_token
      && !account.encrypted_refresh_token
    ) {
      account.is_active = false;
    }
  }
  if (unavailableCredentials > 0) {
    warnings.push(
      `${unavailableCredentials} legacy account credential value(s) could not be decrypted on this server. Affected accounts were restored inactive.`
    );
  }
}

function overwriteUserId(row, userId) {
  return { ...row, user_id: userId };
}

async function checkRestoredAccountPolicy(row, kind, warnings) {
  let error;
  const calendarProvider = row.provider || 'local';
  if (kind === 'mail') {
    const result = await validateMailHostPolicy(row);
    if (!result.accepted) error = result.error || 'Mail host policy rejected this account';
  } else if (calendarProvider !== 'local') {
    if (calendarProvider !== 'caldav') error = 'Unsupported calendar provider';
    else {
      const urls = [row.discovery_url, row.base_url].filter(Boolean);
      if (!urls.length) error = 'Calendar account has no valid connection URL';
      for (const url of urls) {
        try { resolveCalDavUrl(url, urls[0], urls[0]); }
        catch (policyError) { error = policyError.message; break; }
        const result = await validateDavUrlPolicy(url);
        if (!result.accepted) { error = result.error || 'Calendar host policy rejected this account'; break; }
      }
    }
  }
  if (error) {
    row.is_active = false;
    warnings.push(`Restored ${kind} account ${row.id} is inactive: ${error}`);
  }
  return !error;
}

function shouldWriteExisting(existingId, targetId, conflictMode) {
  if (!existingId) return true;
  if (targetId !== existingId) return true;
  return conflictMode === 'replace';
}

function isSameCalendarName(a, b) {
  return normalizeIdentifier(a) === normalizeIdentifier(b);
}

function chooseUnclaimedRestoreMatch(rows, claimedIds, source, fields) {
  const available = rows.filter(row => !claimedIds.has(row.id));
  const exact = available.find(row => fields.every(field => (row[field] ?? null) === (source[field] ?? null)));
  return (exact || available[0])?.id || null;
}

async function findExistingContactForRestore(connection, row, userId, claimedIds = new Set()) {
  const [existingById] = await connection.execute('SELECT id FROM contacts WHERE id = ? AND user_id = ? LIMIT 1', [row.id, userId]);
  if (existingById.length && !claimedIds.has(existingById[0].id)) return existingById[0].id;

  const identityFields = ['first_name', 'last_name', 'email', 'email2', 'email3', 'phone', 'phone2', 'phone3', 'company', 'job_title', 'notes', 'avatar_url'];
  const selection = ['id', ...identityFields].join(', ');
  const emails = [row.email, row.email2, row.email3].map(normalizeIdentifier).filter(Boolean);
  for (const email of emails) {
    const [existingByEmail] = await connection.execute(
      `SELECT ${selection} FROM contacts
       WHERE user_id = ?
         AND (LOWER(email) = ? OR LOWER(email2) = ? OR LOWER(email3) = ?)
       ORDER BY created_at ASC, id ASC`,
      [userId, email, email, email]
    );
    const matchedId = chooseUnclaimedRestoreMatch(existingByEmail, claimedIds, row, identityFields);
    if (matchedId) return matchedId;
  }

  const firstName = normalizeIdentifier(row.first_name);
  const lastName = normalizeIdentifier(row.last_name);
  const phone = normalizeIdentifier(row.phone || row.phone2 || row.phone3);
  if (firstName || lastName || phone) {
    const [existingByName] = await connection.execute(
      `SELECT ${selection} FROM contacts
       WHERE user_id = ?
         AND LOWER(first_name) = ?
         AND COALESCE(LOWER(last_name), '') = ?
         AND (? = '' OR phone = ? OR phone2 = ? OR phone3 = ?)
       ORDER BY created_at ASC, id ASC`,
      [userId, firstName, lastName, phone, phone, phone, phone]
    );
    const matchedId = chooseUnclaimedRestoreMatch(existingByName, claimedIds, row, identityFields);
    if (matchedId) return matchedId;
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
  const [existingById] = await connection.execute('SELECT id FROM calendar_calendars WHERE id = ? AND user_id = ? AND account_id = ? LIMIT 1', [row.id, userId, targetAccountId]);
  if (existingById.length) return existingById[0].id;
  if (row.external_id) {
    const [existingByExternal] = await connection.execute(
      'SELECT id FROM calendar_calendars WHERE account_id = ? AND external_id = ? AND user_id = ? LIMIT 1',
      [targetAccountId, row.external_id, userId]
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

async function findExistingCalendarEventForRestore(connection, row, userId, targetCalendarId, claimedIds = new Set()) {
  const [existingById] = await connection.execute('SELECT id FROM calendar_events WHERE id = ? AND user_id = ? AND calendar_id <=> ? LIMIT 1', [row.id, userId, targetCalendarId]);
  if (existingById.length && !claimedIds.has(existingById[0].id)) return existingById[0].id;
  const serializedReminders = value => {
    if (!value) return null;
    if (typeof value === 'string') { try { return canonicalJson(JSON.parse(value)); } catch { return value; } }
    return canonicalJson(value);
  };
  const content = {
    reminders: serializedReminders(row.reminders),
    description: row.description ?? null, location: row.location || null, color: row.color || '#22c55e',
    recurrence: row.recurrence || null, reminder_minutes: row.reminder_minutes ?? null,
    todo_status: row.todo_status || null, done_at: normalizeMysqlDateTime(row.done_at),
    all_day: row.all_day ? 1 : 0, is_todo_only: row.is_todo_only ? 1 : 0,
  };
  const startTime = normalizeMysqlDateTime(row.start_time);
  const endTime = normalizeMysqlDateTime(row.end_time);
  const [existingByShape] = await connection.execute(
    `SELECT id, ${Object.keys(content).join(', ')} FROM calendar_events
     WHERE user_id = ?
       AND calendar_id <=> ?
       AND title = ?
       AND start_time = ?
       AND end_time = ?
     ORDER BY created_at ASC, id ASC`,
    [userId, targetCalendarId || null, row.title || 'Untitled Event', startTime, endTime]
  );
  return chooseUnclaimedRestoreMatch(existingByShape.map(candidate => ({ ...candidate,
    done_at: normalizeMysqlDateTime(candidate.done_at), reminders: serializedReminders(candidate.reminders),
  })), claimedIds, content, Object.keys(content));
}

async function findExistingEmailForRestore(connection, row, userId, targetMailAccountId, claimedIds = new Set()) {
  const [existingById] = await connection.execute(
    'SELECT id FROM emails WHERE id = ? AND user_id = ? AND mail_account_id = ? LIMIT 1',
    [row.id, userId, targetMailAccountId]
  );
  const byId = existingById.find(item => !claimedIds.has(item.id));
  if (byId) return byId.id;


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
      query += ' AND imap_uidvalidity = ?';
      params.push(row.imap_uidvalidity);
    } else {
      query += ' AND imap_uidvalidity IS NULL';
    }

    query += ' ORDER BY created_at ASC, id ASC';
    const [existingByUid] = await connection.execute(query, params);
    const byUid = existingByUid.find(item => !claimedIds.has(item.id));
    if (byUid) return byUid.id;
  }

  if (row.message_id) {
    const [existingByMessageId] = await connection.execute(
      'SELECT id FROM emails WHERE user_id = ? AND mail_account_id = ? AND message_id = ? ORDER BY created_at ASC, id ASC',
      [userId, targetMailAccountId, row.message_id]
    );
    const byMessage = existingByMessageId.find(item => !claimedIds.has(item.id));
    if (byMessage) return byMessage.id;
  }

  return null;
}

async function restoreMailFolderRemoteBox(connection, userId, row, folderMap, accountMap, conflictMode, warnings) {
  const folderId = await resolveOwnedReference(connection, userId, 'mail_folders', row.folder_id, folderMap);
  const accountId = await resolveOwnedReference(connection, userId, 'mail_accounts', row.mail_account_id, accountMap);
  const [existing] = await connection.execute(
    `SELECT b.folder_id, b.mail_account_id, b.remote_name
     FROM mail_folder_remote_boxes b
     JOIN mail_folders f ON f.id = b.folder_id
     JOIN mail_accounts a ON a.id = b.mail_account_id
     WHERE f.user_id = ? AND a.user_id = ? AND b.mail_account_id = ?
       AND (b.folder_id = ? OR b.remote_name = ?) FOR UPDATE`,
    [userId, userId, accountId, folderId, row.remote_name]
  );
  if (existing.some(item => item.folder_id === folderId && item.remote_name === row.remote_name)) return;
  const remoteAlreadyMapped = existing.some(item => item.folder_id !== folderId);
  if (existing.length && (conflictMode !== 'replace' || remoteAlreadyMapped)) {
    if (conflictMode === 'replace' && remoteAlreadyMapped) {
      throw new Error('A restored provider folder is already mapped to a different local folder. Restore with keep existing to preserve that mapping.');
    }
    warnings.push(`Kept the existing provider folder mapping for restored folder ${row.folder_id}.`);
    return;
  }
  if (existing.length) {
    await connection.execute(
      `UPDATE mail_folder_remote_boxes b
       JOIN mail_folders f ON f.id = b.folder_id
       JOIN mail_accounts a ON a.id = b.mail_account_id
       SET b.remote_name = ?
       WHERE b.folder_id = ? AND b.mail_account_id = ? AND f.user_id = ? AND a.user_id = ?`,
      [row.remote_name, folderId, accountId, userId, userId]
    );
  } else {
    // Both parent IDs were remapped or locked with ownership checks above.
    // A unique-key collision fails the restore; it never updates another mapping.
    await connection.execute(
      'INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name) VALUES (?, ?, ?)',
      [folderId, accountId, row.remote_name]
    );
  }
}

function remapRestoredInlineAttachments(html, attachmentIds) {
  if (typeof html !== 'string' || !attachmentIds?.size) return html;
  return html.replace(/(\/api\/mail\/attachments\/)([^/?#\s"'<>]+)/g,
    (original, prefix, id) => attachmentIds.has(id) ? `${prefix}${attachmentIds.get(id)}` : original);
}

function firstUnclaimed(rows, claimedIds) {
  return rows.find(row => !claimedIds.has(row.id))?.id || null;
}

async function findExistingAttachmentForRestore(connection, row, userId, targetEmailId, claimedIds = new Set()) {
  const [existingById] = await connection.execute(
    'SELECT id FROM email_attachments WHERE id = ? AND user_id = ? AND email_id = ? LIMIT 1',
    [row.id, userId, targetEmailId]
  );
  const byId = firstUnclaimed(existingById, claimedIds);
  if (byId) return byId;

  if (row.content_id) {
    const [existingByContentId] = await connection.execute(
      'SELECT id FROM email_attachments WHERE user_id = ? AND email_id = ? AND content_id = ? ORDER BY created_at ASC, id ASC',
      [userId, targetEmailId, row.content_id]
    );
    const byContentId = firstUnclaimed(existingByContentId, claimedIds);
    if (byContentId) return byContentId;
  }

  const [existingByMetadata] = await connection.execute(
    `SELECT id
     FROM email_attachments
     WHERE user_id = ?
       AND email_id = ?
       AND filename = ?
       AND COALESCE(size_bytes, 0) = ?
     ORDER BY created_at ASC, id ASC`,
    [userId, targetEmailId, row.filename || 'attachment', Number(row.size_bytes) || 0]
  );
  return firstUnclaimed(existingByMetadata, claimedIds);
}

async function findExistingRecordingForRestore(connection, row, userId, restoredFilePath = null, claimedIds = new Set()) {
  const [existingById] = await connection.execute('SELECT id FROM recordings WHERE id = ? AND user_id = ? LIMIT 1', [row.id, userId]);
  const byId = firstUnclaimed(existingById, claimedIds);
  if (byId) return byId;

  const [existingByShape] = await connection.execute(
    `SELECT id FROM recordings
     WHERE user_id = ?
       AND LOWER(title) = ?
       AND COALESCE(recorded_at, created_at) = COALESCE(?, ?)
       AND COALESCE(size_bytes, 0) = ?
     ORDER BY created_at ASC, id ASC`,
    [userId, normalizeIdentifier(row.title || row.original_filename || 'Recording'), normalizeMysqlDateTime(row.recorded_at), normalizeMysqlDateTime(row.created_at), Number(row.size_bytes) || 0]
  );
  const byShape = firstUnclaimed(existingByShape, claimedIds);
  if (byShape) return byShape;

  if (restoredFilePath) {
    const [existingByFile] = await connection.execute(
      `SELECT id FROM recordings
       WHERE user_id = ?
         AND COALESCE(size_bytes, 0) = ?
         AND COALESCE(original_filename, '') = COALESCE(?, '')
       ORDER BY created_at ASC, id ASC`,
      [userId, Number(row.size_bytes) || 0, row.original_filename || null]
    );
    return firstUnclaimed(existingByFile, claimedIds);
  }
  return null;
}

async function writeFileSource(targetPath, source, expectedHash, { checkCancelled = null } = {}) {
  if (checkCancelled) await checkCancelled();
  if (Buffer.isBuffer(source)) {
    if (sha256Buffer(source) !== expectedHash) {
      throw new Error('Checksum mismatch while restoring backup file.');
    }
    await fs.promises.writeFile(targetPath, source, { flag: 'wx', mode: 0o600 });
    return;
  }
  if (!isFileRangeSource(source)) {
    throw new Error('Backup file source is unavailable.');
  }

  const hash = crypto.createHash('sha256');
  const output = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
  const input = createFileRangeStream(source);
  try {
    if (input) {
      for await (const chunk of input) {
        if (checkCancelled) await checkCancelled();
        hash.update(chunk);
        if (!output.write(chunk)) {
          await new Promise((resolve, reject) => {
            output.once('drain', resolve);
            output.once('error', reject);
          });
        }
      }
      output.end();
      await finished(output);
    } else {
      output.end();
      await finished(output);
    }
    if (hash.digest('hex') !== expectedHash) {
      throw new Error('Checksum mismatch while restoring backup file.');
    }
  } catch (error) {
    output.destroy();
    if (error?.code !== 'EEXIST') {
      await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

async function writeRestoredFile(userId, file, {
  fileBuffersByPath = null,
  fileSourcesByPath = fileBuffersByPath,
  restoreJobId = null,
  checkCancelled = null,
} = {}) {
  if (file.missing) return null;
  const source = file.archive_path && fileSourcesByPath
    ? fileSourcesByPath.get(file.archive_path)
    : file.data_base64 ? Buffer.from(String(file.data_base64), 'base64') : null;
  if (!source) return null;
  const root = file.kind === 'raw_email'
    ? MAIL_RAW_STORAGE_ROOT
    : file.kind === 'recording' ? RECORDINGS_ROOT : ATTACHMENTS_ROOT;
  const targetDir = restoreJobId
    ? path.join(root, String(userId), 'restores', sanitizeArchivePathPart(restoreJobId))
    : path.join(root, String(userId));
  const safeId = sanitizeArchivePathPart(file.id || crypto.randomUUID());
  const safeFilename = `${safeId}-${sanitizeArchivePathPart(file.filename || safeId)}`;
  await fs.promises.mkdir(targetDir, { recursive: true });
  let targetPath = path.join(targetDir, safeFilename);
  for (let attempt = 1; attempt < 100; attempt += 1) {
    try {
      await writeFileSource(targetPath, source, file.sha256, { checkCancelled });
      return targetPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const ext = path.extname(safeFilename);
      const base = ext ? safeFilename.slice(0, -ext.length) : safeFilename;
      targetPath = path.join(targetDir, `${base}-${attempt}${ext}`);
    }
  }
  await writeFileSource(targetPath, source, file.sha256, { checkCancelled });
  return targetPath;
}

module.exports = {
  prepareCredentialsForRestore,
  overwriteUserId,
  checkRestoredAccountPolicy,
  shouldWriteExisting,
  findExistingContactForRestore,
  findExistingCalendarAccountForRestore,
  findExistingCalendarForRestore,
  findExistingCalendarEventForRestore,
  findExistingEmailForRestore,
  restoreMailFolderRemoteBox,
  remapRestoredInlineAttachments,
  findExistingAttachmentForRestore,
  findExistingRecordingForRestore,
  writeRestoredFile,
};
