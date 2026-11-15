import type { RowDataPacket } from 'mysql2/promise';
import { db } from '../state';
import { withTransaction } from './transactions';
import { isSectionRestoreActive } from './restore-locks';
import { SETTLED } from './mail-engine/operation-states';
import { deleteEmailRows, removeUnreferencedFiles } from './mail-sync-policy';
import { publishMailChanged } from './realtime';

function fail(message: string, status = 409, code?: string) { return Object.assign(new Error(message), { status, ...code ? { code } : {} }); }

/**
 * Download mode: deletes UniHub's copy of messages in its Trash for good, with
 * their stored files. The provider's copy is never touched (Download writes
 * nothing to the server). The route's bin.delete policy decides whether
 * deleting for good is allowed at all.
 */
async function deleteTrashForGood(userId: string, ids: unknown) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string')) throw fail('Select between 1 and 500 messages.', 400);
  const unique = [...new Set(ids as string[])].sort();
  if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore in progress');
  const marks = unique.map(() => '?').join(',');
  const removed = await withTransaction(async cx => {
    const [emails] = await cx.execute<RowDataPacket[]>(`SELECT e.id, e.mail_account_id,
        e.folder = 'trash' AND a.sync_mode = 'download' AND e.is_legacy = FALSE
          AND COALESCE(e.filing_account_id, e.mail_account_id) = e.mail_account_id
          AND NOT EXISTS (SELECT 1 FROM mail_writebacks w WHERE w.email_id = e.id AND w.user_id = e.user_id
            AND (w.state IS NULL OR w.state NOT IN (${SETTLED.map(() => '?').join(',')}))) AS eligible
      FROM emails e JOIN mail_accounts a ON a.id = e.mail_account_id AND a.user_id = e.user_id
      WHERE e.user_id = ? AND e.id IN (${marks}) ORDER BY e.id FOR UPDATE`, [...SETTLED, userId, ...unique]);
    if (emails.length !== unique.length) throw fail('Some selected emails are unavailable', 404);
    if (emails.some(email => !Number(email.eligible))) throw fail('Only messages in Trash of a Download account can be deleted for good.', 400);
    // A message whose folder UniHub has not read to the end yet would be
    // downloaded again by that read, so it waits until then.
    const [unread] = await cx.execute<RowDataPacket[]>(`SELECT o.email_id FROM mail_remote_occurrences o
      JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id AND m.uidvalidity = o.uidvalidity AND m.state = 'active'
      LEFT JOIN mail_engine_cursors c ON c.mailbox_id = m.id AND c.uidvalidity = m.uidvalidity AND c.stream = 'history'
      WHERE o.user_id = ? AND o.email_id IN (${marks}) AND (c.covered_through IS NULL OR o.uid > c.covered_through) LIMIT 1`, [userId, ...unique]);
    if (unread.length) throw fail('UniHub is still downloading this folder from the server. Delete the message for good in a few minutes.', 409, 'MAIL_STILL_DOWNLOADING');
    const result = { deleted: 0, accounts: new Set<string>(), attachmentPaths: [] as (string | null)[], rawPaths: [] as (string | null)[] };
    for (const accountId of new Set(emails.map(email => String(email.mail_account_id)))) {
      const outcome = await deleteEmailRows(cx, { userId, accountId, ids: emails.filter(email => email.mail_account_id === accountId).map(email => email.id) });
      result.deleted += outcome.deleted;
      result.accounts.add(accountId);
      result.attachmentPaths.push(...outcome.attachmentPaths);
      result.rawPaths.push(...outcome.rawPaths);
    }
    return result;
  }, db);
  await removeUnreferencedFiles({ userId, attachmentPaths: removed.attachmentPaths, rawPaths: removed.rawPaths });
  publishMailChanged(userId, removed.accounts.size === 1 ? [...removed.accounts][0] : null, 'local');
  return { deleted: removed.deleted };
}

export { deleteTrashForGood };
