// UniHub API Server
// Backend API for self-hosted deployments

const http = require('http');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const readFile = promisify(fs.readFile);

// Debug logging helper - write to container filesystem and console
const DEBUG_LOG_PATH = '/app/debug.log';
const debugLog = (location, message, data, hypothesisId, runId = 'run1') => {
  try {
    const logEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      location,
      message,
      data,
      runId,
      hypothesisId,
    };
    const logLine = JSON.stringify(logEntry);
    // Write to file
    fs.appendFileSync(DEBUG_LOG_PATH, logLine + '\n');
    // Also log to console for Docker logs visibility
    console.log(`[DEBUG] ${location}: ${message}`, JSON.stringify(data));
  } catch (e) {
    // Fallback to console only if file write fails
    console.log(`[DEBUG] ${location}: ${message}`, JSON.stringify(data), `[LOG ERROR: ${e.message}]`);
  }
};

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unihub-encryption-key-for-email-credentials-change-me';

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────
function deriveKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const key = deriveKey(ENCRYPTION_KEY);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decrypt(encryptedText) {
  try {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const key = deriveKey(ENCRYPTION_KEY);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

// ── Mail sync and send functions ──────────────────────────────────

// Helper function to sync a specific folder
async function syncMailFolder(connection, account, accountId, folderName, dbFolderName, lastSyncedAt = null) {
  try {
    console.log(`[SYNC] Opening ${folderName}...`);
    try {
      await connection.openBox(folderName);
    } catch (openError) {
      // Folder doesn't exist or can't be opened - return early without affecting connection state
      console.log(`[SYNC] Could not open folder ${folderName}: ${openError.message}`);
      return { newEmails: 0, processed: 0, failed: 0, total: 0, error: openError.message };
    }
    
    // Optimize: Only fetch emails since last sync if we have a last_synced_at timestamp
    let searchCriteria = ['ALL'];
    if (lastSyncedAt) {
      // Use SINCE to only get emails since last sync (subtract 1 day for safety margin)
      const sinceDate = new Date(lastSyncedAt);
      sinceDate.setDate(sinceDate.getDate() - 1); // 1 day margin for timezone/server differences
      const sinceDateStr = sinceDate.toISOString().split('T')[0].replace(/-/g, '-');
      searchCriteria = ['SINCE', sinceDateStr];
      console.log(`[SYNC] Using optimized search: emails since ${sinceDateStr} (last sync: ${lastSyncedAt})`);
    } else {
      console.log(`[SYNC] First sync - fetching last 500 emails`);
    }
    
    // Search for emails (either all or since last sync)
    const searchResults = await connection.search(searchCriteria, {});
    const allUids = searchResults.map(msg => msg.attributes?.uid).filter(uid => typeof uid === 'number');
    console.log(`[SYNC] Found ${allUids.length} messages in ${folderName}${lastSyncedAt ? ' since last sync' : ''}`);
    
    if (allUids.length === 0) {
      return { newEmails: 0, processed: 0, failed: 0, total: 0 };
    }
    
    // If no lastSyncedAt, limit to last 500 for first sync. Otherwise process all found UIDs (should be new ones)
    const uidsToProcess = lastSyncedAt ? allUids : allUids.slice(-500);
    console.log(`[SYNC] Will fetch ${uidsToProcess.length} emails from ${folderName}${lastSyncedAt ? ' (new since last sync)' : ' (last 500 for initial sync)'}...`);
    
    if (uidsToProcess.length === 0) {
      return { newEmails: 0, processed: 0, failed: 0, total: allUids.length };
    }
    
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT'],
      markSeen: false,
      struct: true,
    };
    
    let newEmailsCount = 0;
    let processedCount = 0;
    let failedCount = 0;
    const uploadsDir = '/app/uploads/attachments';
    
    // Sequentially download each email individually using the actual UIDs
    for (let i = 0; i < uidsToProcess.length; i++) {
      const uid = uidsToProcess[i];
      processedCount++;
      
      console.log(`[SYNC] Downloading email ${processedCount}/${uidsToProcess.length} (UID: ${uid})...`);
      
      try {
        // Ensure uid is a number, not an object
        if (typeof uid !== 'number') {
          console.log(`[SYNC] [${processedCount}/${uidsToProcess.length}] Invalid UID type: ${typeof uid}, skipping`);
          failedCount++;
          continue;
        }
        
        // Fetch single email by UID using search with UID criteria (this is the working method)
        const messageResults = await connection.search([['UID', uid]], fetchOptions);
        
        if (!messageResults || messageResults.length === 0) {
          console.log(`[SYNC] [${processedCount}/${uidsToProcess.length}] UID ${uid}: Not found, skipping`);
          continue;
        }
        
        const item = messageResults[0]; // Should only be one result
        console.log(`[SYNC] [${processedCount}/${uidsToProcess.length}] ✓ Downloaded UID ${uid}`);
        const headerPart = item.parts.find(p => p.which === 'HEADER');
        const textPart = item.parts.find(p => p.which === 'TEXT');
        
        let headerContent = '';
        let bodyContent = '';
        
        if (headerPart && headerPart.body) {
          if (typeof headerPart.body === 'string') {
            headerContent = headerPart.body;
          } else if (typeof headerPart.body === 'object') {
            const headerLines = [];
            for (const [key, value] of Object.entries(headerPart.body)) {
              if (Array.isArray(value)) {
                value.forEach(v => { if (v) headerLines.push(`${key}: ${v}`); });
              } else if (value) {
                headerLines.push(`${key}: ${value}`);
              }
            }
            headerContent = headerLines.join('\r\n');
          }
        }
        
        if (textPart && textPart.body) {
          bodyContent = typeof textPart.body === 'string' ? textPart.body : String(textPart.body);
        }
        
        let fullEmail = '';
        if (headerContent) {
          fullEmail = headerContent + (bodyContent ? '\r\n\r\n' + bodyContent : '');
        } else if (bodyContent) {
          fullEmail = bodyContent;
        }
        
        if (!fullEmail || fullEmail.trim().length === 0) {
          if (processedCount <= 5) {
            console.log(`[SYNC] Skipping empty email (UID: ${uid})`);
          }
          continue;
        }
        
        const parsed = await simpleParser(fullEmail);
        const messageId = parsed.messageId || `${accountId}-${uid}`;
        
        // Check if already synced (match old working version - check without folder since we only sync inbox)
        const [existing] = await db.execute(
          'SELECT id FROM emails WHERE message_id = ? AND mail_account_id = ?',
          [messageId, accountId]
        );
        if (existing.length > 0) {
          if (processedCount <= 5) {
            console.log(`[SYNC] Email already exists (UID: ${uid}, messageId: ${messageId}), skipping`);
          }
          continue;
        }
        
        // Extract from address and name
        let fromAddress = 'unknown';
        let fromName = null;
        if (parsed.from) {
          if (parsed.from.value && parsed.from.value.length > 0) {
            fromAddress = parsed.from.value[0].address || parsed.from.text || 'unknown';
            fromName = parsed.from.value[0].name || null;
          } else if (parsed.from.text) {
            const textMatch = parsed.from.text.match(/^(.+?)\s*<(.+?)>$/);
            if (textMatch) {
              fromName = textMatch[1].trim();
              fromAddress = textMatch[2].trim();
            } else {
              fromAddress = parsed.from.text;
            }
          }
        }
        
        // Extract to addresses
        const toAddresses = [];
        if (parsed.to && parsed.to.value) {
          toAddresses.push(...parsed.to.value.map(t => t.address).filter(Boolean));
        }
        
        // Process attachments
        const hasAttachments = parsed.attachments && parsed.attachments.length > 0;
        let attachmentCount = 0;
        let processedHtml = parsed.html || null;
        
        if (hasAttachments) {
          try {
            await mkdir(uploadsDir, { recursive: true });
          } catch (err) {
            if (err.code !== 'EEXIST') {
              console.error(`[SYNC] Failed to create uploads directory:`, err.message);
            }
          }
        }
        
        const emailId = crypto.randomUUID();
        try {
          await db.execute(
            'INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, body_text, body_html, has_attachments, received_at, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              emailId,
              account.user_id,
              accountId,
              messageId,
              parsed.subject || '(No subject)',
              fromAddress,
              fromName,
              JSON.stringify(toAddresses),
              parsed.text || null,
              processedHtml,
              hasAttachments ? 1 : 0,
              parsed.date || new Date(),
              dbFolderName,
            ]
          );
        } catch (dbError) {
          console.error(`[SYNC] Database error saving email UID ${uid}:`, dbError.message);
          console.error(`[SYNC] Error details:`, dbError.code, dbError.sqlState);
          throw dbError; // Re-throw to be caught by outer catch
        }
        
        // Process attachments
        if (hasAttachments) {
          for (const attachment of parsed.attachments) {
            try {
              const attachmentId = crypto.randomUUID();
              const filename = attachment.filename || attachment.cid || `attachment-${attachmentId}`;
              const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
              const storagePath = path.join(uploadsDir, `${emailId}-${attachmentId}-${safeFilename}`);
              const isInline = !!(attachment.contentId || attachment.cid);
              const cid = attachment.contentId || attachment.cid;
              
              const content = attachment.content;
              let sizeBytes = 0;
              
              if (Buffer.isBuffer(content)) {
                await writeFile(storagePath, content);
                sizeBytes = content.length;
              } else if (typeof content === 'string') {
                const buffer = Buffer.from(content, 'utf8');
                await writeFile(storagePath, buffer);
                sizeBytes = buffer.length;
              } else if (content && typeof content.pipe === 'function') {
                const chunks = [];
                for await (const chunk of content) {
                  chunks.push(chunk);
                }
                const buffer = Buffer.concat(chunks);
                await writeFile(storagePath, buffer);
                sizeBytes = buffer.length;
              } else {
                const buffer = Buffer.from(String(content));
                await writeFile(storagePath, buffer);
                sizeBytes = buffer.length;
              }
              
              await db.execute(
                'INSERT INTO email_attachments (id, email_id, filename, content_type, size_bytes, storage_path, content_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [
                  attachmentId,
                  emailId,
                  filename,
                  attachment.contentType || attachment.contentDisposition?.type || 'application/octet-stream',
                  attachment.size || sizeBytes,
                  storagePath,
                  cid || null,
                ]
              );
              
              if (isInline && cid && processedHtml) {
                const attachmentUrl = `/api/mail/attachments/${attachmentId}`;
                const escapedCid = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const patterns = [
                  new RegExp(`cid:${escapedCid}`, 'gi'),
                  new RegExp(`"cid:${escapedCid}"`, 'gi'),
                  new RegExp(`'cid:${escapedCid}'`, 'gi'),
                ];
                patterns.forEach(pattern => {
                  processedHtml = processedHtml.replace(pattern, attachmentUrl);
                });
              }
              
              attachmentCount++;
            } catch (attachError) {
              console.error(`[SYNC] Failed to save attachment:`, attachError.message);
            }
          }
          
          if (processedHtml !== (parsed.html || null)) {
            await db.execute('UPDATE emails SET body_html = ? WHERE id = ?', [processedHtml, emailId]);
          }
        }
        
        newEmailsCount++;
        const attachMsg = attachmentCount > 0 ? ` (${attachmentCount} attachment${attachmentCount > 1 ? 's' : ''})` : '';
        console.log(`[SYNC] [${processedCount}/${uidsToProcess.length}] ✓ Stored email: "${parsed.subject || '(No subject)'}" from ${fromAddress}${attachMsg} (${newEmailsCount} new so far)`);
      } catch (emailError) {
        failedCount++;
        // Log error for every email (since we're downloading individually)
        console.log(`[SYNC] [${processedCount}/${uidsToProcess.length}] ✗ Failed to process UID ${uid}:`, emailError.message);
        if (emailError.stack && failedCount <= 5) {
          console.error(`[SYNC] Stack trace:`, emailError.stack.substring(0, 300));
        }
        continue;
      }
    }
    
    console.log(`[SYNC] Completed: ${newEmailsCount} new emails stored, ${failedCount} failed, ${processedCount} processed`);
    return { newEmails: newEmailsCount, processed: processedCount, failed: failedCount, total: allUids.length };
  } catch (error) {
    console.error(`[SYNC] Error syncing ${folderName}:`, error.message);
    return { newEmails: 0, processed: 0, failed: 0, total: 0, error: error.message };
  }
}

// Test IMAP connection and authentication without syncing
async function testImapConnection(account) {
  let connection = null;
  try {
    const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
    if (!password) {
      return { success: false, error: 'No password configured' };
    }
    
    const imapPort = account.imap_port || 993;
    const config = {
      imap: {
        user: account.username || account.email_address,
        password,
        host: account.imap_host,
        port: imapPort,
        tls: true,
        tlsOptions: { 
          rejectUnauthorized: false,
          servername: account.imap_host,
        },
        connTimeout: 60000,
        authTimeout: 30000,
        keepalive: true,
      },
    };
    
    connection = await imaps.connect(config);
    connection.on('error', (err) => {
      console.error('[ACCOUNT] IMAP connection error (handled):', err.message);
    });
    await connection.openBox('INBOX');
    
    // Connection successful
    if (connection) connection.end();
    return { success: true };
  } catch (error) {
    if (connection) {
      try { connection.end(); } catch (e) { /* ignore */ }
    }
    const errorMsg = error.message || String(error);
    
    let friendlyError = errorMsg;
    if (errorMsg.includes('AUTHENTICATIONFAILED') || errorMsg.includes('Invalid credentials')) {
      friendlyError = 'Authentication failed. Check your username and password (use App Password for Gmail/Yahoo).';
    } else if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timeout')) {
      friendlyError = 'Connection timeout. Check server address and port.';
    } else if (errorMsg.includes('ENOTFOUND')) {
      friendlyError = 'Server not found. Check the IMAP host address.';
    } else if (errorMsg.includes('ECONNREFUSED')) {
      friendlyError = 'Connection refused. Check the IMAP port and server settings.';
    } else if (errorMsg.includes('Connection ended unexpectedly') || errorMsg.includes('ECONNRESET')) {
      friendlyError = 'Connection closed by server. Check your credentials and server settings.';
    }
    
    return { success: false, error: friendlyError, details: errorMsg };
  }
}

async function syncMailAccount(accountId) {
  let connection = null;
  try {
    debugLog('server.js:50', 'syncMailAccount START', { accountId }, 'H1');
    const [accounts] = await db.execute('SELECT * FROM mail_accounts WHERE id = ?', [accountId]);
    if (!accounts[0]) {
      return { success: false, error: `Account ${accountId} not found in database` };
    }
    
    const account = accounts[0];
    const lastSyncedAt = account.last_synced_at;
    const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
    if (!password) {
      return { success: false, error: 'No password configured for this account' };
    }
    
    const imapPort = account.imap_port || 993;
    const config = {
      imap: {
        user: account.username || account.email_address,
        password,
        host: account.imap_host,
        port: imapPort,
        tls: true,
        tlsOptions: { 
          rejectUnauthorized: false,
          servername: account.imap_host,
        },
        connTimeout: 60000,
        authTimeout: 30000,
        keepalive: true,
      },
    };
    
    console.log(`[SYNC] Connecting to ${account.email_address}...`);
    connection = await imaps.connect(config);
    connection.on('error', (err) => {
      console.error('[SYNC] IMAP connection error (handled, sync may fail):', err.message);
    });
    
    // Sync INBOX only (pass lastSyncedAt to optimize sync)
    const inboxResult = await syncMailFolder(connection, account, accountId, 'INBOX', 'inbox', lastSyncedAt);
    
    // Clean up connection
    if (connection) {
      try {
        connection.end();
      } catch (endError) {
        console.log(`[SYNC] Error closing connection: ${endError.message}`);
      }
    }
    
    // Update last synced
    await db.execute(
      'UPDATE mail_accounts SET last_synced_at = UTC_TIMESTAMP() WHERE id = ?',
      [accountId]
    );
    
    const resultMsg = `Synced ${account.email_address}: ${inboxResult.newEmails} new emails (${inboxResult.total} in INBOX, ${inboxResult.processed} processed, ${inboxResult.failed} failed)`;
    console.log(`[SYNC] ✓ ${resultMsg}`);
    
    // Log detailed summary for debugging
    if (inboxResult.newEmails === 0 && inboxResult.processed > 0) {
      console.warn(`[SYNC] ⚠ WARNING: Processed ${inboxResult.processed} emails but saved 0. This might indicate:`);
      console.warn(`[SYNC]   - All emails already exist in database (duplicate detection)`);
      console.warn(`[SYNC]   - Emails are empty or invalid`);
      console.warn(`[SYNC]   - Database insert errors (check logs above)`);
    }
    
    return { success: true, newEmails: inboxResult.newEmails, totalFound: inboxResult.total, message: resultMsg };
  } catch (error) {
    if (connection) {
      try { connection.end(); } catch (e) { /* ignore */ }
    }
    const errorMsg = error.message || String(error);
    debugLog('server.js:146', 'syncMailAccount ERROR', { accountId, errorMessage: errorMsg, errorName: error.name }, 'H1,H2,H3,H4');
    console.error(`[SYNC] ✗ Error syncing account ${accountId}:`, errorMsg);
    
    let friendlyError = errorMsg;
    if (errorMsg.includes('AUTHENTICATIONFAILED') || errorMsg.includes('Invalid credentials')) {
      friendlyError = 'Authentication failed. Check your username and password (use App Password for Gmail/Yahoo).';
    } else if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timeout')) {
      friendlyError = 'Connection timeout. Check server address and port, or try again later.';
    } else if (errorMsg.includes('ENOTFOUND')) {
      friendlyError = 'Server not found. Check the IMAP host address.';
    } else if (errorMsg.includes('ECONNREFUSED')) {
      friendlyError = 'Connection refused. Check the IMAP port and server settings.';
    } else if (errorMsg.includes('Connection ended unexpectedly') || errorMsg.includes('ECONNRESET')) {
      friendlyError = 'Connection closed by server. This may indicate:\n1. Gmail requires an App Password (not your regular password)\n2. "Less secure app access" needs to be enabled\n3. Network/firewall blocking port 993\n4. Account security settings blocking the connection';
    }
    
    return { success: false, error: friendlyError, details: errorMsg };
  }
}

async function sendEmail(accountId, { to, subject, body, isHtml = false }) {
  try {
    // #region agent log
    debugLog('server.js:169', 'sendEmail START', { accountId, to, subjectLength: subject?.length || 0, bodyLength: body?.length || 0, isHtml }, 'H5');
    // #endregion
    const [accounts] = await db.execute(
      'SELECT * FROM mail_accounts WHERE id = ?',
      [accountId]
    );
    if (!accounts[0]) throw new Error('Account not found');

    const account = accounts[0];
    // #region agent log
    debugLog('server.js:177', 'Account loaded for send', { email: account.email_address, smtpHost: account.smtp_host, smtpPort: account.smtp_port, hasPassword: !!account.encrypted_password }, 'H5');
    // #endregion
    const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
    if (!password) throw new Error('No password configured');

    const smtpPort = account.smtp_port || 587;
    // Port 465 uses implicit SSL/TLS, port 587 uses STARTTLS
    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: smtpPort,
      secure: smtpPort === 465, // Implicit SSL/TLS for port 465
      requireTLS: smtpPort === 587, // Require STARTTLS for port 587
      auth: {
        user: account.username || account.email_address,
        pass: password,
      },
      tls: {
        rejectUnauthorized: false, // Allow self-signed certificates
        servername: account.smtp_host, // SNI support for proper TLS handshake
      },
      connectionTimeout: 60000, // Connection timeout: 60 seconds
      greetingTimeout: 30000, // Greeting timeout: 30 seconds
      socketTimeout: 60000, // Socket timeout: 60 seconds
    });
    // #region agent log
    debugLog('server.js:189', 'Before SMTP sendMail', { smtpHost: account.smtp_host, smtpPort: account.smtp_port, from: account.email_address, to }, 'H5');
    // #endregion

    const info = await transporter.sendMail({
      from: `${account.display_name || account.email_address} <${account.email_address}>`,
      to,
      subject,
      text: isHtml ? undefined : body,
      html: isHtml ? body : undefined,
    });
    // #region agent log
    debugLog('server.js:199', 'SMTP sendMail success', { messageId: info.messageId }, 'H5');
    // #endregion

    // Save sent email to database
    try {
      const emailId = crypto.randomUUID();
      const messageId = info.messageId || `<${Date.now()}-${emailId}@unihub.local>`;
      
      // Parse "to" addresses (can be comma-separated)
      const toAddresses = to.split(',').map(addr => {
        const match = addr.trim().match(/^(.+?)\s*<(.+?)>$/);
        return match ? match[2].trim() : addr.trim();
      });
      
      await db.execute(
        'INSERT INTO emails (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, body_text, body_html, has_attachments, received_at, folder) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
          0, // has_attachments
          new Date(),
          'sent',
        ]
      );
      console.log(`✓ Saved sent email to database: ${emailId}`);
    } catch (saveError) {
      // Log error but don't fail the send operation
      console.error(`⚠ Failed to save sent email to database:`, saveError.message);
    }

    console.log(`✓ Sent email from ${account.email_address}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    // #region agent log
    debugLog('server.js:201', 'sendEmail ERROR', { accountId, errorMessage: error.message, errorStack: error.stack?.substring(0, 200), errorName: error.name }, 'H5');
    // #endregion
    console.error(`Error sending email from account ${accountId}:`, error.message);
    throw error;
  }
}

// Database connection pool
let db;

function getDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const host = process.env.MYSQL_HOST;
  const port = process.env.MYSQL_PORT || '3306';
  const database = process.env.MYSQL_DATABASE;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;

  if (!host || !database || !user || !password) {
    return null;
  }

  return `mysql://${user}:${password}@${host}:${port}/${database}`;
}

async function initDatabase() {
  if (!JWT_SECRET) {
    console.error('✗ Missing JWT_SECRET. Set it in docker-compose.yml before starting.');
    process.exit(1);
  }
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    console.error('✗ Missing database configuration. Set DATABASE_URL or MYSQL_* in docker-compose.yml.');
    process.exit(1);
  }

  const dbUrl = new URL(databaseUrl);
  const poolConfig = {
    // Connection options (inherited by pool)
    host: dbUrl.hostname,
    port: parseInt(dbUrl.port, 10) || 3306,
    user: decodeURIComponent(dbUrl.username),
    password: decodeURIComponent(dbUrl.password),
    database: dbUrl.pathname.slice(1),
    timezone: '+00:00', // interpret DATETIME as UTC (we store UTC)
    
    // Pool-specific options only
    waitForConnections: true,
    connectionLimit: 50, // Maximum number of connections in the pool
    queueLimit: 0, // Unlimited queue (0 = no limit)
    idleTimeout: 300000, // 5 minutes - close idle connections
    maxIdle: 5, // Keep max 5 idle connections
  };

  // Retry connection — MySQL may still be starting
  // Reduced retry time since MySQL startup is optimized
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      db = mysql.createPool(poolConfig);
      await db.execute('SELECT 1');
      console.log('✓ Database connected');
      break;
    } catch (error) {
      // Clean up the failed pool before retrying
      if (db) { await db.end().catch(() => {}); db = null; }
      if (attempt === 20) {
        console.error('✗ Database connection failed after 20 attempts:', error.message);
        process.exit(1);
      }
      // Faster retry intervals: 2s for first 5 attempts, then 3s
      const waitTime = attempt <= 5 ? 2000 : 3000;
      console.log(`⏳ Waiting for database (attempt ${attempt}/20)…`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }

  await ensureSchema();
}

// ── Auto-create tables & seed admin user on first run ─────────────
async function ensureSchema() {
  console.log('Checking database schema…');

  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    avatar_url TEXT,
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    is_active BOOLEAN DEFAULT TRUE,
    email_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_email (email),
    INDEX idx_users_active (is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS sessions (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    token VARCHAR(512) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_sessions_token (token),
    INDEX idx_sessions_user (user_id),
    INDEX idx_sessions_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS contacts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    email VARCHAR(255),
    phone VARCHAR(50),
    company VARCHAR(255),
    job_title VARCHAR(255),
    notes TEXT,
    avatar_url TEXT,
    is_favorite BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_contacts_user (user_id),
    INDEX idx_contacts_name (first_name, last_name),
    INDEX idx_contacts_email (email),
    INDEX idx_contacts_favorite (user_id, is_favorite)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS calendar_events (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    all_day BOOLEAN DEFAULT FALSE,
    location VARCHAR(500),
    color VARCHAR(20) DEFAULT '#22c55e',
    recurrence VARCHAR(100),
    reminder_minutes INT,
    reminders JSON DEFAULT NULL COMMENT 'Array of reminder minutes before event: [0, 15, 60] for default + 15min + 1hr before',
    todo_status VARCHAR(20) DEFAULT NULL COMMENT 'done, changed, time_moved, cancelled',
    is_todo_only BOOLEAN DEFAULT FALSE COMMENT 'True for standalone todos without calendar dates',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_events_user (user_id),
    INDEX idx_events_start (start_time),
    INDEX idx_events_user_time (user_id, start_time, end_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  
  // Add todo_status column if it doesn't exist (for existing installations)
  try {
    await db.execute(`ALTER TABLE calendar_events ADD COLUMN todo_status VARCHAR(20) DEFAULT NULL COMMENT 'done, changed, time_moved, cancelled'`);
  } catch (error) {
    // Column already exists, ignore error
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: todo_status column may already exist');
    }
  }
  
  // Add reminders JSON column if it doesn't exist (for existing installations)
  try {
    await db.execute(`ALTER TABLE calendar_events ADD COLUMN reminders JSON DEFAULT NULL COMMENT 'Array of reminder minutes before event: [0, 15, 60] for default + 15min + 1hr before'`);
  } catch (error) {
    // Column already exists, ignore error
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: reminders column may already exist');
    }
  }
  
  // Add is_todo_only column if it doesn't exist (for existing installations)
  try {
    await db.execute(`ALTER TABLE calendar_events ADD COLUMN is_todo_only BOOLEAN DEFAULT FALSE COMMENT 'True for standalone todos without calendar dates'`);
  } catch (error) {
    // Column already exists, ignore error
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: is_todo_only column may already exist');
    }
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS mail_accounts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    email_address VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    provider VARCHAR(50) NOT NULL,
    username VARCHAR(255),
    imap_host VARCHAR(255),
    imap_port INT DEFAULT 993,
    smtp_host VARCHAR(255),
    smtp_port INT DEFAULT 587,
    encrypted_password TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_mail_accounts_user (user_id),
    INDEX idx_mail_accounts_email (email_address),
    UNIQUE KEY unique_user_email (user_id, email_address)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  
  // Add username column if it doesn't exist (migration for existing installs)
  try {
    await db.execute(`ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS username VARCHAR(255) AFTER provider`);
  } catch (e) {
    // Column might already exist or unsupported syntax, ignore
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS emails (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    mail_account_id CHAR(36) NOT NULL,
    message_id VARCHAR(500),
    subject TEXT,
    from_address VARCHAR(255) NOT NULL,
    from_name VARCHAR(255),
    to_addresses JSON NOT NULL,
    cc_addresses JSON,
    bcc_addresses JSON,
    body_text LONGTEXT,
    body_html LONGTEXT,
    folder VARCHAR(50) DEFAULT 'inbox',
    is_read BOOLEAN DEFAULT FALSE,
    is_starred BOOLEAN DEFAULT FALSE,
    is_draft BOOLEAN DEFAULT FALSE,
    has_attachments BOOLEAN DEFAULT FALSE,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
    INDEX idx_emails_user (user_id),
    INDEX idx_emails_account (mail_account_id),
    INDEX idx_emails_folder (mail_account_id, folder),
    INDEX idx_emails_date (received_at DESC),
    INDEX idx_emails_unread (user_id, is_read, received_at DESC),
    FULLTEXT INDEX ft_emails_search (subject, body_text)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS email_attachments (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email_id CHAR(36) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(100),
    size_bytes BIGINT,
    storage_path TEXT,
    content_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    INDEX idx_attachments_email (email_id),
    INDEX idx_attachments_content_id (content_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  
  // Initialize default signup mode if not set
  const [signupModeSetting] = await db.execute(
    'SELECT setting_value FROM system_settings WHERE setting_key = ?',
    ['signup_mode']
  );
  if (signupModeSetting.length === 0) {
    await db.execute(
      'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)',
      ['signup_mode', 'open'] // Default: open signups
    );
  }

  // Seed default admin user if no users exist yet
  const [rows] = await db.execute('SELECT COUNT(*) as count FROM users');
  if (rows[0].count === 0) {
    const adminHash = await hashPassword('admin123');
    await db.execute(
      `INSERT INTO users (id, email, password_hash, full_name, email_verified, role)
       VALUES (UUID(), 'admin@unihub.local', ?, 'Admin User', TRUE, 'admin')`,
      [adminHash]
    );
    console.log('✓ Default admin created (admin@unihub.local / admin123)');
  }

  console.log('✓ Database schema ready');
}

// Password hashing
async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Generate CSRF token
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Generate JWT token
function generateToken(userId) {
  return jwt.sign(
    { userId, sub: userId },
    JWT_SECRET,
    { expiresIn: '21d' }
  );
}

function getSessionExpiry() {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 21);
  return expiresAt;
}

// ── Rate limiting (in-memory) ──────────────────────────────────────
const rateLimitStore = new Map();
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_BLOCK_MS = 300 * 60 * 1000; // 300 minutes

function getClientIP(req) {
  return req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);
  if (!entry) return null;
  if (entry.blockedUntil > now) {
    return Math.ceil((entry.blockedUntil - now) / 60000);
  }
  if (entry.blockedUntil > 0) {
    rateLimitStore.delete(ip);
  }
  return null;
}

function recordFailedAttempt(ip) {
  const entry = rateLimitStore.get(ip) || { failures: 0, blockedUntil: 0 };
  entry.failures++;
  if (entry.failures >= RATE_LIMIT_MAX_ATTEMPTS) {
    entry.blockedUntil = Date.now() + RATE_LIMIT_BLOCK_MS;
  }
  rateLimitStore.set(ip, entry);
}

function resetRateLimit(ip) {
  rateLimitStore.delete(ip);
}

// Clean up expired rate-limit entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (entry.blockedUntil > 0 && entry.blockedUntil < now) {
      rateLimitStore.delete(ip);
    }
  }
}, 3600000);

// CSRF token validation
function validateCsrfToken(req, res) {
  // Skip CSRF for GET, HEAD, OPTIONS requests
  const method = req.method.toUpperCase();
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return true;
  }

  // Skip CSRF for auth endpoints (they generate new tokens)
  const url = req.url.split('?')[0];
  if (url === '/api/auth/signin' || url === '/api/auth/signup') {
    return true;
  }

  // Get CSRF token from cookie and header
  const cookieToken = req.headers.cookie
    ?.split(';')
    .find(c => c.trim().startsWith('csrf-token='))
    ?.split('=')[1];
  const headerToken = req.headers['x-csrf-token'];

  // Both must be present and match
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return false;
  }

  return true;
}

// Set CSRF token cookie
function setCsrfCookie(res, token) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 21); // Match JWT expiry
  // Note: Secure flag requires HTTPS. For HTTP (development), remove Secure flag
  const isSecure = process.env.NODE_ENV === 'production';
  const secureFlag = isSecure ? 'Secure;' : '';
  res.setHeader('Set-Cookie', `csrf-token=${token}; HttpOnly; ${secureFlag} SameSite=Strict; Path=/; Expires=${expires.toUTCString()}`);
}

// JWT verification + session check
async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }

  try {
    // Add retry logic for database queries
    let retries = 3;
    while (retries > 0) {
      try {
        const [sessions] = await db.execute(
          'SELECT user_id, expires_at FROM sessions WHERE token = ? LIMIT 1',
          [token]
        );

        if (sessions.length === 0) return null;
        const session = sessions[0];
        if (new Date(session.expires_at) < new Date()) return null;

        return session.user_id || decoded.userId || decoded.sub;
      } catch (dbError) {
        retries--;
        if (retries === 0) {
          console.error('[AUTH] Database error in verifyToken:', dbError.message);
          return null;
        }
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return null;
  } catch (error) {
    console.error('[AUTH] Error in verifyToken:', error.message);
    return null;
  }
}

// Admin check
async function isAdmin(userId) {
  if (!userId) return false;
  try {
    const [users] = await db.execute('SELECT role FROM users WHERE id = ?', [userId]);
    return users.length > 0 && users[0].role === 'admin';
  } catch {
    return false;
  }
}

// Get signup mode (open, approval, disabled)
async function getSignupMode() {
  try {
    const [rows] = await db.execute(
      'SELECT setting_value FROM system_settings WHERE setting_key = ?',
      ['signup_mode']
    );
    return rows[0]?.setting_value || 'open';
  } catch {
    return 'open';
  }
}

// Parse JSON body (configurable max size, default 1000 chars)
async function parseBody(req, maxSize = 1000) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (body.length > maxSize) { resolve(null); return; }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// ── vCard helpers (3.0, compatible with Google & Apple) ──────────
function escapeVCard(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function unescapeVCard(str) {
  if (!str) return '';
  return str.replace(/\\n/gi, '\n').replace(/\\;/g, ';').replace(/\\,/g, ',').replace(/\\\\/g, '\\');
}

function decodeQuotedPrintable(str) {
  return str.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function contactToVCard(c) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  const ln = escapeVCard(c.last_name || '');
  const fn = escapeVCard(c.first_name || '');
  lines.push(`N:${ln};${fn};;;`);
  lines.push(`FN:${escapeVCard([c.first_name, c.last_name].filter(Boolean).join(' '))}`);
  if (c.email)     lines.push(`EMAIL;TYPE=INTERNET:${escapeVCard(c.email)}`);
  if (c.phone)     lines.push(`TEL;TYPE=CELL:${escapeVCard(c.phone)}`);
  if (c.company)   lines.push(`ORG:${escapeVCard(c.company)}`);
  if (c.job_title) lines.push(`TITLE:${escapeVCard(c.job_title)}`);
  if (c.notes)     lines.push(`NOTE:${escapeVCard(c.notes)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n');
}

function parseVCards(vcfData) {
  // Unfold continuation lines (RFC 2425 §5.8.1)
  const unfolded = vcfData.replace(/\r\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const contacts = [];
  const blocks = unfolded.split(/(?=BEGIN:VCARD)/i);

  for (const block of blocks) {
    if (!block.trim().match(/^BEGIN:VCARD/i)) continue;
    if (!block.match(/END:VCARD/i)) continue;

    const contact = {
      first_name: '', last_name: null, email: null,
      phone: null, company: null, job_title: null, notes: null,
    };

    for (const line of block.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const propFull = line.substring(0, colonIdx).toUpperCase();
      let value = line.substring(colonIdx + 1).trim();
      const propName = propFull.split(';')[0];

      // Handle quoted-printable encoding (used by some Apple exports)
      if (propFull.includes('ENCODING=QUOTED-PRINTABLE')) {
        value = decodeQuotedPrintable(value);
      }

      value = unescapeVCard(value);

      switch (propName) {
        case 'N': {
          const parts = value.split(';');
          contact.last_name = parts[0] || null;
          contact.first_name = parts[1] || '';
          break;
        }
        case 'FN':
          // Only use FN as fallback if N wasn't parsed
          if (!contact.first_name) {
            const parts = value.split(' ');
            contact.first_name = parts[0] || '';
            contact.last_name = parts.slice(1).join(' ') || null;
          }
          break;
        case 'EMAIL':
          if (!contact.email) contact.email = value;
          break;
        case 'TEL':
          if (!contact.phone) contact.phone = value;
          break;
        case 'ORG':
          contact.company = value.split(';')[0] || null;
          break;
        case 'TITLE':
          contact.job_title = value || null;
          break;
        case 'NOTE':
          contact.notes = value || null;
          break;
      }
    }

    // Must have at least a name
    if (contact.first_name || contact.last_name) {
      if (!contact.first_name && contact.last_name) {
        contact.first_name = contact.last_name;
        contact.last_name = null;
      }
      contacts.push(contact);
    }
  }

  return contacts;
}

// Simple router
const routes = {
  'GET /health': async () => ({ status: 'ok', timestamp: new Date().toISOString() }),
  
  // Authentication endpoints
  'POST /api/auth/signup': async (req, userId, body, res) => {
    const ip = getClientIP(req);
    const blockedMinutes = isRateLimited(ip);
    if (blockedMinutes) {
      return { error: `Too many attempts. Try again in ${blockedMinutes} minutes.`, status: 429 };
    }

    // Check signup mode
    const signupMode = await getSignupMode();
    if (signupMode === 'disabled') {
      return { error: 'Signups are currently disabled', status: 403 };
    }

    const { email, password, full_name } = body;
    if (!email || !password) {
      return { error: 'Email and password are required', status: 400 };
    }
    
    try {
      // Check if user exists
      const [existing] = await db.execute(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );
      
      if (existing.length > 0) {
        recordFailedAttempt(ip);
        return { error: 'User already exists', status: 400 };
      }
      
      // Create user (active if mode is 'open', inactive if 'approval')
      const isActive = signupMode === 'open';
      const passwordHash = await hashPassword(password);
      const newUserId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO users (id, email, password_hash, full_name, email_verified, is_active) VALUES (?, ?, ?, ?, TRUE, ?)',
        [newUserId, email, passwordHash, full_name || null, isActive]
      );
      
      // If approval required, don't create session or return token
      if (!isActive) {
        return { 
          message: 'Account created. Waiting for admin approval.',
          requiresApproval: true 
        };
      }
      
      const token = generateToken(newUserId);
      const csrfToken = generateCsrfToken();
      
      // Create session
      const expiresAt = getSessionExpiry();
      await db.execute(
        'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
        [newUserId, token, expiresAt]
      );
      
      resetRateLimit(ip);
      const result = { token, csrfToken, user: { id: newUserId, email, full_name, role: 'user' } };
      // Set CSRF cookie in response
      setCsrfCookie(res, csrfToken);
      return result;
    } catch (error) {
      console.error('Signup error:', error);
      recordFailedAttempt(ip);
      return { error: 'Failed to create user', status: 500 };
    }
  },
  
  'POST /api/auth/signin': async (req, userId, body, res) => {
    const ip = getClientIP(req);
    const blockedMinutes = isRateLimited(ip);
    if (blockedMinutes) {
      return { error: `Too many attempts. Try again in ${blockedMinutes} minutes.`, status: 429 };
    }

    const { email, password } = body;
    if (!email || !password) {
      return { error: 'Email and password are required', status: 400 };
    }
    
    try {
      // Add retry logic for database queries
      let users;
      let retries = 3;
      while (retries > 0) {
        try {
          const result = await db.execute(
            'SELECT id, email, password_hash, full_name, role, is_active FROM users WHERE email = ?',
            [email]
          );
          users = result[0];
          break;
        } catch (dbError) {
          retries--;
          if (retries === 0) {
            console.error('[AUTH] Database error in signin:', dbError.message);
            recordFailedAttempt(ip);
            return { error: 'Database connection error. Please try again.', status: 503 };
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      if (users.length === 0) {
        recordFailedAttempt(ip);
        return { error: 'Invalid credentials', status: 401 };
      }
      
      const user = users[0];
      const isValid = await verifyPassword(password, user.password_hash);
      
      if (!isValid) {
        recordFailedAttempt(ip);
        return { error: 'Invalid credentials', status: 401 };
      }
      
      if (!user.is_active) {
        return { error: 'Your account is pending admin approval', status: 403 };
      }
      
      const token = generateToken(user.id);
      const csrfToken = generateCsrfToken();
      
      // Create session with retry logic
      const expiresAt = getSessionExpiry();
      retries = 3;
      while (retries > 0) {
        try {
          await db.execute(
            'INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)',
            [user.id, token, expiresAt]
          );
          break;
        } catch (dbError) {
          retries--;
          if (retries === 0) {
            console.error('[AUTH] Database error creating session:', dbError.message);
            recordFailedAttempt(ip);
            return { error: 'Failed to create session. Please try again.', status: 503 };
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      resetRateLimit(ip);
      const result = { token, csrfToken, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role } };
      // Set CSRF cookie in response
      setCsrfCookie(res, csrfToken);
      return result;
    } catch (error) {
      console.error('Signin error:', error);
      recordFailedAttempt(ip);
      return { error: 'Failed to sign in', status: 500 };
    }
  },
  
  'POST /api/auth/signout': async (req, userId, body, res) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        await db.execute('DELETE FROM sessions WHERE token = ?', [token]);
      }
      return { message: 'Signed out successfully' };
    } catch (error) {
      return { error: 'Failed to sign out', status: 500 };
    }
  },
  
  'GET /api/auth/me': async (req, userId, body, res) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [users] = await db.execute(
        'SELECT id, email, full_name, avatar_url, role FROM users WHERE id = ?',
        [userId]
      );
      
      if (users.length === 0) {
        return { error: 'User not found', status: 404 };
      }
      
      // Refresh CSRF token on every /auth/me call to prevent stale tokens
      const csrfToken = generateCsrfToken();
      setCsrfCookie(res, csrfToken);
      
      return { user: users[0], csrfToken };
    } catch (error) {
      return { error: 'Failed to get user', status: 500 };
    }
  },

  'PUT /api/auth/password': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { current_password, new_password } = body;
    if (!current_password || !new_password) {
      return { error: 'Current password and new password are required', status: 400 };
    }
    if (new_password.length < 6) {
      return { error: 'New password must be at least 6 characters', status: 400 };
    }

    try {
      const [users] = await db.execute(
        'SELECT password_hash FROM users WHERE id = ?',
        [userId]
      );
      if (users.length === 0) {
        return { error: 'User not found', status: 404 };
      }

      const isValid = await verifyPassword(current_password, users[0].password_hash);
      if (!isValid) {
        return { error: 'Current password is incorrect', status: 401 };
      }

      const newHash = await hashPassword(new_password);
      await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);

      return { message: 'Password updated successfully' };
    } catch (error) {
      console.error('Password change error:', error);
      return { error: 'Failed to change password', status: 500 };
    }
  },

  'PUT /api/auth/profile': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { full_name } = body;
    if (full_name === undefined || full_name === null) {
      return { error: 'Full name is required', status: 400 };
    }

    try {
      await db.execute('UPDATE users SET full_name = ? WHERE id = ?', [full_name.trim() || null, userId]);
      const [users] = await db.execute(
        'SELECT id, email, full_name, avatar_url, role FROM users WHERE id = ?',
        [userId]
      );
      return { user: users[0] };
    } catch (error) {
      console.error('Profile update error:', error);
      return { error: 'Failed to update profile', status: 500 };
    }
  },
  
  // Stats endpoint
  'GET /api/stats': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [contacts] = await db.execute(
        'SELECT COUNT(*) as count FROM contacts WHERE user_id = ?',
        [userId]
      );
      const [events] = await db.execute(
        'SELECT COUNT(*) as count FROM calendar_events WHERE user_id = ? AND start_time >= UTC_TIMESTAMP() AND is_todo_only = FALSE',
        [userId]
      );
      const [unread] = await db.execute(
        'SELECT COUNT(*) as count FROM emails WHERE user_id = ? AND is_read = FALSE',
        [userId]
      );
      
      return {
        contacts: contacts[0].count,
        upcomingEvents: events[0].count,
        unreadEmails: unread[0].count,
      };
    } catch (error) {
      return { error: 'Failed to get stats', status: 500 };
    }
  },
  
  // Contacts endpoints
  'GET /api/contacts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [contacts] = await db.execute(
        'SELECT * FROM contacts WHERE user_id = ? ORDER BY is_favorite DESC, first_name ASC',
        [userId]
      );
      return { contacts };
    } catch (error) {
      return { error: 'Failed to get contacts', status: 500 };
    }
  },
  
  'POST /api/contacts': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { first_name, last_name, email, phone, company, job_title, notes } = body;
    if (!first_name || !first_name.trim()) {
      return { error: 'First name is required', status: 400 };
    }

    try {
      const contactId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO contacts (id, user_id, first_name, last_name, email, phone, company, job_title, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [contactId, userId, first_name.trim(), last_name || null, email || null, phone || null, company || null, job_title || null, notes || null]
      );
      
      const [contacts] = await db.execute('SELECT * FROM contacts WHERE id = ?', [contactId]);
      return { contact: contacts[0] };
    } catch (error) {
      return { error: 'Failed to create contact', status: 500 };
    }
  },
  
  'PUT /api/contacts/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { first_name, last_name, email, phone, company, job_title, notes } = body;
    if (!first_name || !first_name.trim()) {
      return { error: 'First name is required', status: 400 };
    }

    try {
      const id = req.url.split('/').pop();
      
      await db.execute(
        'UPDATE contacts SET first_name = ?, last_name = ?, email = ?, phone = ?, company = ?, job_title = ?, notes = ? WHERE id = ? AND user_id = ?',
        [first_name.trim(), last_name || null, email || null, phone || null, company || null, job_title || null, notes || null, id, userId]
      );
      
      const [contacts] = await db.execute('SELECT * FROM contacts WHERE id = ? AND user_id = ?', [id, userId]);
      return { contact: contacts[0] };
    } catch (error) {
      return { error: 'Failed to update contact', status: 500 };
    }
  },
  
  'DELETE /api/contacts/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      await db.execute('DELETE FROM contacts WHERE id = ? AND user_id = ?', [id, userId]);
      return { message: 'Contact deleted' };
    } catch (error) {
      return { error: 'Failed to delete contact', status: 500 };
    }
  },
  
  'GET /api/contacts/export': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const [contacts] = await db.execute(
        'SELECT * FROM contacts WHERE user_id = ? ORDER BY first_name ASC',
        [userId]
      );

      if (contacts.length === 0) {
        return { error: 'No contacts to export', status: 404 };
      }

      const vcf = contacts.map(contactToVCard).join('\r\n');
      return { __raw: vcf, __contentType: 'text/vcard', __filename: 'contacts.vcf' };
    } catch (error) {
      console.error('Export error:', error);
      return { error: 'Failed to export contacts', status: 500 };
    }
  },

  'POST /api/contacts/import': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { vcf_data } = body;
    if (!vcf_data || typeof vcf_data !== 'string') {
      return { error: 'Missing vcf_data field', status: 400 };
    }

    try {
      const parsed = parseVCards(vcf_data);

      if (parsed.length === 0) {
        return { error: 'No valid contacts found in the file. Make sure it is a .vcf (vCard) file.', status: 400 };
      }

      let imported = 0;
      const errors = [];

      for (const c of parsed) {
        try {
          const contactId = crypto.randomUUID();
          await db.execute(
            'INSERT INTO contacts (id, user_id, first_name, last_name, email, phone, company, job_title, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [contactId, userId, c.first_name, c.last_name, c.email, c.phone, c.company, c.job_title, c.notes]
          );
          imported++;
        } catch (err) {
          const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
          errors.push(`Failed to import "${name}": ${err.message}`);
        }
      }

      return {
        message: `Imported ${imported} of ${parsed.length} contacts`,
        imported,
        total: parsed.length,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      console.error('Import error:', error);
      return { error: 'Failed to import contacts', status: 500 };
    }
  },

  'PUT /api/contacts/:id/favorite': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const parts = req.url.split('?')[0].split('/');
      const id = parts[parts.length - 2];
      const { is_favorite } = body;
      await db.execute(
        'UPDATE contacts SET is_favorite = ? WHERE id = ? AND user_id = ?',
        [is_favorite ? 1 : 0, id, userId]
      );
      return { message: 'Favorite status updated' };
    } catch (error) {
      return { error: 'Failed to update favorite', status: 500 };
    }
  },
  
  // Calendar events endpoints
  'GET /api/calendar/events': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const includeTodos = url.searchParams.get('include_todos') === 'true';
      
      let query = 'SELECT * FROM calendar_events WHERE user_id = ?';
      const params = [userId];
      
      // Filter out todo-only events unless explicitly requested
      if (!includeTodos) {
        query += ' AND is_todo_only = FALSE';
      }
      
      query += ' ORDER BY start_time ASC';
      
      const [rows] = await db.execute(query, params);
      // Serialise dates as UTC ISO strings so the client gets correct times
      const events = rows.map((row) => ({
        ...row,
        start_time: row.start_time instanceof Date ? row.start_time.toISOString() : row.start_time,
        end_time: row.end_time instanceof Date ? row.end_time.toISOString() : row.end_time,
        reminders: row.reminders ? (typeof row.reminders === 'string' ? JSON.parse(row.reminders) : row.reminders) : null,
      }));
      return { events };
    } catch (error) {
      return { error: 'Failed to get events', status: 500 };
    }
  },
  
  'POST /api/calendar/events': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!body.title?.trim()) return { error: 'Title is required', status: 400 };

    try {
      const { title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, is_todo_only } = body;
      // Normalise to MySQL DATETIME format (YYYY-MM-DD HH:MM:SS)
      const toMysqlDatetime = (v) => {
        if (v == null || v === '') return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 19).replace('T', ' ');
      };
      const start = toMysqlDatetime(start_time);
      const end = toMysqlDatetime(end_time);
      if (!start || !end) return { error: 'Valid start and end time are required', status: 400 };

      const eventId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO calendar_events (id, user_id, title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, is_todo_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [eventId, userId, title.trim(), description || null, start, end, !!all_day, location?.trim() || null, color || '#22c55e', recurrence || null, reminder_minutes ?? null, reminders ? JSON.stringify(reminders) : null, !!is_todo_only]
      );

      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ?', [eventId]);
      const event = events[0];
      if (event) {
        event.start_time = event.start_time instanceof Date ? event.start_time.toISOString() : event.start_time;
        event.end_time = event.end_time instanceof Date ? event.end_time.toISOString() : event.end_time;
        event.reminders = event.reminders ? (typeof event.reminders === 'string' ? JSON.parse(event.reminders) : event.reminders) : null;
      }
      return { event };
    } catch (error) {
      console.error('Create event error:', error);
      return { error: error.message || 'Failed to create event', status: 500 };
    }
  },
  
  'PUT /api/calendar/events/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = req.url.split('/').pop();
      const { title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, todo_status, is_todo_only } = body;
      const toMysqlDatetime = (v) => {
        if (v == null || v === '') return null;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) return null;
        return d.toISOString().slice(0, 19).replace('T', ' ');
      };
      const start = toMysqlDatetime(start_time);
      const end = toMysqlDatetime(end_time);
      if (!start || !end) return { error: 'Valid start and end time are required', status: 400 };

      // Handle reminders - ensure it's properly formatted
      const remindersValue = reminders !== undefined && reminders !== null 
        ? (Array.isArray(reminders) ? JSON.stringify(reminders) : reminders)
        : null;
      
      await db.execute(
        'UPDATE calendar_events SET title = ?, description = ?, start_time = ?, end_time = ?, all_day = ?, location = ?, color = ?, recurrence = ?, reminder_minutes = ?, reminders = ?, todo_status = ?, is_todo_only = ? WHERE id = ? AND user_id = ?',
        [title?.trim() ?? '', description || null, start, end, !!all_day, location?.trim() || null, color || '#22c55e', recurrence || null, reminder_minutes ?? null, remindersValue, todo_status || null, !!is_todo_only, id, userId]
      );

      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      return { event: events[0] };
    } catch (error) {
      console.error('Update event error:', error);
      return { error: error.message || 'Failed to update event', status: 500 };
    }
  },

  'PUT /api/calendar/events/:id/todo-status': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = req.url.split('/').pop();
      const { todo_status, start_time } = body;
      
      if (!['done', 'changed', 'time_moved', 'cancelled', null].includes(todo_status)) {
        return { error: 'Invalid todo_status', status: 400 };
      }

      let updateQuery = 'UPDATE calendar_events SET todo_status = ?';
      const params = [todo_status || null];
      
      // If time_moved, also update start_time and end_time
      if (todo_status === 'time_moved' && start_time) {
        const toMysqlDatetime = (v) => {
          if (v == null || v === '') return null;
          const d = new Date(v);
          if (Number.isNaN(d.getTime())) return null;
          return d.toISOString().slice(0, 19).replace('T', ' ');
        };
        const newStart = toMysqlDatetime(start_time);
        if (newStart) {
          // Get current event to calculate duration
          const [currentEvents] = await db.execute('SELECT start_time, end_time FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
          if (currentEvents.length > 0) {
            const currentStart = new Date(currentEvents[0].start_time);
            const currentEnd = new Date(currentEvents[0].end_time);
            const duration = currentEnd.getTime() - currentStart.getTime();
            const newEnd = new Date(new Date(newStart).getTime() + duration);
            updateQuery += ', start_time = ?, end_time = ?';
            params.push(newStart, newEnd.toISOString().slice(0, 19).replace('T', ' '));
          }
        }
      }
      
      updateQuery += ' WHERE id = ? AND user_id = ?';
      params.push(id, userId);
      
      await db.execute(updateQuery, params);

      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      return { event: events[0] };
    } catch (error) {
      console.error('Update todo status error:', error);
      return { error: error.message || 'Failed to update todo status', status: 500 };
    }
  },
  
  'DELETE /api/calendar/events/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      await db.execute('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      return { message: 'Event deleted' };
    } catch (error) {
      return { error: 'Failed to delete event', status: 500 };
    }
  },
  
  // Mail accounts endpoints
  'GET /api/mail/accounts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [accounts] = await db.execute(
        'SELECT id, user_id, email_address, display_name, provider, is_active, last_synced_at, created_at FROM mail_accounts WHERE user_id = ?',
        [userId]
      );
      return { accounts };
    } catch (error) {
      return { error: 'Failed to get mail accounts', status: 500 };
    }
  },
  
  'POST /api/mail/accounts': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password } = body;
      
      if (!email_address || !encrypted_password) {
        return { error: 'Email address and password are required', status: 400 };
      }
      if (!imap_host || !smtp_host) {
        return { error: 'IMAP and SMTP server addresses are required', status: 400 };
      }
      
      // Create temporary account object for testing
      const tempAccount = {
        email_address,
        username: username || email_address,
        imap_host,
        imap_port: imap_port || 993,
        encrypted_password: encrypt(encrypted_password),
      };
      
      // Test IMAP connection/auth first (fast, non-blocking)
      console.log(`[ACCOUNT] Testing IMAP connection for ${email_address}...`);
      const testResult = await testImapConnection(tempAccount);
      
      if (!testResult.success) {
        // Auth failed - return error immediately without saving account
        return { 
          error: testResult.error, 
          details: testResult.details,
          status: 400 
        };
      }
      
      // Auth successful - save account immediately
      const accountId = crypto.randomUUID();
      const actualUsername = username || email_address;
      await db.execute(
        'INSERT INTO mail_accounts (id, user_id, email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [accountId, userId, email_address, display_name || null, provider, actualUsername, imap_host || null, imap_port || 993, smtp_host || null, smtp_port || 587, tempAccount.encrypted_password]
      );
      
      const [accounts] = await db.execute('SELECT id, user_id, email_address, display_name, provider, is_active FROM mail_accounts WHERE id = ?', [accountId]);
      
      // Start sync in background (non-blocking)
      console.log(`[ACCOUNT] Starting background sync for ${email_address}...`);
      syncMailAccount(accountId).catch(err => {
        console.error(`[ACCOUNT] Background sync failed for ${email_address}:`, err.message);
      });
      
      // Return success immediately
      return { 
        account: accounts[0],
        authSuccess: true,
        syncInProgress: true,
        message: 'Account connected successfully. Syncing emails in the background — this may take several minutes for large mailboxes.'
      };
    } catch (error) {
      console.error('[ACCOUNT] Create mail account error:', error);
      return { error: error.message || 'Failed to create mail account', status: 500 };
    }
  },
  
  'PUT /api/mail/accounts/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      const { email_address, display_name, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password } = body;
      
      // Verify account belongs to user
      const [accounts] = await db.execute(
        'SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };
      
      // Build update query dynamically
      const updates = [];
      const params = [];
      
      if (email_address) { updates.push('email_address = ?'); params.push(email_address); }
      if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name || null); }
      if (username !== undefined) { updates.push('username = ?'); params.push(username || email_address); }
      if (imap_host) { updates.push('imap_host = ?'); params.push(imap_host); }
      if (imap_port) { updates.push('imap_port = ?'); params.push(imap_port); }
      if (smtp_host) { updates.push('smtp_host = ?'); params.push(smtp_host); }
      if (smtp_port) { updates.push('smtp_port = ?'); params.push(smtp_port); }
      if (encrypted_password) { updates.push('encrypted_password = ?'); params.push(encrypt(encrypted_password)); }
      
      if (updates.length === 0) return { error: 'No fields to update', status: 400 };
      
      params.push(id, userId);
      await db.execute(
        `UPDATE mail_accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
        params
      );
      
      const [updated] = await db.execute(
        'SELECT id, user_id, email_address, display_name, provider, is_active FROM mail_accounts WHERE id = ?',
        [id]
      );
      
      return { account: updated[0] };
    } catch (error) {
      console.error('[ACCOUNT] Update error:', error);
      return { error: error.message || 'Failed to update mail account', status: 500 };
    }
  },
  
  'DELETE /api/mail/accounts/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      await db.execute('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      return { message: 'Mail account deleted' };
    } catch (error) {
      return { error: 'Failed to delete mail account', status: 500 };
    }
  },
  
  // Emails endpoints
  'GET /api/mail/emails': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    let query, params, folder, accountId;
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      folder = url.searchParams.get('folder') || 'inbox';
      accountId = url.searchParams.get('account_id');
      
      query = 'SELECT * FROM emails WHERE user_id = ?';
      params = [userId];
      
      if (folder) {
        query += ' AND folder = ?';
        params.push(folder);
      }
      
      if (accountId) {
        query += ' AND mail_account_id = ?';
        params.push(accountId);
      }
      
      // Pagination
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const page = Math.max(1, Math.floor(offset / limit) + 1);
      
      // Use template literals for LIMIT/OFFSET since they're already sanitized integers
      // This avoids parameter binding issues with mysql2
      query += ` ORDER BY received_at DESC LIMIT ${limit} OFFSET ${offset}`;
      
      // Get total count for pagination
      let countQuery = 'SELECT COUNT(*) as total FROM emails WHERE user_id = ?';
      const countParams = [userId];
      if (folder) {
        countQuery += ' AND folder = ?';
        countParams.push(folder);
      }
      if (accountId) {
        countQuery += ' AND mail_account_id = ?';
        countParams.push(accountId);
      }
      const [countResult] = await db.execute(countQuery, countParams);
      const total = countResult[0]?.total || 0;
      
      const [emails] = await db.execute(query, params);
      console.log(`[API] GET /api/mail/emails: Found ${emails.length} emails for user ${userId}, folder ${folder}, account ${accountId || 'all'}, total ${total}`);
      
      // Parse JSON fields
      const parsedEmails = emails.map(email => ({
        ...email,
        to_addresses: typeof email.to_addresses === 'string' ? JSON.parse(email.to_addresses || '[]') : email.to_addresses,
        is_read: !!email.is_read,
        is_starred: !!email.is_starred,
      }));
      return { 
        emails: parsedEmails,
        pagination: {
          total,
          limit,
          offset,
          page,
          totalPages: Math.ceil(total / limit),
        }
      };
    } catch (error) {
      console.error(`[API] GET /api/mail/emails ERROR:`, error.message);
      console.error(`[API] Query:`, query || 'N/A');
      console.error(`[API] Params:`, params || 'N/A');
      console.error(`[API] Folder:`, folder || 'N/A', `AccountId:`, accountId || 'N/A');
      console.error(`[API] Error stack:`, error.stack);
      return { error: 'Failed to get emails', status: 500 };
    }
  },
  
  'GET /api/mail/emails/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = req.url.split('/').pop();
      const [emails] = await db.execute(
        'SELECT * FROM emails WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      
      if (emails.length === 0) {
        return { error: 'Email not found', status: 404 };
      }
      
      const email = emails[0];
      // Parse JSON fields
      const parsedEmail = {
        ...email,
        to_addresses: typeof email.to_addresses === 'string' ? JSON.parse(email.to_addresses || '[]') : email.to_addresses,
        is_read: !!email.is_read,
        is_starred: !!email.is_starred,
      };
      
      // Fetch attachments (exclude inline attachments from list - they're embedded in HTML)
      const [attachments] = await db.execute(
        'SELECT id, filename, content_type, size_bytes, content_id FROM email_attachments WHERE email_id = ? ORDER BY filename',
        [id]
      );
      
      // Separate inline and regular attachments
      const inlineAttachments = attachments.filter(att => att.content_id);
      const regularAttachments = attachments.filter(att => !att.content_id);
      
      parsedEmail.attachments = regularAttachments.map(att => ({
        id: att.id,
        filename: att.filename,
        content_type: att.content_type,
        size_bytes: att.size_bytes,
      }));
      
      // Note: Inline attachments are already embedded in body_html via URL replacement
      
      return { email: parsedEmail };
    } catch (error) {
      return { error: 'Failed to get email', status: 500 };
    }
  },

  'GET /api/mail/attachments/:id': async (req, userId, body, res) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const parts = req.url.split('?')[0].split('/');
      const attachmentId = parts[parts.length - 1];
      
      // Get attachment info and verify it belongs to user's email
      const [attachments] = await db.execute(
        `SELECT a.id, a.filename, a.content_type, a.storage_path, e.user_id 
         FROM email_attachments a
         INNER JOIN emails e ON a.email_id = e.id
         WHERE a.id = ? AND e.user_id = ?`,
        [attachmentId, userId]
      );
      
      if (attachments.length === 0) {
        return { error: 'Attachment not found', status: 404 };
      }
      
      const attachment = attachments[0];
      
      // Read file from storage
      try {
        const fileContent = await readFile(attachment.storage_path);
        
        // Return as raw response for download
        // Ensure proper content type for PDFs and other common types
        let contentType = attachment.content_type || 'application/octet-stream';
        const filename = attachment.filename || 'download';
        
        // Fix common content type issues
        if (filename.toLowerCase().endsWith('.pdf') && !contentType.includes('pdf')) {
          contentType = 'application/pdf';
        } else if (filename.toLowerCase().endsWith('.jpg') || filename.toLowerCase().endsWith('.jpeg')) {
          contentType = 'image/jpeg';
        } else if (filename.toLowerCase().endsWith('.png')) {
          contentType = 'image/png';
        } else if (filename.toLowerCase().endsWith('.txt')) {
          contentType = 'text/plain';
        }
        
        return {
          __raw: fileContent,
          __contentType: contentType,
          __filename: filename,
        };
      } catch (fileError) {
        console.error(`[ATTACH] Failed to read attachment file:`, fileError.message);
        return { error: 'Failed to read attachment file', status: 500 };
      }
    } catch (error) {
      console.error('[ATTACH] Error:', error);
      return { error: 'Failed to fetch attachment', status: 500 };
    }
  },
  
  'PUT /api/mail/emails/:id/read': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const parts = req.url.split('?')[0].split('/');
      const id = parts[parts.length - 2];
      const { is_read } = body;
      await db.execute(
        'UPDATE emails SET is_read = ? WHERE id = ? AND user_id = ?',
        [is_read ? 1 : 0, id, userId]
      );
      return { message: 'Email read status updated' };
    } catch (error) {
      return { error: 'Failed to update email', status: 500 };
    }
  },
  
  'PUT /api/mail/emails/:id/star': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const parts = req.url.split('?')[0].split('/');
      const id = parts[parts.length - 2];
      const { is_starred } = body;
      await db.execute(
        'UPDATE emails SET is_starred = ? WHERE id = ? AND user_id = ?',
        [is_starred ? 1 : 0, id, userId]
      );
      return { message: 'Email star status updated' };
    } catch (error) {
      return { error: 'Failed to update email', status: 500 };
    }
  },

  'POST /api/mail/emails/bulk-delete': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { email_ids } = body;
      if (!Array.isArray(email_ids) || email_ids.length === 0) {
        return { error: 'Email IDs array required', status: 400 };
      }
      
      // Move emails to trash folder instead of permanently deleting
      const placeholders = email_ids.map(() => '?').join(',');
      await db.execute(
        `UPDATE emails SET folder = 'trash' WHERE id IN (${placeholders}) AND user_id = ?`,
        [...email_ids, userId]
      );
      
      return { message: `Moved ${email_ids.length} email(s) to trash` };
    } catch (error) {
      console.error('[BULK] Delete error:', error);
      return { error: 'Failed to delete emails', status: 500 };
    }
  },

  'POST /api/mail/emails/bulk-move': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { email_ids, folder } = body;
      if (!Array.isArray(email_ids) || email_ids.length === 0) {
        return { error: 'Email IDs array required', status: 400 };
      }
      if (!folder || !['inbox', 'archive', 'trash', 'sent'].includes(folder)) {
        return { error: 'Valid folder required (inbox, archive, trash, sent)', status: 400 };
      }
      
      // Update folder for emails
      const placeholders = email_ids.map(() => '?').join(',');
      await db.execute(
        `UPDATE emails SET folder = ? WHERE id IN (${placeholders}) AND user_id = ?`,
        [folder, ...email_ids, userId]
      );
      
      return { message: `Moved ${email_ids.length} email(s) to ${folder}` };
    } catch (error) {
      console.error('[BULK] Move error:', error);
      return { error: 'Failed to move emails', status: 500 };
    }
  },

  'POST /api/mail/emails/bulk-update': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { email_ids, is_read, is_starred } = body;
      if (!Array.isArray(email_ids) || email_ids.length === 0) {
        return { error: 'Email IDs array required', status: 400 };
      }
      
      const updates = [];
      const values = [];
      
      if (typeof is_read === 'boolean') {
        updates.push('is_read = ?');
        values.push(is_read ? 1 : 0);
      }
      if (typeof is_starred === 'boolean') {
        updates.push('is_starred = ?');
        values.push(is_starred ? 1 : 0);
      }
      
      if (updates.length === 0) {
        return { error: 'At least one field (is_read or is_starred) required', status: 400 };
      }
      
      const placeholders = email_ids.map(() => '?').join(',');
      await db.execute(
        `UPDATE emails SET ${updates.join(', ')} WHERE id IN (${placeholders}) AND user_id = ?`,
        [...values, ...email_ids, userId]
      );
      
      return { message: `Updated ${email_ids.length} email(s)` };
    } catch (error) {
      console.error('[BULK] Update error:', error);
      return { error: 'Failed to update emails', status: 500 };
    }
  },
  
  'POST /api/mail/sync': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { account_id } = body;
      if (!account_id) return { error: 'Account ID required', status: 400 };
      
      // Verify account belongs to user
      const [accounts] = await db.execute(
        'SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?',
        [account_id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };
      
      // Sync and wait for result
      console.log(`[SYNC] Manual sync requested for account ${account_id}`);
      // #region agent log
      debugLog('server.js:1391', 'POST /mail/sync START', { account_id, userId }, 'H1,H2,H3,H4');
      // #endregion
      const result = await syncMailAccount(account_id);
      // #region agent log
      debugLog('server.js:1392', 'POST /mail/sync RESULT', { success: result.success, error: result.error, newEmails: result.newEmails }, 'H1,H2,H3,H4');
      // #endregion
      
      if (!result.success) {
        return { 
          error: result.error, 
          details: result.details,
          status: 400 
        };
      }
      
      return { 
        success: true,
        newEmails: result.newEmails,
        totalFound: result.totalFound,
        message: result.message
      };
    } catch (error) {
      console.error('[SYNC] Sync error:', error);
      return { error: error.message || 'Failed to sync mail', status: 500 };
    }
  },
  
  'POST /api/mail/send': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const { account_id, to, subject, body: emailBody, isHtml } = body;
      if (!account_id || !to || !subject || !emailBody) {
        return { error: 'Missing required fields', status: 400 };
      }
      
      // Verify account belongs to user
      const [accounts] = await db.execute(
        'SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?',
        [account_id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };
      
      // #region agent log
      debugLog('server.js:1440', 'POST /mail/send START', { account_id, to, subject, userId }, 'H5');
      // #endregion
      const result = await sendEmail(account_id, { to, subject, body: emailBody, isHtml });
      // #region agent log
      debugLog('server.js:1441', 'POST /mail/send SUCCESS', { messageId: result.messageId }, 'H5');
      // #endregion
      return { success: true, messageId: result.messageId };
    } catch (error) {
      // #region agent log
      debugLog('server.js:1442', 'POST /mail/send ERROR', { errorMessage: error.message, errorStack: error.stack?.substring(0, 200) }, 'H5');
      // #endregion
      console.error('Send email error:', error);
      return { error: error.message || 'Failed to send email', status: 500 };
    }
  },

  // ── Admin endpoints (require admin role) ────────────────────────
  'GET /api/admin/users': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    try {
      const [users] = await db.execute(
        'SELECT id, email, full_name, role, is_active, created_at FROM users ORDER BY created_at DESC'
      );
      return { users };
    } catch (error) {
      return { error: 'Failed to get users', status: 500 };
    }
  },

  'PUT /api/admin/users/:id/password': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const parts = req.url.split('?')[0].split('/');
    const targetId = parts[parts.length - 2];
    const { new_password } = body;

    if (!new_password || new_password.length < 6) {
      return { error: 'New password must be at least 6 characters', status: 400 };
    }

    try {
      const newHash = await hashPassword(new_password);
      await db.execute('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, targetId]);
      // Invalidate all sessions so the user must re-login
      await db.execute('DELETE FROM sessions WHERE user_id = ?', [targetId]);
      return { message: 'Password updated successfully' };
    } catch (error) {
      return { error: 'Failed to update password', status: 500 };
    }
  },

  'DELETE /api/admin/users/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const id = req.url.split('?')[0].split('/').pop();

    if (id === userId) {
      return { error: 'Cannot delete your own account', status: 400 };
    }

    try {
      await db.execute('DELETE FROM users WHERE id = ?', [id]);
      return { message: 'User deleted' };
    } catch (error) {
      return { error: 'Failed to delete user', status: 500 };
    }
  },
  
  'PUT /api/admin/users/:id/activate': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const id = req.url.split('?')[0].split('/').pop();
    const { is_active } = body;

    try {
      await db.execute('UPDATE users SET is_active = ? WHERE id = ?', [!!is_active, id]);
      return { message: is_active ? 'User activated' : 'User deactivated' };
    } catch (error) {
      return { error: 'Failed to update user status', status: 500 };
    }
  },
  
  'GET /api/admin/settings/signup-mode': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    try {
      const mode = await getSignupMode();
      return { signup_mode: mode };
    } catch (error) {
      return { error: 'Failed to get settings', status: 500 };
    }
  },
  
  'PUT /api/admin/settings/signup-mode': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!(await isAdmin(userId))) return { error: 'Forbidden', status: 403 };

    const { signup_mode } = body;
    if (!['open', 'approval', 'disabled'].includes(signup_mode)) {
      return { error: 'Invalid signup mode. Must be: open, approval, or disabled', status: 400 };
    }

    try {
      await db.execute(
        'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        ['signup_mode', signup_mode, signup_mode]
      );
      return { message: `Signup mode set to: ${signup_mode}` };
    } catch (error) {
      return { error: 'Failed to update settings', status: 500 };
    }
  },
};

// Request handler
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let routeKey = `${req.method} ${url.pathname}`;
  
  // Handle parameterized routes
  if (routeKey.includes('/api/contacts/') && req.method !== 'GET' && req.method !== 'POST') {
    routeKey = `${req.method} /api/contacts/:id`;
    if (url.pathname.includes('/favorite')) {
      routeKey = `${req.method} /api/contacts/:id/favorite`;
    }
  } else if (routeKey.includes('/api/calendar/events/')) {
    if (url.pathname.includes('/todo-status')) {
      routeKey = `${req.method} /api/calendar/events/:id/todo-status`;
    } else {
      routeKey = `${req.method} /api/calendar/events/:id`;
    }
  } else if (routeKey.includes('/api/mail/accounts/')) {
    routeKey = `${req.method} /api/mail/accounts/:id`;
  } else if (routeKey.includes('/api/mail/emails/')) {
    if (url.pathname.includes('/bulk-delete')) {
      routeKey = `${req.method} /api/mail/emails/bulk-delete`;
    } else if (url.pathname.includes('/bulk-move')) {
      routeKey = `${req.method} /api/mail/emails/bulk-move`;
    } else if (url.pathname.includes('/bulk-update')) {
      routeKey = `${req.method} /api/mail/emails/bulk-update`;
    } else if (url.pathname.includes('/read')) {
      routeKey = `${req.method} /api/mail/emails/:id/read`;
    } else if (url.pathname.includes('/star')) {
      routeKey = `${req.method} /api/mail/emails/:id/star`;
    } else {
      // Handle GET /api/mail/emails/:id
      routeKey = `${req.method} /api/mail/emails/:id`;
    }
  } else if (routeKey.includes('/api/admin/users/')) {
    if (url.pathname.includes('/password')) {
      routeKey = `${req.method} /api/admin/users/:id/password`;
    } else {
      routeKey = `${req.method} /api/admin/users/:id`;
    }
  }
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  const handler = routes[routeKey];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }
  
  try {
    const userId = await verifyToken(req.headers.authorization);

    // Validate CSRF token for authenticated state-changing requests
    if (userId && !validateCsrfToken(req, res)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'CSRF token validation failed', status: 403 }));
      return;
    }

    // Allow larger bodies for vCard import and bulk operations
    let maxBodySize = 1000; // Default for most endpoints
    if (routeKey === 'POST /api/contacts/import') {
      maxBodySize = 500000; // vCard import can be large
    } else if (
      routeKey === 'POST /api/mail/emails/bulk-update' ||
      routeKey === 'POST /api/mail/emails/bulk-delete' ||
      routeKey === 'POST /api/mail/emails/bulk-move' ||
      routeKey === 'POST /api/mail/send' ||
      routeKey === 'POST /api/mail/sync'
    ) {
      maxBodySize = 50000; // Bulk operations and mail operations need more space (100 emails * ~36 chars UUID + JSON overhead)
    }
    const body = await parseBody(req, maxBodySize);

    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Request body too large (max ${maxBodySize} characters)` }));
      return;
    }

    const result = await handler(req, userId, body, res);

    // Raw response (used by vCard export and attachments)
    if (result.__raw) {
      const filename = result.__filename || 'download';
      // Properly encode filename for Content-Disposition header (RFC 5987)
      const encodedFilename = encodeURIComponent(filename);
      const contentDisposition = `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`;
      
      res.writeHead(200, {
        'Content-Type': result.__contentType || 'application/octet-stream',
        'Content-Disposition': contentDisposition,
        'Cache-Control': 'no-cache',
      });
      res.end(result.__raw);
      return;
    }
    
    const status = result.status || 200;
    delete result.status;
    
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    console.error('Request error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
}

// Start server
async function start() {
  await initDatabase();
  
  const server = http.createServer(handleRequest);
  
  server.listen(PORT, () => {
    console.log(`✓ UniHub API server running on port ${PORT}`);
  });
  
  // Periodic mail sync every 10 minutes
  setInterval(async () => {
    try {
      const [accounts] = await db.execute(
        'SELECT id, email_address FROM mail_accounts WHERE is_active = TRUE'
      );
      console.log(`\n[${new Date().toISOString()}] Starting periodic mail sync for ${accounts.length} accounts...`);
      for (const account of accounts) {
        syncMailAccount(account.id).catch(err => 
          console.error(`Failed to sync ${account.email_address}:`, err.message)
        );
      }
    } catch (error) {
      console.error('Periodic sync error:', error);
    }
  }, 10 * 60 * 1000); // 10 minutes
  
  // Clean up expired sessions every hour to prevent table bloat
  setInterval(async () => {
    try {
      const [result] = await db.execute(
        'DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()'
      );
      if (result.affectedRows > 0) {
        console.log(`[CLEANUP] Deleted ${result.affectedRows} expired session(s)`);
      }
    } catch (error) {
      console.error('[CLEANUP] Error cleaning expired sessions:', error.message);
    }
  }, 60 * 60 * 1000); // 1 hour
  
  // Database connection pool health check and cleanup every 15 minutes
  setInterval(async () => {
    try {
      // Test connection pool health with a simple query
      await db.execute('SELECT 1');
      
      // Get pool statistics (mysql2 pool internal structure)
      const pool = db.pool;
      if (pool && pool._allConnections) {
        const totalConnections = pool._allConnections.length || 0;
        const freeConnections = pool._freeConnections?.length || 0;
        const activeConnections = totalConnections - freeConnections;
        const queuedRequests = pool._connectionQueue?.length || 0;
        
        console.log(`[DB POOL] Total: ${totalConnections}, Active: ${activeConnections}, Free: ${freeConnections}, Queued: ${queuedRequests}`);
        
        // If we're using too many connections, log a warning (warn at 80% usage)
        if (activeConnections > 40) {
          console.warn(`[DB POOL] ⚠ High connection usage: ${activeConnections}/50 connections in use`);
        }
        
        // If we have many idle connections, we can let them timeout naturally
        if (freeConnections > 8) {
          console.log(`[DB POOL] Many idle connections (${freeConnections}), will timeout naturally`);
        }
      }
    } catch (error) {
      console.error('[DB POOL] Health check error:', error.message);
      // Try to reconnect if connection is lost
      try {
        await db.execute('SELECT 1');
        console.log('[DB POOL] Reconnection successful');
      } catch (reconnectError) {
        console.error('[DB POOL] Reconnection failed:', reconnectError.message);
      }
    }
  }, 15 * 60 * 1000); // 15 minutes
  
  console.log('✓ Periodic mail sync enabled (every 10 minutes)');
  console.log('✓ Expired session cleanup enabled (every hour)');
  console.log('✓ Database connection pool health check enabled (every 15 minutes)');
}

start();
