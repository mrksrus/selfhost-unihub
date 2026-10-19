import type { RowDataPacket } from 'mysql2/promise';
import type { StoredFlag, StagedAttachment } from '../types';

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { db } from '../state';
import { decrypt } from '../security/encryption';
import { resolveMailConnectionTarget } from '../security/outbound-network';
import { isModuleEnabled } from './module-settings';
import { normalizeComposerAttachments, stageAttachments, insertStagedAttachments, discardStagedAttachments } from './mail-attachments';
import { finishReceipt, recordReceipt, withTransaction } from './mail-engine/repository';
import { log } from '../log';
import { accountTlsOptions, toBooleanFlag } from './mail-host-policy';
import { normalizeRecipients } from './mail-recipients';

interface SmtpAccount {
  id: string;
  user_id: string;
  is_active: StoredFlag;
  disconnected_at: Date | null;
  encrypted_password: string | null;
  smtp_host: string;
  smtp_port: number | string;
  username: string | null;
  email_address: string;
  display_name: string | null;
  allow_self_signed: StoredFlag;
  trusted_smtp_fingerprint256: string | null;
}

interface OutgoingEmail {
  /** Recipients as typed in the composer ("Name <a@example.com>, b@example.com") or a stored list. */
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  body: string;
  isHtml?: boolean;
  attachments?: unknown;
}

const storedRecipients = (recipients: string[]) => recipients.length ? JSON.stringify(recipients) : null;

// The account is looked up with its owner: a stored reference (a draft's
// account) cannot send from another user's account.
async function sendEmail({ userId, accountId }: { userId: string; accountId: string }, { subject, body, isHtml = false, attachments = [], ...recipients }: OutgoingEmail) {
  // SMTP and the Sent copy get the same parsed recipients, names kept, whichever route sent.
  const to = normalizeRecipients(recipients.to);
  const cc = normalizeRecipients(recipients.cc);
  const bcc = normalizeRecipients(recipients.bcc);
  try {
    const [accounts] = await db.execute<(RowDataPacket & SmtpAccount)[]>(
      'SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?',
      [accountId, userId]
    );
    if (!accounts[0]) throw new Error('Account not found');

    const account = accounts[0];
    if (!toBooleanFlag(account.is_active) || account.disconnected_at) throw new Error('Mail account is inactive or disconnected');
    const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
    if (!password) throw new Error('No password configured');

    const smtpPort = Number(account.smtp_port) || 587;
    const target = await resolveMailConnectionTarget(account.smtp_host);
    // Port 465 uses implicit SSL/TLS, port 587 uses STARTTLS
    const transporter = nodemailer.createTransport({
      host: target.address,
      port: smtpPort,
      secure: smtpPort === 465, // Implicit SSL/TLS for port 465
      requireTLS: smtpPort !== 465, // Require STARTTLS on explicit-TLS SMTP ports
      auth: {
        user: account.username || account.email_address,
        pass: password,
      },
      // Verify the account hostname after DNS pinning, or the confirmed certificate.
      tls: accountTlsOptions('smtp', account, target.hostname),
      connectionTimeout: 60000, // Connection timeout: 60 seconds
      greetingTimeout: 30000, // Greeting timeout: 30 seconds
      socketTimeout: 60000, // Socket timeout: 60 seconds
    });
    const smtpAttachments = normalizeComposerAttachments(attachments).map(attachment => ({
      filename: attachment.filename, contentType: attachment.contentType, content: attachment.content,
    }));

    if (!await isModuleEnabled(account.user_id, 'mail')) throw new Error('Mail module is disabled');
    const info = await transporter.sendMail({
      from: { name: account.display_name || '', address: account.email_address },
      to: to.length ? to : undefined,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject,
      text: isHtml ? undefined : body,
      html: isHtml ? body : undefined,
      attachments: smtpAttachments.length > 0 ? smtpAttachments : undefined,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    // Saving the copy is a separate effect from SMTP delivery. A failed local
    // copy must never become an overall send failure inviting a second SMTP send.
    let sentCopyState = 'failed';
    let sentCopyError: string | null = null;
    let sentCopyId: string | null = null;
    // Files are staged first and the rows commit together, like drafts and
    // imports: a Sent copy never claims attachments whose rows do not exist.
    let staged: StagedAttachment[] = [];
    let commitAttempted = false;
    try {
      const emailId = crypto.randomUUID();
      const messageId = info.messageId || `<${Date.now()}-${emailId}@unihub.local>`;
      staged = await stageAttachments({ userId: account.user_id, emailId, attachments: smtpAttachments });
      await withTransaction(async connection => {
        commitAttempted = false;
        // Bcc stays in the sender's own copy only; SMTP never puts it in the message headers.
        await connection.execute(
          'INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, cc_addresses, bcc_addresses, body_text, body_html, has_attachments, received_at, folder, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            emailId,
            account.user_id,
            accountId,
            messageId,
            subject || '(No subject)',
            account.email_address,
            account.display_name || null,
            JSON.stringify(to),
            storedRecipients(cc),
            storedRecipients(bcc),
            isHtml ? null : body,
            isHtml ? body : null,
            staged.length > 0 ? 1 : 0,
            new Date(),
            'sent',
            1,
          ]
        );
        await insertStagedAttachments(connection, staged);
        commitAttempted = true;
      });
      sentCopyState = 'confirmed';
      sentCopyId = emailId;
      console.log(`✓ Saved sent email to database: ${emailId}`);
    } catch (saveError) {
      // Keep the files if COMMIT may have reached the server: their rows may exist.
      if (!commitAttempted) await discardStagedAttachments(staged);
      sentCopyError = String((saveError as Error)?.message || saveError).slice(0, 240);
      console.error('Sent message delivered but local Sent copy failed:', sentCopyError);
    }

    return { success: true, sent: true, messageId: info.messageId,
      sent_copy_state: sentCopyState, sent_copy_id: sentCopyId,
      ...(sentCopyError ? { sent_copy_error: sentCopyError,
        message: 'Message sent, but the local Sent copy failed. Do not resend the message.' } : {}) };
  } catch (error) {
    console.error('Mail send failed for account', accountId, (error as NodeJS.ErrnoException)?.code || (error as Error)?.name || 'Error');
    throw error;
  }
}

const SEND_PENDING = { send_pending: true };

/**
 * Sends at most once per Idempotency-Key. A lost response or a second click
 * repeats the request; the key is claimed (in its own transaction) before
 * SMTP and holds the result after it, so a repeat gets that result, or
 * SEND_IN_PROGRESS while the first send runs or when it ended without a
 * recorded outcome, never a second message. A send that failed (threw, or
 * returned an `error`) releases the key, so the same message can be sent again;
 * `send` must not fail once the message is out.
 */
async function sendOnce<T extends Record<string, unknown>>({ userId, clientKey, request }: { userId: string; clientKey?: string; request: unknown }, send: () => Promise<T>): Promise<T> {
  if (!clientKey) return send();
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ kind: 'send', request })).digest('hex');
  let claim;
  try {
    claim = await withTransaction(connection => recordReceipt({ userId, clientKey, requestHash, response: SEND_PENDING }, connection));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'IDEMPOTENCY_KEY_REUSED') {
      throw Object.assign(new Error('This message was already sent with different content. Check Sent before sending again.'), { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    throw error;
  }
  if (claim.replayed) {
    if ((claim.response as Record<string, unknown>).send_pending) {
      throw Object.assign(new Error('This message is already being sent, or its sending was interrupted. Check Sent before sending it again.'), { status: 409, code: 'SEND_IN_PROGRESS' });
    }
    return claim.response as T;
  }
  const release = () => db.execute('DELETE FROM mail_command_receipts WHERE user_id = ? AND client_key = ? AND request_hash = ?', [userId, clientKey, requestHash])
    .catch((cleanup: unknown) => log.warn('mail', 'could not release the key of a failed send', { userId }, cleanup));
  let result: T;
  try {
    result = await send();
  } catch (error) {
    await release();
    throw error;
  }
  if (result.error) { await release(); return result; }
  // The message is out; a failure to record that leaves the key pending, which refuses a resend.
  await finishReceipt({ userId, clientKey, requestHash, response: result })
    .catch((error: unknown) => log.warn('mail', 'could not record a sent message', { userId }, error));
  return result;
}

export {
  sendEmail,
  sendOnce,
};
