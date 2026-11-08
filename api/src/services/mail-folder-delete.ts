import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ApiError, SqlExecutor } from '../types';
import { ApiError as HttpError } from '../http/errors';
import type { ProtocolConnection, ProtocolError } from '../types/imap-protocol';

import { db } from '../state';
import * as imapClient from './mail-imap-client';
import { guardImapConnection, runGuardedImap, closeImapConnection } from './mail-imap-guard';
import { buildImapConnectionConfig } from './mail-host-policy';
import { withTransaction, repointToLiveOccurrence } from './mail-engine/repository';
import { SETTLED } from './mail-engine/operation-states';
import { deleteEmailRows, removeUnreferencedFiles } from './mail-sync-policy';
import { yieldMailReadWork } from './mail-sync-control';
import { SYSTEM_MAIL_FOLDER_SET } from './mail-folders';
import { assertFinalStep, underFinalStep } from './final-step';
import { accountSnapshot } from './account-identity';
import { withPersonLock } from './person-lock';
import { log } from '../log';

type AccountRow = RowDataPacket & { id: string; user_id: string; email_address: string };
type FolderConnection = Pick<ProtocolConnection, 'mailboxDelete' | 'list'>;
interface RemoteBox { mail_account_id: string; remote_name: string }
interface Options {
  pool?: Pick<Pool, 'execute' | 'getConnection'>;
  /** Opens a guarded IMAP connection for an account; replaced in tests. */
  connect?: (account: AccountRow) => Promise<FolderConnection>;
}

const fail = (status: number, message: string): ApiError => Object.assign(new Error(message), { status });
const settled = SETTLED.map(() => '?').join(',');

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
async function settleBox(cx: SqlExecutor, { userId, slug, box }: { userId: string; slug: string; box: RemoteBox }) {
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
  [...SETTLED, mailboxId, mailboxId, userId, accountId, slug]);

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
 * would return with the next folder discovery. Every account the folder is
 * on is connected and checked first (policy, Mail, restores, the account
 * itself), so a refusal or an unreachable server deletes nothing; then the
 * server copies are deleted, and the local change follows for those deleted,
 * in one transaction. A server that fails a DELETE after others succeeded
 * leaves the folder for the accounts still holding it and answers 409
 * FOLDER_PARTLY_DELETED with where it is gone and where it remains; this
 * attempt sends nothing again. No record is kept across attempts: deleting
 * the folder again asks the servers again, and one that already deleted its
 * copy answers that it has none (alreadyGone).
 *
 * The account's read jobs are stopped before the DELETE. Not covered: a
 * folder discovery whose LIST ran just before the DELETE can register the
 * folder once more; the next discovery retires it again.
 */
// The values of DELETE /api/mail/folders/:slug?server= that delete the
// folder at the provider too. The route reads them, and its spec names the
// mail.provider_delete policy (F13) for exactly these values, so no spelling
// the route accepts escapes the policy.
const SERVER_DELETE_VALUES: readonly string[] = ['1', 'true'];

// Under the person's lock (person-lock.ts), from the first read to the local settlement.
async function deleteMailFolder(request: { userId: string; slug: string; server?: boolean }, options: Options = {}) {
  return withPersonLock(request.userId, () => deleteNow(request, options));
}

async function deleteNow({ userId, slug, server = false }: { userId: string; slug: string; server?: boolean }, { pool = db, connect = connectToAccount }: Options) {
  const [folders] = await pool.execute<RowDataPacket[]>('SELECT * FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1', [userId, slug]);
  const folder = folders[0];
  if (!folder) throw fail(404, 'Folder not found');
  if (folder.is_system || SYSTEM_MAIL_FOLDER_SET.has(slug)) throw fail(400, 'System folders cannot be deleted');
  const [boxes] = await pool.execute<(RowDataPacket & RemoteBox)[]>(`SELECT b.mail_account_id, b.remote_name FROM mail_folder_remote_boxes b
    JOIN mail_accounts a ON a.id = b.mail_account_id AND a.user_id = ? WHERE b.folder_id = ?`, [userId, folder.id]);
  if (boxes.length && !server) throw fail(409, 'This folder is on the mail server. Delete it there as well, or keep it.');
  // One order everywhere (the final check locks the accounts by id too), whatever the database's collation.
  const byId = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  boxes.sort((left, right) => byId(left.mail_account_id, right.mail_account_id) || byId(left.remote_name, right.remote_name));

  // Every account the folder is on, connected before the first DELETE: a
  // folder on several accounts is deleted at none of them when one of them
  // cannot be reached or may not be changed.
  const chosen = new Map<string, { account: AccountRow; connection: FolderConnection | null }>();
  try {
    for (const box of boxes) {
      if (chosen.has(box.mail_account_id)) continue;
      const [accounts] = await pool.execute<AccountRow[]>('SELECT * FROM mail_accounts WHERE id = ? AND user_id = ? AND is_active = TRUE AND disconnected_at IS NULL', [box.mail_account_id, userId]);
      const account = accounts[0];
      if (!account) throw fail(409, 'The account this folder belongs to is disconnected. Reconnect it first, or keep the folder.');
      chosen.set(account.id, { account, connection: null });
    }
    for (const entry of chosen.values()) {
      await yieldMailReadWork(entry.account.id);
      try {
        entry.connection = await connect(entry.account);
      } catch (error) {
        log.warn('MAIL', 'Could not connect to delete a folder', undefined, error);
        throw serverFailure(`Could not connect to the mail server (${entry.account.email_address}). Nothing was changed.`);
      }
    }
    // The provider's DELETEs under one final check (final-step.ts): the
    // policy, Mail on and not being restored, and every account still as
    // read above (account-identity.ts), held until the last one answered.
    // A refusal deletes nothing. A server that fails a DELETE stops the
    // rest; the ones already deleted are settled below, never sent again by
    // UniHub itself.
    const removed: RemoteBox[] = [];
    let failure: ApiError | null = null;
    // A folder only UniHub has sends nothing to a provider: no provider check.
    if (boxes.length) {
      try {
        await underFinalStep({ userId, policies: ['mail.provider_delete'], modules: ['mail'],
          unchanged: [...chosen.values()].map(entry => accountSnapshot('mail', entry.account)) }, async () => {
          for (const box of boxes) {
            const { account, connection } = chosen.get(box.mail_account_id)!;
            try {
              await runGuardedImap(connection as ProtocolConnection, () => connection!.mailboxDelete(box.remote_name));
            } catch (error) {
              if (!await alreadyGone(connection!, box.remote_name, error)) {
                log.warn('MAIL', 'The mail server did not delete a folder', undefined, error);
                failure = serverFailure(`Could not delete the folder on the mail server (${account.email_address}).`);
                return;
              }
            }
            removed.push(box);
          }
        }, pool);
      } catch (error) {
        // Refused, or failed, before any server deleted it: nothing changed.
        // Once one did, what the servers answered counts, whatever the
        // check's own end (its COMMIT) did.
        if (!removed.length) throw error;
        log.warn('MAIL', 'The final check of a folder deletion ended with an error after its DELETEs', undefined, error);
      }
    }
    // What the servers deleted is settled locally even when a later DELETE
    // failed; refused there (Mail turned off, a restore admitted since), it
    // is settled when the folder is deleted again (alreadyGone), and the
    // answer still says what went.
    // 409, so the answer reaches the client with what went (a 5xx would not).
    const partly = (error: ApiError, settled: boolean) => Object.assign(error, { status: 409, code: 'FOLDER_PARTLY_DELETED', details: {
      deleted_on: removed.map(box => chosen.get(box.mail_account_id)!.account.email_address),
      remaining_on: boxes.filter(box => !removed.includes(box)).map(box => chosen.get(box.mail_account_id)!.account.email_address),
      settled,
    } });
    let outcome: Awaited<ReturnType<typeof settle>> | null = null;
    try {
      if (removed.length) outcome = await settle({ userId, slug, folderId: folder.id, removed, whole: !failure }, pool);
    } catch (error) {
      if (!failure) throw partly(fail(409, 'The folder was deleted on the mail server, but UniHub could not update its copy yet. Delete it again to finish.'), false);
      log.warn('MAIL', 'Could not settle a partly deleted folder', undefined, error);
    }
    // Nothing deleted anywhere: the server's answer in UniHub's words, everything as it was.
    if (failure && !removed.length) throw failure;
    if (failure) throw partly(failure, Boolean(outcome));
    if (!outcome) outcome = await settle({ userId, slug, folderId: folder.id, removed, whole: true }, pool);
    return { slug, server: removed.map(box => ({ accountId: box.mail_account_id, remoteName: box.remote_name, emailAddress: chosen.get(box.mail_account_id)!.account.email_address })),
      deletedMessages: outcome.deleted, movedMessages: outcome.moved };
  } finally {
    for (const entry of chosen.values()) if (entry.connection) closeImapConnection(entry.connection as ProtocolConnection);
  }
}

// A deliberate 502: the mail server's failure in UniHub's words (the
// server's own text goes to the log), with nothing changed.
const serverFailure = (message: string): ApiError => Object.assign(new HttpError(502, 'MAIL_SERVER_ERROR', message), { expose: true });

// The local side of what the server deleted: the items of each deleted box
// settled, its link to the folder gone. `whole`: every server copy is gone,
// so the folder itself goes, and what else was filed in it returns to Inbox.
async function settle({ userId, slug, folderId, removed, whole }: { userId: string; slug: string; folderId: string; removed: readonly RemoteBox[]; whole: boolean }, pool: Options['pool'] & object) {
  const outcome = await withTransaction(async cx => {
    await cx.execute('SELECT id FROM mail_folders WHERE id = ? AND user_id = ? FOR UPDATE', [folderId, userId]);
    await assertFinalStep(cx, { userId, modules: ['mail'] });
    const attachmentPaths: string[] = [], rawPaths: string[] = [];
    let deleted = 0, moved = 0;
    for (const box of removed) {
      const result = await settleBox(cx, { userId, slug, box });
      deleted += result.deleted; moved += result.moved;
      attachmentPaths.push(...result.attachmentPaths);
      rawPaths.push(...result.rawPaths);
      if (!whole) await cx.execute('DELETE FROM mail_folder_remote_boxes WHERE folder_id = ? AND mail_account_id = ? AND BINARY remote_name = BINARY ?', [folderId, box.mail_account_id, box.remote_name]);
    }
    if (whole) {
      // Whatever else was filed here (a local folder, other accounts) goes back to Inbox.
      const [rest] = await cx.execute<ResultSetHeader>("UPDATE emails SET folder = 'inbox' WHERE user_id = ? AND folder = ?", [userId, slug]);
      await cx.execute("UPDATE mail_sender_rules SET target_folder = 'inbox' WHERE user_id = ? AND target_folder = ?", [userId, slug]);
      await cx.execute('DELETE o FROM mail_folder_rule_overrides o JOIN mail_sender_rules r ON r.id = o.rule_id WHERE r.user_id = ? AND o.target_folder = ?', [userId, slug]);
      await cx.execute('DELETE FROM mail_folders WHERE id = ? AND user_id = ?', [folderId, userId]);
      moved += rest.affectedRows;
    }
    return { deleted, moved, attachmentPaths, rawPaths };
  }, pool);
  await removeUnreferencedFiles({ userId, attachmentPaths: outcome.attachmentPaths, rawPaths: outcome.rawPaths });
  return outcome;
}

export { deleteMailFolder, SERVER_DELETE_VALUES };
