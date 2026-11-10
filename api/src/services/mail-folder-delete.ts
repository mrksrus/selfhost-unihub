import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { ApiError, SqlExecutor } from '../types';
import type { FolderCopyOutcome, FolderPartlyDeletedDetails, FolderServerCopy } from '../contracts/mail';
import { ApiError as HttpError, badRequest, conflict } from '../http/errors';
import type { ProtocolConnection, ProtocolError } from '../types/imap-protocol';

import { db } from '../state';
import * as imapClient from './mail-imap-client';
import { guardImapConnection, runGuardedImap, closeImapConnection } from './mail-imap-guard';
import { buildImapConnectionConfig } from './mail-host-policy';
import { mailboxGeneration, nonexistent } from './mail-engine/transport';
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
type FolderConnection = Pick<ProtocolConnection, 'mailboxDelete' | 'exec' | 'capabilities' | 'enabled'>;
/** A server copy of a folder and the generation UniHub knows of it (FolderServerCopy). */
interface RemoteBox { mail_account_id: string; remote_name: string; uidvalidity: string | null; mailbox_id: string | null }
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

// The server copies of a user's folders and their generations, as the folder
// listing shows them and as deleting a folder checks them: one query, so
// what the person saw and what the deletion compares are the same thing.
async function serverCopies(cx: Pick<SqlExecutor, 'execute'>, userId: string, folderId: string | null = null) {
  const [rows] = await cx.execute<(RowDataPacket & RemoteBox & { slug: string })[]>(`SELECT f.slug, b.mail_account_id, b.remote_name,
      m.uidvalidity, m.provider_mailbox_id AS mailbox_id
    FROM mail_folder_remote_boxes b
    JOIN mail_folders f ON f.id = b.folder_id AND f.user_id = ?
    JOIN mail_accounts a ON a.id = b.mail_account_id AND a.user_id = f.user_id
    LEFT JOIN mail_remote_mailboxes m ON m.user_id = f.user_id AND m.mail_account_id = b.mail_account_id AND BINARY m.remote_name = BINARY b.remote_name
    WHERE ${folderId === null ? 'TRUE' : 'f.id = ?'}`, folderId === null ? [userId] : [userId, folderId]);
  return rows.map(row => ({ slug: row.slug, mail_account_id: row.mail_account_id, remote_name: row.remote_name,
    uidvalidity: row.uidvalidity == null ? null : String(row.uidvalidity), mailbox_id: row.mailbox_id ?? null }));
}

/** `server_copies` of each folder in GET /api/mail/folders, by slug. */
async function folderServerCopies(userId: string, cx: Pick<SqlExecutor, 'execute'> = db) {
  const copies = new Map<string, FolderServerCopy[]>();
  for (const { slug, ...box } of await serverCopies(cx, userId)) {
    if (!copies.has(slug)) copies.set(slug, []);
    copies.get(slug)!.push(copyOf(box));
  }
  return copies;
}
const copyOf = (box: RemoteBox): FolderServerCopy => ({ account_id: box.mail_account_id, remote_name: box.remote_name, uidvalidity: box.uidvalidity, mailbox_id: box.mailbox_id });

// One generation of a mailbox name: UIDVALIDITY, and MAILBOXID where both
// sides know it (a server gains OBJECTID, UniHub learns the id at its next
// read). An unknown UIDVALIDITY matches nothing.
const sameGeneration = (known: { uidvalidity: string | null; mailbox_id: string | null }, now: { uidvalidity: string | null; mailbox_id: string | null }) =>
  known.uidvalidity !== null && known.uidvalidity === now.uidvalidity
  && (known.mailbox_id === null || now.mailbox_id === null || known.mailbox_id === now.mailbox_id);

// The request's copies, read strictly: what the folder listing gave.
function requestedCopies(value: unknown): FolderServerCopy[] {
  const text = (item: unknown, max: number) => typeof item === 'string' && item.length > 0 && item.length <= max;
  if (!Array.isArray(value) || value.length > 64 || !value.every(copy => copy && typeof copy === 'object'
    && text(copy.account_id, 64) && text(copy.remote_name, 255)
    && (copy.uidvalidity === null || typeof copy.uidvalidity === 'string' && /^[1-9][0-9]{0,9}$/.test(copy.uidvalidity))
    && (copy.mailbox_id === null || text(copy.mailbox_id, 255))))
    throw badRequest('INVALID_INPUT', 'The folder copies to delete are not valid.');
  return value.map(copy => ({ account_id: copy.account_id, remote_name: copy.remote_name, uidvalidity: copy.uidvalidity, mailbox_id: copy.mailbox_id }));
}

// A DELETE answered NO with wording that says the mailbox is missing, but
// without the NONEXISTENT code: no proof either way, so nothing is settled.
const MISSING_TEXT = /\b(mailbox|folder)\b[^.]*\b(does not exist|doesn't exist|not found)\b|\bno such (mailbox|folder)\b|\bunknown mailbox\b/i;
const missingWording = (error: unknown) => {
  const reply = error as ProtocolError & { responseText?: string };
  return reply?.responseStatus === 'NO' && MISSING_TEXT.test(String(reply.responseText || ''));
};

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
  const [[mailbox]] = await cx.execute<RowDataPacket[]>(`SELECT id, uidvalidity, provider_mailbox_id FROM mail_remote_mailboxes
    WHERE user_id = ? AND mail_account_id = ? AND BINARY remote_name = BINARY ? FOR UPDATE`, [userId, accountId, box.remote_name]);
  // Only the mailbox of the generation the server deleted: a folder created
  // again under the name and read by a sync since is another one, and stays.
  if (!mailbox || !sameGeneration(box, { uidvalidity: mailbox.uidvalidity == null ? null : String(mailbox.uidvalidity), mailbox_id: mailbox.provider_mailbox_id ?? null })) return null;
  // As after a folder listing without it: its copies stop counting as membership.
  await cx.execute(`UPDATE mail_remote_mailboxes SET state = 'missing', epoch_revision = epoch_revision + 1
    WHERE id = ? AND state = 'active'`, [mailbox.id]);
  const mailboxId = mailbox.id;
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
 * on the mail server can only go together with its server copies (`server`):
 * the server is the source of truth, so a folder removed in UniHub alone
 * would return with the next folder discovery.
 *
 * The request names the copies the person was shown (`copies`: each with the
 * generation the folder listing gave, UIDVALIDITY and, where the server has
 * OBJECTID, MAILBOXID). A copy UniHub has seen change since, or one added or
 * gone, answers 409 FOLDER_CHANGED before anything is sent. A request
 * without copies (a page loaded before 0.28.2) is refused with 400
 * FOLDER_COPIES_REQUIRED: a folder on the server is never deleted by its
 * name alone. Every account the folder is on is connected and checked first
 * (policy, Mail, restores, the account itself), so a refusal or an
 * unreachable server deletes nothing. Then, under one final check, STATUS
 * reads each copy's generation as the server holds it now; a copy created
 * again under the name answers FOLDER_CHANGED and nothing is sent anywhere.
 * Each copy is read once more right before its own DELETE.
 *
 * A copy counts as deleted only on the server's word: its DELETE answered
 * OK, or the NONEXISTENT response code to its STATUS (then no DELETE is
 * sent) or to its DELETE. Wording alone ("Mailbox does not exist" without
 * the code) proves nothing: that copy is reported as changed, and the
 * folder listing retires it once the server no longer lists it. The local
 * change follows for the deleted copies, in one transaction, and touches a
 * mailbox only while it still has the generation that was deleted.
 *
 * A server that fails after others succeeded stops the rest; the deleted
 * copies are settled and the answer is 409 FOLDER_PARTLY_DELETED with what
 * happened to each copy. Nothing is kept between attempts and UniHub sends
 * nothing again by itself: deleting the folder again starts from the
 * listing, and a copy already deleted answers NONEXISTENT to its STATUS.
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

interface DeleteRequest { userId: string; slug: string; server?: boolean; /** The request body's `copies` (FolderDeleteRequest), unchecked. */ copies?: unknown }

// Under the person's lock (person-lock.ts), from the first read to the local settlement.
async function deleteMailFolder(request: DeleteRequest, options: Options = {}) {
  return withPersonLock(request.userId, () => deleteNow(request, options));
}

const changed = (addresses: string[]) => conflict('FOLDER_CHANGED',
  `The folder changed on the mail server${addresses.length ? ` (${addresses.join(', ')})` : ''} since it was shown. Nothing was deleted there. Refresh the folders and try again.`, { changed_on: addresses });

async function deleteNow({ userId, slug, server = false, copies }: DeleteRequest, { pool = db, connect = connectToAccount }: Options) {
  const [folders] = await pool.execute<RowDataPacket[]>('SELECT * FROM mail_folders WHERE user_id = ? AND slug = ? LIMIT 1', [userId, slug]);
  const folder = folders[0];
  if (!folder) throw fail(404, 'Folder not found');
  if (folder.is_system || SYSTEM_MAIL_FOLDER_SET.has(slug)) throw fail(400, 'System folders cannot be deleted');
  const boxes: RemoteBox[] = (await serverCopies(pool, userId, folder.id)).map(({ slug: _slug, ...box }) => box);
  if (boxes.length && !server) throw fail(409, 'This folder is on the mail server. Delete it there as well, or keep it.');
  if (boxes.length && copies === undefined) throw badRequest('FOLDER_COPIES_REQUIRED', 'This page is older than the server. Reload UniHub, then delete the folder again.');
  const shown = copies === undefined ? [] : requestedCopies(copies);
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
      chosen.set(box.mail_account_id, { account, connection: null });
    }
    const addressOf = (box: RemoteBox) => chosen.get(box.mail_account_id)!.account.email_address;
    // Exactly the copies shown, each still of the generation shown, as far as UniHub knows.
    const unread = boxes.filter(box => box.uidvalidity === null);
    if (unread.length) throw conflict('FOLDER_CHANGED', `UniHub has not read this folder on the mail server (${unread.map(addressOf).join(', ')}) yet. Sync the account, then try again.`,
      { changed_on: unread.map(addressOf) });
    const stale = boxes.filter(box => {
      const copy = shown.find(item => item.account_id === box.mail_account_id && item.remote_name === box.remote_name);
      return !copy || !sameGeneration(copy, box);
    });
    if (stale.length || shown.length !== boxes.length) throw changed(stale.map(addressOf));
    for (const entry of chosen.values()) {
      await yieldMailReadWork(entry.account.id);
      try {
        entry.connection = await connect(entry.account);
      } catch (error) {
        log.warn('MAIL', 'Could not connect to delete a folder', undefined, error);
        throw serverFailure(`Could not connect to the mail server (${entry.account.email_address}). Nothing was changed.`);
      }
    }

    // What became of each copy, for the answer.
    const outcomes = new Map<RemoteBox, FolderCopyOutcome['outcome']>(boxes.map(box => [box, 'not_tried']));
    // What each copy is now at its server: the generation shown, another
    // one (created again under the name), or gone (NONEXISTENT).
    const generationNow = async (box: RemoteBox) => {
      const now = await mailboxGeneration(chosen.get(box.mail_account_id)!.connection as ProtocolConnection, box.remote_name);
      return now === null ? 'gone' : sameGeneration(box, { uidvalidity: now.uidvalidity, mailbox_id: now.mailboxId }) ? 'same' : 'changed';
    };
    // A STATUS or DELETE the server failed. "Does not exist" without the
    // NONEXISTENT code is no proof the copy went: refresh and try again.
    const failed = (box: RemoteBox, error: unknown, doing: string) => {
      log.warn('MAIL', `The mail server did not ${doing} a folder`, undefined, error);
      if (missingWording(error)) {
        outcomes.set(box, 'changed');
        return conflict('FOLDER_CHANGED', `The mail server (${addressOf(box)}) answered that this folder does not exist, but without confirming it, so nothing was deleted there. `
          + 'Sync the account, then refresh the folders and try again. If the folder is gone at the provider, its mail leaves the folder at that sync.', { changed_on: [addressOf(box)] });
      }
      outcomes.set(box, 'failed');
      return serverFailure(`Could not ${doing} the folder on the mail server (${addressOf(box)}).`);
    };

    // The provider's commands under one final check (final-step.ts): the
    // policy, Mail on and not being restored, and every account still as
    // read above (account-identity.ts), held until the last one answered.
    // A refusal deletes nothing. A server that fails stops the rest; the
    // copies already deleted are settled below, never sent again by UniHub
    // itself.
    const removed: RemoteBox[] = [];
    let failure: ApiError | null = null;
    // A folder only UniHub has sends nothing to a provider: no provider check.
    if (boxes.length) {
      try {
        await underFinalStep({ userId, policies: ['mail.provider_delete'], modules: ['mail'],
          unchanged: [...chosen.values()].map(entry => accountSnapshot('mail', entry.account)) }, async () => {
          // Every copy first: one created again anywhere deletes nothing anywhere.
          for (const box of boxes) {
            let state: string;
            try { state = await generationNow(box); } catch (error) { failure = failed(box, error, 'check'); return; }
            if (state === 'changed') outcomes.set(box, 'changed');
          }
          const replaced = boxes.filter(box => outcomes.get(box) === 'changed');
          if (replaced.length) { failure = changed(replaced.map(addressOf)); return; }
          for (const box of boxes) {
            const { connection } = chosen.get(box.mail_account_id)!;
            let state: string;
            try { state = await generationNow(box); } catch (error) { failure = failed(box, error, 'check'); return; }
            if (state === 'changed') { outcomes.set(box, 'changed'); failure = changed([addressOf(box)]); return; }
            if (state === 'same') {
              try {
                await runGuardedImap(connection as ProtocolConnection, () => connection!.mailboxDelete(box.remote_name));
              } catch (error) {
                if (!nonexistent(error)) { failure = failed(box, error, 'delete'); return; }
              }
            }
            removed.push(box);
            outcomes.set(box, 'deleted');
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
    // Nothing deleted anywhere: the server's answer in UniHub's words, everything as it was.
    if (failure && !removed.length) throw failure;
    // What the servers deleted is settled locally even when a later one
    // failed; refused there (Mail turned off, a restore admitted since), the
    // next attempt finds those copies gone (NONEXISTENT) and settles them.
    // 409, so the answer reaches the client with what went (a 5xx would not).
    const partly = (error: ApiError, settled: boolean) => Object.assign(error, { status: 409, code: 'FOLDER_PARTLY_DELETED', details: {
      deleted_on: boxes.filter(box => outcomes.get(box) === 'deleted').map(addressOf),
      remaining_on: boxes.filter(box => outcomes.get(box) !== 'deleted').map(addressOf),
      settled,
      copies: boxes.map(box => ({ account_id: box.mail_account_id, email_address: addressOf(box), outcome: outcomes.get(box)! })),
    } satisfies FolderPartlyDeletedDetails });
    let outcome: Awaited<ReturnType<typeof settle>>;
    try {
      outcome = await settle({ userId, slug, folderId: folder.id, removed, all: removed.length === boxes.length }, pool);
    } catch (error) {
      if (!failure) throw partly(fail(409, 'The folder was deleted on the mail server, but UniHub could not update its copy yet. Delete it again to finish.'), false);
      log.warn('MAIL', 'Could not settle a partly deleted folder', undefined, error);
      throw partly(failure, false);
    }
    // Deleted at the server, but a sync has read a folder created again
    // under the name since: that one stays, linked to the folder.
    for (const box of outcome.replaced) outcomes.set(box, 'changed');
    if (!failure && outcome.replaced.length) failure = changed(outcome.replaced.map(addressOf));
    if (failure) {
      if (!boxes.some(box => outcomes.get(box) === 'deleted')) throw failure;
      throw partly(failure, true);
    }
    return { slug, server: removed.map(box => ({ accountId: box.mail_account_id, remoteName: box.remote_name, emailAddress: addressOf(box) })),
      deletedMessages: outcome.deleted, movedMessages: outcome.moved };
  } finally {
    for (const entry of chosen.values()) if (entry.connection) closeImapConnection(entry.connection as ProtocolConnection);
  }
}

// A deliberate 502: the mail server's failure in UniHub's words (the
// server's own text goes to the log), with nothing changed.
const serverFailure = (message: string): ApiError => Object.assign(new HttpError(502, 'MAIL_SERVER_ERROR', message), { expose: true });

// The local side of what the server deleted: the items of each deleted box
// settled, its link to the folder gone. `all`: every server copy is gone,
// so unless one was replaced meanwhile the folder itself goes, and what
// else was filed in it returns to Inbox.
async function settle({ userId, slug, folderId, removed, all }: { userId: string; slug: string; folderId: string; removed: readonly RemoteBox[]; all: boolean }, pool: Options['pool'] & object) {
  const outcome = await withTransaction(async cx => {
    await cx.execute('SELECT id FROM mail_folders WHERE id = ? AND user_id = ? FOR UPDATE', [folderId, userId]);
    await assertFinalStep(cx, { userId, modules: ['mail'] });
    const attachmentPaths: string[] = [], rawPaths: string[] = [], replaced: RemoteBox[] = [], settled: RemoteBox[] = [];
    let deleted = 0, moved = 0;
    for (const box of removed) {
      const result = await settleBox(cx, { userId, slug, box });
      if (!result) { replaced.push(box); continue; }
      settled.push(box);
      deleted += result.deleted; moved += result.moved;
      attachmentPaths.push(...result.attachmentPaths);
      rawPaths.push(...result.rawPaths);
    }
    const whole = all && !replaced.length;
    if (!whole) for (const box of settled)
      await cx.execute('DELETE FROM mail_folder_remote_boxes WHERE folder_id = ? AND mail_account_id = ? AND BINARY remote_name = BINARY ?', [folderId, box.mail_account_id, box.remote_name]);
    if (whole) {
      // Whatever else was filed here (a local folder, other accounts) goes back to Inbox.
      const [rest] = await cx.execute<ResultSetHeader>("UPDATE emails SET folder = 'inbox' WHERE user_id = ? AND folder = ?", [userId, slug]);
      await cx.execute("UPDATE mail_sender_rules SET target_folder = 'inbox' WHERE user_id = ? AND target_folder = ?", [userId, slug]);
      await cx.execute('DELETE o FROM mail_folder_rule_overrides o JOIN mail_sender_rules r ON r.id = o.rule_id WHERE r.user_id = ? AND o.target_folder = ?', [userId, slug]);
      await cx.execute('DELETE FROM mail_folders WHERE id = ? AND user_id = ?', [folderId, userId]);
      moved += rest.affectedRows;
    }
    return { deleted, moved, attachmentPaths, rawPaths, replaced };
  }, pool);
  await removeUnreferencedFiles({ userId, attachmentPaths: outcome.attachmentPaths, rawPaths: outcome.rawPaths });
  return outcome;
}

export { deleteMailFolder, folderServerCopies, SERVER_DELETE_VALUES };
