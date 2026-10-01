const { folderConnections } = require('../services/mail-folder-reconciliation');
const { membershipCountQuery, unreadMembershipQuery } = require('../services/mail-folder-view');
const { filingAccountId, folderAcceptsAccount } = require('../services/mail-filing');
const crypto = require('crypto');
const { db } = require('../state');
const {
  MAIL_SENDER_RULE_MATCH_TYPES,
  normalizeMailSenderRuleInput,
  SYSTEM_MAIL_FOLDER_SET,
  normalizeMailFolderSlug,
  normalizeMailFolderDisplayName,
  allocateCollisionSafeMailFolderSlug,
  createRemoteMailFolderForUserAccounts,
  loadMailFoldersForUser,
  toBooleanFlag,
  resolveMailSenderTargetFolder,
  createMailRoutingContext,
} = require('../services/mail');
const { EFFECTIVE_READ_SQL, validateUserMailFolder } = require('./mail-route-helpers');

async function getMailFolderRowsWithCounts(userId, accountId = null) {
  const folders = await loadMailFoldersForUser(userId);
  const [countRows] = await db.execute(
    membershipCountQuery(EFFECTIVE_READ_SQL, accountId),
    accountId && accountId !== 'legacy' && accountId !== 'all' ? [userId, accountId] : [userId]
  );
  const countsByFolder = new Map((countRows || []).map(row => [
    row.folder,
    {
      total_count: Number(row.total_count) || 0,
      unread_count: Number(row.unread_count) || 0,
    },
  ]));
  const links = await folderConnections(userId);
  const [legacyRows] = await db.execute('SELECT folder, COUNT(*) AS count FROM emails WHERE user_id = ? AND is_legacy = TRUE GROUP BY folder', [userId]);
  const legacyCounts = new Map(legacyRows.map(row => [row.folder, Number(row.count)]));
  for (const row of legacyRows) {
    if (!folders.some(folder => folder.slug === row.folder)) folders.push({ id: `legacy:${row.folder}`, slug: row.folder,
      display_name: row.folder || '(Unnamed folder)', is_system: false, mail_account_id: null, position: 999 });
  }
  return folders.filter(folder => !accountId || (accountId === 'legacy' ? legacyCounts.has(folder.slug)
    : folderAcceptsAccount(folder, accountId, links))).map(folder => ({
    ...folder,
    connected_account_ids: links.get(folder.slug) || [],
    legacy_count: legacyCounts.get(folder.slug) || 0,
    total_count: countsByFolder.get(folder.slug)?.total_count || 0,
    unread_count: countsByFolder.get(folder.slug)?.unread_count || 0,
  }));
}

async function persistRemoteMailFolderBoxes(folderId, remoteFolder, connection) {
  for (const account of remoteFolder?.accounts || []) {
    if (account.status === 'failed') continue;
    await connection.execute(
      `INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE remote_name = VALUES(remote_name)`,
      [folderId, account.accountId, account.remoteName]
    );
  }
}

function encodeSenderRuleBackfillCursor(email) {
  const receivedAt = String(email?.received_at_cursor || '');
  const id = String(email?.id || '');
  return receivedAt && id ? Buffer.from(JSON.stringify({ receivedAt, id })).toString('base64url') : null;
}

function decodeSenderRuleBackfillCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const receivedAt = String(cursor?.receivedAt || '');
    const id = String(cursor?.id || '');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(receivedAt) || !id || id.length > 128) throw new Error('invalid cursor');
    return { receivedAt, id };
  } catch {
    const error = new Error('Invalid backfill cursor');
    error.status = 400;
    throw error;
  }
}

module.exports = {
  'GET /api/mail/folders': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const accountId = new URL(req.url, 'http://localhost').searchParams.get('account_id') || null;
      return { folders: await getMailFolderRowsWithCounts(userId, accountId) };
    } catch (error) {
      console.error('List mail folders error:', error);
      return { error: 'Failed to load mail folders', status: 500 };
    }
  },

  'POST /api/mail/folders': async (req, userId, body) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const accountId = String(body?.mail_account_id || '').trim();
      if (!accountId) return { error: 'Select one mail account before creating a folder', status: 400 };
      const [accounts] = await db.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE LIMIT 1', [accountId, userId]);
      if (!accounts.length) return { error: 'Active mail account not found', status: 400 };
      const displayName = normalizeMailFolderDisplayName(body?.display_name || body?.name);
      if (!displayName) return { error: 'Folder name is required', status: 400 };
      const requestedSlug = normalizeMailFolderSlug(body?.slug || displayName);
      if (!requestedSlug) return { error: 'Folder slug is invalid', status: 400 };
      if (requestedSlug === 'all' || requestedSlug === 'starred') {
        return { error: 'Folder slug is reserved', status: 400 };
      }
      const [sameName] = await db.execute(
        'SELECT id FROM mail_folders WHERE user_id = ? AND (mail_account_id = ? OR is_system = TRUE) AND LOWER(display_name) = LOWER(?) LIMIT 1',
        [userId, accountId, displayName]
      );
      if (sameName.length > 0) return { error: 'Folder already exists', status: 409 };
      const [mappedName] = await db.execute(
        `SELECT f.id FROM mail_folder_remote_boxes b JOIN mail_folders f ON f.id = b.folder_id
         WHERE f.user_id = ? AND b.mail_account_id = ? AND LOWER(b.remote_name) = LOWER(?) LIMIT 1`,
        [userId, accountId, displayName]);
      if (mappedName.length) return { error: 'This provider folder is already represented, possibly under Legacy shared. Choose a different name.', status: 409 };
      const [existing] = await db.execute('SELECT id FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1', [userId, requestedSlug]);
      const slug = existing.length > 0
        ? await allocateCollisionSafeMailFolderSlug(userId, displayName)
        : requestedSlug;
      const [positionRows] = await db.execute(
        'SELECT COALESCE(MAX(position), 90) AS max_position FROM mail_folders WHERE user_id = ?',
        [userId]
      );
      const position = Number(positionRows[0]?.max_position || 90) + 10;
      // Remote creation may be partially successful. Persist successes so retrying is safe.
      const remoteFolder = await createRemoteMailFolderForUserAccounts(userId, displayName, accountId);
      const folderId = crypto.randomUUID();
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO mail_folders (id, user_id, mail_account_id, slug, display_name, is_system, position)
           VALUES (?, ?, ?, ?, ?, FALSE, ?)`,
          [folderId, userId, accountId, slug, displayName, position]
        );
        await persistRemoteMailFolderBoxes(folderId, remoteFolder, connection);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      const folders = await getMailFolderRowsWithCounts(userId);
      return { folder: folders.find(folder => folder.slug === slug) || null, folders, remoteFolder };
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
      if (!folder.is_system && (Object.prototype.hasOwnProperty.call(body || {}, 'display_name') || Object.prototype.hasOwnProperty.call(body || {}, 'name'))) {
        return { error: 'Renaming synced custom folders is not supported; create a new folder instead.', status: 409 };
      }
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
      return { error: 'Deleting synced custom folders is not supported; keep the folder or delete it in your mail provider.', status: 409 };
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
      if (folderValidation.accountId && folderValidation.accountId !== accountId) {
        return { error: 'This folder requires a rule for its own mail account', status: 400 };
      }
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
      if (folderValidation.accountId && folderValidation.accountId !== accountId) {
        return { error: 'This folder requires a rule for its own mail account', status: 400 };
      }
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
      await db.execute('DELETE FROM mail_folder_rule_overrides WHERE rule_id = ?', [ruleId]);
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
      const cursor = decodeSenderRuleBackfillCursor(body?.cursor);
      const requestedLimit = Number.parseInt(String(body?.limit ?? '1000'), 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 5000) : 1000;
      if (accountId) {
        const [accounts] = await db.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
        if (!accounts.length) return { error: 'Invalid account_id', status: 400 };
      }
      const where = ['e.user_id = ?', 'e.is_legacy = FALSE', "e.folder = 'inbox'", 'e.from_address IS NOT NULL', "TRIM(e.from_address) <> ''"];
      const params = [userId];
      if (accountId) {
        where.push('COALESCE(e.filing_account_id, e.mail_account_id) = ?');
        params.push(accountId);
      }
      if (cursor) {
        where.push('(e.received_at < ? OR (e.received_at = ? AND e.id < ?))');
        params.push(cursor.receivedAt, cursor.receivedAt, cursor.id);
      }
      const [emailRows] = await db.execute(
        `SELECT e.id, e.mail_account_id, e.filing_account_id, e.from_address, e.folder,
                DATE_FORMAT(e.received_at, '%Y-%m-%d %H:%i:%s.%f') AS received_at_cursor
         FROM emails e
         WHERE NOT EXISTS (SELECT 1 FROM mail_accounts a WHERE a.id = e.mail_account_id AND a.sync_mode = 'sync')
           AND ${where.join(' AND ')}
         ORDER BY e.received_at DESC, e.id DESC
         LIMIT ${limit + 1}`,
        params
      );
      const hasMore = (emailRows || []).length > limit;
      const emails = (emailRows || []).slice(0, limit);
      const nextCursor = hasMore ? encodeSenderRuleBackfillCursor(emails[emails.length - 1]) : null;
      const perAccountRules = new Map();
      const folders = new Map((await loadMailFoldersForUser(userId)).map(folder => [folder.slug, folder]));
      const links = await folderConnections(userId);
      const updates = [];
      const originals = new Map(emails.map(email => [email.id, email]));
      for (const email of emails || []) {
        const filingAccount = filingAccountId(email);
        const ruleCacheKey = String(filingAccount || '');
        if (!perAccountRules.has(ruleCacheKey)) {
          const context = await createMailRoutingContext(userId, filingAccount, db);
          context.folders = new Set([...folders.values()].filter(folder => folderAcceptsAccount(folder, filingAccount, links)).map(folder => folder.slug));
          perAccountRules.set(ruleCacheKey, context);
        }
        const resolved = await resolveMailSenderTargetFolder({
          userId,
          mailAccountId: filingAccount,
          fromAddress: email.from_address || '',
          fallbackFolder: 'inbox',
          routingContext: perAccountRules.get(ruleCacheKey),
          connection: db,
        });
        if (resolved.folder !== 'inbox' && folderAcceptsAccount(folders.get(resolved.folder), filingAccount, links)) {
          updates.push({
            email_id: email.id,
            from_address: email.from_address,
            current_folder: email.folder,
            next_folder: resolved.folder,
            rule_id: resolved.rule?.id || null,
          });
        }
      }
      let applied = 0;
      if (applyChanges && updates.length > 0) {
        const connection = await db.getConnection();
        try {
          await connection.beginTransaction();
          for (const item of updates) {
            const original = originals.get(item.email_id);
            // Skip messages moved or recovered since this batch was read.
            const [result] = await connection.execute(`UPDATE emails SET folder = ?
              WHERE id = ? AND user_id = ? AND folder = ? AND is_legacy = FALSE
                AND mail_account_id <=> ? AND filing_account_id <=> ?
                AND NOT EXISTS (SELECT 1 FROM mail_accounts a WHERE a.id = emails.mail_account_id AND a.sync_mode = 'sync')`,
            [item.next_folder, item.email_id, userId, original.folder, original.mail_account_id, original.filing_account_id ?? null]);
            applied += result.affectedRows;
          }
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      }
      return {
        dry_run: !applyChanges,
        scanned: emails.length,
        matched: updates.length,
        applied,
        complete: !hasMore,
        has_more: hasMore,
        next_cursor: nextCursor,
        remaining: hasMore ? 'More inbox messages remain; continue sorting to process the next batch.' : null,
        updates: updates.slice(0, 200),
      };
    } catch (error) {
      console.error('Mail sender rule backfill error:', error);
      return { error: 'Failed to backfill mail routing', status: 500 };
    }
  },

  'GET /api/mail/unread-counts': async (req, userId) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const accountId = url.searchParams.get('account_id');
      const includeByAccount = url.searchParams.get('include_by_account') === 'true';
      const hasAccountFilter = !!accountId && accountId !== 'all';

      const folderQuery = unreadMembershipQuery(EFFECTIVE_READ_SQL, accountId);
      const folderParams = [userId];
      if (hasAccountFilter && accountId !== 'legacy') folderParams.push(accountId);

      const [folderRows] = await db.execute(folderQuery, folderParams);
      const unreadByFolder = {};
      for (const row of folderRows) {
        unreadByFolder[row.folder] = (unreadByFolder[row.folder] || 0) + (Number(row.unread_count) || 0);
      }

      const response = { unreadByFolder };

      if (includeByAccount) {
        const unreadByFolderAccount = {};
        for (const row of folderRows) {
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
};
