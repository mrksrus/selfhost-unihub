const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { db } = require('../state');
const { encrypt } = require('../security/encryption');
const { debugLog } = require('../logger');
const {
  DEFAULT_MAIL_SYNC_FETCH_LIMIT,
  MAIL_SENDER_RULE_MATCH_TYPES,
  normalizeMailSenderRuleInput,
  SYSTEM_MAIL_FOLDER_SET,
  normalizeMailFolderSlug,
  normalizeMailFolderDisplayName,
  loadMailFoldersForUser,
  mailFolderExists,
  toBooleanFlag,
  loadActiveMailSenderRules,
  resolveMailSenderTargetFolder,
  ensureDefaultMailFoldersForUser,
  normalizeSyncFetchLimit,
  requireMailHostTrustApproval,
  testImapConnection,
  syncMailAccount,
  sendEmail,
  deleteStoredAttachmentFiles,
} = require('../services/mail');

const readFile = promisify(fs.readFile);
const BACKGROUND_MAIL_SYNC_MIN_AGE_MS = 5 * 60 * 1000;
const backgroundMailSyncAccounts = new Set();

function startMailSyncInBackground(accountId, label = accountId) {
  if (backgroundMailSyncAccounts.has(accountId)) {
    return false;
  }

  backgroundMailSyncAccounts.add(accountId);
  syncMailAccount(accountId)
    .catch((error) => {
      console.error(`[SYNC] Background sync failed for ${label}:`, error.message);
    })
    .finally(() => {
      backgroundMailSyncAccounts.delete(accountId);
    });
  return true;
}

function isMailSyncFresh(lastSyncedAt, minAgeMs = BACKGROUND_MAIL_SYNC_MIN_AGE_MS) {
  if (!lastSyncedAt) return false;
  const lastSyncedAtMs = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(lastSyncedAtMs)) return false;
  return Date.now() - lastSyncedAtMs < minAgeMs;
}

async function getMailFolderRowsWithCounts(userId) {
  const folders = await loadMailFoldersForUser(userId);
  const [countRows] = await db.execute(
    `SELECT folder, COUNT(*) AS total_count, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread_count
     FROM emails
     WHERE user_id = ?
     GROUP BY folder`,
    [userId]
  );
  const countsByFolder = new Map((countRows || []).map(row => [
    row.folder,
    {
      total_count: Number(row.total_count) || 0,
      unread_count: Number(row.unread_count) || 0,
    },
  ]));
  return folders.map(folder => ({
    ...folder,
    total_count: countsByFolder.get(folder.slug)?.total_count || 0,
    unread_count: countsByFolder.get(folder.slug)?.unread_count || 0,
  }));
}

async function validateUserMailFolder(userId, folderSlug) {
  const normalizedSlug = normalizeMailFolderSlug(folderSlug);
  if (!normalizedSlug) return { error: 'Valid folder is required', status: 400 };
  if (!(await mailFolderExists(userId, normalizedSlug))) {
    return { error: 'Folder not found', status: 404 };
  }
  return { folder: normalizedSlug };
}


module.exports = {
  'GET /api/mail/folders': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      return { folders: await getMailFolderRowsWithCounts(userId) };
    } catch (error) {
      console.error('List mail folders error:', error);
      return { error: 'Failed to load mail folders', status: 500 };
    }
  },

  'POST /api/mail/folders': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const displayName = normalizeMailFolderDisplayName(body?.display_name || body?.name);
      if (!displayName) return { error: 'Folder name is required', status: 400 };
      const requestedSlug = normalizeMailFolderSlug(body?.slug || displayName);
      if (!requestedSlug) return { error: 'Folder slug is invalid', status: 400 };
      if (requestedSlug === 'all' || requestedSlug === 'starred') {
        return { error: 'Folder slug is reserved', status: 400 };
      }
      const [existing] = await db.execute(
        'SELECT id FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1',
        [userId, requestedSlug]
      );
      if (existing.length > 0) return { error: 'Folder already exists', status: 409 };
      const [positionRows] = await db.execute(
        'SELECT COALESCE(MAX(position), 90) AS max_position FROM mail_folders WHERE user_id = ?',
        [userId]
      );
      const position = Number(positionRows[0]?.max_position || 90) + 10;
      const folderId = crypto.randomUUID();
      await db.execute(
        `INSERT INTO mail_folders (id, user_id, slug, display_name, is_system, position)
         VALUES (?, ?, ?, ?, FALSE, ?)`,
        [folderId, userId, requestedSlug, displayName, position]
      );
      const folders = await getMailFolderRowsWithCounts(userId);
      return { folder: folders.find(folder => folder.slug === requestedSlug) || null, folders };
    } catch (error) {
      console.error('Create mail folder error:', error);
      return { error: 'Failed to create mail folder', status: 500 };
    }
  },

  'PUT /api/mail/folders/:slug': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const slug = normalizeMailFolderSlug(req.params.slug);
      if (!slug) return { error: 'Folder is required', status: 400 };
      const [folders] = await db.execute(
        'SELECT * FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1',
        [userId, slug]
      );
      if (!folders.length) return { error: 'Folder not found', status: 404 };
      const folder = folders[0];
      const updates = [];
      const params = [];
      if (Object.prototype.hasOwnProperty.call(body || {}, 'display_name') || Object.prototype.hasOwnProperty.call(body || {}, 'name')) {
        const displayName = normalizeMailFolderDisplayName(body.display_name || body.name);
        if (!displayName) return { error: 'Folder name is required', status: 400 };
        updates.push('display_name = ?');
        params.push(displayName);
      }
      if (Object.prototype.hasOwnProperty.call(body || {}, 'position')) {
        const position = Number.parseInt(String(body.position), 10);
        if (!Number.isFinite(position)) return { error: 'Position must be a number', status: 400 };
        updates.push('position = ?');
        params.push(position);
      }
      if (updates.length === 0) return { error: 'No fields to update', status: 400 };
      params.push(folder.id, userId);
      await db.execute(`UPDATE mail_folders SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
      const updatedFolders = await getMailFolderRowsWithCounts(userId);
      return { folder: updatedFolders.find(item => item.slug === slug) || null, folders: updatedFolders };
    } catch (error) {
      console.error('Update mail folder error:', error);
      return { error: 'Failed to update mail folder', status: 500 };
    }
  },

  'DELETE /api/mail/folders/:slug': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const slug = normalizeMailFolderSlug(req.params.slug);
      if (!slug) return { error: 'Folder is required', status: 400 };
      const [folders] = await db.execute(
        'SELECT * FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1',
        [userId, slug]
      );
      if (!folders.length) return { error: 'Folder not found', status: 404 };
      if (folders[0].is_system || SYSTEM_MAIL_FOLDER_SET.has(slug)) {
        return { error: 'System folders cannot be deleted', status: 400 };
      }
      await db.execute('UPDATE emails SET folder = ? WHERE user_id = ? AND folder = ?', ['inbox', userId, slug]);
      await db.execute('UPDATE mail_sender_rules SET target_folder = ? WHERE user_id = ? AND target_folder = ?', ['inbox', userId, slug]);
      await db.execute('DELETE FROM mail_folders WHERE user_id = ? AND slug = ?', [userId, slug]);
      return { deleted: true, folders: await getMailFolderRowsWithCounts(userId) };
    } catch (error) {
      console.error('Delete mail folder error:', error);
      return { error: 'Failed to delete mail folder', status: 500 };
    }
  },

  // Mail accounts endpoints
  'GET /api/mail/sender-rules': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const accountId = String(url.searchParams.get('account_id') || '').trim();
      const matchType = String(url.searchParams.get('match_type') || '').trim().toLowerCase();
      const where = ['r.user_id = ?'];
      const params = [userId];
      if (accountId) {
        where.push('(r.mail_account_id IS NULL OR r.mail_account_id = ?)');
        params.push(accountId);
      }
      if (matchType) {
        if (!MAIL_SENDER_RULE_MATCH_TYPES.has(matchType)) return { error: 'Invalid match_type filter', status: 400 };
        where.push('r.match_type = ?');
        params.push(matchType);
      }
      const [rules] = await db.execute(
        `SELECT r.id, r.user_id, r.mail_account_id, r.match_type, LOWER(TRIM(r.match_value)) AS match_value, r.target_folder, r.priority, r.is_active, r.created_at, r.updated_at,
                a.email_address AS account_email
         FROM mail_sender_rules r
         LEFT JOIN mail_accounts a ON a.id = r.mail_account_id
         WHERE ${where.join(' AND ')}
         ORDER BY r.is_active DESC, r.priority ASC, r.match_type ASC, r.created_at ASC`,
        params
      );
      return { rules: rules || [] };
    } catch (error) {
      console.error('List mail sender rules error:', error);
      return { error: 'Failed to load sender rules', status: 500 };
    }
  },
  'POST /api/mail/sender-rules': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const parsed = normalizeMailSenderRuleInput(body?.match_type, body?.match_value);
      if (parsed.error) return { error: parsed.error, status: 400 };
      const targetFolder = normalizeMailFolderSlug(body?.target_folder);
      const folderValidation = await validateUserMailFolder(userId, targetFolder);
      if (folderValidation.error) return folderValidation;
      const accountId = String(body?.mail_account_id || '').trim() || null;
      if (accountId) {
        const [accounts] = await db.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
        if (!accounts.length) return { error: 'Invalid mail_account_id', status: 400 };
      }
      const priorityNumber = Number.parseInt(String(body?.priority ?? '100'), 10);
      const priority = Number.isFinite(priorityNumber) ? priorityNumber : 100;
      const isActive = body?.is_active === undefined ? true : !!body.is_active;
      const ruleId = crypto.randomUUID();
      await db.execute(
        `INSERT INTO mail_sender_rules (id, user_id, mail_account_id, match_type, match_value, target_folder, priority, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ruleId, userId, accountId, parsed.matchType, parsed.matchValue, targetFolder, priority, isActive ? 1 : 0]
      );
      const [rows] = await db.execute(
        'SELECT id, user_id, mail_account_id, match_type, match_value, target_folder, priority, is_active, created_at, updated_at FROM mail_sender_rules WHERE id = ? LIMIT 1',
        [ruleId]
      );
      return { rule: rows[0] || null };
    } catch (error) {
      console.error('Create mail sender rule error:', error);
      return { error: 'Failed to create sender rule', status: 500 };
    }
  },
  'PUT /api/mail/sender-rules/:id': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const ruleId = req.params.id;
    if (!ruleId) return { error: 'Rule id is required', status: 400 };
    try {
      const [existingRows] = await db.execute('SELECT * FROM mail_sender_rules WHERE id = ? AND user_id = ? LIMIT 1', [ruleId, userId]);
      if (!existingRows.length) return { error: 'Rule not found', status: 404 };
      const existing = existingRows[0];
      const nextMatchType = body?.match_type !== undefined ? body.match_type : existing.match_type;
      const nextMatchValue = body?.match_value !== undefined ? body.match_value : existing.match_value;
      const parsed = normalizeMailSenderRuleInput(nextMatchType, nextMatchValue);
      if (parsed.error) return { error: parsed.error, status: 400 };
      const nextTargetFolder = body?.target_folder !== undefined ? normalizeMailFolderSlug(body.target_folder) : existing.target_folder;
      const folderValidation = await validateUserMailFolder(userId, nextTargetFolder);
      if (folderValidation.error) return folderValidation;
      const accountId = body?.mail_account_id !== undefined
        ? (String(body.mail_account_id || '').trim() || null)
        : (existing.mail_account_id || null);
      if (accountId) {
        const [accounts] = await db.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
        if (!accounts.length) return { error: 'Invalid mail_account_id', status: 400 };
      }
      const priorityCandidate = body?.priority !== undefined ? body.priority : existing.priority;
      const parsedPriority = Number.parseInt(String(priorityCandidate), 10);
      const priority = Number.isFinite(parsedPriority) ? parsedPriority : 100;
      const isActive = body?.is_active !== undefined ? !!body.is_active : toBooleanFlag(existing.is_active);
      await db.execute(
        `UPDATE mail_sender_rules
         SET mail_account_id = ?, match_type = ?, match_value = ?, target_folder = ?, priority = ?, is_active = ?
         WHERE id = ? AND user_id = ?`,
        [accountId, parsed.matchType, parsed.matchValue, nextTargetFolder, priority, isActive ? 1 : 0, ruleId, userId]
      );
      const [rows] = await db.execute(
        'SELECT id, user_id, mail_account_id, match_type, match_value, target_folder, priority, is_active, created_at, updated_at FROM mail_sender_rules WHERE id = ? LIMIT 1',
        [ruleId]
      );
      return { rule: rows[0] || null };
    } catch (error) {
      console.error('Update mail sender rule error:', error);
      return { error: 'Failed to update sender rule', status: 500 };
    }
  },
  'DELETE /api/mail/sender-rules/:id': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const ruleId = req.params.id;
    if (!ruleId) return { error: 'Rule id is required', status: 400 };
    try {
      const [result] = await db.execute('DELETE FROM mail_sender_rules WHERE id = ? AND user_id = ? LIMIT 1', [ruleId, userId]);
      if (!result.affectedRows) return { error: 'Rule not found', status: 404 };
      return { deleted: true };
    } catch (error) {
      console.error('Delete mail sender rule error:', error);
      return { error: 'Failed to delete sender rule', status: 500 };
    }
  },
  'POST /api/mail/sender-rules/backfill': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const accountId = String(body?.account_id || '').trim() || null;
      const applyChanges = body?.mode === 'apply' || body?.apply === true;
      const requestedLimit = Number.parseInt(String(body?.limit ?? '1000'), 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 5000) : 1000;
      if (accountId) {
        const [accounts] = await db.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
        if (!accounts.length) return { error: 'Invalid account_id', status: 400 };
      }
      const where = ['e.user_id = ?', "e.folder = 'inbox'", 'e.from_address IS NOT NULL', "TRIM(e.from_address) <> ''"];
      const params = [userId];
      if (accountId) {
        where.push('e.mail_account_id = ?');
        params.push(accountId);
      }
      const [emails] = await db.execute(
        `SELECT e.id, e.mail_account_id, e.from_address, e.folder
         FROM emails e
         WHERE ${where.join(' AND ')}
         ORDER BY e.received_at DESC
         LIMIT ${limit}`,
        params
      );
      const perAccountRules = new Map();
      const updates = [];
      for (const email of emails || []) {
        const ruleCacheKey = String(email.mail_account_id || '');
        if (!perAccountRules.has(ruleCacheKey)) {
          const rules = await loadActiveMailSenderRules(userId, email.mail_account_id || null, db);
          perAccountRules.set(ruleCacheKey, rules);
        }
        const resolved = await resolveMailSenderTargetFolder({
          userId,
          mailAccountId: email.mail_account_id || null,
          fromAddress: email.from_address || '',
          fallbackFolder: 'inbox',
          rules: perAccountRules.get(ruleCacheKey),
          connection: db,
        });
        if (resolved.folder !== 'inbox') {
          updates.push({
            email_id: email.id,
            from_address: email.from_address,
            current_folder: email.folder,
            next_folder: resolved.folder,
            rule_id: resolved.rule?.id || null,
          });
        }
      }
      if (applyChanges && updates.length > 0) {
        for (const item of updates) {
          await db.execute('UPDATE emails SET folder = ? WHERE id = ? AND user_id = ?', [item.next_folder, item.email_id, userId]);
        }
      }
      return {
        dry_run: !applyChanges,
        scanned: (emails || []).length,
        matched: updates.length,
        applied: applyChanges ? updates.length : 0,
        updates: updates.slice(0, 200),
      };
    } catch (error) {
      console.error('Mail sender rule backfill error:', error);
      return { error: 'Failed to backfill mail routing', status: 500 };
    }
  },
  'GET /api/mail/accounts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    
    try {
      const [accounts] = await db.execute(
        'SELECT id, user_id, email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, sync_fetch_limit, is_active, last_synced_at, created_at FROM mail_accounts WHERE user_id = ?',
        [userId]
      );
      await ensureDefaultMailFoldersForUser(userId);

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
        sync_fetch_limit: normalizeSyncFetchLimit(account.sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT) || DEFAULT_MAIL_SYNC_FETCH_LIMIT,
        unread_count: unreadByAccount[account.id] || 0,
      }));

      return { accounts: accountsWithUnread };
    } catch (error) {
      return { error: 'Failed to get mail accounts', status: 500 };
    }
  },

  'GET /api/mail/unread-counts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const accountId = url.searchParams.get('account_id');
      const includeByAccount = url.searchParams.get('include_by_account') === 'true';
      const hasAccountFilter = !!accountId && accountId !== 'all';

      let folderQuery = `
        SELECT folder, COUNT(*) AS unread_count
        FROM emails
        WHERE user_id = ? AND is_read = 0
      `;
      const folderParams = [userId];

      if (hasAccountFilter) {
        folderQuery += ' AND mail_account_id = ?';
        folderParams.push(accountId);
      }
      folderQuery += ' GROUP BY folder';

      const [folderRows] = await db.execute(folderQuery, folderParams);
      const unreadByFolder = {};
      for (const row of folderRows) {
        unreadByFolder[row.folder] = Number(row.unread_count) || 0;
      }

      const response = { unreadByFolder };

      if (includeByAccount) {
        let accountBreakdownQuery = `
          SELECT folder, mail_account_id, COUNT(*) AS unread_count
          FROM emails
          WHERE user_id = ? AND is_read = 0
        `;
        const accountBreakdownParams = [userId];
        if (hasAccountFilter) {
          accountBreakdownQuery += ' AND mail_account_id = ?';
          accountBreakdownParams.push(accountId);
        }
        accountBreakdownQuery += ' GROUP BY folder, mail_account_id';

        const [folderAccountRows] = await db.execute(accountBreakdownQuery, accountBreakdownParams);
        const unreadByFolderAccount = {};
        for (const row of folderAccountRows) {
          if (!unreadByFolderAccount[row.folder]) {
            unreadByFolderAccount[row.folder] = {};
          }
          unreadByFolderAccount[row.folder][row.mail_account_id] = Number(row.unread_count) || 0;
        }
        response.unreadByFolderAccount = unreadByFolderAccount;
      }

      return response;
    } catch (error) {
      console.error('[MAIL] Failed to get unread counts:', error);
      return { error: 'Failed to get unread counts', status: 500 };
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
        sync_fetch_limit,
        accept_host_trust,
      } = body;
      
      if (!email_address || !encrypted_password) {
        return { error: 'Email address and password are required', status: 400 };
      }
      if (!imap_host || !smtp_host) {
        return { error: 'IMAP and SMTP server addresses are required', status: 400 };
      }
      const normalizedSyncFetchLimit = normalizeSyncFetchLimit(sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT);
      if (!normalizedSyncFetchLimit) {
        return { error: 'Invalid sync fetch limit. Allowed values: 100, 500, 1000, 2000, all', status: 400 };
      }

      const hostTrustResult = await requireMailHostTrustApproval({
        imap_host,
        imap_port: imap_port || 993,
        smtp_host,
        smtp_port: smtp_port || 587,
        accept_host_trust,
      });
      if (hostTrustResult.error) return hostTrustResult;

      // Verify authentication using strict TLS unless the user explicitly accepted an untrusted certificate.
      const tempAccount = {
        email_address,
        username: username || email_address,
        imap_host,
        imap_port: imap_port || 993,
        allow_self_signed: hostTrustResult.allowInsecureTls,
        trusted_imap_fingerprint256: hostTrustResult.trustedImapFingerprint256,
        encrypted_password: encrypt(encrypted_password),
      };
      
      // Test IMAP connection and auth (wrong password / connection errors still returned)
      console.log(`[ACCOUNT] Testing IMAP connection for ${email_address}...`);
      const testResult = await testImapConnection(tempAccount);
      
      if (!testResult.success) {
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
        'INSERT INTO mail_accounts (id, user_id, email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, encrypted_password, sync_fetch_limit, allow_self_signed, trusted_imap_fingerprint256, trusted_smtp_fingerprint256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [accountId, userId, email_address, display_name || null, provider, actualUsername, imap_host || null, imap_port || 993, smtp_host || null, smtp_port || 587, tempAccount.encrypted_password, normalizedSyncFetchLimit, hostTrustResult.allowInsecureTls ? 1 : 0, hostTrustResult.trustedImapFingerprint256, hostTrustResult.trustedSmtpFingerprint256]
      );
      await ensureDefaultMailFoldersForUser(userId);
      
      const [accounts] = await db.execute('SELECT id, user_id, email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, sync_fetch_limit, is_active FROM mail_accounts WHERE id = ?', [accountId]);
      
      // Start sync in background (non-blocking)
      console.log(`[ACCOUNT] Starting background sync for ${email_address}...`);
      startMailSyncInBackground(accountId, email_address);
      
      // Return success immediately
      return { 
        account: accounts[0],
        authSuccess: true,
        syncInProgress: true,
        mailHostTrust: hostTrustResult.mailHostTrust,
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
        sync_fetch_limit,
        accept_host_trust,
      } = body;
      
      // Verify account belongs to user
      const [accounts] = await db.execute(
        'SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (accounts.length === 0) return { error: 'Account not found', status: 404 };
      const existingAccount = accounts[0];

      const nextImapHost = imap_host || existingAccount.imap_host;
      const nextImapPort = imap_port || existingAccount.imap_port || 993;
      const nextSmtpHost = smtp_host || existingAccount.smtp_host;
      const nextSmtpPort = smtp_port || existingAccount.smtp_port || 587;
      const hostSettingsChanged = Boolean(imap_host || imap_port || smtp_host || smtp_port);
      let hostTrustResult = null;

      if (hostSettingsChanged) {
        hostTrustResult = await requireMailHostTrustApproval({
          imap_host: nextImapHost,
          imap_port: nextImapPort,
          smtp_host: nextSmtpHost,
          smtp_port: nextSmtpPort,
          accept_host_trust,
        });
        if (hostTrustResult.error) return hostTrustResult;
      }
      
      // Build update query dynamically
      const updates = [];
      const params = [];
      
      if (email_address) { updates.push('email_address = ?'); params.push(email_address); }
      if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name || null); }
      if (username !== undefined) { updates.push('username = ?'); params.push(username || email_address || existingAccount.email_address); }
      if (imap_host) { updates.push('imap_host = ?'); params.push(imap_host); }
      if (imap_port) { updates.push('imap_port = ?'); params.push(imap_port); }
      if (smtp_host) { updates.push('smtp_host = ?'); params.push(smtp_host); }
      if (smtp_port) { updates.push('smtp_port = ?'); params.push(smtp_port); }
      if (encrypted_password) { updates.push('encrypted_password = ?'); params.push(encrypt(encrypted_password)); }
      if (hostTrustResult) {
        updates.push('allow_self_signed = ?');
        params.push(hostTrustResult.allowInsecureTls ? 1 : 0);
        updates.push('trusted_imap_fingerprint256 = ?');
        params.push(hostTrustResult.trustedImapFingerprint256);
        updates.push('trusted_smtp_fingerprint256 = ?');
        params.push(hostTrustResult.trustedSmtpFingerprint256);
      }
      if (sync_fetch_limit !== undefined) {
        const normalizedSyncFetchLimit = normalizeSyncFetchLimit(sync_fetch_limit, DEFAULT_MAIL_SYNC_FETCH_LIMIT);
        if (!normalizedSyncFetchLimit) {
          return { error: 'Invalid sync fetch limit. Allowed values: 100, 500, 1000, 2000, all', status: 400 };
        }
        updates.push('sync_fetch_limit = ?');
        params.push(normalizedSyncFetchLimit);
      }
      
      if (updates.length === 0) return { error: 'No fields to update', status: 400 };
      
      params.push(id, userId);
      await db.execute(
        `UPDATE mail_accounts SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
        params
      );
      
      const [updated] = await db.execute(
        'SELECT id, user_id, email_address, display_name, provider, username, imap_host, imap_port, smtp_host, smtp_port, sync_fetch_limit, is_active FROM mail_accounts WHERE id = ?',
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
      const [attachments] = await db.execute(
        `SELECT a.storage_path
         FROM email_attachments a
         INNER JOIN emails e ON e.id = a.email_id
         WHERE e.mail_account_id = ? AND e.user_id = ?`,
        [id, userId]
      );
      await db.execute('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', [id, userId]);
      const fileResult = await deleteStoredAttachmentFiles((attachments || []).map(row => row.storage_path));
      return {
        message: 'Mail account deleted',
        deletedAttachmentFiles: fileResult.deletedFiles,
        failedAttachmentFiles: fileResult.failedFiles,
      };
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
      folder = url.searchParams.get('folder');
      accountId = url.searchParams.get('account_id');
      const hasFolderFilter = !!folder && folder !== 'all';
      const hasAccountFilter = !!accountId && accountId !== 'all';
      const isReadParam = url.searchParams.get('is_read');
      const isStarredParam = url.searchParams.get('is_starred');
      const searchParam = (url.searchParams.get('search') || '').trim();
      
      query = 'SELECT * FROM emails WHERE user_id = ?';
      params = [userId];
      
      if (hasFolderFilter) {
        query += ' AND folder = ?';
        params.push(folder);
      }
      
      if (hasAccountFilter) {
        query += ' AND mail_account_id = ?';
        params.push(accountId);
      }

      if (isReadParam === 'true' || isReadParam === 'false') {
        query += ' AND is_read = ?';
        params.push(isReadParam === 'true' ? 1 : 0);
      }

      if (isStarredParam === 'true' || isStarredParam === 'false') {
        query += ' AND is_starred = ?';
        params.push(isStarredParam === 'true' ? 1 : 0);
      }

      if (searchParam) {
        const searchValue = `%${searchParam.toLowerCase()}%`;
        query += ` AND (
          LOWER(COALESCE(subject, '')) LIKE ? OR
          LOWER(COALESCE(from_name, '')) LIKE ? OR
          LOWER(COALESCE(from_address, '')) LIKE ? OR
          LOWER(COALESCE(body_text, '')) LIKE ?
        )`;
        params.push(searchValue, searchValue, searchValue, searchValue);
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
      if (hasFolderFilter) {
        countQuery += ' AND folder = ?';
        countParams.push(folder);
      }
      if (hasAccountFilter) {
        countQuery += ' AND mail_account_id = ?';
        countParams.push(accountId);
      }
      if (isReadParam === 'true' || isReadParam === 'false') {
        countQuery += ' AND is_read = ?';
        countParams.push(isReadParam === 'true' ? 1 : 0);
      }
      if (isStarredParam === 'true' || isStarredParam === 'false') {
        countQuery += ' AND is_starred = ?';
        countParams.push(isStarredParam === 'true' ? 1 : 0);
      }
      if (searchParam) {
        const searchValue = `%${searchParam.toLowerCase()}%`;
        countQuery += ` AND (
          LOWER(COALESCE(subject, '')) LIKE ? OR
          LOWER(COALESCE(from_name, '')) LIKE ? OR
          LOWER(COALESCE(from_address, '')) LIKE ? OR
          LOWER(COALESCE(body_text, '')) LIKE ?
        )`;
        countParams.push(searchValue, searchValue, searchValue, searchValue);
      }
      const [countResult] = await db.execute(countQuery, countParams);
      const total = countResult[0]?.total || 0;
      
      const [emails] = await db.execute(query, params);
      console.log(`[API] GET /api/mail/emails: Found ${emails.length} emails for user ${userId}, folder ${hasFolderFilter ? folder : 'all'}, account ${hasAccountFilter ? accountId : 'all'}, total ${total}`);
      
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
      const folderValidation = await validateUserMailFolder(userId, folder);
      if (folderValidation.error) return folderValidation;
      
      // Update folder for emails
      const placeholders = email_ids.map(() => '?').join(',');
      await db.execute(
        `UPDATE emails SET folder = ? WHERE id IN (${placeholders}) AND user_id = ?`,
        [folderValidation.folder, ...email_ids, userId]
      );
      
      return { message: `Moved ${email_ids.length} email(s) to ${folderValidation.folder}` };
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

  'POST /api/mail/sync/background': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const accountId = String(body?.account_id || '').trim();
      const requestedMinAgeMs = Number(body?.min_age_ms);
      const minAgeMs = Number.isFinite(requestedMinAgeMs)
        ? Math.max(60 * 1000, requestedMinAgeMs)
        : BACKGROUND_MAIL_SYNC_MIN_AGE_MS;

      const params = [userId];
      let query = `
        SELECT id, email_address, last_synced_at
        FROM mail_accounts
        WHERE user_id = ? AND is_active = TRUE`;

      if (accountId) {
        query += ' AND id = ?';
        params.push(accountId);
      }

      const [accounts] = await db.execute(query, params);
      if (accountId && accounts.length === 0) {
        return { error: 'Account not found', status: 404 };
      }

      const started = [];
      const skipped = [];
      const alreadyRunning = [];

      for (const account of accounts) {
        if (isMailSyncFresh(account.last_synced_at, minAgeMs)) {
          skipped.push(account.id);
          continue;
        }

        const didStart = startMailSyncInBackground(account.id, account.email_address || account.id);
        if (didStart) {
          started.push(account.id);
        } else {
          alreadyRunning.push(account.id);
        }
      }

      return { started, skipped, alreadyRunning };
    } catch (error) {
      console.error('[SYNC] Background sync trigger error:', error);
      return { error: error.message || 'Failed to start background mail sync', status: 500 };
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
};
