import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ComposerAttachment, StagedAttachment } from '../types';

import crypto from 'crypto';
import { promises as fs } from 'node:fs';
import {
  stageAttachments,
  discardStagedAttachments,
  insertStagedAttachments,
  rewriteInlineAttachments,
} from './mail-attachments';
import { adoptReplies, resolveThreadKey, storedReferences, threadHeaders } from './mail-threading';

interface RawArchive {
  rawStoragePath?: string;
  rawSha256: string;
  rawBytes?: number;
  rawFormat?: string;
  rawVerified?: boolean;
}
interface ImportedMessage {
  db: Pick<Pool, 'getConnection'>;
  account: { user_id: string; sync_mode?: string };
  accountId: string;
  folderName: string;
  uid: number;
  uidValidity: string | number | bigint;
  existingEmail?: { id: string; raw_storage_path?: string | null } | null;
  messageId: string | null;
  fullEmail: Buffer | string;
  parsed: { attachments?: ComposerAttachment[]; html?: string | false; subject?: string; date?: Date; text?: string;
    /** mailparser's In-Reply-To and References (untrusted; services/mail-threading.ts keeps the well-formed ids). */
    inReplyTo?: string; references?: string | string[] };
  fromAddress: string;
  fromName: string | null;
  toAddresses: unknown;
  ccAddresses?: string[];
  folder: string;
  isRead: boolean;
  archiveRaw: (input: { userId: string; emailId: string; messageId: string | null; rawEmail: Buffer | string }) => Promise<RawArchive>;
  enqueueDeletion: (input: { connection: PoolConnection; userId: string; accountId: string; emailId: string; sourceFolder: string; imapUid: number; imapUidValidity: string | number | bigint; rawStoragePath: string; rawSha256: string; rawBytes?: number; rawFormat?: string; rawVerified: true }) => Promise<unknown>;
  validateOccurrence?: ((connection: PoolConnection, emailId: string) => Promise<unknown>) | null;
}

// Column lengths of the header-derived values (docker/mariadb/schema.sql). In
// MariaDB's strict mode an overlong value is refused, and a refused message
// would be downloaded and refused again by every body job of its mailbox. The
// raw .eml keeps the originals, so cutting is safe. Storage names are bounded
// separately in stageAttachments.
const COLUMN_LENGTHS = Object.freeze({ messageId: 500, fromAddress: 255, fromName: 255, filename: 255, contentType: 100, contentId: 255 });
// varchar(n) counts characters; slice code points so a surrogate pair is not split.
const bound = <T extends string | null | undefined>(value: T, max: number): T | string =>
  value == null ? value : Array.from(value).slice(0, max).join('');
function normalizeParsedHeaders({ messageId, fromAddress, fromName, attachments }:
  { messageId: string | null; fromAddress: string; fromName: string | null; attachments: readonly ComposerAttachment[] }) {
  return {
    messageId: bound(messageId, COLUMN_LENGTHS.messageId),
    fromAddress: bound(fromAddress, COLUMN_LENGTHS.fromAddress),
    fromName: bound(fromName, COLUMN_LENGTHS.fromName),
    attachments: attachments.map(attachment => ({ ...attachment,
      filename: bound(attachment.filename, COLUMN_LENGTHS.filename),
      contentType: bound(attachment.contentType, COLUMN_LENGTHS.contentType),
      contentId: bound(attachment.contentId, COLUMN_LENGTHS.contentId),
      cid: bound(attachment.cid, COLUMN_LENGTHS.contentId) })),
  };
}

// Persist one complete provider message. Existing local read/star/folder choices
// survive repair; files are staged before a short metadata transaction. The
// notification for a new message is held by the engine's discovery scan and
// released here, once the sender and subject are known.
async function persistImportedMessage({ db, account, accountId, folderName, uid, uidValidity,
  existingEmail, messageId, fullEmail, parsed, fromAddress, fromName, toAddresses, ccAddresses = [],
  folder, isRead, archiveRaw, enqueueDeletion, validateOccurrence = null }: ImportedMessage) {
  const emailId = existingEmail?.id || crypto.randomUUID();
  const { messageId: storedMessageId, fromAddress: storedFromAddress, fromName: storedFromName, attachments } =
    normalizeParsedHeaders({ messageId, fromAddress, fromName, attachments: parsed.attachments || [] });
  const storedCc = ccAddresses.length ? JSON.stringify(ccAddresses) : null;
  const threading = threadHeaders({ inReplyTo: parsed.inReplyTo, references: parsed.references });
  const subject = parsed.subject || '(No subject)';
  const receivedAt = parsed.date || new Date();
  let staged: StagedAttachment[] = [];
  let archive: RawArchive | undefined;
  let connection: PoolConnection | undefined;
  let committed = false;
  let commitAttempted = false;
  let oldAttachments: (RowDataPacket & { id: string; storage_path: string })[] = [];
  try {
    archive = await archiveRaw({ userId: account.user_id, emailId, messageId, rawEmail: fullEmail });
    if (!archive!.rawStoragePath) throw new Error('Raw message archive was not saved');
    const rawBuffer = Buffer.isBuffer(fullEmail) ? fullEmail : Buffer.from(String(fullEmail), 'utf8');
    const exact = Buffer.isBuffer(fullEmail) && archive.rawFormat === 'exact_octets'
      && archive.rawVerified === true && archive.rawBytes === rawBuffer.length
      && archive.rawSha256 === crypto.createHash('sha256').update(rawBuffer).digest('hex');
    if (Buffer.isBuffer(fullEmail) && !exact) throw new Error('Raw archive integrity could not be verified');
    staged = await stageAttachments({ userId: account.user_id, emailId, attachments });
    const bodyHtml = rewriteInlineAttachments(parsed.html, staged);
    connection = await db.getConnection();
    await connection.beginTransaction();
    if (validateOccurrence) await validateOccurrence(connection, emailId);
    const threadKey = await resolveThreadKey(connection, { userId: account.user_id, emailId, messageId: storedMessageId,
      inReplyTo: threading.inReplyTo, references: threading.references, subject, receivedAt,
      participants: [storedFromAddress, ...(Array.isArray(toAddresses) ? toAddresses : []), ...ccAddresses].filter((value): value is string => typeof value === 'string') });
    if (existingEmail) {
      [oldAttachments] = await connection.execute<(RowDataPacket & { id: string; storage_path: string })[]>('SELECT id, storage_path FROM email_attachments WHERE email_id = ? AND user_id = ?', [emailId, account.user_id]);
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE emails SET message_id = ?, subject = ?, received_at = ?, from_address = ?, from_name = ?, to_addresses = ?, cc_addresses = ?,
          body_text = ?, body_html = ?, has_attachments = ?, source_folder = COALESCE(source_folder, ?),
          imap_uid = COALESCE(imap_uid, ?), imap_uidvalidity = COALESCE(imap_uidvalidity, ?),
          raw_storage_path = ?, raw_sha256 = ?, raw_bytes = ?, raw_format = ?, raw_verified = ?,
          content_state = 'complete', import_complete = TRUE, in_reply_to = ?, references_header = ?, thread_key = ?
         WHERE id = ? AND user_id = ? AND mail_account_id = ?`,
        [storedMessageId, subject, receivedAt,
          storedFromAddress, storedFromName, JSON.stringify(toAddresses), storedCc, parsed.text || null, bodyHtml,
          staged.length > 0 ? 1 : 0, folderName, uid, uidValidity, archive.rawStoragePath, archive.rawSha256,
          archive.rawBytes ?? null, exact ? 'exact_octets' : 'legacy_normalized', exact ? 1 : 0,
          threading.inReplyTo, storedReferences(threading.references), threadKey,
          emailId, account.user_id, accountId]
      );
      if (updated.affectedRows !== 1) throw new Error('Archived item changed before body commit');
      await connection.execute('DELETE FROM email_attachments WHERE email_id = ? AND user_id = ?', [emailId, account.user_id]);
      await (require('./notifications') as typeof import('./notifications')).releaseMailNotification({ userId: account.user_id, emailId }, connection);
    } else {
      await connection.execute(
        `INSERT INTO emails
          (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, cc_addresses, body_text, body_html,
           has_attachments, received_at, folder, source_folder, imap_uid, imap_uidvalidity, raw_storage_path, raw_sha256,
           raw_bytes, raw_format, raw_verified, content_state, is_read, import_complete, in_reply_to, references_header, thread_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, TRUE, ?, ?, ?)`,
        [emailId, account.user_id, accountId, storedMessageId, subject, storedFromAddress, storedFromName,
          JSON.stringify(toAddresses), storedCc, parsed.text || null, bodyHtml, staged.length > 0 ? 1 : 0, receivedAt,
          folder, folderName, uid, uidValidity, archive.rawStoragePath, archive.rawSha256, archive.rawBytes ?? null,
          exact ? 'exact_octets' : 'legacy_normalized', exact ? 1 : 0, isRead ? 1 : 0,
          threading.inReplyTo, storedReferences(threading.references), threadKey]
      );
    }
    await adoptReplies(connection, { userId: account.user_id, messageId: storedMessageId, threadKey });
    await insertStagedAttachments(connection, staged);
    if (exact && account.sync_mode === 'download') {
      await enqueueDeletion({ connection, userId: account.user_id, accountId, emailId, sourceFolder: folderName,
        imapUid: uid, imapUidValidity: uidValidity, rawStoragePath: archive.rawStoragePath,
        rawSha256: archive.rawSha256, rawBytes: archive.rawBytes, rawFormat: archive.rawFormat, rawVerified: true });
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
  const { deleteStoredAttachmentFiles, isMailRawPathUnderRoot } = require('./mail') as typeof import('./mail');
  await deleteStoredAttachmentFiles(oldAttachments.map(row => row.storage_path));
  if (existingEmail?.raw_storage_path && existingEmail.raw_storage_path !== archive!.rawStoragePath) {
    // The caller controls archive paths; avoid deleting a restored arbitrary path.
    if (isMailRawPathUnderRoot(existingEmail.raw_storage_path)) await fs.rm(existingEmail.raw_storage_path, { force: true }).catch(() => {});
  }
  return { emailId, isNew: !existingEmail };
}

export { COLUMN_LENGTHS, normalizeParsedHeaders, persistImportedMessage };
