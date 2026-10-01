const crypto = require('crypto');
const { db } = require('../state');
const imapClient = require('./mail-imap-client');
const { guardImapConnection, runGuardedImap, closeImapConnection } = require('./mail-imap-guard');
const { buildImapConnectionConfig } = require('./mail-host-policy');

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

const SPECIAL_USE_ROLES = { '\\sent': 'sent', '\\drafts': 'drafts', '\\junk': 'junk', '\\trash': 'trash', '\\archive': 'archive', '\\all': 'archive', '\\important': 'important' };

// Maps ImapFlow LIST entries to selectable mailbox paths. Only the attributes
// the server sent (RFC 6154 special-use or Gmail XLIST) assign a role; the
// library's name-based specialUse guess is deliberately ignored.
// allMailboxes (optional Set) collects mailboxes flagged \All (Gmail's All Mail).
// Sync mode needs it: on Gmail only absence from every label *and* All Mail
// proves deletion; without a visible All Mail, missing mail may be archived.
function imapListToFolders(entries, specialUses = new Map(), allMailboxes = null) {
  const results = [];
  for (const entry of entries || []) {
    const fullName = typeof entry?.path === 'string' ? entry.path : '';
    if (!fullName) continue;
    const attributes = [...(entry.flags || [])].map(value => String(value).toLowerCase());
    const role = attributes.map(attribute => SPECIAL_USE_ROLES[attribute]).find(Boolean);
    if (role) specialUses.set(fullName, role);
    if (allMailboxes && attributes.includes('\\all')) allMailboxes.add(fullName);
    if (!attributes.includes('\\noselect') && !attributes.includes('\\nonexistent')) results.push(fullName);
  }
  return results;
}

async function listAvailableImapFolders(connection, specialUses = new Map(), strict = false, allMailboxes = null) {
  try {
    if (typeof connection?.list !== 'function') {
      if (strict) throw new Error('Server folder listing unavailable');
      return ['INBOX'];
    }
    const entries = await runGuardedImap(connection, () => connection.list());
    if (strict && !Array.isArray(entries)) throw new Error('Invalid server folder listing');
    const folders = imapListToFolders(entries, specialUses, allMailboxes);
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
    let demotedSystemFolder = false;
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
      if (verified[0]?.folder_id === systemRows[0].id) {
        registered.push({ slug, displayName, remoteName });
        continue;
      }
      // The system folder is already mapped to another remote mailbox of this
      // account (e.g. Gmail's [Gmail]/Sent Mail plus a user label named Sent).
      // Established mappings never move; list this mailbox as its own folder.
      if (verified.length) throw new Error('Remote system folder mapping conflicts with another mailbox');
      demotedSystemFolder = true;
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
        [folderId, userId, accountId, demotedSystemFolder ? null : specialUses.get(remoteName) || null, slug, displayName, Number(positionRows[0]?.max_position || 100) + 10]
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

// Resolves with { created } (false when the server reports it already exists).
async function createImapBox(connection, folderName) {
  if (typeof connection?.mailboxCreate !== 'function') {
    throw new Error('The configured IMAP client does not support remote folder creation.');
  }
  const result = await runGuardedImap(connection, () => connection.mailboxCreate(folderName));
  return { created: result?.created !== false };
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
      connection = guardImapConnection(await imapClient.connectImap(config));
      const availableFolders = await listAvailableImapFolders(connection);
      if (availableFolders.some(name => String(name).toLowerCase() === displayName.toLowerCase())) {
        results.push({ accountId: account.id, remoteName: displayName, status: 'existing' });
      } else {
        const { created } = await createImapBox(connection, displayName);
        results.push({ accountId: account.id, remoteName: displayName, status: created ? 'created' : 'existing' });
      }
    } catch (error) {
      results.push({ accountId: account.id, remoteName: displayName, status: 'failed', retryable: true, error: error.message || String(error) });
    } finally {
      if (connection) closeImapConnection(connection);
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

module.exports = {
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
  normalizeSenderEmail,
  normalizeSenderDomain,
  normalizeMailSenderRuleInput,
  loadActiveMailSenderRules,
  pickBestMailSenderRuleMatch,
  resolveMailSenderTargetFolder,
  createMailRoutingContext,
  ensureDefaultMailFoldersForUser,
  imapListToFolders,
  listAvailableImapFolders,
  isVirtualMailFolderName,
  registerCustomImapFoldersForUser,
  pickImapSyncFolders,
  createImapBox,
  ensureCustomImapFoldersForUser,
  createRemoteMailFolderForUserAccounts,
};
