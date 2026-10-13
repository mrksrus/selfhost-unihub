import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ApiError } from '../types';
import type { ProtocolConnection } from '../types/imap-protocol';

import { db } from '../state';
import * as imapClient from './mail-imap-client';
import { guardImapConnection, runGuardedImap, closeImapConnection } from './mail-imap-guard';
import { buildImapConnectionConfig } from './mail-host-policy';
import { withTransaction } from './mail-engine/repository';
import { deleteEmailRows, removeUnreferencedFiles } from './mail-sync-policy';
import { SYSTEM_MAIL_FOLDER_SET } from './mail-folders';

type AccountRow = RowDataPacket & { id: string; user_id: string; email_address: string };
interface RemoteBox { mail_account_id: string; remote_name: string }
interface Options {
  pool?: Pick<Pool, 'execute' | 'getConnection'>;
  /** Opens a guarded IMAP connection for an account; replaced in tests. */
  connect?: (account: AccountRow) => Promise<Pick<ProtocolConnection, 'mailboxDelete'>>;
}

const fail = (status: number, message: string): ApiError => Object.assign(new Error(message), { status });

async function connectToAccount(account: AccountRow) {
  const config = await buildImapConnectionConfig(account);
  if (!config) throw new Error('No password configured');
  return guardImapConnection(await imapClient.connectImap(config));
}

// The server says the folder is already gone: that is the outcome wanted.
function mailboxMissing(error: unknown) {
  const detail = error as { serverResponseCode?: string; responseText?: string; message?: string };
  return detail?.serverResponseCode === 'NONEXISTENT'
    || /does not exist|doesn't exist|no such|not found|nonexistent/i.test(String(detail?.responseText || detail?.message || ''));
}

/**
 * Removes a custom mail folder.
 *
 * A folder that exists only in UniHub (a local folder, or a Legacy shared
 * folder) moves its messages and sender rules back to Inbox. A folder that is
 * on the mail server can only go together with its server copy (`server`):
 * the server is the source of truth, so a folder removed in UniHub alone
 * would return with the next folder discovery. The server folder is deleted
 * first, with the messages in it; only when every server copy is gone are the
 * local rows removed, so a failed server call leaves everything as it was.
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
    let connection: Pick<ProtocolConnection, 'mailboxDelete'> | null = null;
    try {
      connection = await connect(account);
      await runGuardedImap(connection as ProtocolConnection, () => connection!.mailboxDelete(box.remote_name));
    } catch (error) {
      if (!mailboxMissing(error)) throw fail(502, `Could not delete the folder on the mail server (${account.email_address}): ${(error as Error).message}`);
    } finally {
      if (connection) closeImapConnection(connection as ProtocolConnection);
    }
    removed.push({ accountId: account.id, remoteName: box.remote_name, emailAddress: account.email_address });
  }

  const outcome = await withTransaction(async cx => {
    const attachmentPaths: string[] = [], rawPaths: string[] = [];
    let deleted = 0;
    for (const box of boxes) {
      // The server copy, and with it the messages, is gone: so are the local items.
      const [rows] = await cx.execute<RowDataPacket[]>('SELECT id FROM emails WHERE user_id = ? AND mail_account_id = ? AND folder = ?', [userId, box.mail_account_id, slug]);
      const result = await deleteEmailRows(cx, { userId, accountId: box.mail_account_id, ids: rows.map(row => row.id) });
      deleted += result.deleted;
      attachmentPaths.push(...result.attachmentPaths);
      rawPaths.push(...result.rawPaths);
      // As after a folder listing without it: occurrences stop counting, nothing else is touched.
      await cx.execute(`UPDATE mail_remote_mailboxes SET state = 'missing', epoch_revision = epoch_revision + 1
        WHERE user_id = ? AND mail_account_id = ? AND BINARY remote_name = BINARY ? AND state = 'active'`, [userId, box.mail_account_id, box.remote_name]);
    }
    // Whatever else was filed here (local copies, other accounts) goes back to Inbox.
    const [moved] = await cx.execute<ResultSetHeader>("UPDATE emails SET folder = 'inbox' WHERE user_id = ? AND folder = ?", [userId, slug]);
    await cx.execute("UPDATE mail_sender_rules SET target_folder = 'inbox' WHERE user_id = ? AND target_folder = ?", [userId, slug]);
    await cx.execute('DELETE o FROM mail_folder_rule_overrides o JOIN mail_sender_rules r ON r.id = o.rule_id WHERE r.user_id = ? AND o.target_folder = ?', [userId, slug]);
    await cx.execute('DELETE FROM mail_folders WHERE id = ? AND user_id = ?', [folder.id, userId]);
    return { deleted, moved: moved.affectedRows, attachmentPaths, rawPaths };
  }, pool);
  await removeUnreferencedFiles({ userId, attachmentPaths: outcome.attachmentPaths, rawPaths: outcome.rawPaths });
  return { slug, server: removed, deletedMessages: outcome.deleted, movedMessages: outcome.moved };
}

export { deleteMailFolder };
