const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../state');
const { MAIL_RAW_STORAGE_ROOT } = require('./mail');

const BACKUP_VERSION = 1;
const ATTACHMENTS_ROOT = '/app/uploads/attachments';

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

async function buildBackupForUser(userId) {
  const [[userRows], [contacts], [calendarAccounts], [calendarCalendars], [calendarEvents], [calendarSubtasks], [calendarAttendees], [calendarRefs], [mailFolders], [mailSenderRules], [mailAccounts], [emails], [attachments]] = await Promise.all([
    db.execute('SELECT id, email, full_name, avatar_url, role, is_active, email_verified, timezone, created_at, updated_at FROM users WHERE id = ?', [userId]),
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

  const data = {
    user: normalizeRows(userRows)[0],
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

function validateBackupPayload(backup) {
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
      if (!file?.data_base64 || !file.sha256) {
        errors.push(`File ${file?.kind || 'unknown'}:${file?.id || 'unknown'} is incomplete`);
        continue;
      }
      const buffer = Buffer.from(String(file.data_base64), 'base64');
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

function overwriteUserId(row, userId) {
  return { ...row, user_id: userId };
}

async function writeRestoredFile(userId, file) {
  if (file.missing || !file.data_base64) return null;
  const buffer = Buffer.from(String(file.data_base64), 'base64');
  if (sha256Buffer(buffer) !== file.sha256) {
    throw new Error(`Checksum mismatch while restoring file ${file.kind}:${file.id}`);
  }
  const root = file.kind === 'raw_email' ? MAIL_RAW_STORAGE_ROOT : ATTACHMENTS_ROOT;
  const targetDir = path.join(root, String(userId));
  const safeFilename = String(file.filename || `${file.id}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const targetPath = path.join(targetDir, safeFilename);
  await fs.promises.mkdir(targetDir, { recursive: true });
  await fs.promises.writeFile(targetPath, buffer);
  return targetPath;
}

async function importBackupForUser(userId, backup, { mode = 'dry-run' } = {}) {
  const validation = validateBackupPayload(backup);
  const counts = countBackupRows(backup);
  if (!validation.valid || mode !== 'apply') {
    return {
      dry_run: mode !== 'apply',
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      counts,
    };
  }

  const data = backup.data || {};
  const restoredPaths = new Map();
  for (const file of backup.files || []) {
    const restoredPath = await writeRestoredFile(userId, file);
    if (restoredPath) restoredPaths.set(`${file.kind}:${file.id}`, restoredPath);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const mailAccountIdMap = new Map();

    for (const folder of data.mail_folders || []) {
      const row = overwriteUserId(folder, userId);
      await connection.execute(
        `INSERT INTO mail_folders (id, user_id, slug, display_name, is_system, position)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), is_system = VALUES(is_system), position = VALUES(position)`,
        [row.id, row.user_id, row.slug, row.display_name, row.is_system ? 1 : 0, row.position || 0]
      );
    }

    for (const contact of data.contacts || []) {
      const row = overwriteUserId(contact, userId);
      await connection.execute(
        `INSERT INTO contacts (id, user_id, first_name, last_name, email, email2, email3, phone, phone2, phone3, company, job_title, notes, avatar_url, is_favorite)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE first_name = VALUES(first_name), last_name = VALUES(last_name), email = VALUES(email), email2 = VALUES(email2), email3 = VALUES(email3), phone = VALUES(phone), phone2 = VALUES(phone2), phone3 = VALUES(phone3), company = VALUES(company), job_title = VALUES(job_title), notes = VALUES(notes), avatar_url = VALUES(avatar_url), is_favorite = VALUES(is_favorite)`,
        [row.id, row.user_id, row.first_name || '', row.last_name || null, row.email || null, row.email2 || null, row.email3 || null, row.phone || null, row.phone2 || null, row.phone3 || null, row.company || null, row.job_title || null, row.notes || null, row.avatar_url || null, row.is_favorite ? 1 : 0]
      );
    }

    for (const account of data.calendar_accounts || []) {
      const row = overwriteUserId(account, userId);
      await connection.execute(
        `INSERT INTO calendar_accounts (id, user_id, provider, account_email, display_name, encrypted_access_token, encrypted_refresh_token, token_expires_at, provider_config, capabilities, is_active, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE account_email = VALUES(account_email), display_name = VALUES(display_name), encrypted_access_token = VALUES(encrypted_access_token), encrypted_refresh_token = VALUES(encrypted_refresh_token), token_expires_at = VALUES(token_expires_at), provider_config = VALUES(provider_config), capabilities = VALUES(capabilities), is_active = VALUES(is_active), last_synced_at = VALUES(last_synced_at)`,
        [row.id, row.user_id, row.provider || 'local', row.account_email || null, row.display_name || null, row.encrypted_access_token || null, row.encrypted_refresh_token || null, row.token_expires_at || null, row.provider_config ? (typeof row.provider_config === 'string' ? row.provider_config : JSON.stringify(row.provider_config)) : null, row.capabilities ? (typeof row.capabilities === 'string' ? row.capabilities : JSON.stringify(row.capabilities)) : null, row.is_active === false ? 0 : 1, row.last_synced_at || null]
      );
    }

    for (const calendar of data.calendar_calendars || []) {
      const row = overwriteUserId(calendar, userId);
      await connection.execute(
        `INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary, sync_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), external_id = VALUES(external_id), color = VALUES(color), is_visible = VALUES(is_visible), auto_todo_enabled = VALUES(auto_todo_enabled), read_only = VALUES(read_only), is_primary = VALUES(is_primary), sync_token = VALUES(sync_token)`,
        [row.id, row.user_id, row.account_id, row.name || 'Calendar', row.external_id || null, row.color || '#22c55e', row.is_visible === false ? 0 : 1, row.auto_todo_enabled === false ? 0 : 1, row.read_only ? 1 : 0, row.is_primary ? 1 : 0, row.sync_token || null]
      );
    }

    for (const event of data.calendar_events || []) {
      const row = overwriteUserId(event, userId);
      await connection.execute(
        `INSERT INTO calendar_events (id, user_id, calendar_id, title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, todo_status, is_todo_only, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE calendar_id = VALUES(calendar_id), title = VALUES(title), description = VALUES(description), start_time = VALUES(start_time), end_time = VALUES(end_time), all_day = VALUES(all_day), location = VALUES(location), color = VALUES(color), recurrence = VALUES(recurrence), reminder_minutes = VALUES(reminder_minutes), reminders = VALUES(reminders), todo_status = VALUES(todo_status), is_todo_only = VALUES(is_todo_only), done_at = VALUES(done_at)`,
        [row.id, row.user_id, row.calendar_id || null, row.title || 'Untitled Event', row.description || null, row.start_time, row.end_time, row.all_day ? 1 : 0, row.location || null, row.color || '#22c55e', row.recurrence || null, row.reminder_minutes ?? null, row.reminders ? (typeof row.reminders === 'string' ? row.reminders : JSON.stringify(row.reminders)) : null, row.todo_status || null, row.is_todo_only ? 1 : 0, row.done_at || null]
      );
    }

    for (const subtask of data.calendar_event_subtasks || []) {
      const row = overwriteUserId(subtask, userId);
      await connection.execute(
        `INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE title = VALUES(title), is_done = VALUES(is_done), position = VALUES(position)`,
        [row.id, row.event_id, row.user_id, row.title || '', row.is_done ? 1 : 0, row.position || 0]
      );
    }

    for (const attendee of data.calendar_event_attendees || []) {
      const row = overwriteUserId(attendee, userId);
      await connection.execute(
        `INSERT INTO calendar_event_attendees (id, user_id, event_id, email, display_name, response_status, is_organizer, optional_attendee, comment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), response_status = VALUES(response_status), is_organizer = VALUES(is_organizer), optional_attendee = VALUES(optional_attendee), comment = VALUES(comment)`,
        [row.id, row.user_id, row.event_id, row.email, row.display_name || null, row.response_status || 'needsAction', row.is_organizer ? 1 : 0, row.optional_attendee ? 1 : 0, row.comment || null]
      );
    }

    for (const ref of data.calendar_event_external_refs || []) {
      const row = overwriteUserId(ref, userId);
      await connection.execute(
        `INSERT INTO calendar_event_external_refs (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, external_etag, external_updated_at, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE event_id = VALUES(event_id), calendar_id = VALUES(calendar_id), provider = VALUES(provider), external_etag = VALUES(external_etag), external_updated_at = VALUES(external_updated_at), last_synced_at = VALUES(last_synced_at)`,
        [row.id, row.user_id, row.event_id, row.calendar_id, row.account_id, row.provider, row.external_event_id, row.external_etag || null, row.external_updated_at || null, row.last_synced_at || null]
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

      if (existingById.length) {
        await connection.execute(
          `UPDATE mail_accounts
           SET email_address = ?, display_name = ?, provider = ?, username = ?, imap_host = ?, imap_port = ?,
               smtp_host = ?, smtp_port = ?, encrypted_password = ?, sync_fetch_limit = ?, allow_self_signed = ?,
               trusted_imap_fingerprint256 = ?, trusted_smtp_fingerprint256 = ?, is_active = ?, last_synced_at = ?
           WHERE id = ? AND user_id = ?`,
          [row.email_address, row.display_name || null, row.provider || 'custom', row.username || row.email_address, row.imap_host || null, row.imap_port || 993, row.smtp_host || null, row.smtp_port || 587, row.encrypted_password || null, row.sync_fetch_limit || '500', row.allow_self_signed ? 1 : 0, row.trusted_imap_fingerprint256 || null, row.trusted_smtp_fingerprint256 || null, row.is_active === false ? 0 : 1, row.last_synced_at || null, targetAccountId, userId]
        );
      } else {
        await connection.execute(
          `INSERT INTO mail_accounts (id, user_id, email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password, sync_fetch_limit, allow_self_signed, trusted_imap_fingerprint256, trusted_smtp_fingerprint256, is_active, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [targetAccountId, row.user_id, row.email_address, row.display_name || null, row.provider || 'custom', row.username || row.email_address, row.imap_host || null, row.imap_port || 993, row.smtp_host || null, row.smtp_port || 587, row.encrypted_password || null, row.sync_fetch_limit || '500', row.allow_self_signed ? 1 : 0, row.trusted_imap_fingerprint256 || null, row.trusted_smtp_fingerprint256 || null, row.is_active === false ? 0 : 1, row.last_synced_at || null]
        );
      }
    }

    for (const rule of data.mail_sender_rules || []) {
      const row = overwriteUserId(rule, userId);
      const targetMailAccountId = row.mail_account_id ? mailAccountIdMap.get(row.mail_account_id) || row.mail_account_id : null;
      await connection.execute(
        `INSERT INTO mail_sender_rules (id, user_id, mail_account_id, match_type, match_value, target_folder, priority, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE mail_account_id = VALUES(mail_account_id), match_type = VALUES(match_type), match_value = VALUES(match_value), target_folder = VALUES(target_folder), priority = VALUES(priority), is_active = VALUES(is_active)`,
        [row.id, row.user_id, targetMailAccountId, row.match_type, row.match_value, row.target_folder || 'inbox', row.priority || 100, row.is_active === false ? 0 : 1]
      );
    }

    for (const email of data.emails || []) {
      const row = overwriteUserId(email, userId);
      const rawPath = restoredPaths.get(`raw_email:${row.id}`) || row.raw_storage_path || null;
      const targetMailAccountId = mailAccountIdMap.get(row.mail_account_id) || row.mail_account_id;
      await connection.execute(
        `INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, body_text, body_html, folder, source_folder, imap_uid, imap_uidvalidity, raw_storage_path, raw_sha256, is_read, is_starred, is_draft, has_attachments, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE subject = VALUES(subject), from_address = VALUES(from_address), from_name = VALUES(from_name), to_addresses = VALUES(to_addresses), cc_addresses = VALUES(cc_addresses), bcc_addresses = VALUES(bcc_addresses), body_text = VALUES(body_text), body_html = VALUES(body_html), folder = VALUES(folder), source_folder = VALUES(source_folder), imap_uid = VALUES(imap_uid), imap_uidvalidity = VALUES(imap_uidvalidity), raw_storage_path = VALUES(raw_storage_path), raw_sha256 = VALUES(raw_sha256), is_read = VALUES(is_read), is_starred = VALUES(is_starred), is_draft = VALUES(is_draft), has_attachments = VALUES(has_attachments), received_at = VALUES(received_at)`,
        [row.id, row.user_id, targetMailAccountId, row.message_id || null, row.subject || null, row.from_address || 'unknown', row.from_name || null, typeof row.to_addresses === 'string' ? row.to_addresses : JSON.stringify(row.to_addresses || []), row.cc_addresses ? (typeof row.cc_addresses === 'string' ? row.cc_addresses : JSON.stringify(row.cc_addresses)) : null, row.bcc_addresses ? (typeof row.bcc_addresses === 'string' ? row.bcc_addresses : JSON.stringify(row.bcc_addresses)) : null, row.body_text || null, row.body_html || null, row.folder || 'inbox', row.source_folder || null, row.imap_uid || null, row.imap_uidvalidity || null, rawPath, row.raw_sha256 || null, row.is_read ? 1 : 0, row.is_starred ? 1 : 0, row.is_draft ? 1 : 0, row.has_attachments ? 1 : 0, row.received_at || new Date()]
      );
    }

    for (const attachment of data.email_attachments || []) {
      const row = overwriteUserId(attachment, userId);
      const storagePath = restoredPaths.get(`email_attachment:${row.id}`) || row.storage_path || null;
      await connection.execute(
        `INSERT INTO email_attachments (id, email_id, user_id, filename, content_type, size_bytes, storage_path, content_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE filename = VALUES(filename), content_type = VALUES(content_type), size_bytes = VALUES(size_bytes), storage_path = VALUES(storage_path), content_id = VALUES(content_id)`,
        [row.id, row.email_id, row.user_id, row.filename || 'attachment', row.content_type || 'application/octet-stream', row.size_bytes || 0, storagePath, row.content_id || null]
      );
    }

    await connection.commit();
    return {
      dry_run: false,
      valid: true,
      warnings: validation.warnings,
      counts,
      restored_files: restoredPaths.size,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  BACKUP_VERSION,
  sha256Buffer,
  canonicalJson,
  validateBackupPayload,
  countBackupRows,
  buildBackupForUser,
  importBackupForUser,
};
