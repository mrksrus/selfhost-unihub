const { withMailAccountLock } = require('./mail-account-lock');
const { createDurableMailScheduler, READ_ONLY_MAIL_JOB_KINDS } = require('./mail-sync-scheduler');
const { guardImapConnection } = require('./mail-imap-guard');
const { acquireImapConnection, releaseImapConnection, evictImapConnections } = require('./mail-engine/connection-pool');
const { operationDue, processOperationBatch } = require('./mail-engine/operation-batch');
const { followMailServer, checkCancelled } = require('./mail-server-follow');
const { reconcileAccountFolders } = require('./mail-folder-reconciliation');
const crypto = require('crypto');
require('../imap-patch');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { db } = require('../state');
const { debugLog } = require('../logger');
const { decrypt } = require('../security/encryption');
const { normalizeNetworkHost, isTrustedMailHost, isPublicNetworkAddress, resolveNetworkHost, resolveMailConnectionTarget } = require('../security/outbound-network');
const { isModuleEnabled, isModuleBackgroundEnabled } = require('./module-settings');
const { isSectionRestoreActive } = require('./restore-locks');
const { normalizeComposerAttachments } = require('./mail-attachments');
const { loadFolderSyncState, buildFolderSearchCriteria, saveFolderSyncState } = require('./mail-sync-state');

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
const mailDeleteStopRequests = new Set();
async function cancelMailAccountSync(accountId) {
  // HTTP /sync/cancel is read-only. Accepted operation/reconcile jobs remain
  // runnable and keep their dispatch/uncertainty journal intact.
  const key = normalizeMailAccountId(accountId);
  const [accounts] = await db.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [key]);
  if (!accounts.length) return false;
  let cursor = '', changed = false;
  for (;;) {
    const [jobs] = await db.execute(`SELECT id FROM mail_engine_jobs WHERE user_id = ? AND mail_account_id = ?
      AND kind IN (${[...READ_ONLY_MAIL_JOB_KINDS].map(() => '?').join(',')})
      AND state IN ('queued','running') AND id > ? ORDER BY id LIMIT 100`,
    [accounts[0].user_id, key, ...READ_ONLY_MAIL_JOB_KINDS, cursor]);
    if (!jobs.length) break;
    for (const job of jobs) {
      changed = await durableScheduler.cancel({ userId: accounts[0].user_id, accountId: key, jobId: job.id }) || changed;
    }
    cursor = jobs[jobs.length - 1].id;
  }
  return changed;
}
async function yieldMailReadWork(accountId) {
  const key = normalizeMailAccountId(accountId);
  if (!key) return false;
  return durableScheduler.yieldReadWork(key);
}
// Disconnect/settings/module shutdown is a different operation from /sync/cancel.
// Fencing first prevents new provider dispatch; dispatched effects remain
// inspectable until reconnect. Direct writeback workers must also close their
// own transports when the account generation is invalidated.
async function stopMailAccountWork(accountId, reason = 'Account stopped') {
  const key = normalizeMailAccountId(accountId);
  const [accounts] = await db.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [key]);
  if (!accounts.length) return false;
  await require('./mail-engine/runtime').pauseAccount({ userId: accounts[0].user_id, accountId: key, reason });
  mailDeleteStopRequests.add(key);
  durableScheduler.interruptAccount(key);
  evictImapConnections(key);
  // The direct writeback runner owns a separate guarded transport; abort it
  // after the generation fence, never wait for it while holding this call.
  require('./mail-writebacks').stopWritebacks?.(key);
  return true;
}
const activeMailServerDeleteAccounts = new Set();
const MAIL_SERVER_DELETE_GRACE_MS = 10 * 60 * 1000;
const MAIL_SERVER_DELETE_BATCH_SIZE = 100;
const MAIL_RAW_STORAGE_ROOT = process.env.MAIL_RAW_STORAGE_ROOT || '/app/uploads/mail-raw';
const MAIL_FOLDER_DEFINITIONS = [
  { slug: 'inbox', displayName: 'Inbox', position: 10 },
  { slug: 'sent', displayName: 'Sent', position: 20 },
  { slug: 'drafts', displayName: 'Drafts', position: 30 },
  { slug: 'archive', displayName: 'Archive', position: 40 },
  { slug: 'trash', displayName: 'Trash', position: 50 },
  { slug: 'important', displayName: 'Important', position: 60 },
  { slug: 'marketing', displayName: 'Marketing', position: 70 },
  { slug: 'scam', displayName: 'Scam', position: 80 },
  { slug: 'unknown', displayName: 'Unknown', position: 90 },
  { slug: 'twofactor_notifications', displayName: '2FA / Notifications', position: 100 },
];
const ALLOWED_MAIL_FOLDER_SET = new Set(MAIL_FOLDER_DEFINITIONS.map(folder => folder.slug));
const SYSTEM_MAIL_FOLDER_SET = new Set(MAIL_FOLDER_DEFINITIONS.map(folder => folder.slug));
const MAIL_SENDER_RULE_MATCH_TYPES = new Set(['domain', 'email']);
const MAIL_FOLDER_SLUG_MAX_LENGTH = 64;

const MAIL_SYNC_FOLDER_CANDIDATES = [
  { slug: 'inbox', names: ['INBOX'] },
  { slug: 'sent', names: ['Sent', 'Sent Items', 'Sent Mail', '[Gmail]/Sent Mail', '[Google Mail]/Sent Mail'] },
  { slug: 'drafts', names: ['Drafts', '[Gmail]/Drafts', '[Google Mail]/Drafts'] },
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
    `SELECT id, user_id, mail_account_id, special_use, slug, display_name, is_system, position, created_at, updated_at
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

async function mailFolderExists(userId, slug, connection = db, accountId = undefined) {
  const normalizedSlug = normalizeMailFolderSlug(slug);
  if (!userId || !normalizedSlug) return false;
  await ensureDefaultMailFoldersForUser(userId, connection);
  const [rows] = await connection.execute(
    `SELECT id FROM mail_folders WHERE user_id = ? AND slug = ?
     ${accountId !== undefined ? 'AND (mail_account_id IS NULL OR mail_account_id = ?)' : ''} LIMIT 1`,
    accountId !== undefined ? [userId, normalizedSlug, accountId] : [userId, normalizedSlug]
  );
  return rows.length > 0;
}

function normalizeHost(host) {
  return normalizeNetworkHost(host);
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
  return !!normalizedAccountId && runningDurableAccounts.has(normalizedAccountId);
}

function isMailAccountWriteRunning(accountId) {
  return runningDurableMutationAccounts.has(normalizeMailAccountId(accountId));
}
function isAnyMailAccountSyncRunning() {
  return runningDurableAccounts.size > 0 || require('./mail-writebacks').isWritebackRunning();
}

function getRunningMailSyncAccountIds() {
  return [...runningDurableAccounts];
}

function isMailServerDeleteRunning(accountId) {
  const normalizedAccountId = normalizeMailAccountId(accountId);
  return !!normalizedAccountId && activeMailServerDeleteAccounts.has(normalizedAccountId);
}

function isAnyMailServerDeleteRunning() {
  return activeMailServerDeleteAccounts.size > 0;
}

function getRunningMailServerDeleteAccountIds() {
  return Array.from(activeMailServerDeleteAccounts.keys());
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
    `SELECT r.id, r.user_id, r.mail_account_id, r.match_type, LOWER(TRIM(r.match_value)) AS match_value,
            COALESCE(o.target_folder, r.target_folder) AS target_folder, r.priority, r.is_active, r.created_at, r.updated_at
     FROM mail_sender_rules r LEFT JOIN mail_folder_rule_overrides o ON o.rule_id = r.id AND o.mail_account_id = ?
     WHERE r.user_id = ? AND r.is_active = TRUE AND (r.mail_account_id IS NULL OR r.mail_account_id = ?)`,
    [accountId, userId, accountId]
  );
  return Array.isArray(rules) ? rules : [];
}

function sortMailSenderRules(rules, mailAccountId) {
  const accountId = String(mailAccountId || '').trim() || null;
  return [...(rules || [])].sort((a, b) => {
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
}

function pickBestMailSenderRuleMatch(rules, mailAccountId, senderEmail, senderDomain, sorted = false) {
  for (const rule of sorted ? rules : sortMailSenderRules(rules, mailAccountId)) {
    const isEmailMatch = rule.match_type === 'email' && senderEmail && rule.match_value === senderEmail;
    const isDomainMatch = rule.match_type === 'domain' && senderDomain && rule.match_value === senderDomain;
    if (isEmailMatch || isDomainMatch) return rule;
  }
  return null;
}

async function createMailRoutingContext(userId, mailAccountId, connection = db) {
  const folders = await loadMailFoldersForUser(userId, connection);
  const rules = await loadActiveMailSenderRules(userId, mailAccountId, connection);
  return { userId, mailAccountId, folders: new Set(folders.filter(folder => !folder.mail_account_id || folder.mail_account_id === mailAccountId).map(folder => folder.slug)), rules: sortMailSenderRules(rules, mailAccountId) };
}

async function resolveMailSenderTargetFolder({ userId, mailAccountId = null, fromAddress = '', fallbackFolder = 'inbox', rules = null, routingContext = null, connection = db }) {
  const senderEmail = normalizeSenderEmail(fromAddress);
  const senderDomain = normalizeSenderDomain(fromAddress);
  const context = routingContext?.userId === userId && routingContext?.mailAccountId === mailAccountId ? routingContext : null;
  const activeRules = context ? context.rules : Array.isArray(rules) ? rules : await loadActiveMailSenderRules(userId, mailAccountId, connection);
  const winningRule = pickBestMailSenderRuleMatch(activeRules, mailAccountId, senderEmail, senderDomain, !!context);
  let resolvedFolder = fallbackFolder || 'inbox';
  if (winningRule?.target_folder) {
    const targetFolder = normalizeMailFolderSlug(winningRule.target_folder);
    if (context ? context.folders.has(targetFolder) : await mailFolderExists(userId, targetFolder, connection, mailAccountId)) {
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
  await connection.execute(
      `INSERT INTO mail_folders (id, user_id, slug, display_name, is_system, position)
       VALUES ${MAIL_FOLDER_DEFINITIONS.map(() => '(?, ?, ?, ?, TRUE, ?)').join(', ')}
       ON DUPLICATE KEY UPDATE id = id`,
      MAIL_FOLDER_DEFINITIONS.flatMap(folder => [crypto.randomUUID(), userId, folder.slug, folder.displayName, folder.position])
    );
}

function isKnownMailProviderHost(host) {
  const normalizedHost = normalizeHost(host);
  if (!normalizedHost) return false;
  return KNOWN_MAIL_HOST_SUFFIXES.some(suffix => normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`));
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

function isTlsTrustError(errorOrMessage) {
  const values = typeof errorOrMessage === 'object' && errorOrMessage !== null
    ? [
        errorOrMessage.message,
        errorOrMessage.code,
        errorOrMessage.source,
        errorOrMessage.authorizationError,
        errorOrMessage.reason,
      ]
    : [errorOrMessage];
  const normalized = values
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).toUpperCase())
    .join(' ');
  if (!normalized) return false;
  return (
    isSelfSignedTlsError(normalized) ||
    normalized.includes('CERT') ||
    normalized.includes('UNABLE_TO_VERIFY') ||
    normalized.includes('UNABLE_TO_GET_ISSUER') ||
    normalized.includes('UNABLE_TO_GET_CRL') ||
    normalized.includes('HOSTNAME') ||
    normalized.includes('ALTNAME') ||
    normalized.includes('EXPIRED') ||
    normalized.includes('NOT_YET_VALID')
  );
}

async function assessMailHost(host, port) {
  const normalizedHost = normalizeHost(host);
  const knownProvider = isKnownMailProviderHost(normalizedHost);
  const allowlisted = isTrustedMailHost(normalizedHost);
  const reasons = [];

  if (!knownProvider && !allowlisted) {
    reasons.push('unknown_provider');
  }

  let resolvedAddresses = [];
  let resolveError = null;
  try {
    resolvedAddresses = (await resolveNetworkHost(normalizedHost)).map(entry => entry.address);
  } catch (error) {
    resolveError = error.message;
  }

  if (resolveError) reasons.push('dns_resolution_failed');
  const privateAddresses = resolvedAddresses.filter(address => !isPublicNetworkAddress(address));
  if (privateAddresses.length > 0 && !allowlisted) {
    reasons.push('private_or_local_address');
  }

  return {
    host: normalizedHost,
    port: Number(port) || null,
    knownProvider,
    allowlisted,
    unknownProvider: !knownProvider && !allowlisted,
    blocked: !!resolveError || (privateAddresses.length > 0 && !allowlisted),
    reasons,
    resolvedAddresses,
    privateAddresses,
    resolveError,
  };
}

async function buildMailHostTrustResult({ imap_host, imap_port, smtp_host, smtp_port, imapTlsError = null }) {
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
  if (imapAssessment.blocked) warnings.push(`IMAP host "${imapAssessment.host}" could not be safely resolved to an allowed address.`);
  if (smtpAssessment.blocked) warnings.push(`SMTP host "${smtpAssessment.host}" could not be safely resolved to an allowed address.`);
  if (imapTlsError) {
    warnings.push(`IMAP certificate for "${imapAssessment.host}" could not be verified by the mail login (${imapTlsError}).`);
  }

  if (blocked) {
    return {
      blocked,
      requiresConfirmation: true,
      requiresInsecureTls: false,
      warnings,
      assessments,
      certificates: {
        imap: { error: 'Blocked before certificate check because the host could not be safely resolved to an allowed address.' },
        smtp: { error: 'Blocked before certificate check because the host could not be safely resolved to an allowed address.' },
      },
    };
  }

  const requiresInsecureTls = Boolean(imapTlsError);
  return {
    blocked,
    requiresConfirmation: requiresInsecureTls,
    requiresInsecureTls,
    warnings,
    assessments,
    certificates: requiresInsecureTls
      ? {
          imap: {
            authorized: false,
            authorizationError: imapTlsError,
            error: imapTlsError,
          },
        }
      : {},
  };
}

async function validateMailHostPolicy({ imap_host, imap_port, smtp_host, smtp_port }) {
  const mailHostTrust = await buildMailHostTrustResult({
    imap_host,
    imap_port,
    smtp_host,
    smtp_port,
  });

  if (mailHostTrust.blocked) {
    return {
      error: 'Mail host blocked because it could not be safely resolved to an allowed address. Ask the host administrator to add it to TRUSTED_MAIL_HOSTS if this is intentional.',
      status: 400,
      mailHostTrust,
    };
  }

  return {
    accepted: true,
    mailHostTrust,
  };
}

function isAttachmentPathUnderUploads(storagePath) {
  const uploadsRoot = path.resolve(process.env.MAIL_ATTACHMENT_UPLOAD_ROOT || '/app/uploads/attachments');
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

function isMailRawPathUnderRoot(storagePath) {
  const root = path.resolve(MAIL_RAW_STORAGE_ROOT);
  const resolvedPath = path.resolve(storagePath || '');
  return resolvedPath === root || resolvedPath.startsWith(`${root}${path.sep}`);
}

function isUsableRawEmailArchive(storagePath) {
  if (!storagePath || !isMailRawPathUnderRoot(storagePath)) return false;
  try {
    return fs.existsSync(path.resolve(storagePath));
  } catch {
    return false;
  }
}

async function saveRawEmailSource({ userId, emailId, rawEmail }) {
  return require('./mail-engine/content').publishRaw({ root: MAIL_RAW_STORAGE_ROOT, userId, emailId, raw: rawEmail });
}

function flattenImapBoxes(boxes, prefix = '', specialUses = new Map()) {
  const results = [];
  for (const [name, box] of Object.entries(boxes || {})) {
    const delimiter = box?.delimiter || '/';
    const fullName = prefix ? `${prefix}${delimiter}${name}` : name;
    const attributes = (box?.attribs || []).map(value => String(value).toLowerCase());
    const roles = { '\\sent': 'sent', '\\drafts': 'drafts', '\\junk': 'junk', '\\trash': 'trash', '\\archive': 'archive', '\\all': 'archive', '\\important': 'important' };
    const role = attributes.map(attribute => roles[attribute]).find(Boolean);
    if (role) specialUses.set(fullName, role);
    if (!attributes.includes('\\noselect')) results.push(fullName);
    if (box?.children) {
      results.push(...flattenImapBoxes(box.children, fullName, specialUses));
    }
  }
  return results;
}

async function listAvailableImapFolders(connection, specialUses = new Map(), strict = false) {
  try {
    if (typeof connection.getBoxes !== 'function') {
      if (strict) throw new Error('Server folder listing unavailable');
      return ['INBOX'];
    }
    const boxes = await connection.getBoxes();
    if (strict && (!boxes || typeof boxes !== 'object' || Array.isArray(boxes))) throw new Error('Invalid server folder listing');
    const folders = flattenImapBoxes(boxes, '', specialUses);
    if (strict && folders.length === 0) throw new Error('Server returned no selectable folders; retry required');
    return folders;
  } catch (error) {
    if (strict) throw error;
    console.log('[SYNC] Could not list IMAP folders, falling back to INBOX:', error.message);
    return ['INBOX'];
  }
}

function isProviderManagedImapFolder(folderName) {
  return String(folderName || '').trim().startsWith('[');
}

function isVirtualMailFolderName(folderName) {
  return String(folderName || '').trim().toLowerCase() === 'starred';
}

async function allocateCollisionSafeMailFolderSlug(userId, displayName, connection = db) {
  const baseSlug = normalizeMailFolderSlug(displayName);
  if (!baseSlug) return '';
  const [rows] = await connection.execute(
    'SELECT slug FROM mail_folders WHERE user_id = ? AND slug LIKE ?',
    [userId, `${baseSlug.slice(0, MAIL_FOLDER_SLUG_MAX_LENGTH - 3)}%`]
  );
  const used = new Set((rows || []).map(row => row.slug));
  if (!used.has(baseSlug)) return baseSlug;
  for (let suffix = 2; suffix < 100000; suffix += 1) {
    const candidate = `${baseSlug.slice(0, MAIL_FOLDER_SLUG_MAX_LENGTH - String(suffix).length - 1)}_${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Unable to allocate a unique mail folder slug');
}

async function registerCustomImapFoldersForUser(userId, accountId, availableFolders, connection = db, specialUses = new Map(), includeAll = false) {
  if (!userId || !accountId) return [];
  await ensureDefaultMailFoldersForUser(userId, connection);
  const standardNames = new Set(MAIL_SYNC_FOLDER_CANDIDATES.flatMap(candidate => candidate.names.map(name => name.toLowerCase())));
  const registered = [];

  for (const rawFolderName of availableFolders || []) {
    // Keep the remote identity lossless; only the label shown in the UI is normalized.
    const remoteName = includeAll ? String(rawFolderName || '') : String(rawFolderName || '').trim();
    const displayName = normalizeMailFolderDisplayName(remoteName);
    if (!remoteName || !displayName || (!includeAll && isVirtualMailFolderName(remoteName))) continue;
    const [mapped] = await connection.execute(
      `SELECT f.id, f.slug, f.display_name
       FROM mail_folder_remote_boxes b
       JOIN mail_folders f ON f.id = b.folder_id
       WHERE f.user_id = ? AND b.mail_account_id = ? AND b.remote_name = ? LIMIT 1`,
      [userId, accountId, remoteName]
    );
    if (mapped.length > 0) {
      // Metadata may improve the icon, but an established mapping must never move old mail.
      if (specialUses.has(remoteName)) {
        await connection.execute('UPDATE mail_folders SET special_use = ? WHERE id = ? AND special_use IS NULL', [specialUses.get(remoteName), mapped[0].id]);
      }
      registered.push({ slug: mapped[0].slug, displayName, remoteName });
      continue;
    }
    if (SYSTEM_MAIL_FOLDER_SET.has(specialUses.get(remoteName))) {
      const slug = specialUses.get(remoteName);
      const [systemRows] = await connection.execute('SELECT id FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1', [userId, slug]);
      if (!systemRows.length) throw new Error('Missing local system folder mapping');
      await connection.execute(`INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name)
        VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE folder_id = folder_id`, [systemRows[0].id, accountId, remoteName]);
      const [verified] = await connection.execute(`SELECT folder_id FROM mail_folder_remote_boxes
        WHERE mail_account_id = ? AND BINARY remote_name = BINARY ? LIMIT 1`, [accountId, remoteName]);
      if (verified[0]?.folder_id !== systemRows[0].id) throw new Error('Remote system folder mapping conflicts with another mailbox');
      registered.push({ slug, displayName, remoteName });
      continue;
    }
    if (!includeAll && !specialUses.has(remoteName) && (isProviderManagedImapFolder(remoteName) || standardNames.has(remoteName.toLowerCase()))) continue;
    // Only reuse a folder from this account. Legacy shared rows remain untouched.
    const [sameName] = await connection.execute(
      `SELECT id, slug FROM mail_folders f
       WHERE f.user_id = ? AND f.mail_account_id = ? AND f.is_system = FALSE AND f.display_name = ?
         AND NOT EXISTS (SELECT 1 FROM mail_folder_remote_boxes b WHERE b.folder_id = f.id AND b.remote_name <> ?)
       ORDER BY f.created_at ASC LIMIT 1`,
      [userId, accountId, displayName, remoteName]
    );
    const folderId = sameName[0]?.id || crypto.randomUUID();
    const slug = sameName[0]?.slug || await allocateCollisionSafeMailFolderSlug(userId, displayName, connection);
    const [positionRows] = await connection.execute(
      'SELECT COALESCE(MAX(position), 100) AS max_position FROM mail_folders WHERE user_id = ?',
      [userId]
    );
    if (!sameName.length) {
      await connection.execute(
        `INSERT INTO mail_folders (id, user_id, mail_account_id, special_use, slug, display_name, is_system, position)
         VALUES (?, ?, ?, ?, ?, ?, FALSE, ?)`,
        [folderId, userId, accountId, specialUses.get(remoteName) || null, slug, displayName, Number(positionRows[0]?.max_position || 100) + 10]
      );
    }
    await connection.execute(
      `INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE remote_name = VALUES(remote_name)`,
      [folderId, accountId, remoteName]
    );
    registered.push({ slug, displayName, remoteName });
  }
  return registered;
}

function pickImapSyncFolders(availableFolders, customFolderSlugs = new Map()) {
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
        picked.push({ folderName: actualName, dbFolderName: customFolderSlugs.get(actualName) || candidate.slug });
        seenNames.add(actualName.toLowerCase());
        break;
      }
    }
  }

  if (!picked.some(folder => folder.dbFolderName === 'inbox')) {
    picked.unshift({ folderName: 'INBOX', dbFolderName: 'inbox' });
  }
  for (const rawFolderName of availableFolders || []) {
    const folderName = String(rawFolderName || '').trim();
    const slug = customFolderSlugs.get(folderName);
    if (!folderName || !slug || isVirtualMailFolderName(folderName) || seenNames.has(folderName.toLowerCase())) continue;
    picked.push({ folderName, dbFolderName: slug });
    seenNames.add(folderName.toLowerCase());
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

async function findExistingImportedEmail({ connection = db, accountId, folderName, uid, uidValidity, userId }) {
  const validUid = require('./mail-engine/content').uint32(uid);
  const validEpoch = require('./mail-engine/content').uint32(uidValidity);
  if (!accountId || !folderName || !validUid || !validEpoch) return null;
  const [rows] = await connection.execute(`SELECT e.id, e.message_id, e.from_address, e.from_name, e.to_addresses,
      e.body_text, e.body_html, e.received_at, e.source_folder, e.imap_uid, e.imap_uidvalidity,
      e.raw_storage_path, e.import_complete
    FROM mail_remote_occurrences o JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id
      JOIN emails e ON e.id = o.email_id AND e.mail_account_id = o.mail_account_id
    WHERE o.mail_account_id = ? AND (? IS NULL OR o.user_id = ?) AND BINARY m.remote_name = BINARY ?
      AND o.uidvalidity = ? AND o.uid = ? AND o.presence = 'present' LIMIT 1`,
  [accountId, userId || null, userId || null, folderName, validEpoch, validUid]);
  return rows[0] || null;
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
        AND imap_uid IN (${placeholders})
        AND import_complete = TRUE
        AND raw_storage_path IS NOT NULL`;

    if (uidValidity !== null && uidValidity !== undefined) {
      query += ' AND imap_uidvalidity = ?';
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

function normalizeImapUid(value) {
  const uid = Number(value);
  return Number.isFinite(uid) && uid > 0 ? uid : null;
}

async function recordMailServerMessageForDeletion({
  connection = db,
  userId,
  accountId,
  emailId,
  sourceFolder,
  imapUid,
  imapUidValidity,
  rawStoragePath,
  rawSha256,
  rawBytes,
  rawFormat,
  rawVerified,
}) {
  const { uint32, verifyArchive } = require('./mail-engine/content');
  const normalizedUid = uint32(imapUid), epoch = uint32(imapUidValidity);
  const folderName = String(sourceFolder || '');
  if (!userId || !accountId || !emailId || !folderName || !normalizedUid || !epoch
    || rawFormat !== 'exact_octets' || rawVerified !== true) return false;
  if (!await verifyArchive({ raw_storage_path: rawStoragePath, raw_sha256: rawSha256,
    raw_bytes: rawBytes, raw_format: rawFormat, raw_verified: rawVerified }, { root: MAIL_RAW_STORAGE_ROOT })) return false;

  await connection.execute(
    `INSERT INTO mail_server_messages
       (id, user_id, mail_account_id, email_id, source_folder, imap_uid, imap_uidvalidity)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       imap_uidvalidity = IF(mail_server_messages.email_id = VALUES(email_id)
         AND mail_server_messages.imap_uidvalidity = VALUES(imap_uidvalidity), VALUES(imap_uidvalidity), mail_server_messages.imap_uidvalidity)`,
    [
      crypto.randomUUID(),
      userId,
      accountId,
      emailId,
      folderName,
      normalizedUid,
      imapUidValidity === undefined ? null : imapUidValidity,
    ]
  );
  return true;
}

async function seedMailServerDeletionQueueForAccount({ userId, accountId, connection = db }) {
  if (!userId || !accountId) return { queued: 0 };
  let queued = 0, afterId = '';
  for (;;) {
    const [emails] = await connection.execute(
      `SELECT id, COALESCE(remote_folder, source_folder) AS source_folder,
         COALESCE(remote_uid, imap_uid) AS imap_uid, COALESCE(remote_uidvalidity, imap_uidvalidity) AS imap_uidvalidity,
         raw_storage_path, raw_sha256, raw_bytes, raw_format, raw_verified
       FROM emails WHERE user_id = ? AND mail_account_id = ? AND id > ?
         AND import_complete = TRUE AND raw_verified = TRUE AND raw_format = 'exact_octets'
         AND COALESCE(remote_uidvalidity, imap_uidvalidity) IS NOT NULL
       ORDER BY id LIMIT 200`, [userId, accountId, afterId]);
    for (const email of emails) {
      if (await recordMailServerMessageForDeletion({ connection, userId, accountId, emailId: email.id,
        sourceFolder: email.source_folder, imapUid: email.imap_uid, imapUidValidity: email.imap_uidvalidity,
        rawStoragePath: email.raw_storage_path, rawSha256: email.raw_sha256, rawBytes: Number(email.raw_bytes),
        rawFormat: email.raw_format, rawVerified: toBooleanFlag(email.raw_verified) })) queued++;
    }
    if (emails.length < 200) break;
    afterId = emails[emails.length - 1].id;
    await new Promise(resolve => setImmediate(resolve));
  }
  // A failed/skipped destructive attempt is not silently reset to pending.
  return { queued };
}

async function markMailServerMessageDeleteStatus({ connection = db, id, status, error = null }) {
  const allowedStatuses = new Set(['pending', 'deleted', 'missing', 'failed', 'skipped']);
  if (!id || !allowedStatuses.has(status)) return;
  await connection.execute(
    `UPDATE mail_server_messages
     SET delete_status = ?,
         delete_attempts = delete_attempts + 1,
         delete_error = ?,
         deleted_at = CASE WHEN ? = 'deleted' OR ? = 'missing' THEN UTC_TIMESTAMP() ELSE deleted_at END
     WHERE id = ?`,
    [status, error ? String(error).slice(0, 2000) : null, status, status, id]
  );
}

function imapSupportsUidExpunge(connection) {
  try {
    return !!connection?.imap?.serverSupports?.('UIDPLUS');
  } catch {
    return false;
  }
}

function addImapUidFlag(connection, uid, flag) {
  return new Promise((resolve, reject) => {
    connection.imap.addFlags(uid, flag, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function removeImapUidFlag(connection, uid, flag) {
  return new Promise((resolve, reject) => {
    connection.imap.delFlags(uid, flag, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function expungeImapUid(connection, uid) {
  return new Promise((resolve, reject) => {
    connection.imap.expunge(uid, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function deleteImapUid(connection, uid) {
  if (!imapSupportsUidExpunge(connection)) {
    throw new Error('IMAP server does not support UIDPLUS; refusing mailbox-wide expunge for safety.');
  }

  let markedDeleted = false;
  try {
    await addImapUidFlag(connection, uid, '\\Deleted');
    markedDeleted = true;
    await expungeImapUid(connection, uid);
  } catch (error) {
    if (markedDeleted) {
      try {
        await removeImapUidFlag(connection, uid, '\\Deleted');
      } catch (removeError) {
        console.error(`[SERVER DELETE] Failed to remove \\Deleted flag from UID ${uid}:`, removeError.message);
      }
    }
    throw error;
  }
}

async function isMailServerDeletionStillEnabled(accountId) {
  if (mailDeleteStopRequests.has(normalizeMailAccountId(accountId))) return false;
  const [rows] = await db.execute(
    `SELECT user_id, delete_emails_on_server, is_active, server_delete_grace_until, sync_mode
     FROM mail_accounts
     WHERE id = ?
     LIMIT 1`,
    [accountId]
  );
  const account = rows[0];
  if (!account || account.sync_mode === 'sync') return false;
  if (!toBooleanFlag(account.delete_emails_on_server) || !toBooleanFlag(account.is_active)) return false;
  if (!await isModuleBackgroundEnabled(account.user_id, 'mail') || await isSectionRestoreActive(account.user_id, 'mail')) return false;
  if (!account.server_delete_grace_until) return false;
  return new Date(account.server_delete_grace_until).getTime() <= Date.now();
}

async function buildImapConnectionConfig(account, { keepalive = true } = {}) {
  const password = account.encrypted_password ? decrypt(account.encrypted_password) : null;
  if (!password) return null;
  const imapPort = account.imap_port || 993;
  const target = await resolveMailConnectionTarget(account.imap_host);
  return {
    imap: {
      user: account.username || account.email_address,
      password,
      host: target.address,
      port: imapPort,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: !toBooleanFlag(account.allow_self_signed),
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
      },
      connTimeout: 60000,
      authTimeout: 30000,
      socketTimeout: 60000,
      keepalive,
    },
  };
}

function createImapBox(connection, folderName) {
  return new Promise((resolve, reject) => {
    if (typeof connection?.imap?.addBox !== 'function') {
      reject(new Error('The configured IMAP client does not support remote folder creation.'));
      return;
    }
    connection.imap.addBox(folderName, error => error ? reject(error) : resolve());
  });
}

async function ensureCustomImapFoldersForUser(userId, connection, availableFolders, dbConnection = db) {
  if (!userId || !connection) return { created: 0, failed: [] };
  const [localFolders] = await dbConnection.execute(
    'SELECT display_name FROM mail_folders WHERE user_id = ? AND is_system = FALSE ORDER BY position ASC, display_name ASC',
    [userId]
  );
  const existingNames = new Set((availableFolders || []).map(name => String(name).trim().toLowerCase()));
  const failed = [];
  let created = 0;
  for (const folder of localFolders || []) {
    const displayName = normalizeMailFolderDisplayName(folder.display_name);
    if (!displayName || existingNames.has(displayName.toLowerCase())) continue;
    try {
      await createImapBox(connection, displayName);
      existingNames.add(displayName.toLowerCase());
      created += 1;
    } catch (error) {
      failed.push({ displayName, error: error.message || String(error) });
    }
  }
  return { created, failed };
}

async function createRemoteMailFolderForUserAccounts(userId, folderName, accountId) {
  const displayName = normalizeMailFolderDisplayName(folderName);
  if (!userId || !displayName || !accountId) return { status: 'complete', retryable: false, created: 0, existing: 0, accounts: [] };
  const [accounts] = await db.execute(
    'SELECT * FROM mail_accounts WHERE user_id = ? AND id = ? AND is_active = TRUE',
    [userId, accountId]
  );
  const results = [];
  for (const account of accounts || []) {
    let connection = null;
    try {
      const config = await buildImapConnectionConfig(account);
      if (!config) throw new Error('No password configured');
      connection = await imaps.connect(config);
      const availableFolders = await listAvailableImapFolders(connection);
      if (availableFolders.some(name => String(name).toLowerCase() === displayName.toLowerCase())) {
        results.push({ accountId: account.id, remoteName: displayName, status: 'existing' });
      } else {
        await createImapBox(connection, displayName);
        results.push({ accountId: account.id, remoteName: displayName, status: 'created' });
      }
    } catch (error) {
      results.push({ accountId: account.id, remoteName: displayName, status: 'failed', retryable: true, error: error.message || String(error) });
    } finally {
      if (connection) {
        try { connection.end(); } catch { /* already closed */ }
      }
    }
  }
  return {
    status: results.some(result => result.status === 'failed') ? 'partial' : 'complete',
    retryable: results.some(result => result.status === 'failed'),
    created: results.filter(result => result.status === 'created').length,
    existing: results.filter(result => result.status === 'existing').length,
    accounts: results,
  };
}

async function processMailServerDeletionForAccountUnlocked(accountId, { limit = MAIL_SERVER_DELETE_BATCH_SIZE } = {}) {
  const normalizedAccountId = normalizeMailAccountId(accountId);
  if (!normalizedAccountId || activeMailServerDeleteAccounts.has(normalizedAccountId)) {
    return { accountId: normalizedAccountId, skipped: true, reason: 'already_running' };
  }
  if (isMailAccountSyncRunning(normalizedAccountId)) {
    return { accountId: normalizedAccountId, skipped: true, reason: 'mail_sync_running' };
  }

  activeMailServerDeleteAccounts.add(normalizedAccountId);
  let connection = null;
  try {
    const [accounts] = await db.execute(
      `SELECT *
       FROM mail_accounts
       WHERE id = ?
         AND sync_mode = 'download'
         AND delete_emails_on_server = TRUE
         AND is_active = TRUE
         AND server_delete_grace_until IS NOT NULL
         AND server_delete_grace_until <= UTC_TIMESTAMP()
       LIMIT 1`,
      [normalizedAccountId]
    );
    const account = accounts[0];
    if (!account || account.sync_mode === 'sync') return { accountId: normalizedAccountId, skipped: true, reason: 'not_enabled_or_grace_pending' };
    if (!await isModuleBackgroundEnabled(account.user_id, 'mail')) {
      return { accountId: normalizedAccountId, skipped: true, reason: 'module_paused' };
    }
    if (await isSectionRestoreActive(account.user_id, 'mail')) {
      return { accountId: normalizedAccountId, skipped: true, reason: 'mail_restore_running' };
    }

    const config = await buildImapConnectionConfig(account);
    if (!config) return { accountId: normalizedAccountId, success: false, error: 'No password configured for this account' };

    const safeLimit = Math.min(Math.max(Number(limit) || MAIL_SERVER_DELETE_BATCH_SIZE, 1), 500);
    const [messages] = await db.execute(
      `SELECT m.id, m.user_id, m.mail_account_id, m.email_id, m.source_folder, m.imap_uid, m.imap_uidvalidity,
         e.raw_storage_path, e.raw_sha256, e.raw_bytes, e.raw_format, e.raw_verified, e.import_complete,
         e.remote_folder, e.remote_uid, e.remote_uidvalidity, e.source_folder AS email_source_folder,
         e.imap_uid AS email_imap_uid, e.imap_uidvalidity AS email_imap_uidvalidity, e.remote_missing
       FROM mail_server_messages m JOIN emails e ON e.id = m.email_id AND e.user_id = m.user_id AND e.mail_account_id = m.mail_account_id
       WHERE m.mail_account_id = ?
         AND m.user_id = ?
         AND m.delete_status = 'pending'
       ORDER BY m.created_at ASC
       LIMIT ${safeLimit}`,
      [normalizedAccountId, account.user_id]
    );

    if (!messages.length) {
      await db.execute('UPDATE mail_accounts SET server_delete_last_run_at = UTC_TIMESTAMP() WHERE id = ?', [normalizedAccountId]);
      return { accountId: normalizedAccountId, success: true, processed: 0, deleted: 0, missing: 0, failed: 0, stopped: false };
    }

    console.log(`[SERVER DELETE] Connecting to delete ${messages.length} queued message(s) for ${account.email_address}`);
    connection = await imaps.connect(config);
    connection.on('error', (err) => {
      console.error('[SERVER DELETE] IMAP connection error (handled):', err.message);
    });

    let currentFolder = null;
    let processed = 0;
    let deleted = 0;
    let missing = 0;
    let failed = 0;
    let skipped = 0;
    let stopped = false;

    for (const message of messages) {
      if (!(await isMailServerDeletionStillEnabled(normalizedAccountId))) {
        stopped = true;
        break;
      }

      const { uint32, eligibleForProviderErasure } = require('./mail-engine/content');
      const uid = uint32(message.imap_uid);
      const sourceFolder = String(message.source_folder || '');
      const expectedEpoch = uint32(message.imap_uidvalidity);
      if (!uid || !sourceFolder || !expectedEpoch) {
        await markMailServerMessageDeleteStatus({ id: message.id, status: 'skipped', error: 'Missing verified source folder, UID or epoch.' });
        skipped++;
        processed++;
        continue;
      }

      try {
        if (currentFolder !== sourceFolder) {
          await connection.openBox(sourceFolder);
          currentFolder = sourceFolder;
        }

        const currentUidValidity = uint32(getCurrentBoxUidValidity(connection));
        if (currentUidValidity !== expectedEpoch) {
          await markMailServerMessageDeleteStatus({
            id: message.id, status: 'skipped',
            error: `UIDVALIDITY unverified or changed for ${sourceFolder}.`,
          });
          skipped++; processed++; continue;
        }
        const archived = { ...message, source_folder: message.email_source_folder,
          imap_uid: message.email_imap_uid, imap_uidvalidity: message.email_imap_uidvalidity };
        if (!await eligibleForProviderErasure({ row: archived, sourceFolder, uid,
          uidValidity: expectedEpoch, selectedUidValidity: currentUidValidity, root: MAIL_RAW_STORAGE_ROOT })) {
          await markMailServerMessageDeleteStatus({ id: message.id, status: 'skipped', error: 'Exact archive or current source identity unverified.' });
          skipped++; processed++; continue;
        }

        const found = await connection.search([['UID', uid]], { bodies: ['HEADER.FIELDS (MESSAGE-ID)'], markSeen: false });
        if (!Array.isArray(found) || found.some(item => uint32(item?.attributes?.uid) !== uid)) {
          throw new Error('Malformed provider UID verification; deletion withheld');
        }
        if (found.length === 0) {
          await markMailServerMessageDeleteStatus({ id: message.id, status: 'missing', error: null });
          missing++;
          processed++;
          continue;
        }

        // Settings and local identity may change while SEARCH is in flight.
        if (!(await isMailServerDeletionStillEnabled(normalizedAccountId))) { stopped = true; break; }
        const [freshRows] = await db.execute(`SELECT m.id, m.source_folder, m.imap_uid, m.imap_uidvalidity,
          e.source_folder AS email_source_folder, e.imap_uid AS email_imap_uid,
          e.imap_uidvalidity AS email_imap_uidvalidity, e.remote_folder, e.remote_uid,
          e.remote_uidvalidity, e.remote_missing, e.import_complete, e.raw_storage_path,
          e.raw_sha256, e.raw_bytes, e.raw_format, e.raw_verified
          FROM mail_server_messages m JOIN emails e ON e.id=m.email_id AND e.user_id=m.user_id AND e.mail_account_id=m.mail_account_id
          WHERE m.id=? AND m.user_id=? AND m.mail_account_id=? AND m.delete_status='pending'`,
        [message.id, account.user_id, normalizedAccountId]);
        const fresh = freshRows[0];
        if (!fresh || String(fresh.source_folder) !== sourceFolder || uint32(fresh.imap_uid) !== uid
          || uint32(fresh.imap_uidvalidity) !== expectedEpoch
          || uint32(getCurrentBoxUidValidity(connection)) !== expectedEpoch
          || !await eligibleForProviderErasure({ row: { ...fresh, source_folder: fresh.email_source_folder,
            imap_uid: fresh.email_imap_uid, imap_uidvalidity: fresh.email_imap_uidvalidity },
          sourceFolder, uid, uidValidity: expectedEpoch, selectedUidValidity: expectedEpoch, root: MAIL_RAW_STORAGE_ROOT })) {
          await markMailServerMessageDeleteStatus({ id: message.id, status: 'skipped', error: 'Archive/source changed before dispatch.' });
          skipped++; processed++; continue;
        }
        await deleteImapUid(connection, uid);
        await markMailServerMessageDeleteStatus({ id: message.id, status: 'deleted', error: null });
        deleted++;
        processed++;
      } catch (error) {
        await markMailServerMessageDeleteStatus({ id: message.id, status: 'failed', error: error.message || String(error) });
        failed++;
        processed++;
      }
    }

    await db.execute('UPDATE mail_accounts SET server_delete_last_run_at = UTC_TIMESTAMP() WHERE id = ?', [normalizedAccountId]);
    console.log(`[SERVER DELETE] ${account.email_address}: deleted=${deleted}, missing=${missing}, failed=${failed}, skipped=${skipped}, stopped=${stopped}`);
    return { accountId: normalizedAccountId, success: failed === 0, processed, deleted, missing, failed, skipped, stopped };
  } catch (error) {
    console.error(`[SERVER DELETE] Account ${normalizedAccountId} failed:`, error.message);
    return { accountId: normalizedAccountId, success: false, error: error.message || String(error) };
  } finally {
    if (connection) {
      try { connection.end(); } catch (e) { /* ignore */ }
    }
    activeMailServerDeleteAccounts.delete(normalizedAccountId);
    mailDeleteStopRequests.delete(normalizedAccountId);
  }
}

async function processMailServerDeletionForAccount(accountId, options = {}) {
  const key = normalizeMailAccountId(accountId);
  if (!key || activeMailServerDeleteAccounts.has(key)) return { accountId: key, skipped: true, reason: 'already_running' };
  if (isMailAccountSyncRunning(key)) return { accountId: key, skipped: true, reason: 'mail_sync_running' };
  return withMailAccountLock(accountId, () => processMailServerDeletionForAccountUnlocked(accountId, options));
}

async function runMailServerDeletionPass({ accountId = null, limit = MAIL_SERVER_DELETE_BATCH_SIZE } = {}) {
  const params = [];
  let query = `
    SELECT id
    FROM mail_accounts
    WHERE sync_mode = 'download' AND delete_emails_on_server = TRUE
      AND is_active = TRUE
      AND server_delete_grace_until IS NOT NULL
      AND server_delete_grace_until <= UTC_TIMESTAMP()`;
  if (accountId) {
    query += ' AND id = ?';
    params.push(accountId);
  }
  query += ' ORDER BY server_delete_grace_until ASC LIMIT 10';

  const [accounts] = await db.execute(query, params);
  const results = [];
  for (const account of accounts || []) {
    results.push(await processMailServerDeletionForAccount(account.id, { limit }));
  }
  return { skipped: false, accounts: results };
}

// ── Mail sync and send functions ──────────────────────────────────

// Compatibility entry point: perform one bounded slice. Never enumerate ALL or
// imply that a finite page means all historical bodies/flags are complete.
async function syncMailFolder(connection, account, accountId, folderName, dbFolderName,
  _lastSyncedAt = null, _syncFetchLimit = null, signal = null) {
  const result = await require('./mail-engine/sync').scanMailboxSlice({ db, connection,
    account: { ...account, id: accountId }, folder: { folderName, dbFolderName },
    stream: 'recent', signal });
  return { newEmails: result.inserted || 0, processed: result.processed, failed: 0,
    total: null, coverage: { recent: { through: result.through, upper: result.upper } },
    continuation: result.more, requestedCount: 'bounded' };
}

// Test IMAP connection and authentication without syncing.
async function testImapConnection(account) {
  let connection = null;
  const imapPort = account.imap_port || 993;
  try {
    const config = await buildImapConnectionConfig(account, { keepalive: false });
    if (!config) return { success: false, error: 'No password configured' };

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
    const tlsTrustError = isTlsTrustError(error);
    console.error('[ACCOUNT] IMAP test failed:', {
      host: account.imap_host,
      port: imapPort,
      rejectUnauthorized: !toBooleanFlag(account.allow_self_signed),
      code: error.code || null,
      source: error.source || null,
      message: errorMsg,
      tlsTrustError,
    });

    let friendlyError = errorMsg;
    if (tlsTrustError && !toBooleanFlag(account.allow_self_signed)) {
      friendlyError = 'IMAP certificate could not be verified. Review and confirm mail server authenticity before continuing.';
    } else if (errorMsg.includes('AUTHENTICATIONFAILED') || errorMsg.includes('Invalid credentials')) {
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

    return {
      success: false,
      error: friendlyError,
      details: errorMsg,
      code: error.code || null,
      tlsTrustError,
    };
  }
}

// Retired pre-0.11 implementation, deliberately not called by exported sync.
// Kept temporarily for migration reference; do not re-enable its ALL/inventory
// equality scan. The durable job path below is the only production scheduler.
async function syncMailAccountOnce(accountId, signal, background, report = () => {}) {
  let connection = null;
  try {
    debugLog('server.js:50', 'syncMailAccount START', { accountId }, 'H1');
    const [accounts] = await db.execute('SELECT * FROM mail_accounts WHERE id = ?', [accountId]);
    if (!accounts[0]) {
      return { success: false, error: `Account ${accountId} not found in database` };
    }
    
    const account = accounts[0];
    checkCancelled(signal);
    if (!account.is_active) return { success: false, skipped: true, error: 'Mail account is inactive' };
    if (!await (background ? isModuleBackgroundEnabled : isModuleEnabled)(account.user_id, 'mail')) {
      return { success: false, skipped: true, error: 'Mail module is paused' };
    }
    const followsServer = account.sync_mode === 'sync';
    if (await isSectionRestoreActive(account.user_id, 'mail')) {
      return { success: false, skipped: true, error: 'Mail restore in progress' };
    }
    if (followsServer) await db.execute("UPDATE mail_accounts SET sync_status = 'running' WHERE id = ?", [accountId]);
    const lastSyncedAt = account.last_synced_at;
    const syncFetchLimit = normalizeSyncFetchLimit(account.sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT) || DEFAULT_MAIL_SYNC_FETCH_LIMIT;
    const config = await buildImapConnectionConfig(account);
    if (!config) throw new Error('No password configured for this account');

    checkCancelled(signal);
    console.log(`[SYNC] Connecting to ${account.email_address}...`);
    // The handshake has connection/auth/socket timeouts. If cancellation arrived
    // during it, the guard destroys the newly returned connection before use.
    connection = guardImapConnection(await imaps.connect(config), { signal });
    checkCancelled(signal);
    connection.on('error', (err) => {
      console.error('[SYNC] IMAP connection error (handled, sync may fail):', err.message);
    });
    
    const specialUses = new Map();
    report({ phase: 'listing folders' });
    const availableFolders = await listAvailableImapFolders(connection, specialUses, true);
    checkCancelled(signal);
    for (const planned of pickImapSyncFolders(availableFolders)) {
      if (availableFolders.includes(planned.folderName) && !specialUses.has(planned.folderName)) specialUses.set(planned.folderName, planned.dbFolderName);
    }
    await ensureDefaultMailFoldersForUser(account.user_id);
    const reconciliation = await reconcileAccountFolders(account.user_id, accountId, availableFolders, specialUses);
    if (!reconciliation.skipped) console.log('[FOLDERS] Reconciliation completed:', accountId, reconciliation);
    // Sync only boxes explicitly registered from this account. Never infer an
    // identity from a lossy UI slug or recreate a locally deleted mailbox.
    const registeredFolders = await registerCustomImapFoldersForUser(account.user_id, accountId, availableFolders, db, specialUses, followsServer);
    const customFolderSlugs = new Map(registeredFolders.map(folder => [folder.remoteName, folder.slug]));
    if (followsServer) {
      const writes = await require('./mail-writebacks').processPending(account, connection, { background });
      checkCancelled(signal);
      if (writes.connectionFailed) throw new Error('Provider write interrupted; pending changes will be checked on reconnect');
      const folders = availableFolders.map(folderName => ({ folderName, dbFolderName: customFolderSlugs.get(folderName) }));
      if (folders.some(folder => !folder.dbFolderName)) throw new Error('A listed server folder has no verified local mapping');
      let result;
      for (let scan = 0; scan < 5; scan++) {
        try {
          result = await followMailServer({ db, connection, account, folders, signal,
            progress: report,
            checkpoint: async () => {
              checkCancelled(signal);
              const pending = await require('./mail-writebacks').processPending(account, connection, { background });
              if (pending.connectionFailed) throw new Error('Provider write interrupted; pending changes will be checked on reconnect');
              checkCancelled(signal);
              return pending.needsSync;
            },
            listFolders: () => listAvailableImapFolders(connection, new Map(), true),
            getUidValidity: getCurrentBoxUidValidity, buildRaw: buildRawEmailFromImapParts,
            importMessage: async (remote, fullEmail, existingEmail = null) => {
              const parsed = await simpleParser(fullEmail);
              const { fromAddress, fromName } = extractSenderFromParsedEmail(parsed);
              return require('./mail-import').persistImportedMessage({ db, account, accountId,
                folderName: remote.folderName, uid: remote.uid, uidValidity: remote.validity,
                existingEmail, messageId: parsed.messageId || `${accountId}-${remote.folderName}-${remote.validity}-${remote.uid}`,
                fullEmail, parsed, fromAddress, fromName, toAddresses: extractEmailAddresses(parsed.to),
                folder: remote.dbFolderName, isRead: remote.flags.includes('\\Seen'),
                archiveRaw: saveRawEmailSource, enqueueDeletion: async () => false,
                suppressNotifications: !lastSyncedAt || account.sync_status === 'pending' });
            },
          });
          break;
        } catch (error) {
          if (error.code !== 'MAIL_SYNC_RESTART' || scan === 4) throw error;
          checkCancelled(signal);
        }
      }
      checkCancelled(signal);
      await db.execute("UPDATE mail_accounts SET last_synced_at = UTC_TIMESTAMP(), sync_status = 'idle' WHERE id = ?", [accountId]);
      connection.end();
      connection = null;
      return result;
    }
    const foldersToSync = pickImapSyncFolders(availableFolders, customFolderSlugs);
    console.log(`[SYNC] Folder plan for ${account.email_address}: ${foldersToSync.map(folder => `${folder.folderName}->${folder.dbFolderName}`).join(', ')}`);

    const folderResults = [];
    for (const folder of foldersToSync) {
      checkCancelled(signal);
      report({ phase: `importing ${folder.folderName}`, total: null });
      const folderResult = await syncMailFolder(
        connection,
        account,
        accountId,
        folder.folderName,
        folder.dbFolderName,
        lastSyncedAt,
        syncFetchLimit,
        signal
      );
      checkCancelled(signal);
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
    
    const totals = folderResults.reduce((acc, result) => {
      acc.newEmails += result.newEmails || 0;
      acc.totalFound += result.total || 0;
      acc.processed += result.processed || 0;
      acc.failed += result.failed || 0;
      return acc;
    }, { newEmails: 0, totalFound: 0, processed: 0, failed: 0 });
    const failedFolder = folderResults.find(result => result.error || result.failed > 0);
    if (failedFolder) {
      await db.execute("UPDATE mail_accounts SET sync_status = 'error' WHERE id = ?", [accountId]);
      return {
        success: false,
        error: failedFolder.error || 'Some messages could not be imported',
        details: 'Completed messages are retained; unsuccessful folders will retry on the next sync.',
        newEmails: totals.newEmails,
        totalFound: totals.totalFound,
        folders: folderResults,
      };
    }

    await db.execute('UPDATE mail_accounts SET last_synced_at = UTC_TIMESTAMP() WHERE id = ?', [accountId]);

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
    await db.execute('UPDATE mail_accounts SET sync_status = ? WHERE id = ?', [signal?.aborted ? 'cancelled' : 'error', accountId]).catch(() => {});
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

    return { success: false, cancelled: Boolean(signal?.aborted), error: friendlyError, details: errorMsg };
  } finally {
    if (connection) connection.end();
  }
}

const runningDurableAccounts = new Set();
const runningDurableMutationAccounts = new Set();
let durableScheduler;
async function runRecoveredReconcileJob({ job, account, connection, signal, report }) {
  const runtime = require('./mail-engine/runtime');
  const transport = require('./mail-engine/transport');
  const { uint32 } = require('./mail-engine/content');
  const { settleFlagObservation } = require('./mail-engine/reconciliation');
  const { validateWindowReply } = require('./mail-engine/sync');
  const fence = () => runtime.assertFence({ accountId: account.id, jobId: job.id,
    workerId: job.lease_owner, generation: Number(job.worker_generation) });
  if (!job.operation_id || account.sync_mode !== 'sync') return { success: false, error: 'Reconciliation requires a Sync operation' };
  const [[op]] = await db.execute(`SELECT * FROM mail_writebacks WHERE id=? AND user_id=? AND mail_account_id=?`,
    [job.operation_id, account.user_id, account.id]);
  if (!op) return { success: false, error: 'Reconciliation operation missing' };
  if (['confirmed', 'cancelled', 'superseded', 'rejected'].includes(op.state)) return { success: true };
  if (!Number(op.dispatched)) return { success: false, error: 'Undispatched operation is not a reconciliation job' };
  if (op.action === 'move') {
    // The operations executor owns the bounded MOVE outcome classifier. Its
    // dispatched branch reads provider state and can settle/mark attention;
    // it must never call nativeMove again after the persisted dispatch fence.
    await require('./mail-engine/operations').applyMove(op, connection, Number(job.worker_generation),
      signal, job.lease_owner, job.id);
    await fence();
    const [[current]] = await db.execute('SELECT state FROM mail_writebacks WHERE id=? AND user_id=? AND mail_account_id=?',
      [op.id, account.user_id, account.id]);
    if (current?.state === 'confirmed')
      await runtime.enqueueJob({ userId: account.user_id, accountId: account.id, kind: 'sync', priority: 5 });
    return { success: true, observationOnly: true };
  }
  const [boxes] = await db.execute(`SELECT m.id, m.remote_name, m.uidvalidity, f.slug FROM mail_remote_mailboxes m
    JOIN mail_folder_remote_boxes b ON b.mail_account_id=m.mail_account_id AND BINARY b.remote_name=BINARY m.remote_name
    JOIN mail_folders f ON f.id=b.folder_id AND f.user_id=m.user_id
    WHERE m.user_id=? AND m.mail_account_id=? AND m.state='active'
      AND BINARY m.remote_name=BINARY ?`, [account.user_id, account.id, op.remote_folder]);
  const source = boxes.find(box => box.remote_name === op.remote_folder);
  if (['read', 'star'].includes(op.action) && source && uint32(op.remote_uidvalidity) === uint32(source.uidvalidity)
      && uint32(op.remote_uid)) {
    const selected = await transport.selectMailbox(connection,
      { folder: source.remote_name, readOnly: true, signal });
    if (uint32(selected.uidvalidity) !== uint32(op.remote_uidvalidity))
      return { success: false, error: 'Flag source epoch changed; identity requires attention' };
    const uid = Number(op.remote_uid), window = { start: uid, end: uid };
    const reply = await transport.fetchMetadataWindow(connection, { folder: source.remote_name,
      uidvalidity: Number(op.remote_uidvalidity), startUid: uid, endUid: uid, maxMessages: 1, maxBytes: 1024 * 1024 }, { signal });
    const [item] = validateWindowReply(reply, window, Number(op.remote_uidvalidity));
    if (item) {
      await fence();
      const [[email]] = await db.execute('SELECT observation_revision FROM emails WHERE id=? AND user_id=? AND mail_account_id=?',
        [op.email_id, account.user_id, account.id]);
      if (email) {
        const settled = await settleFlagObservation({ operationId: op.id, userId: account.user_id,
          accountId: account.id, workerGeneration: Number(job.worker_generation), workerId: job.lease_owner,
          jobId: job.id, source: { folder: op.remote_folder, uid, uidvalidity: Number(op.remote_uidvalidity) },
          flags: item.flags, modseq: item.modseq, observationRevision: email.observation_revision });
        if (settled.settled) return { success: true, observationOnly: true };
      }
    }
  }
  // If the bit still differs, the normal operation executor performs another
  // fresh read and classifies a safe idempotent flag retry/attention. This job
  // never blindly replays an interrupted provider command.
  if (['read', 'star'].includes(op.action)) {
    await require('./mail-engine/operations').applyFlag(op, connection, Number(job.worker_generation),
      signal, job.lease_owner, job.id);
    return { success: true, observationOnly: true };
  }
  return { success: false, error: 'Unsupported reconciliation action' };
}
// Jobs that provably have no provider work finish before any transport opens.
async function durableJobIdle(job, account) {
  if (job.kind === 'operation' && job.operation_id) return !await operationDue(account, job.operation_id);
  if (['flags', 'presence'].includes(job.kind) && job.mailbox_id && Number(job.manual_refresh) !== 1)
    return require('./mail-engine/sync').sweepThrottled(db, { userId: account.user_id, accountId: account.id,
      mailboxId: job.mailbox_id, stream: job.kind });
  return false;
}
async function runDurableMailJob(job, signal, report) {
  const runtime = require('./mail-engine/runtime');
  const { scanMailboxSlice } = require('./mail-engine/sync');
  const { processBodySlice } = require('./mail-engine/content');
  const accountId = job.mail_account_id;
  let connection, outcome, threw = true;
  const done = value => { outcome = value; threw = false; return value; };
  try {
    const [accounts] = await db.execute('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, job.user_id]);
    const account = accounts[0];
    if (!account || !toBooleanFlag(account.is_active) || account.disconnected_at) return { success: false, error: 'Account inactive or disconnected' };
    if (!await isModuleEnabled(account.user_id, 'mail') || await isSectionRestoreActive(account.user_id, 'mail'))
      return { success: false, error: 'Mail module paused or restore in progress' };
    checkCancelled(signal);
    await runtime.assertFence({ accountId, jobId: job.id, workerId: job.lease_owner,
      generation: Number(job.worker_generation) });
    const config = await buildImapConnectionConfig(account);
    if (!config) return { success: false, error: 'Mail credentials unavailable' };
    if (await durableJobIdle(job, account)) return { success: true, more: false, skipped: true };
    connection = await acquireImapConnection(account, config, { signal });
    checkCancelled(signal);
    if (job.kind === 'reconcile')
      return done(await runRecoveredReconcileJob({ job, account, connection, signal, report }));
    if (job.kind === 'sync') {
      const specialUses = new Map();
      const names = await listAvailableImapFolders(connection, specialUses, true);
      for (const planned of pickImapSyncFolders(names)) {
        if (names.includes(planned.folderName) && !specialUses.has(planned.folderName)) specialUses.set(planned.folderName, planned.dbFolderName);
      }
      await ensureDefaultMailFoldersForUser(account.user_id);
      const registered = await registerCustomImapFoldersForUser(account.user_id, account.id, names, db, specialUses, true);
      if (registered.length !== names.filter(name => !isVirtualMailFolderName(name)).length)
        throw new Error('Remote folder mapping incomplete');
      for (const folder of registered) {
        checkCancelled(signal);
        const selected = await require('./mail-engine/transport').selectMailbox(connection,
          { folder: folder.remoteName, readOnly: true, signal });
        const mailbox = await require('./mail-engine/repository').withTransaction(executor =>
          require('./mail-engine/repository').ensureMailbox({ userId: account.user_id,
            accountId, folderName: folder.remoteName, epoch: selected.uidvalidity,
            metadata: { localFolderSlug: folder.slug, specialUse: specialUses.get(folder.remoteName) || null } }, executor), db);
        // These are durable independent jobs, never a global inventory equality gate.
        for (const [kind, priority] of account.sync_mode === 'sync'
          ? [['recent', 10], ['flags', 20], ['history', 60], ['presence', 70]]
          : [['recent', 10], ['history', 60]]) {
          await runtime.enqueueJob({ userId: account.user_id, accountId, mailboxId: mailbox.id,
            kind, priority, manualRefresh: Number(job.manual_refresh) === 1 && ['flags', 'presence'].includes(kind) });
        }
      }
      // Stream jobs select a single mapped mailbox in account-scoped rounds.
      return done({ success: true, started: true, folders: registered.length });
    }
    if (job.kind === 'operation') {
      if (account.sync_mode !== 'sync') return { success: false, error: 'Provider writes disabled in Download mode' };
      const result = await processOperationBatch(account, connection, {
        workerGeneration: Number(job.worker_generation), workerId: job.lease_owner, jobId: job.id,
        operationId: job.operation_id, signal }, { process: require('./mail-engine/operations').processDueOperations });
      return done({ success: !result.connectionFailed, more: false, ...result });
    }
    if (!['recent', 'flags', 'history', 'presence', 'body'].includes(job.kind))
      return { success: false, error: 'Unsupported mail job kind' };
    if (account.sync_mode !== 'sync' && ['flags', 'presence'].includes(job.kind))
      return { success: false, error: 'Remote mirroring disabled in Download mode' };
    let mailbox;
    if (job.mailbox_id) {
      const [rows] = await db.execute(`SELECT m.id, m.remote_name, f.slug FROM mail_remote_mailboxes m
        JOIN mail_folder_remote_boxes b ON b.mail_account_id=m.mail_account_id AND BINARY b.remote_name=BINARY m.remote_name
        JOIN mail_folders f ON f.id=b.folder_id AND f.user_id=m.user_id
        WHERE m.id=? AND m.user_id=? AND m.mail_account_id=? AND m.state='active' LIMIT 1`,
      [job.mailbox_id, account.user_id, account.id]);
      mailbox = rows[0];
    }
    if (!mailbox) return { success: false, error: 'Durable mailbox mapping missing' };
    const folder = { folderName: mailbox.remote_name, dbFolderName: mailbox.slug };
    const result = job.kind === 'body'
      ? await processBodySlice({ db, account, connection, folder, mailboxId: mailbox.id, signal, job, report })
      : await scanMailboxSlice({ db, account, connection, folder, stream: job.kind, signal, job, report,
        manualRefresh: Number(job.manual_refresh) === 1 });
    return done({ success: true, more: result.more, ...result });
  } catch (error) {
    if (signal.aborted || error.code === 'MAIL_SYNC_CANCELLED') return { success: false, cancelled: true };
    throw error;
  } finally {
    if (connection) releaseImapConnection(connection, { reusable: !threw && outcome?.success === true && !signal.aborted });
  }
}

durableScheduler = createDurableMailScheduler(runDurableMailJob, { onState: state => {
  if (!state.mail_account_id) return;
  if (state.state === 'running') {
    runningDurableAccounts.add(state.mail_account_id);
    if (['operation', 'reconcile'].includes(state.kind)) runningDurableMutationAccounts.add(state.mail_account_id);
  } else if (['idle', 'error', 'cancelled'].includes(state.state)) {
    runningDurableAccounts.delete(state.mail_account_id);
    if (['operation', 'reconcile'].includes(state.kind)) runningDurableMutationAccounts.delete(state.mail_account_id);
  }
  // A continuation is committed atomically with the completed job by the
  // durable scheduler. An in-memory callback must not create extra work.
} });
async function startMailEngineScheduler() { await durableScheduler.start(); }
// background: periodic/service-worker work; skipped while the user's mail
// background setting is off. followUp: internal refresh after a user action;
// runs regardless of that setting. Neither is manual: no pause resume, no
// forced flags/presence resweep. Background is enforced here at admission
// because durable stream jobs carry no origin and manual Sync spawns them too.
async function scheduleMailAccountSync(accountId, options = {}) {
  const id = normalizeMailAccountId(accountId);
  if (!id) throw new Error('Account ID required');
  const [accounts] = await db.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [id]);
  if (!accounts.length) throw new Error('Mail account not found');
  if (options.background && !await isModuleBackgroundEnabled(accounts[0].user_id, 'mail')) {
    const result = { success: false, skipped: true, error: 'Mail background sync disabled' };
    return { started: false, alreadyRunning: false, skipped: true, job_id: null, promise: Promise.resolve(result) };
  }
  const manual = !options.background && !options.followUp;
  // A manual request may reopen only a background/module pause, never a
  // disconnect, settings fence or active restore. The route calls this entry
  // directly, so the resume belongs at admission, not only syncMailAccount.
  if (manual && await isModuleEnabled(accounts[0].user_id, 'mail')
      && !await isSectionRestoreActive(accounts[0].user_id, 'mail'))
    await require('./mail-engine/runtime').resumeAccount({ userId: accounts[0].user_id,
      accountId: id, resumeStreams: true, reasons: ['Mail module disabled', 'Mail background paused'] });
  await durableScheduler.start();
  const prior = await durableScheduler.state({ userId: accounts[0].user_id, accountId: id });
  const alreadyRunning = prior && prior.kind === 'sync' && ['queued', 'running'].includes(prior.state);
  const job = await durableScheduler.enqueue({ userId: accounts[0].user_id, accountId: id,
    kind: 'sync', priority: 5, manualRefresh: manual });
  return { started: !alreadyRunning, alreadyRunning: !!alreadyRunning, job_id: job.id,
    promise: Promise.resolve({ success: true, started: !alreadyRunning, alreadyRunning: !!alreadyRunning, job_id: job.id }) };
}
async function getMailSyncState(accountId) {
  const id = normalizeMailAccountId(accountId);
  if (!id) return null;
  const [accounts] = await db.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [id]);
  if (!accounts.length) return null;
  const job = await durableScheduler.state({ userId: accounts[0].user_id, accountId: id });
  if (!job) return null;
  return { account_id: id, job_id: job.id, state: job.state, phase: job.phase,
    processed: Number(job.processed || 0), total: job.total == null ? null : Number(job.total),
    coverage: typeof job.coverage_json === 'string' ? JSON.parse(job.coverage_json) : job.coverage_json,
    started_at: job.started_at, updated_at: job.updated_at, completed_at: job.completed_at,
    cancellation_requested: toBooleanFlag(job.cancellation_requested), error: job.error };
}
async function syncMailAccount(accountId, options = {}) {
  const id = normalizeMailAccountId(accountId);
  if (!id) return { success: false, error: 'Account ID required' };
  const job = await scheduleMailAccountSync(id, options);
  return job.promise;
}

// Periodic cadence. Each tick only follows INBOX arrivals ('recent', usually on
// a parked session). Folder discovery and its per-folder recent/flags/history/
// presence fan-out run at most every MAIL_DISCOVERY_INTERVAL_SECONDS, or again
// after a failed pass. Manual Sync stays immediate and complete.
const MAIL_DISCOVERY_INTERVAL_SECONDS = 5 * 60;
async function schedulePeriodicMailWork(accountId, { executor = db, scheduler = durableScheduler } = {}) {
  const id = normalizeMailAccountId(accountId);
  if (!id) throw new Error('Account ID required');
  const [accounts] = await executor.execute('SELECT user_id FROM mail_accounts WHERE id = ?', [id]);
  if (!accounts.length) throw new Error('Mail account not found');
  const userId = accounts[0].user_id;
  // Background off is enforced at admission; the INBOX follow-up is background work too.
  if (!await isModuleBackgroundEnabled(userId, 'mail'))
    return { started: false, alreadyRunning: false, skipped: true, promise: Promise.resolve({ success: true, skipped: true }) };
  const [[discovery]] = await executor.execute(`SELECT COUNT(*) AS n FROM mail_engine_jobs
    WHERE user_id = ? AND mail_account_id = ? AND kind = 'sync' AND (state IN ('queued','running')
      OR (state = 'idle' AND completed_at >= UTC_TIMESTAMP() - INTERVAL ? SECOND))`, [userId, id, MAIL_DISCOVERY_INTERVAL_SECONDS]);
  const [inboxes] = Number(discovery?.n) ? await executor.execute(`SELECT m.id FROM mail_remote_mailboxes m
    JOIN mail_folder_remote_boxes b ON b.mail_account_id=m.mail_account_id AND BINARY b.remote_name=BINARY m.remote_name
    JOIN mail_folders f ON f.id=b.folder_id AND f.user_id=m.user_id
    WHERE m.user_id=? AND m.mail_account_id=? AND m.state='active' AND f.slug='inbox'`, [userId, id]) : [[]];
  if (!inboxes.length) return scheduleMailAccountSync(id, { background: true });
  await scheduler.start();
  for (const box of inboxes) await scheduler.enqueue({ userId, accountId: id, mailboxId: box.id, kind: 'recent', priority: 10 });
  return { started: false, alreadyRunning: false, discovery: false, promise: Promise.resolve({ success: true }) };
}

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
  buildImapConnectionConfig,
  withMailAccountLock,
  cancelMailAccountSync,
  stopMailAccountWork,
  schedulePeriodicMailWork,
  MAIL_DISCOVERY_INTERVAL_SECONDS,
  yieldMailReadWork,
  KNOWN_MAIL_HOST_SUFFIXES,
  DEFAULT_MAIL_SYNC_FETCH_LIMIT,
  MAIL_SYNC_FETCH_LIMITS,
  MAIL_SERVER_DELETE_GRACE_MS,
  MAIL_SERVER_DELETE_BATCH_SIZE,
  MAIL_RAW_STORAGE_ROOT,
  MAIL_FOLDER_DEFINITIONS,
  ALLOWED_MAIL_FOLDER_SET,
  SYSTEM_MAIL_FOLDER_SET,
  MAIL_SENDER_RULE_MATCH_TYPES,
  normalizeMailFolderSlug,
  normalizeMailFolderDisplayName,
  allocateCollisionSafeMailFolderSlug,
  getSystemMailFolderDisplayName,
  loadMailFoldersForUser,
  mailFolderExists,
  normalizeHost,
  normalizeSyncFetchLimit,
  normalizeMailAccountId,
  isMailAccountSyncRunning,
  isMailAccountWriteRunning,
  isAnyMailAccountSyncRunning,
  getRunningMailSyncAccountIds,
  isMailServerDeleteRunning,
  isAnyMailServerDeleteRunning,
  getRunningMailServerDeleteAccountIds,
  normalizeSenderEmail,
  normalizeSenderDomain,
  normalizeMailSenderRuleInput,
  loadActiveMailSenderRules,
  pickBestMailSenderRuleMatch,
  resolveMailSenderTargetFolder,
  createMailRoutingContext,
  ensureDefaultMailFoldersForUser,
  isKnownMailProviderHost,
  toBooleanFlag,
  isSelfSignedTlsError,
  isTlsTrustError,
  assessMailHost,
  buildMailHostTrustResult,
  validateMailHostPolicy,
  isAttachmentPathUnderUploads,
  deleteStoredAttachmentFiles,
  getMailRawStoragePath,
  isMailRawPathUnderRoot,
  isUsableRawEmailArchive,
  saveRawEmailSource,
  flattenImapBoxes,
  listAvailableImapFolders,
  registerCustomImapFoldersForUser,
  pickImapSyncFolders,
  createImapBox,
  ensureCustomImapFoldersForUser,
  createRemoteMailFolderForUserAccounts,
  getCurrentBoxUidValidity,
  buildRawEmailFromImapParts,
  loadExistingImportedUidSet,
  recordMailServerMessageForDeletion,
  seedMailServerDeletionQueueForAccount,
  markMailServerMessageDeleteStatus,
  deleteImapUid,
  processMailServerDeletionForAccount,
  runMailServerDeletionPass,
  syncMailFolder,
  testImapConnection,
  syncMailAccount,
  startMailEngineScheduler,
  runDurableMailJob,
  runRecoveredReconcileJob,
  scheduleMailAccountSync,
  getMailSyncState,
  sendEmail,
};
