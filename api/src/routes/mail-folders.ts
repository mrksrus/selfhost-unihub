import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RouteRequest, ApiError } from '../types';
import type { SqlExecutor } from '../types';
import { folderConnections } from '../services/mail-folder-reconciliation';
import { membershipCountQuery, unreadMembershipQuery } from '../services/mail-folder-view';
import { filingAccountId, folderAcceptsAccount } from '../services/mail-filing';
import crypto from 'crypto';
import * as mailWritebacks from '../services/mail-writebacks';
import { db } from '../state';
import {
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
} from '../services/mail';
import { EFFECTIVE_READ_SQL, validateUserMailFolder } from './mail-route-helpers';

type Request = RouteRequest & { url: string; params: Record<string, string> };
interface Input {
  slug?: unknown;
  display_name?: unknown;
  name?: unknown;
  position?: unknown;
  mail_account_id?: unknown;
  match_type?: unknown;
  match_value?: unknown;
  target_folder?: unknown;
  priority?: unknown;
  is_active?: unknown;
  account_id?: unknown;
  mode?: unknown;
  apply?: unknown;
  cursor?: unknown;
  limit?: unknown;
}
interface Move { email_id: string; next_folder: string }
interface Original extends RowDataPacket {
  id: string;
  folder: string;
  mail_account_id: string;
  filing_account_id: string | null;
  sync_mode: string;
}
type Folder = NonNullable<Parameters<typeof folderAcceptsAccount>[0]> & { id: string; display_name: string; position?: number };

const MAIL_PAUSED_ERRORS = new Set(['Mail restore in progress', 'Mail module is disabled', 'Mail is paused']);
const senderRuleChunk = 500;

// Sort-now moves use the same path as moving mail by hand: Sync accounts queue
// a move on the mail server, Download accounts change the local folder only.
// Messages moved or refiled since the scan are left alone.
async function applySenderRuleMoves(userId: string, updates: Move[], originals: Map<string, Original>, links: Map<string, string[]>) {
  const totals = { applied: 0, queued: 0, skipped: 0 };
  const byFolder = new Map<string, string[]>();
  for (const item of updates) {
    const original = originals.get(item.email_id)!;
    const remote = original.sync_mode === 'sync' && filingAccountId(original) === original.mail_account_id;
    // A Sync message can only move to a folder that exists on its own server.
    if (remote && !(links.get(item.next_folder) || []).includes(original.mail_account_id)) { totals.skipped++; continue; }
    if (!byFolder.has(item.next_folder)) byFolder.set(item.next_folder, []);
    byFolder.get(item.next_folder)!.push(item.email_id);
  }
  const unchanged: NonNullable<Parameters<typeof mailWritebacks.mutateMessages>[3]> = async (_connection, selected) => {
    for (const email of selected) {
      const original = originals.get(email.id)!;
      if (email.is_legacy || email.folder !== original.folder || email.mail_account_id !== original.mail_account_id
        || (email.filing_account_id ?? null) !== (original.filing_account_id ?? null)) {
        throw Object.assign(new Error('Message changed since sorting started'), { status: 409 });
      }
    }
  };
  const move = async (ids: string[], folder: string) => {
    const result = await mailWritebacks.mutateMessages(userId, ids, { move: folder }, unchanged);
    totals.applied += ids.length;
    totals.queued += result.operation_ids?.length || 0;
  };
  for (const [folder, ids] of byFolder) {
    for (let i = 0; i < ids.length; i += senderRuleChunk) {
      const chunk = ids.slice(i, i + senderRuleChunk);
      try {
        await move(chunk, folder);
      } catch (error) {
        if (MAIL_PAUSED_ERRORS.has((error as ApiError).message) || !((error as ApiError).status! >= 400 && (error as ApiError).status! < 500)) throw error;
        // One blocked message refuses the whole batch; retry one by one.
        for (const id of chunk) {
          try { await move([id], folder); } catch (single) {
            if (MAIL_PAUSED_ERRORS.has((single as ApiError).message) || !((single as ApiError).status! >= 400 && (single as ApiError).status! < 500)) throw single;
            totals.skipped++;
          }
        }
      }
    }
  }
  return totals;
}

async function getMailFolderRowsWithCounts(userId: string, accountId: string | null = null) {
  const folders: Folder[] = await loadMailFoldersForUser(userId);
  const [countRows] = await db.execute<RowDataPacket[]>(
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
  const [legacyRows] = await db.execute<RowDataPacket[]>('SELECT folder, COUNT(*) AS count FROM emails WHERE user_id = ? AND is_legacy = TRUE GROUP BY folder', [userId]);
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

async function persistRemoteMailFolderBoxes(folderId: string, remoteFolder: Awaited<ReturnType<typeof createRemoteMailFolderForUserAccounts>>, connection: SqlExecutor) {
  for (const account of remoteFolder?.accounts || []) {
    if (account.status === 'failed') continue;
    await connection.execute(
      `INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE remote_name = VALUES(remote_name)`,
      [folderId, account.accountId, account.remoteName]
    );
  }
}

function encodeSenderRuleBackfillCursor(email: { received_at_cursor?: unknown; id?: unknown } | null) {
  const receivedAt = String(email?.received_at_cursor || '');
  const id = String(email?.id || '');
  return receivedAt && id ? Buffer.from(JSON.stringify({ receivedAt, id })).toString('base64url') : null;
}

function decodeSenderRuleBackfillCursor(value: unknown) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const receivedAt = String(cursor?.receivedAt || '');
    const id = String(cursor?.id || '');
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(receivedAt) || !id || id.length > 128) throw new Error('invalid cursor');
    return { receivedAt, id };
  } catch {
    const error: ApiError = new Error('Invalid backfill cursor');
    (error as ApiError).status! = 400;
    throw error;
  }
}

export = {
  'GET /api/mail/folders': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const accountId = new URL(req.url, 'http://localhost').searchParams.get('account_id') || null;
      return { folders: await getMailFolderRowsWithCounts(userId, accountId) };
    } catch (error) {
      console.error('List mail folders error:', error);
      return { error: 'Failed to load mail folders', status: 500 };
    }
  },

  'POST /api/mail/folders': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const accountId = String(body?.mail_account_id || '').trim();
      if (!accountId) return { error: 'Select one mail account before creating a folder', status: 400 };
      const [accounts] = await db.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE LIMIT 1', [accountId, userId]);
      if (!accounts.length) return { error: 'Active mail account not found', status: 400 };
      const displayName = normalizeMailFolderDisplayName(body?.display_name || body?.name);
      if (!displayName) return { error: 'Folder name is required', status: 400 };
      const requestedSlug = normalizeMailFolderSlug(body?.slug || displayName);
      if (!requestedSlug) return { error: 'Folder slug is invalid', status: 400 };
      if (requestedSlug === 'all' || requestedSlug === 'starred') {
        return { error: 'Folder slug is reserved', status: 400 };
      }
      const [sameName] = await db.execute<RowDataPacket[]>(
        'SELECT id FROM mail_folders WHERE user_id = ? AND (mail_account_id = ? OR is_system = TRUE) AND LOWER(display_name) = LOWER(?) LIMIT 1',
        [userId, accountId, displayName]
      );
      if (sameName.length > 0) return { error: 'Folder already exists', status: 409 };
      const [mappedName] = await db.execute<RowDataPacket[]>(
        `SELECT f.id FROM mail_folder_remote_boxes b JOIN mail_folders f ON f.id = b.folder_id
         WHERE f.user_id = ? AND b.mail_account_id = ? AND LOWER(b.remote_name) = LOWER(?) LIMIT 1`,
        [userId, accountId, displayName]);
      if (mappedName.length) return { error: 'This provider folder is already represented, possibly under Legacy shared. Choose a different name.', status: 409 };
      const [existing] = await db.execute<RowDataPacket[]>('SELECT id FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1', [userId, requestedSlug]);
      const slug = existing.length > 0
        ? await allocateCollisionSafeMailFolderSlug(userId, displayName)
        : requestedSlug;
      const [positionRows] = await db.execute<RowDataPacket[]>(
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

  'PUT /api/mail/folders/:slug': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const slug = normalizeMailFolderSlug(req.params.slug);
      if (!slug) return { error: 'Folder is required', status: 400 };
      const [folders] = await db.execute<RowDataPacket[]>(
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
      await db.execute<RowDataPacket[]>(`UPDATE mail_folders SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
      const updatedFolders = await getMailFolderRowsWithCounts(userId);
      return { folder: updatedFolders.find(item => item.slug === slug) || null, folders: updatedFolders };
    } catch (error) {
      console.error('Update mail folder error:', error);
      return { error: 'Failed to update mail folder', status: 500 };
    }
  },

  'DELETE /api/mail/folders/:slug': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const slug = normalizeMailFolderSlug(req.params.slug);
      if (!slug) return { error: 'Folder is required', status: 400 };
      const [folders] = await db.execute<RowDataPacket[]>(
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

  'GET /api/mail/sender-rules': async (req: Request, userId: string | null) => {
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
      const [rules] = await db.execute<RowDataPacket[]>(
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

  'POST /api/mail/sender-rules': async (req: Request, userId: string | null, body: Input) => {
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
        const [accounts] = await db.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
        if (!accounts.length) return { error: 'Invalid mail_account_id', status: 400 };
      }
      const priorityNumber = Number.parseInt(String(body?.priority ?? '100'), 10);
      const priority = Number.isFinite(priorityNumber) ? priorityNumber : 100;
      const isActive = body?.is_active === undefined ? true : !!body.is_active;
      const ruleId = crypto.randomUUID();
      await db.execute<RowDataPacket[]>(
        `INSERT INTO mail_sender_rules (id, user_id, mail_account_id, match_type, match_value, target_folder, priority, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ruleId, userId, accountId, parsed.matchType!, parsed.matchValue!, targetFolder, priority, isActive ? 1 : 0]
      );
      const [rows] = await db.execute<RowDataPacket[]>(
        'SELECT id, user_id, mail_account_id, match_type, match_value, target_folder, priority, is_active, created_at, updated_at FROM mail_sender_rules WHERE id = ? LIMIT 1',
        [ruleId]
      );
      return { rule: rows[0] || null };
    } catch (error) {
      console.error('Create mail sender rule error:', error);
      return { error: 'Failed to create sender rule', status: 500 };
    }
  },

  'PUT /api/mail/sender-rules/:id': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const ruleId = req.params.id;
    if (!ruleId) return { error: 'Rule id is required', status: 400 };
    try {
      const [existingRows] = await db.execute<RowDataPacket[]>('SELECT * FROM mail_sender_rules WHERE id = ? AND user_id = ? LIMIT 1', [ruleId, userId]);
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
        const [accounts] = await db.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
        if (!accounts.length) return { error: 'Invalid mail_account_id', status: 400 };
      }
      const priorityCandidate = body?.priority !== undefined ? body.priority : existing.priority;
      const parsedPriority = Number.parseInt(String(priorityCandidate), 10);
      const priority = Number.isFinite(parsedPriority) ? parsedPriority : 100;
      const isActive = body?.is_active !== undefined ? !!body.is_active : toBooleanFlag(existing.is_active);
      await db.execute<RowDataPacket[]>(
        `UPDATE mail_sender_rules
         SET mail_account_id = ?, match_type = ?, match_value = ?, target_folder = ?, priority = ?, is_active = ?
         WHERE id = ? AND user_id = ?`,
        [accountId, parsed.matchType!, parsed.matchValue!, nextTargetFolder, priority, isActive ? 1 : 0, ruleId, userId]
      );
      await db.execute<RowDataPacket[]>('DELETE FROM mail_folder_rule_overrides WHERE rule_id = ?', [ruleId]);
      const [rows] = await db.execute<RowDataPacket[]>(
        'SELECT id, user_id, mail_account_id, match_type, match_value, target_folder, priority, is_active, created_at, updated_at FROM mail_sender_rules WHERE id = ? LIMIT 1',
        [ruleId]
      );
      return { rule: rows[0] || null };
    } catch (error) {
      console.error('Update mail sender rule error:', error);
      return { error: 'Failed to update sender rule', status: 500 };
    }
  },

  'DELETE /api/mail/sender-rules/:id': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    const ruleId = req.params.id;
    if (!ruleId) return { error: 'Rule id is required', status: 400 };
    try {
      const [result] = await db.execute<ResultSetHeader>('DELETE FROM mail_sender_rules WHERE id = ? AND user_id = ? LIMIT 1', [ruleId, userId]);
      if (!result.affectedRows) return { error: 'Rule not found', status: 404 };
      return { deleted: true };
    } catch (error) {
      console.error('Delete mail sender rule error:', error);
      return { error: 'Failed to delete sender rule', status: 500 };
    }
  },

  'POST /api/mail/sender-rules/backfill': async (req: Request, userId: string | null, body: Input) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
    try {
      const accountId = String(body?.account_id || '').trim() || null;
      const applyChanges = body?.mode === 'apply' || body?.apply === true;
      const cursor = decodeSenderRuleBackfillCursor(body?.cursor);
      const requestedLimit = Number.parseInt(String(body?.limit ?? '1000'), 10);
      const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 5000) : 1000;
      if (accountId) {
        const [accounts] = await db.execute<RowDataPacket[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [accountId, userId]);
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
      const [emailRows] = await db.execute<Original[]>(
        `SELECT e.id, e.mail_account_id, e.filing_account_id, e.from_address, e.folder, a.sync_mode,
                DATE_FORMAT(e.received_at, '%Y-%m-%d %H:%i:%s.%f') AS received_at_cursor
         FROM emails e
         LEFT JOIN mail_accounts a ON a.id = e.mail_account_id AND a.user_id = e.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY e.received_at DESC, e.id DESC
         LIMIT ${limit + 1}`,
        params
      );
      const hasMore = (emailRows || []).length > limit;
      const emails = (emailRows || []).slice(0, limit);
      const nextCursor = hasMore ? encodeSenderRuleBackfillCursor(emails[emails.length - 1]) : null;
      const perAccountRules = new Map<string, Awaited<ReturnType<typeof createMailRoutingContext>>>();
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
      const result = applyChanges ? await applySenderRuleMoves(userId, updates, originals, links) : { applied: 0, queued: 0, skipped: 0 };
      return {
        dry_run: !applyChanges,
        scanned: emails.length,
        matched: updates.length,
        applied: result.applied,
        queued: result.queued,
        skipped: result.skipped,
        complete: !hasMore,
        has_more: hasMore,
        next_cursor: nextCursor,
        remaining: hasMore ? 'More inbox messages remain; continue sorting to process the next batch.' : null,
        updates: updates.slice(0, 200),
      };
    } catch (error) {
      if (MAIL_PAUSED_ERRORS.has((error as ApiError).message)) return { error: (error as ApiError).message, status: 409 };
      console.error('Mail sender rule backfill error:', error);
      return { error: 'Failed to backfill mail routing', status: 500 };
    }
  },

  'GET /api/mail/unread-counts': async (req: Request, userId: string | null) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const accountId = url.searchParams.get('account_id');
      const includeByAccount = url.searchParams.get('include_by_account') === 'true';
      const hasAccountFilter = !!accountId && accountId !== 'all';

      const folderQuery = unreadMembershipQuery(EFFECTIVE_READ_SQL, accountId);
      const folderParams = [userId];
      if (hasAccountFilter && accountId !== 'legacy') folderParams.push(accountId);

      const [folderRows] = await db.execute<RowDataPacket[]>(folderQuery, folderParams);
      const unreadByFolder: Record<string, number> = {};
      for (const row of folderRows) {
        unreadByFolder[row.folder] = (unreadByFolder[row.folder] || 0) + (Number(row.unread_count) || 0);
      }

      const response: { unreadByFolder: Record<string, number>; unreadByFolderAccount?: Record<string, Record<string, number>> } = { unreadByFolder };

      if (includeByAccount) {
        const unreadByFolderAccount: Record<string, Record<string, number>> = {};
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
