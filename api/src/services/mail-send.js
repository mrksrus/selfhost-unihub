const crypto = require('crypto');
const nodemailer = require('nodemailer');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { db } = require('../state');
const { decrypt } = require('../security/encryption');
const { resolveMailConnectionTarget } = require('../security/outbound-network');
const { isModuleEnabled } = require('./module-settings');
const { normalizeComposerAttachments } = require('./mail-attachments');
const { toBooleanFlag } = require('./mail-host-policy');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

async function sendEmail(accountId, { to, subject, body, isHtml = false, attachments = [] }) {
  try {
    const [accounts] = await db.execute(
      'SELECT * FROM mail_accounts WHERE id = ?',
      [accountId]
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
      tls: {
        rejectUnauthorized: !toBooleanFlag(account.allow_self_signed),
        servername: net.isIP(target.hostname) ? undefined : target.hostname, // Preserve hostname verification after DNS pinning
      },
      connectionTimeout: 60000, // Connection timeout: 60 seconds
      greetingTimeout: 30000, // Greeting timeout: 30 seconds
      socketTimeout: 60000, // Socket timeout: 60 seconds
    });
    const smtpAttachments = normalizeComposerAttachments(attachments).map(attachment => ({
      filename: attachment.filename, contentType: attachment.contentType, content: attachment.content,
    }));

    if (!await isModuleEnabled(account.user_id, 'mail')) throw new Error('Mail module is disabled');
    const info = await transporter.sendMail({
      from: `${account.display_name || account.email_address} <${account.email_address}>`,
      to,
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
    let sentCopyError = null;
    let sentCopyId = null;
    try {
      const emailId = crypto.randomUUID();
      const messageId = info.messageId || `<${Date.now()}-${emailId}@unihub.local>`;
      
      // Parse "to" addresses (can be comma-separated)
      const toAddresses = to.split(',').map(addr => {
        const match = addr.trim().match(/^(.+?)\s*<(.+?)>$/);
        return match ? match[2].trim() : addr.trim();
      });
      
      await db.execute(
        'INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, body_text, body_html, has_attachments, received_at, folder, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          emailId,
          account.user_id,
          accountId,
          messageId,
          subject || '(No subject)',
          account.email_address,
          account.display_name || null,
          JSON.stringify(toAddresses),
          isHtml ? null : body,
          isHtml ? body : null,
          smtpAttachments.length > 0 ? 1 : 0,
          new Date(),
          'sent',
          1,
        ]
      );

      if (smtpAttachments.length > 0) {
        const uploadsDir = path.join('/app/uploads/attachments', account.user_id);
        await mkdir(uploadsDir, { recursive: true });

        for (const attachment of smtpAttachments) {
          const attachmentId = crypto.randomUUID();
          const safeFilename = attachment.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const storagePath = path.join(uploadsDir, `${emailId}-${attachmentId}-${safeFilename}`);
          await writeFile(storagePath, attachment.content);

          await db.execute(
            'INSERT INTO email_attachments (id, email_id, user_id, filename, content_type, size_bytes, storage_path, content_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              attachmentId,
              emailId,
              account.user_id,
              attachment.filename,
              attachment.contentType || 'application/octet-stream',
              attachment.content.length,
              storagePath,
              null,
            ]
          );
        }
      }
      sentCopyState = 'confirmed';
      sentCopyId = emailId;
      console.log(`✓ Saved sent email to database: ${emailId}`);
    } catch (saveError) {
      sentCopyError = String(saveError?.message || saveError).slice(0, 240);
      console.error('Sent message delivered but local Sent copy failed:', sentCopyError);
    }

    return { success: true, sent: true, messageId: info.messageId,
      sent_copy_state: sentCopyState, sent_copy_id: sentCopyId,
      ...(sentCopyError ? { sent_copy_error: sentCopyError,
        message: 'Message sent, but the local Sent copy failed. Do not resend the message.' } : {}) };
  } catch (error) {
    console.error('Mail send failed for account', accountId, error?.code || error?.name || 'Error');
    throw error;
  }
}

module.exports = {
  sendEmail,
};
