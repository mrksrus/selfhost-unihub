import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ApiError } from '../types';
import type { ProtocolConnection, ProtocolError } from '../types/imap-protocol';

import { db } from '../state';
import * as imapClient from './mail-imap-client';
import { guardImapConnection, runGuardedImap, closeImapConnection } from './mail-imap-guard';
import { buildImapConnectionConfig } from './mail-host-policy';
import { withTransaction, repointToLiveOccurrence } from './mail-engine/repository';
import { deleteEmailRows, removeUnreferencedFiles, SETTLED_OPERATION_STATES } from './mail-sync-policy';
import { yieldMailReadWork } from './mail-sync-control';
import { SYSTEM_MAIL_FOLDER_SET } from './mail-folders';

type AccountRow = RowDataPacket & { id: string; user_id: string; email_address: string };
type FolderConnection = Pick<ProtocolConnection, 'mailboxDelete' | 'list'>;
interface RemoteBox { mail_account_id: string; remote_name: string }
interface Options {
  pool?: Pick<Pool, 'execute' | 'getConnection'>;
  /** Opens a guarded IMAP connection for an account; replaced in tests. */
  connect?: (account: AccountRow) => Promise<FolderConnection>;
}

const fail = (status: number, message: string): ApiError => Object.assign(new Error(message), { status });
const settled = SETTLED_OPERATION_STATES.map(() => '?').join(',');

async function connectToAccount(account: AccountRow) {
  const config = await buildImapConnectionConfig(account);
  if (!config) throw new Error('No password configured');
  return guardImapConnection(await imapClient.connectImap(config));
}

// Only the DELETE reply is classified, never a login failure ("NO User does
// not exist"). Without the NONEXISTENT code the wording alone is no proof:
// the folder must also be missing from a listing.
const MISSING_TEXT = /\b(mailbox|folder)\b[^.]*\b(does not exist|doesn't exist|not found)\b|\bno such (mailbox|folder)\b|\bunknown mailbox\b/i;
async function alreadyGone(connection: FolderConnection, name: string, error: unknown) {
  const reply = error as ProtocolError & { serverResponseCode?: string; responseText?: string };
  if (reply?.serverResponseCode === 'NONEXISTENT') return true;
  if (reply?.responseStatus !== 'NO' || !MISSING_TEXT.test(String(reply.responseText || ''))) return false;
  const entries = await runGuardedImap(connection as ProtocolConnection, () => connection.list()).catch(() => null);
  return Array.isArray(entries) && entries.length > 0 && !entries.some(entry => entry?.path === name);
}

/**
 * Settles the items filed in a folder whose server mailbox was just deleted.
 * Deleting a mailbox removes only the copies in it, so an item goes only when
 * that was its last copy on the server. Drafts, mail that never had a copy
 * there, Legacy or cross-filed mail and items with an unsettled change (its
 * dispatch evidence lives with the item) stay; so does a message the server
 * still holds elsewhere (on Gmail another label or All Mail), filed where that
 * copy is.
 */
async function settleBox(cx: PoolConnection, { userId, slug, box }: { userId: string; slug: string; box: RemoteBox }) {
  const accountId = box.mail_account_id;
  const [[mailbox]] = await cx.execute<RowDataPacket[]>(`SELECT id FROM mail_remote_mailboxes
    WHERE user_id = ? AND mail_account_id = ? AND BINARY remote_name = BINARY ? FOR UPDATE`, [userId, accountId, box.remote_name]);
  // As after a folder listing without it: its copies stop counting as membership.
  if (mailbox) await cx.execute(`UPDATE mail_remote_mailboxes SET state = 'missing', epoch_revision = epoch_revision + 1
    WHERE id = ? AND state = 'active'`, [mailbox.id]);
  const mailboxId = mailbox?.id ?? null;
  const [items] = await cx.execute<RowDataPacket[]>(`SELECT e.id, COALESCE(e.is_draft, FALSE) AS is_draft,
      e.remote_folder, e.remote_uid, e.remote_uidvalidity,
      (e.is_legacy = TRUE OR COALESCE(e.filing_account_id, e.mail_account_id) <> e.mail_account_id
        OR EXISTS (SELECT 1 FROM mail_writebacks w WHERE w.email_id = e.id AND w.user_id = e.user_id
          AND (w.state IS NULL OR w.state NOT IN (${settled})))) AS held,
      EXISTS (SELECT 1 FROM mail_remote_occurrences o WHERE o.email_id = e.id AND o.user_id = e.user_id
        AND o.mail_account_id = e.mail_account_id AND o.mailbox_id <=> ? AND o.presence = 'present') AS was_here,
      EXISTS (SELECT 1 FROM mail_remote_occurrences o JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id
        WHERE o.email_id = e.id AND o.user_id = e.user_id AND o.mail_account_id = e.mail_account_id
          AND NOT (o.mailbox_id <=> ?) AND m.state <> 'missing' AND o.presence IN ('present','quarantined')) AS elsewhere
    FROM emails e WHERE e.user_id = ? AND e.mail_account_id = ? AND e.folder = ? FOR UPDATE`,
  [...SETTLED_OPERATION_STATES, mailboxId, mailboxId, userId, accountId, slug]);

  const doomed: string[] = [];
  let moved = 0;
  for (const item of items) {
    if (Number(item.is_draft)) {
      await cx.execute("UPDATE emails SET folder = 'drafts' WHERE id = ? AND user_id = ?", [item.id, userId]);
      moved++; continue;
    }
    if (Number(item.was_here) && !Number(item.elsewhere) && !Number(item.held)) { doomed.push(item.id); continue; }
    let target = 'inbox';
    if (Number(item.elsewhere)) {
      // The same pick as repointToLiveOccurrence: a real folder before All Mail, then the latest copy.
      const [[live]] = await cx.execute<RowDataPacket[]>(`SELECT f.slug FROM mail_remote_occurrences o
        JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id AND m.user_id = o.user_id AND m.mail_account_id = o.mail_account_id
          AND m.state = 'active' AND m.uidvalidity = o.uidvalidity
        LEFT JOIN mail_folder_remote_boxes b ON b.mail_account_id = m.mail_account_id AND BINARY b.remote_name = BINARY m.remote_name
        LEFT JOIN mail_folders f ON f.id = b.folder_id AND f.user_id = o.user_id
        WHERE o.email_id = ? AND o.user_id = ? AND o.mail_account_id = ? AND o.presence = 'present'
        ORDER BY (m.special_use <=> 'all'), o.observed_at DESC, m.remote_name, o.uid LIMIT 1`, [item.id, userId, accountId]);
      if (live?.slug && live.slug !== slug) target = live.slug;
      // Later changes go to the copy that is left, not to the deleted mailbox.
      if (live && !Number(item.held) && item.remote_folder === box.remote_name && item.remote_uid != null && item.remote_uidvalidity != null)
        await repointToLiveOccurrence({ userId, accountId, emailId: item.id,
          from: { folder: box.remote_name, uid: item.remote_uid, uidvalidity: item.remote_uidvalidity } }, cx);
    }
    await cx.execute('UPDATE emails SET folder = ? WHERE id = ? AND user_id = ?', [target, item.id, userId]);
    moved++;
  }
  return { moved, ...await deleteEmailRows(cx, { userId, accountId, ids: doomed }) };
}

/**
 * Removes a custom mail folder.
 *
 * A folder that exists only in UniHub (a local folder, or a Legacy shared
 * folder) moves its messages and sender rules back to Inbox. A folder that is
 * on the mail server can only go together with its server copy (`server`):
 * the server is the source of truth, so a folder removed in UniHub alone
 * would return with the next folder discovery. The server folder is deleted
 * first; only when every server copy is gone does the local change follow, in
 * one transaction, so a failed server call leaves everything as it was.
 *
 * The account's read jobs are stopped before the DELETE. Not covered: a
 * folder discovery whose LIST ran just before the DELETE can register the
 * folder once more; the next discovery retires it again.
 */
async function deleteMailFolder({ userId, slug, server = false }: { userId: string; slug: string; server?: boolean }, { pool = db, connect = connectToAccount }: Options = {}) {
  const [folders] = await pool.execute<RowDataPacket[]>('SELECT * FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1', [userId, slug]);
  const folder = folders[0];
  if (!folder) throw fail(404, 'Folder not found');
  if (folder.is_system || SYSTEM_MAIL_FOLDER_SET.has(slug)) throw fail(400, 'System folders cannot be deleted');
  const [boxes] = await pool.execute<(RowDataPacket & RemoteBox)[]>(`SELECT b.mail_account_id, b.remote_name FROM mail_folder_remote_boxes b
    JOIN mail_accounts a ON a.id = b.mail_account_id AND a.user_id = ? WHERE b.folder_id = ?`, [userId, folder.id]);
  if (boxes.length && !server) throw fail(409, 'This folder is on the mail server. Delete it there as well, or keep it.');

  const removed: { accountId: string; remoteName: string; emailAddress: string }[] = [];
  for (const box of boxes) {
    const [accounts] = await pool.execute<AccountRow[]>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE AND disconnected_at IS NULL', [box.mail_account_id, userId]);
    const account = accounts[0];
    if (!account) throw fail(409, 'The account this folder belongs to is disconnected. Reconnect it first, or keep the folder.');
    await yieldMailReadWork(account.id);
    let connection: FolderConnection;
    try {
      connection = await connect(account);
    } catch (error) {
      throw fail(502, `Could not connect to the mail server (${account.email_address}): ${(error as Error).message}`);
    }
    try {
      await runGuardedImap(connection as ProtocolConnection, () => connection.mailboxDelete(box.remote_name));
    } catch (error) {
      if (!await alreadyGone(connection, box.remote_name, error))
        throw fail(502, `Could not delete the folder on the mail server (${account.email_address}): ${(error as Error).message}`);
    } finally {
      closeImapConnection(connection as ProtocolConnection);
    }
    removed.push({ accountId: account.id, remoteName: box.remote_name, emailAddress: account.email_address });
  }

  const outcome = await withTransaction(async cx => {
    const attachmentPaths: string[] = [], rawPaths: string[] = [];
    let deleted = 0, moved = 0;
    for (const box of boxes) {
      const result = await settleBox(cx, { userId, slug, box });
      deleted += result.deleted; moved += result.moved;
      attachmentPaths.push(...result.attachmentPaths);
      rawPaths.push(...result.rawPaths);
    }
    // Whatever else was filed here (a local folder, other accounts) goes back to Inbox.
    const [rest] = await cx.execute<ResultSetHeader>("UPDATE emails SET folder = 'inbox' WHERE user_id = ? AND folder = ?", [userId, slug]);
    await cx.execute("UPDATE mail_sender_rules SET target_folder = 'inbox' WHERE user_id = ? AND target_folder = ?", [userId, slug]);
    await cx.execute('DELETE o FROM mail_folder_rule_overrides o JOIN mail_sender_rules r ON r.id = o.rule_id WHERE r.user_id = ? AND o.target_folder = ?', [userId, slug]);
    await cx.execute('DELETE FROM mail_folders WHERE id = ? AND user_id = ?', [folder.id, userId]);
    return { deleted, moved: moved + rest.affectedRows, attachmentPaths, rawPaths };
  }, pool);
  await removeUnreferencedFiles({ userId, attachmentPaths: outcome.attachmentPaths, rawPaths: outcome.rawPaths });
  return { slug, server: removed, deletedMessages: outcome.deleted, movedMessages: outcome.moved };
}

export { deleteMailFolder };
