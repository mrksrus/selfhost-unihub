const crypto = require('crypto');
const fs = require('fs').promises;
const { stageAttachments, discardStagedAttachments, insertStagedAttachments, rewriteInlineAttachments } = require('./mail-attachments');

// Persist one complete provider message. Existing local read/star/folder choices
// survive repair; files are staged before a short metadata transaction.
async function persistImportedMessage({ db, account, accountId, folderName, uid, uidValidity,
  existingEmail, messageId, fullEmail, parsed, fromAddress, fromName, toAddresses,
  folder, isRead, archiveRaw, enqueueDeletion, suppressNotifications = true }) {
  const emailId = existingEmail?.id || crypto.randomUUID();
  let staged = [];
  let archive;
  let connection;
  let committed = false;
  let commitAttempted = false;
  let oldAttachments = [];
  try {
    archive = await archiveRaw({ userId: account.user_id, emailId: `${emailId}-${crypto.randomUUID()}`, messageId, rawEmail: fullEmail });
    if (!archive.rawStoragePath) throw new Error('Raw message archive was not saved');
    staged = await stageAttachments({ userId: account.user_id, emailId, attachments: parsed.attachments || [] });
    const bodyHtml = rewriteInlineAttachments(parsed.html, staged);
    connection = await db.getConnection();
    await connection.beginTransaction();
    if (existingEmail) {
      [oldAttachments] = await connection.execute('SELECT id, storage_path FROM email_attachments WHERE email_id = ? AND user_id = ?', [emailId, account.user_id]);
      await connection.execute(
        `UPDATE emails SET message_id = ?, from_address = ?, from_name = ?, to_addresses = ?,
          body_text = ?, body_html = ?, has_attachments = ?, source_folder = COALESCE(source_folder, ?),
          imap_uid = COALESCE(imap_uid, ?), imap_uidvalidity = COALESCE(imap_uidvalidity, ?),
          raw_storage_path = ?, raw_sha256 = ?, import_complete = TRUE
         WHERE id = ? AND user_id = ?`,
        [messageId, fromAddress, fromName, JSON.stringify(toAddresses), parsed.text || null, bodyHtml,
          staged.length > 0 ? 1 : 0, folderName, uid, uidValidity, archive.rawStoragePath, archive.rawSha256, emailId, account.user_id]
      );
      await connection.execute('DELETE FROM email_attachments WHERE email_id = ? AND user_id = ?', [emailId, account.user_id]);
    } else {
      await connection.execute(
        `INSERT INTO emails
          (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, body_text, body_html,
           has_attachments, received_at, folder, source_folder, imap_uid, imap_uidvalidity, raw_storage_path, raw_sha256, is_read, import_complete)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
        [emailId, account.user_id, accountId, messageId, parsed.subject || '(No subject)', fromAddress, fromName,
          JSON.stringify(toAddresses), parsed.text || null, bodyHtml, staged.length > 0 ? 1 : 0, parsed.date || new Date(),
          folder, folderName, uid, uidValidity, archive.rawStoragePath, archive.rawSha256, isRead ? 1 : 0]
      );
    }
    await insertStagedAttachments(connection, staged);
    await enqueueDeletion({ connection, userId: account.user_id, accountId, emailId, sourceFolder: folderName,
      imapUid: uid, imapUidValidity: uidValidity, rawStoragePath: archive.rawStoragePath });
    if (!existingEmail && !suppressNotifications) {
      await require('./notifications').enqueueMailNotification({ userId: account.user_id, emailId, suppressNotifications }, connection);
    }
    commitAttempted = true;
    await connection.commit();
    committed = true;
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection?.release();
    // A connection can fail after MySQL accepted COMMIT. Retain staged files
    // in that uncertain case so a committed message never loses its content.
    if (!committed && !commitAttempted) {
      await discardStagedAttachments(staged);
      if (archive?.rawStoragePath) await fs.rm(archive.rawStoragePath, { force: true }).catch(() => {});
    }
  }
  // Metadata now references the replacement. Cleanup failure leaves only an
  // orphan file, never a committed row referencing a deleted attachment.
  const { deleteStoredAttachmentFiles, isMailRawPathUnderRoot } = require('./mail');
  await deleteStoredAttachmentFiles(oldAttachments.map(row => row.storage_path));
  if (existingEmail?.raw_storage_path && existingEmail.raw_storage_path !== archive.rawStoragePath) {
    // The caller controls archive paths; avoid deleting a restored arbitrary path.
    if (isMailRawPathUnderRoot(existingEmail.raw_storage_path)) await fs.rm(existingEmail.raw_storage_path, { force: true }).catch(() => {});
  }
  return { emailId, isNew: !existingEmail };
}

module.exports = { persistImportedMessage };
