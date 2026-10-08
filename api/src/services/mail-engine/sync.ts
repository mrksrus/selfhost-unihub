import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../../types';
import type { ClaimedJob, MailCursor, RemoteMailbox } from '../../types/mail-engine';
import type { ProtocolConnection, CopyUidMapping } from '../../types/imap-protocol';
import crypto from 'node:crypto';
import * as repository from './repository';
import * as runtime from './runtime';
import * as transport from './transport';
import { uint32, DEFAULT_MAX_BYTES } from './content';
import { outsideWindow } from '../mail-sync-policy';

type Selection = Awaited<ReturnType<typeof transport.selectMailbox>>;
type WindowReply = Awaited<ReturnType<typeof transport.fetchMetadataWindow>>;
type Item = WindowReply['items'][number];
interface Account {
  id: string;
  user_id: string;
  sync_mode?: string;
  sync_window_days?: number | null;
  trash_window_days?: number | null;
}
interface Folder { folderName: string; dbFolderName: string; delimiter?: string; specialUse?: string | null }
interface Window { start: number; end: number }
interface Identity { userId: string; accountId: string; mailboxId: string; epoch: number }
interface MappedOperation extends RowDataPacket { remote_uid: number | string; }
interface Mapping { operationId: string; emailId: string; mapping: CopyUidMapping }
interface Revision extends RowDataPacket {
  uid: number;
  observation_revision: number;
  email_revision: number;
  observed_modseq: string | null;
}
interface CommitInput {
  db: Pick<Pool, 'getConnection' | 'execute' | 'query'>;
  account: Account;
  folder: Folder;
  mailbox: RemoteMailbox;
  stream: string;
  epoch: number;
  upper: number;
  window: Window;
  items: Item[];
  snapshot: Map<number, Revision>;
  gmail: boolean;
  job: ClaimedJob | null;
  sweepGeneration?: number;
  saveCoverage?: boolean;
}
interface ScanInput {
  db: Pick<Pool, 'getConnection' | 'execute' | 'query'>;
  connection: ProtocolConnection;
  account: Account;
  folder: Folder;
  stream?: string;
  signal?: AbortSignal;
  job?: ClaimedJob | null;
  maxWindow?: number;
  targetUid?: number | null;
  expectedEpoch?: number | null;
  manualRefresh?: boolean;
  report?: (progress: { phase: string; processed: number; total: null; coverage?: Record<string, unknown> }) => unknown;
}

const WINDOW = 128; // UID-span, not offset or message count; one fetch has <=128 items.
const STREAMS = ['recent', 'flags', 'history', 'presence'];
const SWEEP_THROTTLE_MINUTES = 15;
// Downloading a discovered message is what makes it readable, so bodies run
// right after INBOX arrivals ('recent', 10) and ahead of the anti-entropy
// flags/presence sweeps and older history. Those still interleave through the
// claim query's ageing; at the old priority 90, a Gmail account whose sweeps
// never finish left new messages without content for hours.
const BODY_PRIORITY = 15;
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('Mail sync cancelled; committed slices remain available'), { code: 'MAIL_SYNC_CANCELLED' });
}
function modseqOlder(incoming: unknown, stored: unknown) {
  return incoming != null && stored != null && BigInt(String(incoming)) < BigInt(String(stored));
}
function gmailCapable(selected: Selection, connection: ProtocolConnection) {
  // A hostname, banner or user preference is not Gmail identity evidence.
  const caps = selected.capabilities || {};
  return ('gmail' in caps && caps.gmail === true) || caps.xGmExt1 === true ||
    (Array.isArray(caps) && caps.includes('X-GM-EXT-1')) ||
    (connection?.capabilities instanceof Map && connection.capabilities.has('X-GM-EXT-1'));
}
function upperBoundary(selected: Selection) {
  if (selected.uidnext === null) throw new Error('Cannot establish a finite mailbox UID boundary');
  const next = uint32(selected.uidnext);
  if (!next) throw new Error('Invalid UIDNEXT');
  return next - 1;
}
function windowFor(stream: string, cursor: MailCursor | null | undefined, upper: number, width = WINDOW) {
  if (upper === 0) return null;
  const covered = Number(cursor?.covered_through || 0);
  if (stream === 'recent') {
    const start = cursor ? covered + 1 : Math.max(1, upper - width + 1);
    return start <= upper ? { start, end: Math.min(start + width - 1, upper) } : null;
  }
  // The older history and anti-entropy sweeps use independent finite windows.
  // Repeated invocations advance their own cursor even while new UIDs arrive.
  const start = covered + 1;
  return start <= upper ? { start, end: Math.min(start + width - 1, upper) } : null;
}
function validateWindowReply(reply: WindowReply, window: Window, epoch: number) {
  if (!reply || reply.complete !== true || uint32(reply.uidvalidity) !== epoch ||
      reply.startUid !== window.start || reply.endUid !== window.end || !Array.isArray(reply.items)) {
    throw new Error('Incomplete or mismatched UID window; cursor retained');
  }
  const seen = new Set();
  for (const item of reply.items) {
    if (!uint32(item.uid) || item.uid < window.start || item.uid > window.end || seen.has(item.uid) || !Array.isArray(item.flags)) {
      throw new Error('Malformed UID descriptor window; cursor retained');
    }
    seen.add(item.uid);
  }
  return reply.items;
}

async function snapshotRevisions(db: SqlExecutor, { userId, accountId, mailboxId, epoch, start, end }: Identity & Window) {
  const [rows] = await db.execute<Revision[]>(`SELECT o.uid, o.observation_revision, e.observation_revision AS email_revision,
      o.observed_modseq FROM mail_remote_occurrences o JOIN emails e ON e.id = o.email_id AND e.user_id = o.user_id
    WHERE o.user_id = ? AND o.mail_account_id = ? AND o.mailbox_id = ? AND o.uidvalidity = ?
      AND o.uid BETWEEN ? AND ?`, [userId, accountId, mailboxId, epoch, start, end]);
  return new Map(rows.map(row => [Number(row.uid), row]));
}

// Only a provider's validated one-to-one COPYUID, durably recorded on the
// exact accepted operation, can bind an as-yet-unseen generic destination to
// its source item. A Message-ID, raw hash, or source absence cannot do this.
async function mappedMoveFor(executor: SqlExecutor, { userId, accountId, folderName, mailboxId, epoch, uid }: Identity & { folderName: string; uid: number }): Promise<Mapping | null> {
  const [rows] = await executor.execute<MappedOperation[]>(`SELECT w.id, w.email_id, w.remote_uid, w.remote_uidvalidity,
      w.evidence_json, s.id AS source_occurrence_id
    FROM mail_writebacks w JOIN mail_remote_occurrences s ON s.id = w.source_occurrence_id
      AND s.user_id = w.user_id AND s.mail_account_id = w.mail_account_id AND s.email_id = w.email_id
      AND s.uidvalidity = w.remote_uidvalidity AND s.uid = w.remote_uid
      AND s.presence IN ('present','absent')
    JOIN mail_remote_mailboxes m ON m.id = s.mailbox_id AND m.user_id = w.user_id
      AND m.mail_account_id = w.mail_account_id AND BINARY m.remote_name = BINARY w.remote_folder
      AND m.uidvalidity = s.uidvalidity AND m.state = 'active'
    WHERE w.user_id = ? AND w.mail_account_id = ? AND BINARY w.target_value = BINARY ?
      AND w.action = 'move' AND w.dispatched = TRUE
      AND w.state IN ('executing','verifying','reconciling','needs_attention')
      AND JSON_EXTRACT(w.evidence_json,'$.mapping.destinationUids[0]') = ?
    LIMIT 2 FOR UPDATE`, [userId, accountId, folderName, uid]);
  if (rows.length !== 1) return null;
  const op = rows[0];
  let proof;
  try { proof = typeof op.evidence_json === 'string' ? JSON.parse(op.evidence_json) : op.evidence_json; }
  catch { return null; }
  const mapping = proof?.mapping;
  const { validMapping }: typeof import('./reconciliation') = require('./reconciliation');
  if (proof?.kind !== 'move_outcome' || proof.completion !== 'ok' || proof.mappingStatus !== 'valid' ||
    !validMapping(mapping, op, { uidvalidity: epoch, uid }) || !mailboxId) return null;
  return { operationId: op.id, emailId: op.email_id, mapping };
}

async function ensureItem(executor: SqlExecutor, { userId, accountId, mailboxId, folder, epoch, item, gmail, mapped = null }: Identity & { folder: Folder; item: Item; gmail: boolean; mapped?: Mapping | null }) {
  const [known] = await executor.execute<RowDataPacket[]>(`SELECT o.email_id FROM mail_remote_occurrences o
    WHERE o.user_id = ? AND o.mail_account_id = ? AND o.mailbox_id = ? AND o.uidvalidity = ? AND o.uid = ? LIMIT 1`,
  [userId, accountId, mailboxId, epoch, item.uid]);
  if (known.length) return known[0].email_id;
  if (gmail && item.gmailMsgId && /^[0-9]+$/.test(String(item.gmailMsgId))) {
    const [mapped] = await executor.execute<RowDataPacket[]>('SELECT email_id FROM mail_gmail_messages WHERE mail_account_id = ? AND user_id = ? AND gmail_msgid = ? LIMIT 1', [accountId, userId, String(item.gmailMsgId)]);
    if (mapped.length) return mapped[0].email_id;
  }
  if (mapped) {
    if (gmail && item.gmailMsgId && /^[0-9]+$/.test(String(item.gmailMsgId))) {
      await executor.execute<RowDataPacket[]>(`INSERT INTO mail_gmail_messages (mail_account_id,gmail_msgid,user_id,email_id)
        VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE email_id = email_id`,
      [accountId, String(item.gmailMsgId), userId, mapped.emailId]);
      const [[bound]] = await executor.execute<RowDataPacket[]>(`SELECT email_id FROM mail_gmail_messages
        WHERE mail_account_id = ? AND user_id = ? AND gmail_msgid = ? LIMIT 1`,
      [accountId, userId, String(item.gmailMsgId)]);
      if (bound?.email_id !== mapped.emailId) return bound.email_id;
    }
    return mapped.emailId;
  }
  const id = crypto.randomUUID();
  await executor.execute<RowDataPacket[]>(`INSERT INTO emails (id,user_id,mail_account_id,message_id,subject,from_address,to_addresses,folder,
    source_folder,imap_uid,imap_uidvalidity,remote_folder,remote_uid,remote_uidvalidity,
    is_read,is_starred,import_complete,content_state)
    VALUES (?,?,?,NULL,'(Loading message)','unknown','[]',?,?,?,?,?,?,?,?,?,FALSE,'queued')`,
  [id, userId, accountId, folder.dbFolderName || 'inbox', folder.folderName, item.uid, epoch,
    folder.folderName, item.uid, epoch,
    item.flags.includes('\\Seen') ? 1 : 0, item.flags.includes('\\Flagged') ? 1 : 0]);
  if (gmail && item.gmailMsgId && /^[0-9]+$/.test(String(item.gmailMsgId))) {
    // A concurrently discovered Gmail label may have won the account-scoped
    // identity. Resolve under the unique key without ever merging generic copies.
    await executor.execute<RowDataPacket[]>(`INSERT INTO mail_gmail_messages (mail_account_id,gmail_msgid,user_id,email_id)
      VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE email_id = email_id`, [accountId, String(item.gmailMsgId), userId, id]);
    const [mapped] = await executor.execute<RowDataPacket[]>('SELECT email_id FROM mail_gmail_messages WHERE mail_account_id = ? AND user_id = ? AND gmail_msgid = ? LIMIT 1', [accountId, userId, String(item.gmailMsgId)]);
    if (mapped[0].email_id !== id) {
      await executor.execute<RowDataPacket[]>('DELETE FROM emails WHERE id = ? AND user_id = ? AND mail_account_id = ?', [id, userId, accountId]);
      return mapped[0].email_id;
    }
  }
  return id;
}

async function commitWindow({ db, account, folder, mailbox, stream, epoch, upper, window, items, snapshot, gmail, job, sweepGeneration = 0, saveCoverage = true }: CommitInput) {
  const userId = account.user_id, accountId = account.id;
  return repository.withTransaction(async executor => {
    if (job) await runtime.assertFence({ accountId, jobId: job.id, workerId: job.lease_owner, generation: job.worker_generation }, executor);
    // A reset in another worker invalidates the selection before any cursor write.
    const [epochs] = await executor.execute<RowDataPacket[]>('SELECT uidvalidity FROM mail_remote_mailboxes WHERE id = ? AND user_id = ? AND mail_account_id = ? FOR UPDATE', [mailbox.id, userId, accountId]);
    if (!epochs.length || uint32(epochs[0].uidvalidity) !== epoch) throw new Error('Mailbox epoch changed; window not committed');
    let inserted = 0, updated = 0, skipped = 0;
    for (const item of items) {
      const started = snapshot.get(item.uid);
      const current = await repository.getOccurrence({ userId, accountId, mailboxId: mailbox.id, epoch, uid: item.uid }, executor);
      if (current && (String(current.observation_revision) !== String(started?.observation_revision) || modseqOlder(item.modseq, current.observed_modseq))) continue;
      const mapped = await mappedMoveFor(executor, { userId, accountId, folderName: folder.folderName,
        mailboxId: mailbox.id, epoch, uid: item.uid });
      // Sync retention: a message older than this mailbox's window is not
      // imported (it stays on the server). Known items, a mapped MOVE
      // destination and a further Gmail label of a known message still count.
      if (!current && !mapped && outsideWindow(account, mailbox, item.internalDate)
        && !await knownGmailMessage(executor, { userId, accountId, gmail, item })) { skipped++; continue; }
      const emailId = current?.email_id || await ensureItem(executor, { userId, accountId, mailboxId: mailbox.id, folder, epoch, item, gmail, mapped });
      const revision = Number(current?.observation_revision || 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new RangeError('Observation revision exhausted');
      const occurrence = await repository.upsertOccurrence({ userId, accountId, mailboxId: mailbox.id, epoch,
        uid: item.uid, emailId, flags: item.flags, modseq: item.modseq || null,
        gmailMsgId: gmail ? item.gmailMsgId || null : null, observationRevision: revision,
        internalDate: item.internalDate || null }, executor);
      if (!current) inserted++; else updated++;
      // A fetch that started before a confirmed mutation cannot repaint it.
      // The occurrence repository also protects MODSEQ and its own revision.
      if (!current || String(occurrence?.observation_revision) === String(revision)) {
        await executor.execute<RowDataPacket[]>(`UPDATE emails SET remote_missing = FALSE
          WHERE id = ? AND user_id = ? AND mail_account_id = ?`, [emailId, userId, accountId]);
        await executor.execute<RowDataPacket[]>(`UPDATE emails SET is_read = ?, is_starred = ?, observed_modseq = ?,
          observation_revision = observation_revision + 1, remote_missing = FALSE
          WHERE id = ? AND user_id = ? AND mail_account_id = ? AND observation_revision = ?`,
        [item.flags.includes('\\Seen') ? 1 : 0, item.flags.includes('\\Flagged') ? 1 : 0,
          item.modseq || null, emailId, userId, accountId, String(started?.email_revision || 0)]);
      }
      // Only the validated provider COPYUID stored on an exact dispatched
      // operation supplies enough correlation for shared MOVE settlement.
      // A pre-existing independent tuple cannot be stolen by this operation.
      if (mapped && mapped.emailId === emailId && occurrence!.email_id === emailId) {
        await (require('./reconciliation') as typeof import('./reconciliation')).reconcileObservedOccurrence({ executor, userId, accountId, emailId,
          mailboxId: mailbox.id, epoch, uid: item.uid, sourceAbsent: false,
          evidence: { folder: folder.folderName, verified: true, mapping: mapped.mapping } });
      }
    }
    if (inserted > 0) await runtime.enqueueJob({ userId, accountId, mailboxId: mailbox.id,
      kind: 'body', priority: BODY_PRIORITY }, executor);
    if (stream === 'presence') {
      // Never mark a newer concurrent observation absent using an older fetch.
      const [currentRows] = await executor.execute<RowDataPacket[]>(`SELECT uid, observation_revision FROM mail_remote_occurrences
        WHERE user_id = ? AND mail_account_id = ? AND mailbox_id = ? AND uidvalidity = ?
          AND uid BETWEEN ? AND ? AND presence = 'present' FOR UPDATE`,
      [userId, accountId, mailbox.id, epoch, window.start, window.end]);
      const protectedUids = currentRows.filter(row => !snapshot.has(Number(row.uid)) ||
        String(snapshot.get(Number(row.uid))!.observation_revision) !== String(row.observation_revision)).map(row => Number(row.uid));
      const absent = await repository.markAbsentInWindow({ userId, accountId, mailboxId: mailbox.id, epoch,
        windowStart: window.start, windowEnd: window.end,
        presentUids: [...new Set([...items.map(i => i.uid), ...protectedUids])], complete: true }, executor);
      // Sync: the server is the source of truth. The prune job removes items
      // without any remaining occurrence (only after the account's policy
      // confirmation) or, on Gmail without a visible All Mail, files them as
      // archived. Download mode never sweeps presence.
      if (absent > 0 && account.sync_mode === 'sync')
        await (require('../mail-sync-policy') as typeof import('../mail-sync-policy')).enqueuePrune({ userId, accountId }, executor);
      // Only this confirmed same-epoch absence may mark an item missing.
      // Gmail's other active labels (All Mail included) keep it present;
      // old/quarantined epochs and partial windows can never prove absence.
      await executor.execute<RowDataPacket[]>(`UPDATE emails e SET e.remote_missing = NOT EXISTS (
          SELECT 1 FROM mail_remote_occurrences live
          JOIN mail_remote_mailboxes active_box ON active_box.id = live.mailbox_id
            AND active_box.user_id = live.user_id AND active_box.mail_account_id = live.mail_account_id
            AND active_box.state = 'active' AND active_box.uidvalidity = live.uidvalidity
          WHERE live.email_id = e.id AND live.user_id = e.user_id
            AND live.mail_account_id = e.mail_account_id AND live.presence = 'present'
        ) WHERE e.user_id = ? AND e.mail_account_id = ? AND e.id IN (
          SELECT gone.email_id FROM mail_remote_occurrences gone
          WHERE gone.user_id = ? AND gone.mail_account_id = ? AND gone.mailbox_id = ?
            AND gone.uidvalidity = ? AND gone.uid BETWEEN ? AND ? AND gone.presence = 'absent'
        )`, [userId, accountId, userId, accountId, mailbox.id, epoch, window.start, window.end]);
    }
    if (saveCoverage) await repository.saveCursor({ userId, accountId, mailboxId: mailbox.id, stream, epoch,
      windowStart: window.start, windowEnd: window.end, coveredThrough: window.end,
      sweepGeneration, coverage: { bounded: true, observed: items.length, upper }, complete: true }, executor);
    return { inserted, updated, skipped };
  }, db);
}
async function knownGmailMessage(executor: SqlExecutor, { userId, accountId, gmail, item }: { userId: string; accountId: string; gmail: boolean; item: Item }) {
  if (!gmail || !item.gmailMsgId || !/^[0-9]+$/.test(String(item.gmailMsgId))) return false;
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT email_id FROM mail_gmail_messages WHERE mail_account_id = ? AND user_id = ? AND gmail_msgid = ? LIMIT 1',
    [accountId, userId, String(item.gmailMsgId)]);
  return rows.length > 0;
}

async function scanMailboxSlice({ db, connection, account, folder, stream = 'recent', signal, job = null,
  maxWindow = WINDOW, targetUid = null, expectedEpoch = null, manualRefresh = false, report = () => {} }: ScanInput) {
  if (!STREAMS.includes(stream)) throw new Error('Invalid mail stream');
  if (manualRefresh && (!['flags', 'presence'].includes(stream) || targetUid !== null || !job))
    throw new Error('Manual refresh requires a fenced flags or presence sweep');
  if (targetUid !== null && (!uint32(targetUid) || !job)) throw new Error('Targeted observation requires a fenced job and UID');
  cancelled(signal);
  const selected = await transport.selectMailbox(connection, { folder: folder.folderName, readOnly: true, signal });
  const epoch = uint32(selected.uidvalidity), remoteUpper = upperBoundary(selected);
  if (!epoch) throw new Error('Invalid selected mailbox epoch');
  if (expectedEpoch !== null && epoch !== uint32(expectedEpoch))
    throw Object.assign(new Error('Reconciliation mailbox epoch changed'), { code: 'MAIL_EPOCH_STALE' });
  const mailbox = await repository.withTransaction(async executor => {
    if (job) await runtime.assertFence({ accountId: account.id, jobId: job.id,
      workerId: job.lease_owner, generation: Number(job.worker_generation) }, executor);
    return repository.ensureMailbox({
      userId: account.user_id, accountId: account.id, folderName: folder.folderName, epoch,
      metadata: { localFolderSlug: folder.dbFolderName, delimiter: folder.delimiter || '/',
        specialUse: folder.specialUse || null } }, executor);
  }, db);
  if (targetUid !== null && targetUid > remoteUpper) return { stream, mailboxId: mailbox.id,
    processed: 0, inserted: 0, covered: false, more: false, upper: remoteUpper, currentUpper: remoteUpper };
  let cursor = targetUid === null ? await repository.loadCursor({ userId: account.user_id,
    accountId: account.id, mailboxId: mailbox.id, stream, epoch }, db) : null;
  const initialCoverage = typeof cursor?.coverage_json === 'string'
    ? JSON.parse(cursor.coverage_json) : cursor?.coverage_json;
  const priorUpper = uint32(initialCoverage?.upper) || remoteUpper;
  let refreshPending = manualRefresh && cursor !== null;
  if (cursor && ['flags', 'presence'].includes(stream) && Number(cursor.covered_through) >= priorUpper && priorUpper > 0) {
    await repository.withTransaction(async executor => {
      if (job) await runtime.assertFence({ accountId: account.id, jobId: job.id, workerId: job.lease_owner,
        generation: job.worker_generation }, executor);
      const [reset] = await executor.execute<ResultSetHeader>(`UPDATE mail_engine_cursors SET covered_through = 0, sweep_generation = sweep_generation + 1
        WHERE mailbox_id = ? AND stream = ? AND user_id = ? AND mail_account_id = ? AND uidvalidity = ?
          AND covered_through >= ?${manualRefresh ? '' : ` AND last_covered_at < UTC_TIMESTAMP() - INTERVAL ${SWEEP_THROTTLE_MINUTES} MINUTE`}`,
      [mailbox.id, stream, account.user_id, account.id, epoch, priorUpper]);
      if (manualRefresh && reset.affectedRows !== 1) throw new Error('Manual sweep cursor changed; retry without losing refresh intent');
      if (manualRefresh) refreshPending = false;
    }, db);
    cursor = await repository.loadCursor({ userId: account.user_id, accountId: account.id, mailboxId: mailbox.id, stream, epoch }, db);
  }
  const covered = Number(cursor?.covered_through || 0);
  const storedCoverage = typeof cursor?.coverage_json === 'string'
    ? JSON.parse(cursor.coverage_json) : cursor?.coverage_json;
  // A history/sweep pass has a finite captured upper boundary. Arrivals are
  // handled by recent, not by indefinitely extending the current older pass.
  const pinned = uint32(storedCoverage?.upper);
  const upper = stream !== 'recent' && pinned && covered < pinned ? Math.min(pinned, remoteUpper) : remoteUpper;
  const window = targetUid === null
    ? windowFor(stream, cursor, upper, Math.min(WINDOW, Math.max(1, maxWindow)))
    : { start: targetUid, end: targetUid };
  if (!window) return { stream, mailboxId: mailbox.id, processed: 0, inserted: 0,
    covered: false, more: false, upper, currentUpper: remoteUpper };
  const snapshot = await snapshotRevisions(db, { userId: account.user_id, accountId: account.id,
    mailboxId: mailbox.id, epoch, start: window.start, end: window.end });
  const reply = await transport.fetchMetadataWindow(connection, { folder: folder.folderName, uidvalidity: epoch,
    startUid: window.start, endUid: window.end, maxMessages: maxWindow, maxBytes: 1024 * 1024 }, { signal });
  cancelled(signal);
  const items = validateWindowReply(reply, window, epoch);
  const result = await commitWindow({ db, account, folder, mailbox, stream, epoch, upper, window, items, snapshot,
    gmail: gmailCapable(selected, connection), job, sweepGeneration: Number(cursor?.sweep_generation || 0),
    saveCoverage: targetUid === null });
  await report({ phase: targetUid === null ? stream : 'reconcile', processed: items.length, total: null,
    coverage: targetUid === null ? { [stream]: { mailboxId: mailbox.id, epoch, through: window.end, upper } } : undefined });
  return { stream, mailboxId: mailbox.id, epoch, processed: items.length,
    ...result, covered: true, through: window.end, upper, currentUpper: remoteUpper,
    // An unfinished sweep retains its checkpoint; once it reaches its pinned
    // boundary, one successor consumes the manual request by starting at UID 1.
    refreshPending, more: targetUid === null && (window.end < upper || refreshPending) };
}

// Folder discovery calls this for every mailbox still holding messages without
// content. A body chain only continues on success, so an error or a cancelled
// sync left its mailbox without a body job until new mail arrived there. Queued
// body jobs from before BODY_PRIORITY keep their old priority on continuation,
// so they are promoted here as well; enqueueJob returns an active job as is.
// A manual sync also queues again the messages set aside as 'slow' after their
// download did not finish within the deadline.
async function enqueuePendingBodies({ userId, accountId, retrySlow = false }: { userId: string; accountId: string; retrySlow?: boolean }, executor: SqlExecutor) {
  if (retrySlow) await executor.execute<RowDataPacket[]>(`UPDATE emails SET content_state = 'queued'
    WHERE user_id = ? AND mail_account_id = ? AND content_state = 'slow' AND import_complete = FALSE`, [userId, accountId]);
  const [boxes] = await executor.execute<RowDataPacket[]>(`SELECT DISTINCT o.mailbox_id FROM emails e
    JOIN mail_remote_occurrences o ON o.email_id = e.id AND o.user_id = e.user_id
      AND o.mail_account_id = e.mail_account_id AND o.presence = 'present'
    JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id AND m.uidvalidity = o.uidvalidity AND m.state = 'active'
    WHERE e.user_id = ? AND e.mail_account_id = ? AND e.content_state = 'queued' AND e.import_complete = FALSE`,
  [userId, accountId]);
  await executor.execute<RowDataPacket[]>(`UPDATE mail_engine_jobs SET priority = ? WHERE user_id = ? AND mail_account_id = ?
    AND kind = 'body' AND state IN ('queued','paused') AND priority > ?`, [BODY_PRIORITY, userId, accountId, BODY_PRIORITY]);
  for (const { mailbox_id: mailboxId } of boxes)
    await runtime.enqueueJob({ userId, accountId, mailboxId, kind: 'body', priority: BODY_PRIORITY }, executor);
  return { mailboxes: boxes.length };
}

// A background flags/presence job over a sweep completed within the throttle
// would only re-read UIDs that 'recent' already observes. Decide from the
// durable cursor before any transport is opened; manual refresh never skips.
async function sweepThrottled(db: SqlExecutor, { userId, accountId, mailboxId, stream }: { userId: string; accountId: string; mailboxId: string; stream: string }) {
  if (!['flags', 'presence'].includes(stream)) return false;
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT c.mailbox_id FROM mail_engine_cursors c
    JOIN mail_remote_mailboxes m ON m.id = c.mailbox_id AND m.uidvalidity = c.uidvalidity AND m.state = 'active'
    WHERE c.mailbox_id = ? AND c.stream = ? AND c.user_id = ? AND c.mail_account_id = ? AND c.covered_through > 0
      AND c.covered_through >= CAST(JSON_UNQUOTE(JSON_EXTRACT(c.coverage_json, '$.upper')) AS UNSIGNED)
      AND c.last_covered_at >= UTC_TIMESTAMP() - INTERVAL ${SWEEP_THROTTLE_MINUTES} MINUTE LIMIT 1`,
  [mailboxId, stream, userId, accountId]);
  return rows.length > 0;
}

export {
  WINDOW,
  STREAMS,
  SWEEP_THROTTLE_MINUTES,
  BODY_PRIORITY,
  enqueuePendingBodies,
  sweepThrottled,
  windowFor,
  validateWindowReply,
  scanMailboxSlice,
  gmailCapable,
  upperBoundary,
  snapshotRevisions,
};
