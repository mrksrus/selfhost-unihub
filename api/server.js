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
const tls = require('tls');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { getCalendarEventIdFromPath, getCalendarSubtaskIdFromPath } = require('./calendar-route-utils');

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
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const BOOTSTRAP_ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
const BOOTSTRAP_ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === 'true';
const TRUSTED_MAIL_HOSTS = (process.env.TRUSTED_MAIL_HOSTS || '')
  .split(',')
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);
const AUTH_COOKIE_NAME = 'auth-token';

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

const KNOWN_MAIL_HOST_SUFFIXES = [
  'gmail.com',
  'googlemail.com',
  'mail.me.com',
  'icloud.com',
  'yahoo.com',
  'outlook.com',
  'office365.com',
  'hotmail.com',
  'live.com',
];

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase();
}

function isKnownMailProviderHost(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return false;
  return KNOWN_MAIL_HOST_SUFFIXES.some(suffix => normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`));
}

function hostInAllowlist(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return false;
  return TRUSTED_MAIL_HOSTS.some(allowed => normalizedHost === allowed || normalizedHost.endsWith(`.${allowed}`));
}

function toBooleanFlag(value) {
  return value === true || value === 1 || value === '1';
}

function isSelfSignedTlsError(message) {
  const normalized = String(message || '').toUpperCase();
  if (!normalized) return false;
  return (
    normalized.includes('SELF SIGNED') ||
    normalized.includes('SELF-SIGNED') ||
    normalized.includes('SELF_SIGNED') ||
    normalized.includes('DEPTH_ZERO_SELF_SIGNED_CERT') ||
    normalized.includes('SELF_SIGNED_CERT_IN_CHAIN')
  );
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

function isPrivateOrLocalIP(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return false;
}

async function assessMailHost(host, port) {
  const normalizedHost = normalizeHost(host);
  const knownProvider = isKnownMailProviderHost(normalizedHost);
  const allowlisted = hostInAllowlist(normalizedHost);
  const reasons = [];

  if (!knownProvider && !allowlisted) {
    reasons.push('unknown_provider');
  }

  let resolvedAddresses = [];
  let resolveError = null;
  try {
    if (net.isIP(normalizedHost)) {
      resolvedAddresses = [normalizedHost];
    } else if (normalizedHost) {
      const lookup = await dns.lookup(normalizedHost, { all: true, verbatim: true });
      resolvedAddresses = lookup.map(entry => entry.address);
    }
  } catch (error) {
    resolveError = error.message;
  }

  const privateAddresses = resolvedAddresses.filter(isPrivateOrLocalIP);
  if (privateAddresses.length > 0 && !allowlisted) {
    reasons.push('private_or_local_address');
  }

  return {
    host: normalizedHost,
    port: Number(port) || null,
    knownProvider,
    allowlisted,
    unknownProvider: !knownProvider && !allowlisted,
    blocked: privateAddresses.length > 0 && !allowlisted,
    reasons,
    resolvedAddresses,
    privateAddresses,
    resolveError,
  };
}

function fetchTlsCertificate(host, port) {
  const normalizedHost = normalizeHost(host);
  const numericPort = Number(port);
  if (!normalizedHost || !numericPort) {
    return Promise.resolve({ error: 'Missing host or port' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const socket = tls.connect({
      host: normalizedHost,
      port: numericPort,
      servername: normalizedHost,
      rejectUnauthorized: false,
      timeout: 7000,
    }, () => {
      if (settled) return;
      settled = true;
      const cert = socket.getPeerCertificate(true);
      const authorizationError = socket.authorizationError || null;
      socket.end();
      if (!cert || Object.keys(cert).length === 0) {
        resolve({ error: 'No certificate presented' });
        return;
      }
      resolve({
        subject: cert.subject || null,
        issuer: cert.issuer || null,
        valid_from: cert.valid_from || null,
        valid_to: cert.valid_to || null,
        fingerprint: cert.fingerprint || null,
        fingerprint256: cert.fingerprint256 || null,
        serialNumber: cert.serialNumber || null,
        authorized: socket.authorized === true,
        authorizationError,
        selfSigned: isSelfSignedTlsError(authorizationError),
      });
    });

    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ error: error.message });
    });
    socket.on('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ error: 'TLS handshake timed out' });
    });
  });
}

async function buildMailHostTrustResult({ imap_host, imap_port, smtp_host, smtp_port }) {
  const [imapAssessment, smtpAssessment] = await Promise.all([
    assessMailHost(imap_host, imap_port || 993),
    assessMailHost(smtp_host, smtp_port || 587),
  ]);
  const assessments = {
    imap: imapAssessment,
    smtp: smtpAssessment,
  };

  const blocked = imapAssessment.blocked || smtpAssessment.blocked;
  const warnings = [];
  if (imapAssessment.unknownProvider) warnings.push(`IMAP host "${imapAssessment.host}" is not a known provider.`);
  if (smtpAssessment.unknownProvider) warnings.push(`SMTP host "${smtpAssessment.host}" is not a known provider.`);
  if (imapAssessment.blocked) warnings.push(`IMAP host "${imapAssessment.host}" resolves to a private/local address.`);
  if (smtpAssessment.blocked) warnings.push(`SMTP host "${smtpAssessment.host}" resolves to a private/local address.`);

  const [imapCertificate, smtpCertificate] = await Promise.all([
    fetchTlsCertificate(imapAssessment.host, imapAssessment.port || 993),
    fetchTlsCertificate(smtpAssessment.host, smtpAssessment.port || 587),
  ]);
  const certificates = {
    imap: imapCertificate,
    smtp: smtpCertificate,
  };
  const imapSelfSigned = Boolean(certificates.imap && !certificates.imap.error && certificates.imap.selfSigned);
  const smtpSelfSigned = Boolean(certificates.smtp && !certificates.smtp.error && certificates.smtp.selfSigned);
  const requiresInsecureTls = imapSelfSigned || smtpSelfSigned;
  const requiresConfirmation =
    imapAssessment.unknownProvider ||
    smtpAssessment.unknownProvider ||
    requiresInsecureTls;

  if (imapSelfSigned) {
    warnings.push(`IMAP certificate for "${imapAssessment.host}" is self-signed (${certificates.imap.authorizationError || 'untrusted'}).`);
  }
  if (smtpSelfSigned) {
    warnings.push(`SMTP certificate for "${smtpAssessment.host}" is self-signed (${certificates.smtp.authorizationError || 'untrusted'}).`);
  }

  return {
    blocked,
    requiresConfirmation,
    requiresInsecureTls,
    warnings,
    assessments,
    certificates,
  };
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
      // Format date as ISO string for IMAP SINCE search (nested array format required)
      const sinceDateStr = sinceDate.toISOString();
      searchCriteria = [['SINCE', sinceDateStr]];
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
    const uploadsRoot = '/app/uploads/attachments';
    const uploadsDir = path.join(uploadsRoot, account.user_id);
    
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
                'INSERT INTO email_attachments (id, email_id, user_id, filename, content_type, size_bytes, storage_path, content_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [
                  attachmentId,
                  emailId,
                  account.user_id,
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
    
    const allowSelfSigned = toBooleanFlag(account.allow_self_signed);
    const imapPort = account.imap_port || 993;
    const config = {
      imap: {
        user: account.username || account.email_address,
        password,
        host: account.imap_host,
        port: imapPort,
        tls: true,
        tlsOptions: { 
          rejectUnauthorized: !allowSelfSigned,
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
    } else if (isSelfSignedTlsError(errorMsg)) {
      friendlyError = 'Server uses a self-signed TLS certificate. Review the certificate and confirm trust to continue.';
    } else if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timeout')) {
      friendlyError = 'Connection timeout. Check server address and port.';
    } else if (errorMsg.includes('ENOTFOUND')) {
      friendlyError = 'Server not found. Check the IMAP host address.';
    } else if (errorMsg.includes('ECONNREFUSED')) {
      friendlyError = 'Connection refused. Check the IMAP port and server settings.';
    } else if (errorMsg.includes('Connection ended unexpectedly') || errorMsg.includes('ECONNRESET')) {
      friendlyError = 'Connection closed by server. Check your credentials and server settings.';
    }
    
    return {
      success: false,
      error: friendlyError,
      details: errorMsg,
      isSelfSignedCertificate: isSelfSignedTlsError(errorMsg),
    };
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
    
    const allowSelfSigned = toBooleanFlag(account.allow_self_signed);
    const imapPort = account.imap_port || 993;
    const config = {
      imap: {
        user: account.username || account.email_address,
        password,
        host: account.imap_host,
        port: imapPort,
        tls: true,
        tlsOptions: { 
          rejectUnauthorized: !allowSelfSigned,
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

async function sendEmail(accountId, { to, subject, body, isHtml = false, attachments = [] }) {
  try {
    // #region agent log
    debugLog('server.js:169', 'sendEmail START', { accountId, to, subjectLength: subject?.length || 0, bodyLength: body?.length || 0, isHtml, attachmentCount: Array.isArray(attachments) ? attachments.length : 0 }, 'H5');
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

    const allowSelfSigned = toBooleanFlag(account.allow_self_signed);
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
        rejectUnauthorized: !allowSelfSigned,
        servername: account.smtp_host, // SNI support for proper TLS handshake
      },
      connectionTimeout: 60000, // Connection timeout: 60 seconds
      greetingTimeout: 30000, // Greeting timeout: 30 seconds
      socketTimeout: 60000, // Socket timeout: 60 seconds
    });
    // #region agent log
    debugLog('server.js:189', 'Before SMTP sendMail', { smtpHost: account.smtp_host, smtpPort: account.smtp_port, from: account.email_address, to }, 'H5');
    // #endregion

    const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
    if (normalizedAttachments.length > 20) {
      throw new Error('Too many attachments (max 20)');
    }

    let totalAttachmentBytes = 0;
    const smtpAttachments = normalizedAttachments.map((attachment, index) => {
      if (!attachment || typeof attachment !== 'object') {
        throw new Error(`Invalid attachment at index ${index}`);
      }

      const filename = String(attachment.filename || `attachment-${index + 1}`);
      const contentType = String(attachment.contentType || 'application/octet-stream');
      const dataBase64 = String(attachment.dataBase64 || '');
      if (!dataBase64) {
        throw new Error(`Attachment "${filename}" is empty`);
      }
      const contentBuffer = Buffer.from(dataBase64, 'base64');
      if (contentBuffer.length > 15 * 1024 * 1024) {
        throw new Error(`Attachment "${filename}" exceeds 15MB limit`);
      }

      totalAttachmentBytes += contentBuffer.length;
      return {
        filename,
        contentType,
        content: contentBuffer,
      };
    });

    if (totalAttachmentBytes > 25 * 1024 * 1024) {
      throw new Error('Total attachment size exceeds 25MB limit');
    }

    const info = await transporter.sendMail({
      from: `${account.display_name || account.email_address} <${account.email_address}>`,
      to,
      subject,
      text: isHtml ? undefined : body,
      html: isHtml ? body : undefined,
      attachments: smtpAttachments.length > 0 ? smtpAttachments : undefined,
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
          smtpAttachments.length > 0 ? 1 : 0,
          new Date(),
          'sent',
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
  if (!ENCRYPTION_KEY) {
    console.error('✗ Missing ENCRYPTION_KEY. Set it in docker-compose.yml before starting.');
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
    timezone VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_email (email),
    INDEX idx_users_active (is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  try {
    await db.execute(`ALTER TABLE users ADD COLUMN timezone VARCHAR(64) NULL`);
  } catch (error) {
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: users.timezone column may already exist');
    }
  }

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
    INDEX idx_contacts_favorite (user_id, is_favorite),
    INDEX idx_contacts_user_fav_name (user_id, is_favorite, first_name, last_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Backfill composite index for faster sorted contact lists on existing installs
  try {
    await db.execute(
      'ALTER TABLE contacts ADD INDEX idx_contacts_user_fav_name (user_id, is_favorite, first_name, last_name)'
    );
  } catch (e) {
    // Ignore if index already exists or ALTER not supported
  }

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
    done_at DATETIME NULL COMMENT 'Timestamp when task was marked as done',
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
  
  // Add done_at column if it doesn't exist (for existing installations)
  try {
    await db.execute(`ALTER TABLE calendar_events ADD COLUMN done_at DATETIME NULL COMMENT 'Timestamp when task was marked as done'`);
  } catch (error) {
    // Column already exists, ignore error
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: done_at column may already exist');
    }
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS calendar_event_subtasks (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    event_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    is_done BOOLEAN DEFAULT FALSE,
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_subtasks_event (event_id),
    INDEX idx_subtasks_user (user_id),
    INDEX idx_subtasks_order (event_id, position)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

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
    allow_self_signed BOOLEAN DEFAULT FALSE,
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
  try {
    await db.execute(`ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS allow_self_signed BOOLEAN DEFAULT FALSE AFTER encrypted_password`);
  } catch (e) {
    // Ignore when unsupported or already exists
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
    user_id CHAR(36) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(100),
    size_bytes BIGINT,
    storage_path TEXT,
    content_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_attachments_email (email_id),
    INDEX idx_attachments_user (user_id),
    INDEX idx_attachments_content_id (content_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Migrations for older installs
  try {
    await db.execute(`ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS content_id VARCHAR(255) AFTER storage_path`);
  } catch (e) {
    // Ignore when unsupported or already exists
  }
  try {
    await db.execute(`ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS user_id CHAR(36) NULL AFTER email_id`);
  } catch (e) {
    // Ignore when unsupported or already exists
  }
  try {
    await db.execute(
      `UPDATE email_attachments a
       INNER JOIN emails e ON a.email_id = e.id
       SET a.user_id = e.user_id
       WHERE a.user_id IS NULL`
    );
  } catch (e) {
    // Ignore migration failures and continue startup
  }
  try {
    await db.execute(`ALTER TABLE email_attachments MODIFY COLUMN user_id CHAR(36) NOT NULL`);
  } catch (e) {
    // Ignore if already NOT NULL or unsupported
  }
  try {
    await db.execute(`CREATE INDEX idx_attachments_user ON email_attachments(user_id)`);
  } catch (e) {
    // Ignore duplicate index errors
  }
  try {
    await db.execute(`CREATE INDEX idx_attachments_content_id ON email_attachments(content_id)`);
  } catch (e) {
    // Ignore duplicate index errors
  }

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

  // Bootstrap admin user from environment if no users exist yet
  const [rows] = await db.execute('SELECT COUNT(*) as count FROM users');
  if (rows[0].count === 0) {
    if (!BOOTSTRAP_ADMIN_EMAIL || !BOOTSTRAP_ADMIN_PASSWORD) {
      console.error('✗ Missing BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD for first-run setup.');
      process.exit(1);
    }
    if (BOOTSTRAP_ADMIN_PASSWORD.length < 12) {
      console.error('✗ BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
      process.exit(1);
    }
    const adminHash = await hashPassword(BOOTSTRAP_ADMIN_PASSWORD);
    await db.execute(
      `INSERT INTO users (id, email, password_hash, full_name, email_verified, role)
       VALUES (UUID(), ?, ?, 'Bootstrap Admin', TRUE, 'admin')`,
      [BOOTSTRAP_ADMIN_EMAIL, adminHash]
    );
    console.log(`✓ Bootstrap admin created (${BOOTSTRAP_ADMIN_EMAIL})`);
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
  if (TRUST_PROXY_HEADERS) {
    return req.headers['x-real-ip'] ||
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      'unknown';
  }
  return req.socket?.remoteAddress || 'unknown';
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

function appendSetCookie(res, cookieValue) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieValue]);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
    return;
  }
  res.setHeader('Set-Cookie', [existing, cookieValue]);
}

function parseCookies(req) {
  const rawCookieHeader = req.headers.cookie || '';
  if (!rawCookieHeader) return {};
  return rawCookieHeader.split(';').reduce((acc, part) => {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) return acc;
    const joinedValue = rawValue.join('=');
    acc[rawKey] = decodeURIComponent(joinedValue || '');
    return acc;
  }, {});
}

function getAuthTokenFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const cookies = parseCookies(req);
  return cookies[AUTH_COOKIE_NAME] || null;
}

// Set CSRF token cookie
function setCsrfCookie(res, token) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 21); // Match JWT expiry
  // Note: Secure flag requires HTTPS. For HTTP (development), remove Secure flag
  const isSecure = process.env.NODE_ENV === 'production';
  const secureFlag = isSecure ? 'Secure;' : '';
  appendSetCookie(res, `csrf-token=${token}; HttpOnly; ${secureFlag} SameSite=Strict; Path=/; Expires=${expires.toUTCString()}`);
}

function clearCsrfCookie(res) {
  const isSecure = process.env.NODE_ENV === 'production';
  const secureFlag = isSecure ? 'Secure;' : '';
  appendSetCookie(res, `csrf-token=; HttpOnly; ${secureFlag} SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

function setAuthCookie(res, token) {
  const expires = new Date();
  expires.setDate(expires.getDate() + 21); // Match session expiry
  const isSecure = process.env.NODE_ENV === 'production';
  const secureFlag = isSecure ? 'Secure;' : '';
  appendSetCookie(res, `${AUTH_COOKIE_NAME}=${token}; HttpOnly; ${secureFlag} SameSite=Strict; Path=/; Expires=${expires.toUTCString()}`);
}

function clearAuthCookie(res) {
  const isSecure = process.env.NODE_ENV === 'production';
  const secureFlag = isSecure ? 'Secure;' : '';
  appendSetCookie(res, `${AUTH_COOKIE_NAME}=; HttpOnly; ${secureFlag} SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

// JWT verification + session check
async function verifyToken(req) {
  const token = getAuthTokenFromRequest(req);
  if (!token) return null;
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
          `SELECT s.user_id, s.expires_at, u.is_active
           FROM sessions s
           INNER JOIN users u ON u.id = s.user_id
           WHERE s.token = ?
           LIMIT 1`,
          [token]
        );

        if (sessions.length === 0) return null;
        const session = sessions[0];
        if (new Date(session.expires_at) < new Date()) return null;
        if (!session.is_active) return null;

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
    let currentSize = 0;
    let resolved = false;
    req.on('data', chunk => {
      if (resolved) return;
      currentSize += chunk.length;
      if (currentSize > maxSize) {
        resolved = true;
        resolve(null);
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (resolved) return;
      if (body.length > maxSize) { resolve(null); return; }
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => {
      if (!resolved) resolve(null);
    });
  });
}

function getAllowedOriginForRequest(req) {
  const requestOrigin = req.headers.origin;
  if (!requestOrigin) return null;

  if (ALLOWED_ORIGINS.length > 0) {
    return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : null;
  }

  const host = req.headers.host;
  if (!host) return null;
  const sameHostOrigins = new Set([`http://${host}`, `https://${host}`]);
  return sameHostOrigins.has(requestOrigin) ? requestOrigin : null;
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

function parseDatetimeToMillis(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.getTime();

  const raw = String(value).trim();
  if (!raw) return null;

  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const hasTimezone = /[zZ]$|[+-]\d{2}:\d{2}$/.test(normalized);
  const isoValue = hasTimezone ? normalized : `${normalized}Z`;
  const timestamp = new Date(isoValue).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function toMysqlDatetime(value) {
  const timestamp = parseDatetimeToMillis(value);
  if (timestamp === null) return null;
  return new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');
}

function getCalendarEventIdFromReq(req) {
  return getCalendarEventIdFromPath(req.url, req.headers.host);
}

function getCalendarSubtaskIdFromReq(req) {
  return getCalendarSubtaskIdFromPath(req.url, req.headers.host);
}

function serializeCalendarSubtask(row) {
  return {
    ...row,
    is_done: !!row.is_done,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function serializeCalendarEvent(row, subtasks = []) {
  return {
    ...row,
    all_day: !!row.all_day,
    is_todo_only: !!row.is_todo_only,
    start_time: row.start_time instanceof Date ? row.start_time.toISOString() : row.start_time,
    end_time: row.end_time instanceof Date ? row.end_time.toISOString() : row.end_time,
    done_at: row.done_at instanceof Date ? row.done_at.toISOString() : (row.done_at || null),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    reminders: row.reminders ? (typeof row.reminders === 'string' ? JSON.parse(row.reminders) : row.reminders) : null,
    subtasks,
  };
}

async function getCalendarSubtasksForEvents(userId, eventIds) {
  if (!eventIds || eventIds.length === 0) return new Map();

  const placeholders = eventIds.map(() => '?').join(', ');
  const [rows] = await db.execute(
    `SELECT * FROM calendar_event_subtasks WHERE user_id = ? AND event_id IN (${placeholders}) ORDER BY position ASC, created_at ASC`,
    [userId, ...eventIds]
  );

  const grouped = new Map();
  rows.forEach((row) => {
    const eventSubtasks = grouped.get(row.event_id) || [];
    eventSubtasks.push(serializeCalendarSubtask(row));
    grouped.set(row.event_id, eventSubtasks);
  });
  return grouped;
}

async function getCalendarEventWithSubtasks(userId, eventId) {
  const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
  if (events.length === 0) return null;

  const [subtasks] = await db.execute(
    'SELECT * FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position ASC, created_at ASC',
    [eventId, userId]
  );
  return serializeCalendarEvent(events[0], subtasks.map(serializeCalendarSubtask));
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
      const result = { csrfToken, user: { id: newUserId, email, full_name, role: 'user', timezone: null } };
      setAuthCookie(res, token);
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
            'SELECT id, email, password_hash, full_name, role, is_active, timezone FROM users WHERE email = ?',
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
      const result = { csrfToken, user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, timezone: user.timezone ?? null } };
      setAuthCookie(res, token);
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
      const token = getAuthTokenFromRequest(req);
      if (token) {
        await db.execute('DELETE FROM sessions WHERE token = ?', [token]);
      }
      clearAuthCookie(res);
      clearCsrfCookie(res);
      return { message: 'Signed out successfully' };
    } catch (error) {
      return { error: 'Failed to sign out', status: 500 };
    }
  },
  
  'GET /api/auth/me': async (req, userId, body, res) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [users] = await db.execute(
        'SELECT id, email, full_name, avatar_url, role, timezone FROM users WHERE id = ?',
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

    const { full_name, timezone } = body;
    if (full_name === undefined || full_name === null) {
      return { error: 'Full name is required', status: 400 };
    }
    const tzValue = timezone === undefined || timezone === null || (typeof timezone === 'string' && timezone.trim() === '')
      ? null
      : (typeof timezone === 'string' && timezone.length <= 64 ? timezone.trim() : null);
    if (timezone !== undefined && timezone !== null && typeof timezone === 'string' && timezone.trim() !== '' && tzValue === null) {
      return { error: 'Timezone must be at most 64 characters', status: 400 };
    }

    try {
      await db.execute('UPDATE users SET full_name = ?, timezone = ? WHERE id = ?', [full_name.trim() || null, tzValue, userId]);
      const [users] = await db.execute(
        'SELECT id, email, full_name, avatar_url, role, timezone FROM users WHERE id = ?',
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
        `SELECT COUNT(*) as count
         FROM calendar_events
         WHERE user_id = ?
           AND start_time >= UTC_TIMESTAMP()
           AND is_todo_only = FALSE
           AND (todo_status IS NULL OR todo_status NOT IN ('done', 'cancelled'))`,
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
      const url = new URL(req.url, `http://${req.headers.host}`);
      const q = (url.searchParams.get('q') || '').trim();
      const group = url.searchParams.get('group') || 'all';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '2000', 10), 2000);

      // Only select fields needed on the contacts screen to reduce payload size.
      let query = 'SELECT id, user_id, first_name, last_name, email, phone, company, job_title, notes, avatar_url, is_favorite FROM contacts WHERE user_id = ?';
      const params = [userId];

      // Group filter: name_only = has name but no email/phone; number_or_email_only = has email/phone but no name
      if (group === 'name_only') {
        query += " AND (TRIM(COALESCE(first_name,'')) != '' OR TRIM(COALESCE(last_name,'')) != '')";
        query += " AND (TRIM(COALESCE(email,'')) = '' AND TRIM(COALESCE(phone,'')) = '')";
      } else if (group === 'number_or_email_only') {
        query += " AND (TRIM(COALESCE(email,'')) != '' OR TRIM(COALESCE(phone,'')) != '')";
        query += " AND TRIM(COALESCE(first_name,'')) = '' AND TRIM(COALESCE(last_name,'')) = ''";
      }

      // Server-side search (indexed fields + phone/company for quick find)
      if (q.length > 0) {
        const like = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
        query += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR company LIKE ?)';
        params.push(like, like, like, like, like);
      }

      query += ' ORDER BY is_favorite DESC, first_name ASC, last_name ASC LIMIT ?';
      params.push(limit);

      const [contacts] = await db.execute(query, params);
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
    const firstName = first_name != null ? String(first_name).trim() : '';

    try {
      const id = req.url.split('/').pop();
      
      await db.execute(
        'UPDATE contacts SET first_name = ?, last_name = ?, email = ?, phone = ?, company = ?, job_title = ?, notes = ? WHERE id = ? AND user_id = ?',
        [firstName, last_name || null, email || null, phone || null, company || null, job_title || null, notes || null, id, userId]
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

  'POST /api/contacts/bulk-delete': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { ids } = body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return { error: 'ids array is required', status: 400 };
    }

    try {
      const placeholders = ids.map(() => '?').join(',');
      const [result] = await db.execute(
        `DELETE FROM contacts WHERE user_id = ? AND id IN (${placeholders})`,
        [userId, ...ids]
      );
      const deleted = result.affectedRows || 0;
      return { message: `${deleted} contact(s) deleted`, deleted };
    } catch (error) {
      return { error: 'Failed to delete contacts', status: 500 };
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
      const subtasksByEventId = await getCalendarSubtasksForEvents(userId, rows.map((row) => row.id));
      const events = rows.map((row) => serializeCalendarEvent(row, subtasksByEventId.get(row.id) || []));
      return { events };
    } catch (error) {
      console.error('Get events error:', error);
      return { error: 'Failed to get events', status: 500 };
    }
  },
  
  'POST /api/calendar/events': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!body.title?.trim()) return { error: 'Title is required', status: 400 };

    try {
      const { title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, is_todo_only } = body;
      let start = toMysqlDatetime(start_time);
      let end = toMysqlDatetime(end_time);

      // For unscheduled todo-only tasks we persist a default 30-minute window at "now".
      if (!!is_todo_only && (!start || !end)) {
        const now = Date.now();
        start = toMysqlDatetime(new Date(now).toISOString());
        end = toMysqlDatetime(new Date(now + 30 * 60 * 1000).toISOString());
      }

      if (!start || !end) return { error: 'Valid start and end time are required', status: 400 };
      if (parseDatetimeToMillis(end) < parseDatetimeToMillis(start)) {
        return { error: 'End time must be after start time', status: 400 };
      }

      const eventId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO calendar_events (id, user_id, title, description, start_time, end_time, all_day, location, color, recurrence, reminder_minutes, reminders, is_todo_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [eventId, userId, title.trim(), description || null, start, end, !!all_day, location?.trim() || null, color || '#22c55e', recurrence || null, reminder_minutes ?? null, reminders ? JSON.stringify(reminders) : null, !!is_todo_only]
      );

      const event = await getCalendarEventWithSubtasks(userId, eventId);
      return { event };
    } catch (error) {
      console.error('Create event error:', error);
      return { error: error.message || 'Failed to create event', status: 500 };
    }
  },
  
  'PUT /api/calendar/events/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = getCalendarEventIdFromReq(req);
      if (!id) return { error: 'Invalid event id', status: 400 };

      const [events] = await db.execute('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', [id, userId]);
      if (events.length === 0) return { error: 'Event not found', status: 404 };

      const currentEvent = events[0];
      const updates = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(body, 'title')) {
        if (!body.title?.trim()) return { error: 'Title is required', status: 400 };
        updates.push('title = ?');
        params.push(body.title.trim());
      }

      if (Object.prototype.hasOwnProperty.call(body, 'description')) {
        updates.push('description = ?');
        params.push(body.description || null);
      }

      const startProvided = Object.prototype.hasOwnProperty.call(body, 'start_time');
      const endProvided = Object.prototype.hasOwnProperty.call(body, 'end_time');
      const resolvedStart = startProvided ? toMysqlDatetime(body.start_time) : toMysqlDatetime(currentEvent.start_time);
      const resolvedEnd = endProvided ? toMysqlDatetime(body.end_time) : toMysqlDatetime(currentEvent.end_time);

      if (startProvided && !resolvedStart) return { error: 'Valid start time is required', status: 400 };
      if (endProvided && !resolvedEnd) return { error: 'Valid end time is required', status: 400 };
      if (!resolvedStart || !resolvedEnd) return { error: 'Valid start and end time are required', status: 400 };
      if (parseDatetimeToMillis(resolvedEnd) < parseDatetimeToMillis(resolvedStart)) {
        return { error: 'End time must be after start time', status: 400 };
      }

      if (startProvided) {
        updates.push('start_time = ?');
        params.push(resolvedStart);
      }
      if (endProvided) {
        updates.push('end_time = ?');
        params.push(resolvedEnd);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'all_day')) {
        updates.push('all_day = ?');
        params.push(!!body.all_day);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'location')) {
        updates.push('location = ?');
        params.push(body.location?.trim() || null);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'color')) {
        updates.push('color = ?');
        params.push(body.color || '#22c55e');
      }

      if (Object.prototype.hasOwnProperty.call(body, 'recurrence')) {
        updates.push('recurrence = ?');
        params.push(body.recurrence || null);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'reminder_minutes')) {
        updates.push('reminder_minutes = ?');
        params.push(body.reminder_minutes ?? null);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'reminders')) {
        if (body.reminders !== null && body.reminders !== undefined && !Array.isArray(body.reminders)) {
          return { error: 'Reminders must be an array or null', status: 400 };
        }
        updates.push('reminders = ?');
        params.push(body.reminders ? JSON.stringify(body.reminders) : null);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'is_todo_only')) {
        updates.push('is_todo_only = ?');
        params.push(!!body.is_todo_only);
      }

      if (updates.length > 0) {
        params.push(id, userId);
        await db.execute(
          `UPDATE calendar_events SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
          params
        );
      }

      const updatedEvent = await getCalendarEventWithSubtasks(userId, id);
      return { event: updatedEvent };
    } catch (error) {
      console.error('Update event error:', error);
      return { error: error.message || 'Failed to update event', status: 500 };
    }
  },

  'PUT /api/calendar/events/:id/todo-status': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const id = getCalendarEventIdFromReq(req);
      if (!id) return { error: 'Invalid event id', status: 400 };

      if (!Object.prototype.hasOwnProperty.call(body, 'todo_status')) {
        return { error: 'todo_status is required', status: 400 };
      }

      const { todo_status, start_time, end_time } = body;
      if (!['done', 'changed', 'time_moved', 'cancelled', null].includes(todo_status)) {
        return { error: 'Invalid todo_status', status: 400 };
      }

      const [currentEvents] = await db.execute(
        'SELECT start_time, end_time FROM calendar_events WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (currentEvents.length === 0) return { error: 'Event not found', status: 404 };

      const updates = ['todo_status = ?'];
      const params = [todo_status || null];

      if (todo_status === 'done') {
        updates.push('done_at = NOW()');
      } else {
        updates.push('done_at = NULL');
      }

      if (todo_status === 'time_moved' && (start_time || end_time)) {
        const currentStartMs = parseDatetimeToMillis(currentEvents[0].start_time);
        const currentEndMs = parseDatetimeToMillis(currentEvents[0].end_time);
        const durationMs = currentStartMs !== null && currentEndMs !== null ? Math.max(0, currentEndMs - currentStartMs) : 0;

        const parsedStart = start_time ? toMysqlDatetime(start_time) : null;
        const parsedEnd = end_time ? toMysqlDatetime(end_time) : null;
        if (start_time && !parsedStart) return { error: 'Invalid start_time for time move', status: 400 };
        if (end_time && !parsedEnd) return { error: 'Invalid end_time for time move', status: 400 };

        let movedStart = parsedStart;
        let movedEnd = parsedEnd;

        if (movedStart && !movedEnd) {
          const computedEndMs = (parseDatetimeToMillis(movedStart) || 0) + durationMs;
          movedEnd = toMysqlDatetime(new Date(computedEndMs).toISOString());
        } else if (!movedStart && movedEnd) {
          const computedStartMs = (parseDatetimeToMillis(movedEnd) || 0) - durationMs;
          movedStart = toMysqlDatetime(new Date(computedStartMs).toISOString());
        }

        if (movedStart && movedEnd && parseDatetimeToMillis(movedEnd) < parseDatetimeToMillis(movedStart)) {
          return { error: 'End time must be after start time', status: 400 };
        }

        if (movedStart && movedEnd) {
          updates.push('start_time = ?', 'end_time = ?');
          params.push(movedStart, movedEnd);
        }
      }

      const updateQuery = `UPDATE calendar_events SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`;
      params.push(id, userId);
      await db.execute(updateQuery, params);

      const updatedEvent = await getCalendarEventWithSubtasks(userId, id);
      return { event: updatedEvent };
    } catch (error) {
      console.error('Update todo status error:', error);
      return { error: error.message || 'Failed to update todo status', status: 500 };
    }
  },

  'GET /api/calendar/events/:id/subtasks': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      if (!eventId) return { error: 'Invalid event id', status: 400 };

      const [events] = await db.execute('SELECT id FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
      if (events.length === 0) return { error: 'Event not found', status: 404 };

      const [subtasks] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position ASC, created_at ASC',
        [eventId, userId]
      );
      return { subtasks: subtasks.map(serializeCalendarSubtask) };
    } catch (error) {
      console.error('Get subtasks error:', error);
      return { error: error.message || 'Failed to fetch subtasks', status: 500 };
    }
  },

  'POST /api/calendar/events/:id/subtasks': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    if (!body.title?.trim()) return { error: 'Subtask title is required', status: 400 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      if (!eventId) return { error: 'Invalid event id', status: 400 };

      const [events] = await db.execute('SELECT id FROM calendar_events WHERE id = ? AND user_id = ?', [eventId, userId]);
      if (events.length === 0) return { error: 'Event not found', status: 404 };

      let position = Number.isInteger(body.position) && body.position >= 0 ? body.position : null;
      if (position === null) {
        const [maxRows] = await db.execute(
          'SELECT COALESCE(MAX(position), -1) AS max_position FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ?',
          [eventId, userId]
        );
        position = Number(maxRows[0]?.max_position ?? -1) + 1;
      } else {
        await db.execute(
          'UPDATE calendar_event_subtasks SET position = position + 1 WHERE event_id = ? AND user_id = ? AND position >= ?',
          [eventId, userId, position]
        );
      }

      const subtaskId = crypto.randomUUID();
      await db.execute(
        'INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, ?, ?)',
        [subtaskId, eventId, userId, body.title.trim(), !!body.is_done, position]
      );

      const [subtasks] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id = ?',
        [subtaskId, eventId, userId]
      );
      return { subtask: subtasks[0] ? serializeCalendarSubtask(subtasks[0]) : null };
    } catch (error) {
      console.error('Create subtask error:', error);
      return { error: error.message || 'Failed to create subtask', status: 500 };
    }
  },

  'PUT /api/calendar/events/:id/subtasks/:subtaskId': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      const subtaskId = getCalendarSubtaskIdFromReq(req);
      if (!eventId || !subtaskId) return { error: 'Invalid subtask route', status: 400 };

      const [existing] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id = ?',
        [subtaskId, eventId, userId]
      );
      if (existing.length === 0) return { error: 'Subtask not found', status: 404 };

      const updates = [];
      const params = [];

      if (Object.prototype.hasOwnProperty.call(body, 'title')) {
        if (!body.title?.trim()) return { error: 'Subtask title is required', status: 400 };
        updates.push('title = ?');
        params.push(body.title.trim());
      }

      if (Object.prototype.hasOwnProperty.call(body, 'is_done')) {
        updates.push('is_done = ?');
        params.push(!!body.is_done);
      }

      if (Object.prototype.hasOwnProperty.call(body, 'position')) {
        if (!Number.isInteger(body.position) || body.position < 0) {
          return { error: 'position must be a non-negative integer', status: 400 };
        }
        updates.push('position = ?');
        params.push(body.position);
      }

      if (updates.length > 0) {
        params.push(subtaskId, eventId, userId);
        await db.execute(
          `UPDATE calendar_event_subtasks SET ${updates.join(', ')} WHERE id = ? AND event_id = ? AND user_id = ?`,
          params
        );
      }

      const [subtasks] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id = ?',
        [subtaskId, eventId, userId]
      );
      return { subtask: subtasks[0] ? serializeCalendarSubtask(subtasks[0]) : null };
    } catch (error) {
      console.error('Update subtask error:', error);
      return { error: error.message || 'Failed to update subtask', status: 500 };
    }
  },

  'DELETE /api/calendar/events/:id/subtasks/:subtaskId': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      const subtaskId = getCalendarSubtaskIdFromReq(req);
      if (!eventId || !subtaskId) return { error: 'Invalid subtask route', status: 400 };

      const [result] = await db.execute(
        'DELETE FROM calendar_event_subtasks WHERE id = ? AND event_id = ? AND user_id = ?',
        [subtaskId, eventId, userId]
      );
      if (result.affectedRows === 0) return { error: 'Subtask not found', status: 404 };

      return { message: 'Subtask deleted' };
    } catch (error) {
      console.error('Delete subtask error:', error);
      return { error: error.message || 'Failed to delete subtask', status: 500 };
    }
  },

  'POST /api/calendar/events/:id/subtasks/reorder': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const eventId = getCalendarEventIdFromReq(req);
      if (!eventId) return { error: 'Invalid event id', status: 400 };

      const subtaskIds = Array.isArray(body.subtask_ids) ? body.subtask_ids : null;
      if (!subtaskIds || subtaskIds.length === 0) {
        return { error: 'subtask_ids must be a non-empty array', status: 400 };
      }

      const [existingRows] = await db.execute(
        'SELECT id FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ?',
        [eventId, userId]
      );
      const existingIds = new Set(existingRows.map((row) => row.id));
      if (existingIds.size !== subtaskIds.length || subtaskIds.some((id) => !existingIds.has(id))) {
        return { error: 'subtask_ids must include all subtasks for the event', status: 400 };
      }

      for (let index = 0; index < subtaskIds.length; index += 1) {
        await db.execute(
          'UPDATE calendar_event_subtasks SET position = ? WHERE id = ? AND event_id = ? AND user_id = ?',
          [index, subtaskIds[index], eventId, userId]
        );
      }

      const [subtasks] = await db.execute(
        'SELECT * FROM calendar_event_subtasks WHERE event_id = ? AND user_id = ? ORDER BY position ASC, created_at ASC',
        [eventId, userId]
      );
      return { subtasks: subtasks.map(serializeCalendarSubtask) };
    } catch (error) {
      console.error('Reorder subtasks error:', error);
      return { error: error.message || 'Failed to reorder subtasks', status: 500 };
    }
  },
  
  'DELETE /api/calendar/events/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const id = getCalendarEventIdFromReq(req);
      if (!id) return { error: 'Invalid event id', status: 400 };
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

      // Fetch unread email counts per account
      const [unreadRows] = await db.execute(
        'SELECT mail_account_id, COUNT(*) as unread_count FROM emails WHERE user_id = ? AND is_read = 0 GROUP BY mail_account_id',
        [userId]
      );

      const unreadByAccount = {};
      for (const row of unreadRows) {
        unreadByAccount[row.mail_account_id] = row.unread_count;
      }

      const accountsWithUnread = accounts.map((account) => ({
        ...account,
        unread_count: unreadByAccount[account.id] || 0,
      }));

      return { accounts: accountsWithUnread };
    } catch (error) {
      return { error: 'Failed to get mail accounts', status: 500 };
    }
  },

  'POST /api/mail/accounts/preflight': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    const { imap_host, imap_port, smtp_host, smtp_port } = body || {};
    if (!imap_host || !smtp_host) {
      return { error: 'IMAP and SMTP server addresses are required', status: 400 };
    }

    try {
      const trust = await buildMailHostTrustResult({
        imap_host,
        imap_port: imap_port || 993,
        smtp_host,
        smtp_port: smtp_port || 587,
      });

      if (trust.blocked) {
        return {
          error: 'Mail host resolves to a private/local address and is not allowlisted',
          status: 400,
          host_assessments: trust.assessments,
          warnings: trust.warnings,
        };
      }

      return {
        requires_confirmation: trust.requiresConfirmation,
        requires_insecure_tls: trust.requiresInsecureTls,
        warnings: trust.warnings,
        host_assessments: trust.assessments,
        certificates: trust.certificates,
      };
    } catch (error) {
      return { error: 'Failed to run mail host preflight', status: 500 };
    }
  },
  
  'POST /api/mail/accounts': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const {
        email_address,
        display_name,
        provider,
        username,
        imap_host,
        imap_port,
        smtp_host,
        smtp_port,
        encrypted_password,
        confirm_unknown_host,
        confirm_self_signed_certificate,
      } = body;
      
      if (!email_address || !encrypted_password) {
        return { error: 'Email address and password are required', status: 400 };
      }
      if (!imap_host || !smtp_host) {
        return { error: 'IMAP and SMTP server addresses are required', status: 400 };
      }

      const trust = await buildMailHostTrustResult({
        imap_host,
        imap_port: imap_port || 993,
        smtp_host,
        smtp_port: smtp_port || 587,
      });
      const confirmTrust = Boolean(confirm_unknown_host || confirm_self_signed_certificate);
      if (trust.blocked) {
        return {
          error: 'Mail host resolves to a private/local address and is not allowlisted',
          status: 400,
          warnings: trust.warnings,
          host_assessments: trust.assessments,
        };
      }
      if (trust.requiresConfirmation && !confirmTrust) {
        return {
          error: trust.requiresInsecureTls
            ? 'Mail server certificate is self-signed. Confirm trust before adding this account.'
            : 'Mail host is unknown. Confirm trust before adding this account.',
          status: 409,
          requires_confirmation: true,
          requires_insecure_tls: trust.requiresInsecureTls,
          warnings: trust.warnings,
          host_assessments: trust.assessments,
          certificates: trust.certificates,
        };
      }
      
      // Create temporary account object for testing
      const tempAccount = {
        email_address,
        username: username || email_address,
        imap_host,
        imap_port: imap_port || 993,
        encrypted_password: encrypt(encrypted_password),
        allow_self_signed: trust.requiresInsecureTls && confirmTrust,
      };
      
      // Test IMAP connection/auth first (fast, non-blocking)
      console.log(`[ACCOUNT] Testing IMAP connection for ${email_address}...`);
      const testResult = await testImapConnection(tempAccount);
      
      if (!testResult.success) {
        if (testResult.isSelfSignedCertificate && !tempAccount.allow_self_signed) {
          return {
            error: 'Mail server certificate is self-signed. Confirm trust before adding this account.',
            status: 409,
            requires_confirmation: true,
            requires_insecure_tls: true,
            warnings: trust.warnings,
            host_assessments: trust.assessments,
            certificates: trust.certificates,
          };
        }
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
        'INSERT INTO mail_accounts (id, user_id, email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password, allow_self_signed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [accountId, userId, email_address, display_name || null, provider, actualUsername, imap_host || null, imap_port || 993, smtp_host || null, smtp_port || 587, tempAccount.encrypted_password, tempAccount.allow_self_signed ? 1 : 0]
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
      const {
        email_address,
        display_name,
        username,
        imap_host,
        imap_port,
        smtp_host,
        smtp_port,
        encrypted_password,
        confirm_unknown_host,
        confirm_self_signed_certificate,
      } = body;
      
      // Verify account belongs to user
      const [accounts] = await db.execute(
        'SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };

      let allowSelfSignedUpdate = null;
      if (imap_host || smtp_host) {
        const [existing] = await db.execute(
          'SELECT imap_host, imap_port, smtp_host, smtp_port FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1',
          [id, userId]
        );
        const current = existing[0] || {};
        const trust = await buildMailHostTrustResult({
          imap_host: imap_host || current.imap_host,
          imap_port: imap_port || current.imap_port || 993,
          smtp_host: smtp_host || current.smtp_host,
          smtp_port: smtp_port || current.smtp_port || 587,
        });
        const confirmTrust = Boolean(confirm_unknown_host || confirm_self_signed_certificate);
        if (trust.blocked) {
          return {
            error: 'Mail host resolves to a private/local address and is not allowlisted',
            status: 400,
            warnings: trust.warnings,
            host_assessments: trust.assessments,
          };
        }
        if (trust.requiresConfirmation && !confirmTrust) {
          return {
            error: trust.requiresInsecureTls
              ? 'Mail server certificate is self-signed. Confirm trust before updating this account.'
              : 'Mail host is unknown. Confirm trust before updating this account.',
            status: 409,
            requires_confirmation: true,
            requires_insecure_tls: trust.requiresInsecureTls,
            warnings: trust.warnings,
            host_assessments: trust.assessments,
            certificates: trust.certificates,
          };
        }
        allowSelfSignedUpdate = trust.requiresInsecureTls ? 1 : 0;
      }
      
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
      if (allowSelfSignedUpdate !== null) { updates.push('allow_self_signed = ?'); params.push(allowSelfSignedUpdate); }
      
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
      const requestedLimit = parseInt(url.searchParams.get('limit') || '50', 10);
      const requestedOffset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
      const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
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
        'SELECT id, filename, content_type, size_bytes, content_id FROM email_attachments WHERE email_id = ? AND user_id = ? ORDER BY filename',
        [id, userId]
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
        `SELECT a.id, a.filename, a.content_type, a.storage_path, a.user_id
         FROM email_attachments a
         WHERE a.id = ? AND a.user_id = ?`,
        [attachmentId, userId]
      );
      
      if (attachments.length === 0) {
        return { error: 'Attachment not found', status: 404 };
      }
      
      const attachment = attachments[0];
      
      // Read file from storage (must stay under attachments root)
      try {
        const uploadsRoot = path.resolve('/app/uploads/attachments');
        const resolvedPath = path.resolve(attachment.storage_path || '');
        if (!resolvedPath.startsWith(`${uploadsRoot}${path.sep}`) && resolvedPath !== uploadsRoot) {
          console.error('[ATTACH] Rejected attachment path outside uploads root:', resolvedPath);
          return { error: 'Invalid attachment path', status: 400 };
        }

        const fileContent = await readFile(resolvedPath);
        
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
      const { account_id, to, subject, body: emailBody, isHtml, attachments } = body;
      if (!account_id || !to || !subject || !emailBody) {
        return { error: 'Missing required fields', status: 400 };
      }
      if (attachments !== undefined && !Array.isArray(attachments)) {
        return { error: 'attachments must be an array', status: 400 };
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
      const result = await sendEmail(account_id, { to, subject, body: emailBody, isHtml, attachments: attachments || [] });
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

    const parts = req.url.split('?')[0].split('/');
    const id = parts[parts.length - 2];
    const { is_active } = body;

    try {
      await db.execute('UPDATE users SET is_active = ? WHERE id = ?', [!!is_active, id]);
      if (!is_active) {
        await db.execute('DELETE FROM sessions WHERE user_id = ?', [id]);
      }
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
    } else if (url.pathname.includes('/subtasks/reorder')) {
      routeKey = `${req.method} /api/calendar/events/:id/subtasks/reorder`;
    } else if (url.pathname.endsWith('/subtasks')) {
      routeKey = `${req.method} /api/calendar/events/:id/subtasks`;
    } else if (url.pathname.includes('/subtasks/')) {
      routeKey = `${req.method} /api/calendar/events/:id/subtasks/:subtaskId`;
    } else {
      routeKey = `${req.method} /api/calendar/events/:id`;
    }
  } else if (routeKey.includes('/api/mail/accounts/')) {
    if (url.pathname.endsWith('/preflight')) {
      routeKey = `${req.method} /api/mail/accounts/preflight`;
    } else {
      routeKey = `${req.method} /api/mail/accounts/:id`;
    }
  } else if (routeKey.includes('/api/mail/attachments/')) {
    routeKey = `${req.method} /api/mail/attachments/:id`;
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
    } else if (url.pathname.includes('/activate')) {
      routeKey = `${req.method} /api/admin/users/:id/activate`;
    } else {
      routeKey = `${req.method} /api/admin/users/:id`;
    }
  }
  
  // CORS headers
  const allowedOrigin = getAllowedOriginForRequest(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
  
  if (req.method === 'OPTIONS') {
    if (req.headers.origin && !allowedOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed' }));
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.headers.origin && !allowedOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }
  
  const handler = routes[routeKey];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }
  
  try {
    const userId = await verifyToken(req);

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
    } else if (routeKey === 'POST /api/mail/send') {
      maxBodySize = 30 * 1024 * 1024; // Allow attachments in compose (base64 JSON payload)
    } else if (
      routeKey === 'POST /api/mail/emails/bulk-update' ||
      routeKey === 'POST /api/mail/emails/bulk-delete' ||
      routeKey === 'POST /api/mail/emails/bulk-move' ||
      routeKey === 'POST /api/mail/sync'
    ) {
      maxBodySize = 50000; // Bulk operations and sync need more space (100 emails * ~36 chars UUID + JSON overhead)
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
