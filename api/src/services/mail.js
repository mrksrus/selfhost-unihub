const crypto = require('crypto');
require('../imap-patch');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const tls = require('tls');
const dns = require('dns').promises;
const net = require('net');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { db } = require('../state');
const { debugLog } = require('../logger');
const { decrypt } = require('../security/encryption');
const { TRUSTED_MAIL_HOSTS } = require('../config');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const rm = promisify(fs.rm);

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

const DEFAULT_MAIL_SYNC_FETCH_LIMIT = 'all';
const MAIL_SYNC_FETCH_LIMITS = new Set(['all']);
const LEGACY_MAIL_SYNC_FETCH_LIMITS = new Set(['100', '500', '1000', '2000']);
const activeMailAccountSyncs = new Map();
const MAIL_RAW_STORAGE_ROOT = '/app/uploads/mail-raw';
const MAIL_FOLDER_DEFINITIONS = [
  { slug: 'inbox', displayName: 'Inbox', position: 10 },
  { slug: 'sent', displayName: 'Sent', position: 20 },
  { slug: 'archive', displayName: 'Archive', position: 30 },
  { slug: 'trash', displayName: 'Trash', position: 40 },
  { slug: 'important', displayName: 'Important', position: 50 },
  { slug: 'marketing', displayName: 'Marketing', position: 60 },
  { slug: 'scam', displayName: 'Scam', position: 70 },
  { slug: 'unknown', displayName: 'Unknown', position: 80 },
  { slug: 'twofactor_notifications', displayName: '2FA / Notifications', position: 90 },
];
const ALLOWED_MAIL_FOLDER_SET = new Set(MAIL_FOLDER_DEFINITIONS.map(folder => folder.slug));
const SYSTEM_MAIL_FOLDER_SET = new Set(MAIL_FOLDER_DEFINITIONS.map(folder => folder.slug));
const MAIL_SENDER_RULE_MATCH_TYPES = new Set(['domain', 'email']);
const MAIL_FOLDER_SLUG_MAX_LENGTH = 64;

const MAIL_SYNC_FOLDER_CANDIDATES = [
  { slug: 'inbox', names: ['INBOX'] },
  { slug: 'sent', names: ['Sent', 'Sent Items', 'Sent Mail', '[Gmail]/Sent Mail', '[Google Mail]/Sent Mail'] },
  { slug: 'archive', names: ['Archive', 'Archives', '[Gmail]/All Mail', '[Google Mail]/All Mail'] },
  { slug: 'trash', names: ['Trash', 'Deleted Items', 'Deleted Messages', '[Gmail]/Trash', '[Google Mail]/Trash'] },
];

const IMAP_FULL_MESSAGE_BODY = '';

function normalizeMailFolderSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAIL_FOLDER_SLUG_MAX_LENGTH);
}

function normalizeMailFolderDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 128);
}

function getSystemMailFolderDisplayName(slug) {
  return MAIL_FOLDER_DEFINITIONS.find(folder => folder.slug === slug)?.displayName || null;
}

async function loadMailFoldersForUser(userId, connection = db) {
  if (!userId) return [];
  await ensureDefaultMailFoldersForUser(userId, connection);
  const [folders] = await connection.execute(
    `SELECT id, user_id, slug, display_name, is_system, position, created_at, updated_at
     FROM mail_folders
     WHERE user_id = ?
     ORDER BY position ASC, display_name ASC`,
    [userId]
  );
  return (folders || []).map(folder => ({
    ...folder,
    is_system: !!folder.is_system,
  }));
}

async function mailFolderExists(userId, slug, connection = db) {
  const normalizedSlug = normalizeMailFolderSlug(slug);
  if (!userId || !normalizedSlug) return false;
  await ensureDefaultMailFoldersForUser(userId, connection);
  const [rows] = await connection.execute(
    'SELECT id FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1',
    [userId, normalizedSlug]
  );
  return rows.length > 0;
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase();
}

function normalizeSyncFetchLimit(value, fallbackValue = DEFAULT_MAIL_SYNC_FETCH_LIMIT) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallbackValue;
  if (LEGACY_MAIL_SYNC_FETCH_LIMITS.has(normalized)) return DEFAULT_MAIL_SYNC_FETCH_LIMIT;
  if (!MAIL_SYNC_FETCH_LIMITS.has(normalized)) return null;
  return normalized;
}

function normalizeMailAccountId(accountId) {
  return String(accountId || '').trim();
}

function isMailAccountSyncRunning(accountId) {
  const normalizedAccountId = normalizeMailAccountId(accountId);
  return !!normalizedAccountId && activeMailAccountSyncs.has(normalizedAccountId);
}

function isAnyMailAccountSyncRunning() {
  return activeMailAccountSyncs.size > 0;
}

function getRunningMailSyncAccountIds() {
  return Array.from(activeMailAccountSyncs.keys());
}

function normalizeSenderEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSenderDomain(value) {
  const normalizedEmail = normalizeSenderEmail(value);
  if (!normalizedEmail || !normalizedEmail.includes('@')) return '';
  const domain = normalizedEmail.split('@').pop() || '';
  return domain.trim().toLowerCase();
}

function normalizeMailSenderRuleInput(matchType, matchValue) {
  const normalizedMatchType = String(matchType || '').trim().toLowerCase();
  if (!MAIL_SENDER_RULE_MATCH_TYPES.has(normalizedMatchType)) return { error: 'Invalid match_type. Allowed values: domain, email' };
  const normalizedValue = normalizedMatchType === 'domain'
    ? String(matchValue || '').trim().toLowerCase().replace(/^@+/, '')
    : normalizeSenderEmail(matchValue);
  if (!normalizedValue) return { error: 'match_value is required' };
  if (normalizedMatchType === 'email' && !normalizedValue.includes('@')) return { error: 'Email match_value must be a valid email address' };
  if (normalizedMatchType === 'domain' && normalizedValue.includes('@')) return { error: 'Domain match_value must not include @' };
  return { matchType: normalizedMatchType, matchValue: normalizedValue };
}

async function loadActiveMailSenderRules(userId, mailAccountId = null, connection = db) {
  const accountId = String(mailAccountId || '').trim() || null;
  const [rules] = await connection.execute(
    `SELECT id, user_id, mail_account_id, match_type, LOWER(TRIM(match_value)) AS match_value, target_folder, priority, is_active, created_at, updated_at
     FROM mail_sender_rules
     WHERE user_id = ?
       AND is_active = TRUE
       AND (mail_account_id IS NULL OR mail_account_id = ?)`,
    [userId, accountId]
  );
  return Array.isArray(rules) ? rules : [];
}

function pickBestMailSenderRuleMatch(rules, mailAccountId, senderEmail, senderDomain) {
  const accountId = String(mailAccountId || '').trim() || null;
  const sortedRules = [...(rules || [])].sort((a, b) => {
    const aAccountScore = a.mail_account_id && accountId && a.mail_account_id === accountId ? 0 : 1;
    const bAccountScore = b.mail_account_id && accountId && b.mail_account_id === accountId ? 0 : 1;
    if (aAccountScore !== bAccountScore) return aAccountScore - bAccountScore;
    const aTypeScore = a.match_type === 'email' ? 0 : 1;
    const bTypeScore = b.match_type === 'email' ? 0 : 1;
    if (aTypeScore !== bTypeScore) return aTypeScore - bTypeScore;
    const aPriority = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 100;
    const bPriority = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 100;
    if (aPriority !== bPriority) return aPriority - bPriority;
    const aCreated = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bCreated = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  for (const rule of sortedRules) {
    const isEmailMatch = rule.match_type === 'email' && senderEmail && rule.match_value === senderEmail;
    const isDomainMatch = rule.match_type === 'domain' && senderDomain && rule.match_value === senderDomain;
    if (isEmailMatch || isDomainMatch) return rule;
  }
  return null;
}

async function resolveMailSenderTargetFolder({ userId, mailAccountId = null, fromAddress = '', fallbackFolder = 'inbox', rules = null, connection = db }) {
  const senderEmail = normalizeSenderEmail(fromAddress);
  const senderDomain = normalizeSenderDomain(fromAddress);
  const activeRules = Array.isArray(rules) ? rules : await loadActiveMailSenderRules(userId, mailAccountId, connection);
  const winningRule = pickBestMailSenderRuleMatch(activeRules, mailAccountId, senderEmail, senderDomain);
  let resolvedFolder = fallbackFolder || 'inbox';
  if (winningRule?.target_folder) {
    const targetFolder = normalizeMailFolderSlug(winningRule.target_folder);
    if (await mailFolderExists(userId, targetFolder, connection)) {
      resolvedFolder = targetFolder;
    }
  }
  return {
    folder: resolvedFolder || 'inbox',
    rule: winningRule,
    sender_email: senderEmail || null,
    sender_domain: senderDomain || null,
  };
}

async function ensureDefaultMailFoldersForUser(userId, connection = db) {
  if (!userId) return;
  for (const folder of MAIL_FOLDER_DEFINITIONS) {
    await connection.execute(
      `INSERT INTO mail_folders (id, user_id, slug, display_name, is_system, position)
       VALUES (?, ?, ?, ?, TRUE, ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         is_system = TRUE,
         position = VALUES(position)`,
      [crypto.randomUUID(), userId, folder.slug, folder.displayName, folder.position]
    );
  }
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

function isTlsTrustError(message) {
  const normalized = String(message || '').toUpperCase();
  if (!normalized) return false;
  return (
    isSelfSignedTlsError(normalized) ||
    normalized.includes('CERT') ||
    normalized.includes('UNABLE_TO_VERIFY') ||
    normalized.includes('HOSTNAME') ||
    normalized.includes('EXPIRED') ||
    normalized.includes('NOT_YET_VALID')
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

function serializePeerCertificate(socket) {
  const cert = socket.getPeerCertificate(true);
  const authorizationError = socket.authorizationError || null;
  if (!cert || Object.keys(cert).length === 0) {
    return { error: 'No certificate presented' };
  }
  return {
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
    trustError: isTlsTrustError(authorizationError),
  };
}

function fetchDirectTlsCertificate(host, port) {
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
      const certificate = serializePeerCertificate(socket);
      socket.end();
      resolve(certificate);
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

function smtpResponseComplete(buffer) {
  const lines = buffer.split(/\r?\n/).filter(Boolean);
  const lastLine = lines[lines.length - 1] || '';
  return /^[0-9]{3} /.test(lastLine);
}

function fetchSmtpStartTlsCertificate(host, port) {
  const normalizedHost = normalizeHost(host);
  const numericPort = Number(port);
  if (!normalizedHost || !numericPort) {
    return Promise.resolve({ error: 'Missing host or port' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let state = 'banner';
    let buffer = '';
    const socket = net.createConnection({ host: normalizedHost, port: numericPort });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(7000);

    socket.on('data', (chunk) => {
      if (settled) return;
      buffer += chunk.toString('utf8');
      if (!smtpResponseComplete(buffer)) return;

      const response = buffer;
      buffer = '';

      if (state === 'banner') {
        if (!response.startsWith('220')) {
          settle({ error: `Unexpected SMTP banner: ${response.split(/\r?\n/)[0] || 'unknown'}` });
          return;
        }
        state = 'ehlo';
        socket.write('EHLO unihub.local\r\n');
        return;
      }

      if (state === 'ehlo') {
        if (!/^250[ -]/.test(response)) {
          settle({ error: 'SMTP EHLO failed before STARTTLS check' });
          return;
        }
        if (!/STARTTLS/i.test(response)) {
          settle({ error: 'SMTP server does not advertise STARTTLS' });
          return;
        }
        state = 'starttls';
        socket.write('STARTTLS\r\n');
        return;
      }

      if (state === 'starttls') {
        if (!response.startsWith('220')) {
          settle({ error: 'SMTP server refused STARTTLS' });
          return;
        }

        socket.removeAllListeners('data');
        socket.removeAllListeners('timeout');
        socket.removeAllListeners('error');

        const tlsSocket = tls.connect({
          socket,
          servername: normalizedHost,
          rejectUnauthorized: false,
        }, () => {
          if (settled) return;
          settled = true;
          const certificate = serializePeerCertificate(tlsSocket);
          tlsSocket.end();
          resolve(certificate);
        });

        tlsSocket.setTimeout(7000);
        tlsSocket.on('error', (error) => {
          if (settled) return;
          settled = true;
          resolve({ error: error.message });
        });
        tlsSocket.on('timeout', () => {
          if (settled) return;
          settled = true;
          tlsSocket.destroy();
          resolve({ error: 'SMTP STARTTLS handshake timed out' });
        });
      }
    });

    socket.on('error', (error) => settle({ error: error.message }));
    socket.on('timeout', () => settle({ error: 'SMTP STARTTLS probe timed out' }));
  });
}

function fetchMailTlsCertificate(host, port, service) {
  const numericPort = Number(port);
  if (service === 'smtp' && numericPort !== 465) {
    return fetchSmtpStartTlsCertificate(host, numericPort || 587);
  }
  return fetchDirectTlsCertificate(host, numericPort || (service === 'imap' ? 993 : 465));
}

function certificateRequiresInsecureTls(certificate) {
  if (!certificate) return true;
  if (certificate.error) return true;
  return certificate.authorized !== true;
}

function normalizeCertificateFingerprint(value) {
  return String(value || '').replace(/[^a-f0-9]/gi, '').toUpperCase();
}

async function assertAcceptedMailCertificate({ host, port, service, expectedFingerprint }) {
  const normalizedExpected = normalizeCertificateFingerprint(expectedFingerprint);
  if (!normalizedExpected) return;
  const certificate = await fetchMailTlsCertificate(host, port, service);
  const normalizedActual = normalizeCertificateFingerprint(certificate?.fingerprint256);
  if (!normalizedActual) {
    throw new Error(`${service.toUpperCase()} certificate could not be read for accepted server ${host}.`);
  }
  if (normalizedActual !== normalizedExpected) {
    throw new Error(`${service.toUpperCase()} certificate changed for ${host}. Review the mail account settings before connecting.`);
  }
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

  if (blocked) {
    return {
      blocked,
      requiresConfirmation: true,
      requiresInsecureTls: false,
      warnings,
      assessments,
      certificates: {
        imap: { error: 'Blocked before certificate check because the host resolves to a private/local address.' },
        smtp: { error: 'Blocked before certificate check because the host resolves to a private/local address.' },
      },
    };
  }

  const [imapCertificate, smtpCertificate] = await Promise.all([
    fetchMailTlsCertificate(imapAssessment.host, imapAssessment.port || 993, 'imap'),
    fetchMailTlsCertificate(smtpAssessment.host, smtpAssessment.port || 587, 'smtp'),
  ]);
  const certificates = {
    imap: imapCertificate,
    smtp: smtpCertificate,
  };
  const imapRequiresInsecureTls = certificateRequiresInsecureTls(certificates.imap);
  const smtpRequiresInsecureTls = certificateRequiresInsecureTls(certificates.smtp);
  const requiresInsecureTls = imapRequiresInsecureTls || smtpRequiresInsecureTls;
  const requiresConfirmation =
    imapAssessment.unknownProvider ||
    smtpAssessment.unknownProvider ||
    requiresInsecureTls;

  if (imapRequiresInsecureTls) {
    warnings.push(`IMAP certificate for "${imapAssessment.host}" could not be fully verified (${certificates.imap?.authorizationError || certificates.imap?.error || 'untrusted'}).`);
  }
  if (smtpRequiresInsecureTls) {
    warnings.push(`SMTP certificate for "${smtpAssessment.host}" could not be fully verified (${certificates.smtp?.authorizationError || certificates.smtp?.error || 'untrusted'}).`);
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

async function requireMailHostTrustApproval({ imap_host, imap_port, smtp_host, smtp_port, accept_host_trust }) {
  const mailHostTrust = await buildMailHostTrustResult({ imap_host, imap_port, smtp_host, smtp_port });
  if (mailHostTrust.blocked) {
    return {
      error: 'Mail host blocked because it resolves to a private/local address. Ask the host administrator to add it to TRUSTED_MAIL_HOSTS if this is intentional.',
      status: 400,
      mailHostTrust,
    };
  }

  if (mailHostTrust.requiresConfirmation && !toBooleanFlag(accept_host_trust)) {
    return {
      error: 'Review and confirm mail server authenticity before continuing.',
      status: 409,
      requiresHostTrustConfirmation: true,
      mailHostTrust,
    };
  }

  return {
    accepted: true,
    allowInsecureTls: mailHostTrust.requiresInsecureTls && toBooleanFlag(accept_host_trust),
    trustedImapFingerprint256: mailHostTrust.requiresInsecureTls ? mailHostTrust.certificates.imap?.fingerprint256 || null : null,
    trustedSmtpFingerprint256: mailHostTrust.requiresInsecureTls ? mailHostTrust.certificates.smtp?.fingerprint256 || null : null,
    mailHostTrust,
  };
}

function isAttachmentPathUnderUploads(storagePath) {
  const uploadsRoot = path.resolve('/app/uploads/attachments');
  const resolvedPath = path.resolve(storagePath || '');
  return resolvedPath === uploadsRoot || resolvedPath.startsWith(`${uploadsRoot}${path.sep}`);
}

async function deleteStoredAttachmentFiles(storagePaths) {
  const uniquePaths = Array.from(new Set((storagePaths || []).filter(Boolean)));
  let deletedFiles = 0;
  let failedFiles = 0;

  for (const storagePath of uniquePaths) {
    if (!isAttachmentPathUnderUploads(storagePath)) {
      console.error('[ATTACH] Skipped deleting attachment outside uploads root:', storagePath);
      failedFiles++;
      continue;
    }

    try {
      await rm(path.resolve(storagePath), { force: true });
      deletedFiles++;
    } catch (error) {
      failedFiles++;
      console.error('[ATTACH] Failed to delete attachment file:', error.message);
    }
  }

  return { deletedFiles, failedFiles };
}

function getMailRawStoragePath(userId, emailId, messageId = '') {
  const safeMessagePart = String(messageId || emailId)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  return path.join(MAIL_RAW_STORAGE_ROOT, String(userId), `${emailId}-${safeMessagePart}.eml`);
}

async function saveRawEmailSource({ userId, emailId, messageId, rawEmail }) {
  if (!rawEmail) return { rawStoragePath: null, rawSha256: null };
  const rawStoragePath = getMailRawStoragePath(userId, emailId, messageId);
  await mkdir(path.dirname(rawStoragePath), { recursive: true });
  const buffer = Buffer.isBuffer(rawEmail) ? rawEmail : Buffer.from(String(rawEmail), 'utf8');
  await writeFile(rawStoragePath, buffer);
  return {
    rawStoragePath,
    rawSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function flattenImapBoxes(boxes, prefix = '') {
  const results = [];
  for (const [name, box] of Object.entries(boxes || {})) {
    const delimiter = box?.delimiter || '/';
    const fullName = prefix ? `${prefix}${delimiter}${name}` : name;
    results.push(fullName);
    if (box?.children) {
      results.push(...flattenImapBoxes(box.children, fullName));
    }
  }
  return results;
}

async function listAvailableImapFolders(connection) {
  try {
    if (typeof connection.getBoxes !== 'function') return ['INBOX'];
    return flattenImapBoxes(await connection.getBoxes());
  } catch (error) {
    console.log('[SYNC] Could not list IMAP folders, falling back to INBOX:', error.message);
    return ['INBOX'];
  }
}

function pickImapSyncFolders(availableFolders) {
  const normalizedAvailable = new Map((availableFolders || []).map((folderName) => [
    String(folderName).toLowerCase(),
    String(folderName),
  ]));
  const picked = [];
  const seenNames = new Set();

  for (const candidate of MAIL_SYNC_FOLDER_CANDIDATES) {
    for (const candidateName of candidate.names) {
      const actualName = normalizedAvailable.get(String(candidateName).toLowerCase());
      if (actualName && !seenNames.has(actualName.toLowerCase())) {
        picked.push({ folderName: actualName, dbFolderName: candidate.slug });
        seenNames.add(actualName.toLowerCase());
        break;
      }
    }
  }

  if (!picked.some(folder => folder.dbFolderName === 'inbox')) {
    picked.unshift({ folderName: 'INBOX', dbFolderName: 'inbox' });
  }
  return picked;
}

function getCurrentBoxUidValidity(connection) {
  const candidates = [
    connection?.imap?._box?.uidvalidity,
    connection?.imap?._box?.uidValidity,
    connection?._box?.uidvalidity,
    connection?._box?.uidValidity,
  ];
  const value = candidates.find(candidate => candidate !== undefined && candidate !== null);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringifyImapBody(body) {
  if (!body) return '';
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return String(body);
}

function stringifyImapHeaderBody(body) {
  if (!body) return '';
  if (typeof body === 'string' || Buffer.isBuffer(body)) return stringifyImapBody(body);
  if (typeof body !== 'object') return String(body);

  const headerLines = [];
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item) headerLines.push(`${key}: ${item}`);
      });
    } else if (value) {
      headerLines.push(`${key}: ${value}`);
    }
  }
  return headerLines.join('\r\n');
}

function getImapPart(item, which) {
  return (item?.parts || []).find(part => part.which === which) || null;
}

function buildRawEmailFromImapParts(item) {
  const fullPart = getImapPart(item, IMAP_FULL_MESSAGE_BODY);
  const fullBody = stringifyImapBody(fullPart?.body);
  if (fullBody.trim()) return fullBody;

  const headerContent = stringifyImapHeaderBody(getImapPart(item, 'HEADER')?.body);
  const bodyContent = stringifyImapBody(getImapPart(item, 'TEXT')?.body);

  if (headerContent) {
    return headerContent + (bodyContent ? '\r\n\r\n' + bodyContent : '');
  }
  return bodyContent;
}

function extractSenderFromParsedEmail(parsed) {
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

  return { fromAddress, fromName };
}

function extractEmailAddresses(addressObject) {
  if (!addressObject?.value) return [];
  return addressObject.value.map(address => address.address).filter(Boolean);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isUnknownSender(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === 'unknown' || normalized === 'unknown sender';
}

function bodyLooksLikeHeaderDump(value) {
  const normalized = String(value || '').trimStart().toLowerCase();
  return normalized.startsWith('content-type:')
    || normalized.startsWith('date:')
    || normalized.startsWith('from:')
    || /^[-\w]+:\s+.+\r?\n[-\w]+:/m.test(normalized);
}

async function findExistingImportedEmail({ connection = db, messageId, accountId, folderName, uid, uidValidity }) {
  const [byMessageId] = await connection.execute(
    `SELECT id, message_id, from_address, from_name, to_addresses, body_text, body_html, received_at,
            source_folder, imap_uid, imap_uidvalidity, raw_storage_path
     FROM emails
     WHERE message_id = ? AND mail_account_id = ?
     LIMIT 1`,
    [messageId, accountId]
  );
  if (byMessageId.length > 0) return byMessageId[0];

  if (typeof uid !== 'number' || !folderName) return null;
  const params = [accountId, folderName, uid];
  let query = `
    SELECT id, message_id, from_address, from_name, to_addresses, body_text, body_html, received_at,
           source_folder, imap_uid, imap_uidvalidity, raw_storage_path
    FROM emails
    WHERE mail_account_id = ? AND source_folder = ? AND imap_uid = ?`;

  if (uidValidity !== null && uidValidity !== undefined) {
    query += ' AND (imap_uidvalidity = ? OR imap_uidvalidity IS NULL)';
    params.push(uidValidity);
  }

  query += ' ORDER BY created_at ASC LIMIT 1';
  const [byUid] = await connection.execute(query, params);
  return byUid[0] || null;
}

async function repairExistingImportedEmail({
  existingEmail,
  account,
  messageId,
  fullEmail,
  parsed,
  fromAddress,
  fromName,
  toAddresses,
  processedHtml,
  folderName,
  uid,
  uidValidity,
}) {
  const updates = [];
  const params = [];

  if (messageId && existingEmail.message_id !== messageId) {
    updates.push('message_id = ?');
    params.push(messageId);
  }

  if (isUnknownSender(existingEmail.from_address) && !isUnknownSender(fromAddress)) {
    updates.push('from_address = ?');
    params.push(fromAddress);
    updates.push('from_name = ?');
    params.push(fromName);
  } else if (!existingEmail.from_name && fromName) {
    updates.push('from_name = ?');
    params.push(fromName);
  }

  if (toAddresses.length > 0 && parseJsonArray(existingEmail.to_addresses).length === 0) {
    updates.push('to_addresses = ?');
    params.push(JSON.stringify(toAddresses));
  }

  if (bodyLooksLikeHeaderDump(existingEmail.body_text) && (parsed.text || processedHtml)) {
    updates.push('body_text = ?');
    params.push(parsed.text || null);
    updates.push('body_html = ?');
    params.push(processedHtml || null);
    if (parsed.date) {
      updates.push('received_at = ?');
      params.push(parsed.date);
    }
  }

  updates.push('source_folder = COALESCE(source_folder, ?)');
  params.push(folderName);
  updates.push('imap_uid = COALESCE(imap_uid, ?)');
  params.push(uid);
  updates.push('imap_uidvalidity = COALESCE(imap_uidvalidity, ?)');
  params.push(uidValidity);

  if (!existingEmail.raw_storage_path) {
    try {
      const rawArchive = await saveRawEmailSource({
        userId: account.user_id,
        emailId: existingEmail.id,
        messageId,
        rawEmail: fullEmail,
      });
      updates.push('raw_storage_path = COALESCE(raw_storage_path, ?)');
      params.push(rawArchive.rawStoragePath);
      updates.push('raw_sha256 = COALESCE(raw_sha256, ?)');
      params.push(rawArchive.rawSha256);
    } catch (rawError) {
      console.error(`[SYNC] Failed to archive raw existing email UID ${uid}:`, rawError.message);
    }
  }

  if (updates.length === 0) return;
  params.push(existingEmail.id, account.user_id);
  await db.execute(
    `UPDATE emails
     SET ${updates.join(', ')}
     WHERE id = ? AND user_id = ?`,
    params
  );
}

function chunkArray(values, chunkSize) {
  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

async function loadExistingImportedUidSet({ connection = db, accountId, folderName, uids, uidValidity }) {
  const normalizedUids = Array.from(new Set((uids || []).filter(uid => typeof uid === 'number' && Number.isFinite(uid))));
  const existingUids = new Set();
  if (!accountId || !folderName || normalizedUids.length === 0) return existingUids;

  for (const uidChunk of chunkArray(normalizedUids, 1000)) {
    const placeholders = uidChunk.map(() => '?').join(',');
    const params = [accountId, folderName, ...uidChunk];
    let query = `
      SELECT imap_uid
      FROM emails
      WHERE mail_account_id = ?
        AND source_folder = ?
        AND imap_uid IN (${placeholders})`;

    if (uidValidity !== null && uidValidity !== undefined) {
      query += ' AND (imap_uidvalidity = ? OR imap_uidvalidity IS NULL)';
      params.push(uidValidity);
    }

    const [rows] = await connection.execute(query, params);
    for (const row of rows || []) {
      const uid = Number(row.imap_uid);
      if (Number.isFinite(uid)) existingUids.add(uid);
    }
  }

  return existingUids;
}

// ── Mail sync and send functions ──────────────────────────────────

// Helper function to sync a specific folder
async function syncMailFolder(connection, account, accountId, folderName, dbFolderName, lastSyncedAt = null, syncFetchLimit = DEFAULT_MAIL_SYNC_FETCH_LIMIT) {
  try {
    console.log(`[SYNC] Opening ${folderName}...`);
    try {
      await connection.openBox(folderName);
    } catch (openError) {
      // Folder doesn't exist or can't be opened - return early without affecting connection state
      console.log(`[SYNC] Could not open folder ${folderName}: ${openError.message}`);
      return { newEmails: 0, processed: 0, failed: 0, total: 0, error: openError.message };
    }
    const uidValidity = getCurrentBoxUidValidity(connection);
    
    // "all" applies to the first import only. After that, every sync is incremental.
    let searchCriteria = ['ALL'];
    if (lastSyncedAt) {
      // Use SINCE to only get emails since last sync (subtract 1 day for safety margin)
      const sinceDate = new Date(lastSyncedAt);
      sinceDate.setDate(sinceDate.getDate() - 1); // 1 day margin for timezone/server differences
      // Format date as ISO string for IMAP SINCE search (nested array format required)
      const sinceDateStr = sinceDate.toISOString();
      searchCriteria = [['SINCE', sinceDateStr]];
      console.log(`[SYNC] Using optimized search: emails since ${sinceDateStr} (last sync: ${lastSyncedAt})`);
    } else if (syncFetchLimit === 'all') {
      console.log('[SYNC] First sync - fetching full mailbox history');
    } else {
      console.log(`[SYNC] First sync - fetching last ${syncFetchLimit} emails`);
    }
    
    // Search for emails (either all or since last sync)
    let searchResults;
    try {
      searchResults = await connection.search(searchCriteria, {});
    } catch (searchError) {
      const errorPrefix = !lastSyncedAt && syncFetchLimit === 'all' ? 'Unable to resolve full mailbox history' : 'Unable to search mailbox';
      return { newEmails: 0, processed: 0, failed: 0, total: 0, error: `${errorPrefix}: ${searchError.message}` };
    }

    if (!Array.isArray(searchResults)) {
      return {
        newEmails: 0,
        processed: 0,
        failed: 0,
        total: 0,
        error: 'Mail provider returned unexpected search results while listing message IDs.',
      };
    }

    const allUids = searchResults
      .map(msg => msg && msg.attributes ? msg.attributes.uid : null)
      .filter(uid => typeof uid === 'number' && Number.isFinite(uid));
    console.log(`[SYNC] Found ${allUids.length} messages in ${folderName}${lastSyncedAt ? ' since last sync' : ''}`);
    
    if (searchResults.length > 0 && allUids.length === 0) {
      return {
        newEmails: 0,
        processed: 0,
        failed: 0,
        total: 0,
        error: 'Mail provider returned malformed message IDs; sync stopped to avoid inconsistent imports.',
      };
    }

    if (allUids.length === 0) {
      return { newEmails: 0, processed: 0, failed: 0, total: 0 };
    }
    
    // For incremental syncs, process all found UIDs. For first sync, apply account sync limit.
    let uidsToProcess = allUids;
    const requestedCount = lastSyncedAt ? 'incremental' : syncFetchLimit;
    if (!lastSyncedAt && syncFetchLimit !== 'all') {
      const limitNumber = Number.parseInt(syncFetchLimit, 10);
      const safeLimit = Number.isFinite(limitNumber) && limitNumber > 0
        ? limitNumber
        : 500;
      uidsToProcess = allUids.slice(-safeLimit);
      console.log(`[SYNC] First sync limit requested: ${safeLimit}, available: ${allUids.length}, selected: ${uidsToProcess.length}`);
    } else if (!lastSyncedAt && syncFetchLimit === 'all') {
      console.log(`[SYNC] First sync limit requested: all, available: ${allUids.length}, selected: ${uidsToProcess.length}`);
    }

    const knownUidSet = await loadExistingImportedUidSet({
      connection: db,
      accountId,
      folderName,
      uids: uidsToProcess,
      uidValidity,
    });
    if (knownUidSet.size > 0) {
      uidsToProcess = uidsToProcess.filter(uid => !knownUidSet.has(uid));
      console.log(`[SYNC] Skipping ${knownUidSet.size} already imported UID(s) in ${folderName}; ${uidsToProcess.length} UID(s) still need download`);
    }

    console.log(`[SYNC] Will fetch ${uidsToProcess.length} emails from ${folderName}${lastSyncedAt ? ' (new since last sync)' : ''}...`);
    
    if (uidsToProcess.length === 0) {
      return { newEmails: 0, processed: 0, failed: 0, total: allUids.length, requestedCount, selectedCount: 0 };
    }
    
    const fetchOptions = {
      bodies: [IMAP_FULL_MESSAGE_BODY],
      markSeen: false,
      struct: true,
    };
    
    let newEmailsCount = 0;
    let processedCount = 0;
    let failedCount = 0;
    const routingRules = await loadActiveMailSenderRules(account.user_id, accountId, db);
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
        const fullEmail = buildRawEmailFromImapParts(item);
        
        if (!fullEmail || fullEmail.trim().length === 0) {
          if (processedCount <= 5) {
            console.log(`[SYNC] Skipping empty email (UID: ${uid})`);
          }
          continue;
        }
        
        const parsed = await simpleParser(fullEmail);
        const messageId = parsed.messageId || (dbFolderName === 'inbox' ? `${accountId}-${uid}` : `${accountId}-${folderName}-${uid}`);
        const { fromAddress, fromName } = extractSenderFromParsedEmail(parsed);
        const toAddresses = extractEmailAddresses(parsed.to);
        const hasAttachments = parsed.attachments && parsed.attachments.length > 0;
        let attachmentCount = 0;
        let processedHtml = parsed.html || null;
        
        // Preserve existing local folder moves by never reclassifying an email that is already imported.
        const existingEmail = await findExistingImportedEmail({
          messageId,
          accountId,
          folderName,
          uid,
          uidValidity,
          connection: db,
        });
        if (existingEmail) {
          try {
            await repairExistingImportedEmail({
              existingEmail,
              account,
              messageId,
              fullEmail,
              parsed,
              fromAddress,
              fromName,
              toAddresses,
              processedHtml,
              folderName,
              uid,
              uidValidity,
            });
          } catch (rawError) {
            console.error(`[SYNC] Failed to update existing email UID ${uid}:`, rawError.message);
          }
          if (processedCount <= 5) {
            console.log(`[SYNC] Email already exists (UID: ${uid}, messageId: ${messageId}), skipping`);
          }
          continue;
        }
        
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
        let rawArchive = { rawStoragePath: null, rawSha256: null };
        try {
          rawArchive = await saveRawEmailSource({
            userId: account.user_id,
            emailId,
            messageId,
            rawEmail: fullEmail,
          });
        } catch (rawError) {
          console.error(`[SYNC] Failed to archive raw email UID ${uid}:`, rawError.message);
        }
        const routeResult = await resolveMailSenderTargetFolder({
          userId: account.user_id,
          mailAccountId: accountId,
          fromAddress,
          fallbackFolder: dbFolderName || 'inbox',
          rules: routingRules,
          connection: db,
        });
        try {
          await db.execute(
            `INSERT INTO emails
              (id, user_id, mail_account_id, message_id, subject, from_address, from_name, to_addresses, body_text, body_html,
               has_attachments, received_at, folder, source_folder, imap_uid, imap_uidvalidity, raw_storage_path, raw_sha256)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              routeResult.folder || 'inbox',
              folderName,
              uid,
              uidValidity,
              rawArchive.rawStoragePath,
              rawArchive.rawSha256,
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
    return {
      newEmails: newEmailsCount,
      processed: processedCount,
      failed: failedCount,
      total: allUids.length,
      requestedCount,
      selectedCount: uidsToProcess.length,
    };
  } catch (error) {
    console.error(`[SYNC] Error syncing ${folderName}:`, error.message);
    return { newEmails: 0, processed: 0, failed: 0, total: 0, error: error.message };
  }
}

// Test IMAP connection and authentication without syncing.
async function testImapConnection(account) {
  let connection = null;
  try {
    const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
    if (!password) {
      return { success: false, error: 'No password configured' };
    }
    
    const imapPort = account.imap_port || 993;
    if (toBooleanFlag(account.allow_self_signed)) {
      await assertAcceptedMailCertificate({
        host: account.imap_host,
        port: imapPort,
        service: 'imap',
        expectedFingerprint: account.trusted_imap_fingerprint256,
      });
    }
    const config = {
      imap: {
        user: account.username || account.email_address,
        password,
        host: account.imap_host,
        port: imapPort,
        tls: true,
        tlsOptions: { 
          rejectUnauthorized: !toBooleanFlag(account.allow_self_signed),
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

async function syncMailAccountOnce(accountId) {
  let connection = null;
  try {
    debugLog('server.js:50', 'syncMailAccount START', { accountId }, 'H1');
    const [accounts] = await db.execute('SELECT * FROM mail_accounts WHERE id = ?', [accountId]);
    if (!accounts[0]) {
      return { success: false, error: `Account ${accountId} not found in database` };
    }
    
    const account = accounts[0];
    const lastSyncedAt = account.last_synced_at;
    const syncFetchLimit = normalizeSyncFetchLimit(account.sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT) || DEFAULT_MAIL_SYNC_FETCH_LIMIT;
    const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
    if (!password) {
      return { success: false, error: 'No password configured for this account' };
    }
    
    const imapPort = account.imap_port || 993;
    if (toBooleanFlag(account.allow_self_signed)) {
      await assertAcceptedMailCertificate({
        host: account.imap_host,
        port: imapPort,
        service: 'imap',
        expectedFingerprint: account.trusted_imap_fingerprint256,
      });
    }
    const config = {
      imap: {
        user: account.username || account.email_address,
        password,
        host: account.imap_host,
        port: imapPort,
        tls: true,
        tlsOptions: { 
          rejectUnauthorized: !toBooleanFlag(account.allow_self_signed),
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
    
    const availableFolders = await listAvailableImapFolders(connection);
    const foldersToSync = pickImapSyncFolders(availableFolders);
    console.log(`[SYNC] Folder plan for ${account.email_address}: ${foldersToSync.map(folder => `${folder.folderName}->${folder.dbFolderName}`).join(', ')}`);

    const folderResults = [];
    for (const folder of foldersToSync) {
      const folderResult = await syncMailFolder(
        connection,
        account,
        accountId,
        folder.folderName,
        folder.dbFolderName,
        lastSyncedAt,
        syncFetchLimit
      );
      folderResults.push({ ...folder, ...folderResult });
      if (folder.dbFolderName === 'inbox' && folderResult.error) {
        break;
      }
    }
    
    // Clean up connection
    if (connection) {
      try {
        connection.end();
      } catch (endError) {
        console.log(`[SYNC] Error closing connection: ${endError.message}`);
      }
    }
    
    const inboxResult = folderResults.find(result => result.dbFolderName === 'inbox') || folderResults[0] || {};
    if (inboxResult.error) {
      return {
        success: false,
        error: inboxResult.error,
        details: `Processed ${inboxResult.processed || 0} of ${inboxResult.selectedCount || 0} selected emails before stopping.`,
        newEmails: inboxResult.newEmails || 0,
        totalFound: inboxResult.total || 0,
      };
    }

    // Update last synced
    await db.execute(
      'UPDATE mail_accounts SET last_synced_at = UTC_TIMESTAMP() WHERE id = ?',
      [accountId]
    );
    
    const totals = folderResults.reduce((acc, result) => {
      acc.newEmails += result.newEmails || 0;
      acc.totalFound += result.total || 0;
      acc.processed += result.processed || 0;
      acc.failed += result.failed || 0;
      return acc;
    }, { newEmails: 0, totalFound: 0, processed: 0, failed: 0 });
    const resultMsg = `Synced ${account.email_address}: ${totals.newEmails} new emails across ${folderResults.length} folder(s) (${totals.totalFound} available, ${totals.processed} processed, ${totals.failed} failed; limit=${syncFetchLimit})`;
    console.log(`[SYNC] ✓ ${resultMsg}`);
    
    // Log detailed summary for debugging
    if (totals.newEmails === 0 && totals.processed > 0) {
      console.warn(`[SYNC] ⚠ WARNING: Processed ${totals.processed} emails but saved 0. This might indicate:`);
      console.warn(`[SYNC]   - All emails already exist in database (duplicate detection)`);
      console.warn(`[SYNC]   - Emails are empty or invalid`);
      console.warn(`[SYNC]   - Database insert errors (check logs above)`);
    }
    
    return {
      success: true,
      newEmails: totals.newEmails,
      totalFound: totals.totalFound,
      message: resultMsg,
      folders: folderResults.map(result => ({
        sourceFolder: result.folderName,
        folder: result.dbFolderName,
        newEmails: result.newEmails || 0,
        totalFound: result.total || 0,
        processed: result.processed || 0,
        failed: result.failed || 0,
        error: result.error || null,
      })),
    };
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

async function syncMailAccount(accountId) {
  const normalizedAccountId = normalizeMailAccountId(accountId);
  if (!normalizedAccountId) {
    return { success: false, error: 'Account ID required' };
  }

  if (activeMailAccountSyncs.has(normalizedAccountId)) {
    return {
      success: true,
      alreadyRunning: true,
      skipped: true,
      newEmails: 0,
      totalFound: 0,
      message: 'Sync already running for this account; not starting another sync.',
    };
  }

  const syncPromise = syncMailAccountOnce(normalizedAccountId);
  activeMailAccountSyncs.set(normalizedAccountId, syncPromise);
  try {
    return await syncPromise;
  } finally {
    if (activeMailAccountSyncs.get(normalizedAccountId) === syncPromise) {
      activeMailAccountSyncs.delete(normalizedAccountId);
    }
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

    const smtpPort = account.smtp_port || 587;
    if (toBooleanFlag(account.allow_self_signed)) {
      await assertAcceptedMailCertificate({
        host: account.smtp_host,
        port: smtpPort,
        service: 'smtp',
        expectedFingerprint: account.trusted_smtp_fingerprint256,
      });
    }
    // Port 465 uses implicit SSL/TLS, port 587 uses STARTTLS
    const transporter = nodemailer.createTransport({
      host: account.smtp_host,
      port: smtpPort,
      secure: smtpPort === 465, // Implicit SSL/TLS for port 465
      requireTLS: smtpPort !== 465, // Require STARTTLS on explicit-TLS SMTP ports
      auth: {
        user: account.username || account.email_address,
        pass: password,
      },
      tls: {
        rejectUnauthorized: !toBooleanFlag(account.allow_self_signed),
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

module.exports = {
  KNOWN_MAIL_HOST_SUFFIXES,
  DEFAULT_MAIL_SYNC_FETCH_LIMIT,
  MAIL_SYNC_FETCH_LIMITS,
  MAIL_RAW_STORAGE_ROOT,
  MAIL_FOLDER_DEFINITIONS,
  ALLOWED_MAIL_FOLDER_SET,
  SYSTEM_MAIL_FOLDER_SET,
  MAIL_SENDER_RULE_MATCH_TYPES,
  normalizeMailFolderSlug,
  normalizeMailFolderDisplayName,
  getSystemMailFolderDisplayName,
  loadMailFoldersForUser,
  mailFolderExists,
  normalizeHost,
  normalizeSyncFetchLimit,
  normalizeMailAccountId,
  isMailAccountSyncRunning,
  isAnyMailAccountSyncRunning,
  getRunningMailSyncAccountIds,
  normalizeSenderEmail,
  normalizeSenderDomain,
  normalizeMailSenderRuleInput,
  loadActiveMailSenderRules,
  pickBestMailSenderRuleMatch,
  resolveMailSenderTargetFolder,
  ensureDefaultMailFoldersForUser,
  isKnownMailProviderHost,
  hostInAllowlist,
  toBooleanFlag,
  isSelfSignedTlsError,
  isTlsTrustError,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateOrLocalIP,
  assessMailHost,
  serializePeerCertificate,
  fetchDirectTlsCertificate,
  smtpResponseComplete,
  fetchSmtpStartTlsCertificate,
  fetchMailTlsCertificate,
  certificateRequiresInsecureTls,
  normalizeCertificateFingerprint,
  assertAcceptedMailCertificate,
  buildMailHostTrustResult,
  requireMailHostTrustApproval,
  isAttachmentPathUnderUploads,
  deleteStoredAttachmentFiles,
  getMailRawStoragePath,
  saveRawEmailSource,
  flattenImapBoxes,
  listAvailableImapFolders,
  pickImapSyncFolders,
  getCurrentBoxUidValidity,
  buildRawEmailFromImapParts,
  loadExistingImportedUidSet,
  syncMailFolder,
  testImapConnection,
  syncMailAccount,
  sendEmail,
};
