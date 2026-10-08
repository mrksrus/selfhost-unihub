import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor } from '../../types';
import type { ProviderOperation } from '../../types/mail-engine';
import type { CopyUidMapping } from '../../types/imap-protocol';
interface OperationIdentity { operationId: string; userId: string; accountId: string }
interface Settlement extends OperationIdentity { attemptId?: string | null; workerGeneration?: number | string | null; workerId?: string | null; jobId?: string | null; executor?: SqlExecutor }
interface Destination { uid?: number; uidvalidity?: number; mailboxId?: string; folder?: string }
interface FlagSettlement extends Settlement { source?: { uid: ProviderOperation['remote_uid']; uidvalidity: ProviderOperation['remote_uidvalidity']; folder: string | null }; flags: string[]; modseq?: string | number | bigint | null; observationRevision?: number | null }
interface MoveSettlement extends Settlement { mapping?: CopyUidMapping | null; destination?: Destination | null; source?: { absent?: boolean } | null; evidence?: { verified?: boolean; unique?: boolean } }

// Provider evidence and local operation settlement share one short transaction.
// Never infer generic occurrence identity from a Message-ID or raw hash alone.
import imported1 = require('../../state');
const { db } = imported1;
import runtime = require('./runtime');

async function transaction<T>(fn: (connection: SqlExecutor) => Promise<T>, executor?: SqlExecutor): Promise<T> {
  if (executor) return fn(executor);
  return require('./repository').withTransaction(fn, db); // retries deadlocks
}
const uint = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 4294967295;
const same = (a: unknown, b: unknown) => String(a) === String(b);
function validMapping(mapping: CopyUidMapping | null | undefined, op: Pick<ProviderOperation, 'remote_uid'>, destination: Destination) {
  return !!(mapping && uint(mapping.uidvalidity) && Array.isArray(mapping.sourceUids)
    && Array.isArray(mapping.destinationUids) && mapping.sourceUids.length === 1
    && mapping.destinationUids.length === 1 && same(mapping.sourceUids[0], op.remote_uid)
    && uint(mapping.destinationUids[0]) && same(mapping.destinationUids[0], destination.uid)
    && same(mapping.uidvalidity, destination.uidvalidity));
}
async function lockedOperation(cx: SqlExecutor, { operationId, userId, accountId }: OperationIdentity) {
  const [[op]] = await cx.execute<(RowDataPacket & ProviderOperation)[]>(`SELECT * FROM mail_writebacks WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE`,
    [operationId, userId, accountId]);
  return op;
}
async function generationValid(cx: SqlExecutor, accountId: string, userId: string, generation: string | number | null | undefined, workerId: string | null | undefined, jobId: string | null | undefined) {
  if (generation === undefined || generation === null) return true; // scanner transaction has its own fence
  if (!workerId) return false;
  try { await runtime.assertFence({ accountId, jobId, workerId, generation: Number(generation) }, cx); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'MAIL_WORKER_FENCED') return false; throw error; }
  const [[row]] = await cx.execute<RowDataPacket[]>('SELECT generation FROM mail_engine_accounts WHERE mail_account_id=? AND user_id=?', [accountId, userId]);
  return !!row && same(row.generation, generation);
}
async function finishAttempt(cx: SqlExecutor, id: string | null | undefined, op: ProviderOperation, state: string, evidence: Record<string, unknown>) {
  if (!id) {
    const [[unresolved]] = await cx.execute<RowDataPacket[]>(`SELECT id FROM mail_operation_attempts
      WHERE operation_id=? AND user_id=? AND mail_account_id=? AND completed_at IS NULL
      ORDER BY started_at DESC,id DESC LIMIT 1 FOR UPDATE`, [op.id, op.user_id, op.mail_account_id]);
    id = unresolved?.id;
  }
  if (!id) return;
  await cx.execute(`UPDATE mail_operation_attempts SET outcome=?, evidence_json=?, completed_at=UTC_TIMESTAMP()
    WHERE id=? AND operation_id=? AND user_id=? AND mail_account_id=? AND completed_at IS NULL`,
  [state, JSON.stringify(evidence), id, op.id, op.user_id, op.mail_account_id]);
}
function safeEvidence(input: Record<string, unknown>) {
  // Only whitelisted provider identity/protocol metadata; no body, credentials, subjects or addresses.
  return { kind: input.kind || null, reason: input.reason || null, uid: input.uid || null,
    uidvalidity: input.uidvalidity || null, mailboxId: input.mailboxId || null,
    sourceAbsent: input.sourceAbsent === true, verified: input.verified === true,
    mapping: input.mapping || null, observationRevision: input.observationRevision || null };
}
async function settleFlagObservation({ operationId, userId, accountId, attemptId = null, workerGeneration = null, workerId = null, jobId = null,
  source, flags, modseq = null, observationRevision = null, executor }: FlagSettlement) {
  return transaction(async cx => {
    const op = await lockedOperation(cx, { operationId, userId, accountId });
    if (!op || !['read', 'star'].includes(op.action) || !await generationValid(cx, accountId, userId, workerGeneration, workerId, jobId)) return { settled: false, reason: 'stale_or_missing' };
    if (op.state === 'confirmed') return { settled: true, duplicate: true };
    const flag = op.action === 'read' ? '\\Seen' : '\\Flagged';
    const desired = op.target_value === '1';
    if (!Array.isArray(flags) || flags.includes(flag) !== desired) return { settled: false, reason: 'not_converged' };
    const [[email]] = await cx.execute<RowDataPacket[]>('SELECT * FROM emails WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE', [op.email_id, userId, accountId]);
    if (!email) return { settled: false, reason: 'missing_item' };
    if (observationRevision !== null && !same(email.observation_revision, observationRevision)) return { settled: false, reason: 'stale_observation' };
    if (source && (!same(source.uid, op.remote_uid) || !same(source.uidvalidity, op.remote_uidvalidity)
      || source.folder !== op.remote_folder)) return { settled: false, reason: 'source_mismatch' };
    if (op.source_occurrence_id) {
      const [[occurrence]] = await cx.execute<RowDataPacket[]>(`SELECT * FROM mail_remote_occurrences WHERE id=? AND user_id=? AND mail_account_id=? AND email_id=? FOR UPDATE`,
        [op.source_occurrence_id, userId, accountId, op.email_id]);
      if (!occurrence || !same(occurrence.uid, op.remote_uid) || !same(occurrence.uidvalidity, op.remote_uidvalidity) || occurrence.presence !== 'present')
        return { settled: false, reason: 'occurrence_mismatch' };
      await cx.execute(`UPDATE mail_remote_occurrences SET observed_flags=?, observed_modseq=?, observation_revision=observation_revision+1,
        observed_at=UTC_TIMESTAMP() WHERE id=? AND user_id=? AND mail_account_id=?`, [JSON.stringify(flags), modseq === null ? null : String(modseq), occurrence.id, userId, accountId]);
    }
    const column = op.action === 'read' ? 'is_read' : 'is_starred';
    await cx.execute(`UPDATE emails SET ${column}=?, observed_modseq=?, observation_revision=observation_revision+1 WHERE id=? AND user_id=? AND mail_account_id=?`,
      [Number(desired), modseq === null ? null : String(modseq), op.email_id, userId, accountId]);
    await cx.execute(`UPDATE mail_writebacks SET state='confirmed',status='done',error=NULL,evidence_json=? WHERE id=? AND user_id=? AND mail_account_id=?`,
      [JSON.stringify(safeEvidence({ kind: 'flag_readback', uid: op.remote_uid, uidvalidity: op.remote_uidvalidity, verified: true })), op.id, userId, accountId]);
    await finishAttempt(cx, attemptId, op, 'confirmed', { kind: 'flag_readback', verified: true });
    return { settled: true, operationId: op.id };
  }, executor);
}
async function settleMoveEvidence({ operationId, userId, accountId, attemptId = null, workerGeneration = null, workerId = null, jobId = null,
  mapping = null, destination, source = null, evidence = {}, executor }: MoveSettlement) {
  return transaction(async cx => {
    const op = await lockedOperation(cx, { operationId, userId, accountId });
    if (!op || op.action !== 'move' || !await generationValid(cx, accountId, userId, workerGeneration, workerId, jobId)) return { settled: false, reason: 'stale_or_missing' };
    if (op.state === 'confirmed') return { settled: true, duplicate: true };
    if (!destination || !uint(destination.uid) || !uint(destination.uidvalidity) || !destination.mailboxId || destination.folder !== op.target_value)
      return { settled: false, reason: 'incomplete_destination' };
    const [[mailbox]] = await cx.execute<RowDataPacket[]>(`SELECT * FROM mail_remote_mailboxes WHERE id=? AND user_id=? AND mail_account_id=? AND BINARY remote_name=BINARY ? FOR UPDATE`,
      [destination.mailboxId, userId, accountId, op.target_value]);
    if (!mailbox || mailbox.state !== 'active' || !same(mailbox.uidvalidity, destination.uidvalidity)) return { settled: false, reason: 'destination_epoch' };
    const [[found]] = await cx.execute<RowDataPacket[]>(`SELECT * FROM mail_remote_occurrences WHERE mailbox_id=? AND user_id=? AND mail_account_id=? AND uidvalidity=? AND uid=? FOR UPDATE`,
      [mailbox.id, userId, accountId, destination.uidvalidity, destination.uid]);
    if (!found || found.presence !== 'present') return { settled: false, reason: 'destination_unverified_or_occupied' };
    const mapped = validMapping(mapping, op, destination);
    if (found.email_id !== op.email_id) {
      // A COPYUID pairs the exact dispatched source UID with this destination
      // tuple. A scanner can have created a provisional *local* item first.
      // Do not silently discard its archive or any accepted commands. Without
      // that direct mapping, neither a hash nor an absent source authorizes a join.
      if (!mapped || !evidence.verified || !found.email_id) return { settled: false, reason: 'destination_unverified_or_occupied' };
      const [[placeholder]] = await cx.execute<RowDataPacket[]>(`SELECT * FROM emails WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE`,
        [found.email_id, userId, accountId]);
      if (!placeholder) return { settled: false, reason: 'destination_unverified_or_occupied' };
      const [other] = await cx.execute<RowDataPacket[]>(`SELECT id FROM mail_remote_occurrences WHERE email_id=? AND user_id=? AND mail_account_id=? AND id<>? LIMIT 1 FOR UPDATE`,
        [placeholder.id, userId, accountId, found.id]);
      const [intents] = await cx.execute<RowDataPacket[]>(`SELECT id FROM mail_writebacks WHERE email_id=? AND user_id=? AND mail_account_id=? LIMIT 1 FOR UPDATE`,
        [placeholder.id, userId, accountId]);
      if (other.length || intents.length) return { settled: false, reason: 'placeholder_has_other_identity_or_intents' };
    }
    let recordedSourceAbsent = false;
    if (op.source_occurrence_id) {
      const [[original]] = await cx.execute<RowDataPacket[]>(`SELECT presence FROM mail_remote_occurrences
        WHERE id=? AND user_id=? AND mail_account_id=? AND email_id=? FOR UPDATE`,
      [op.source_occurrence_id, userId, accountId, op.email_id]);
      recordedSourceAbsent = original?.presence === 'absent';
    }
    if (!recordedSourceAbsent && !mapped && source?.absent !== true) {
      // Legacy conflicted MOVE may predate occurrence backfill. Only a fresh,
      // successfully covered *source UID window* in the same mailbox epoch can
      // establish absence. An old email location or raw-hash match cannot.
      const [[covered]] = await cx.execute<RowDataPacket[]>(`SELECT c.mailbox_id FROM mail_remote_mailboxes m
        JOIN mail_engine_cursors c ON c.mailbox_id=m.id AND c.stream='presence'
        WHERE m.user_id=? AND m.mail_account_id=? AND BINARY m.remote_name=BINARY ?
          AND m.uidvalidity=? AND m.state='active' AND c.uidvalidity=?
          AND c.window_start<=? AND c.window_end>=? AND c.last_covered_at>=?
        LIMIT 1`, [userId, accountId, op.remote_folder, op.remote_uidvalidity,
          op.remote_uidvalidity, op.remote_uid, op.remote_uid, op.created_at]);
      if (covered) {
        const [[sourceTuple]] = await cx.execute<RowDataPacket[]>(`SELECT presence FROM mail_remote_occurrences
          WHERE mailbox_id=? AND uidvalidity=? AND uid=? LIMIT 1`,
        [covered.mailbox_id, op.remote_uidvalidity, op.remote_uid]);
        recordedSourceAbsent = !sourceTuple || sourceTuple.presence === 'absent';
      }
    }
    // A scanned destination belonging to this exact item is itself correlated evidence;
    // for unknown replies, source absence plus an explicitly operation-correlated identity is required.
    const scanCorrelated = found.email_id === op.email_id && evidence.verified === true
      && (source?.absent === true || recordedSourceAbsent || mapped) && evidence.unique === true;
    if (!mapped && !scanCorrelated) return { settled: false, reason: 'identity_ambiguous' };
    const [[email]] = await cx.execute<RowDataPacket[]>('SELECT * FROM emails WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE', [op.email_id, userId, accountId]);
    if (!email) return { settled: false, reason: 'missing_item' };
    // An accepted later request is allowed to wait behind this effect. A later
    // *dispatched* placement is not overwritten by the older readback.
    const [[later]] = await cx.execute<RowDataPacket[]>(`SELECT id FROM mail_writebacks WHERE email_id=? AND user_id=? AND action='move'
      AND intent_revision>? AND dispatched=TRUE AND state NOT IN ('cancelled','rejected','superseded') LIMIT 1`, [op.email_id, userId, op.intent_revision]);
    if (later) return { settled: false, reason: 'newer_dispatched_placement' };
    if (found.email_id !== op.email_id) {
      // Retain all bytes/attachments and the provisional ID as a local-only
      // archive; only the provider tuple changes owner. Never delete the row.
      await cx.execute(`UPDATE emails SET remote_missing=TRUE,remote_folder=NULL,remote_uid=NULL,remote_uidvalidity=NULL,
        observation_revision=observation_revision+1 WHERE id=? AND user_id=? AND mail_account_id=?`,
      [found.email_id, userId, accountId]);
      const [adopted] = await cx.execute<ResultSetHeader>(`UPDATE mail_remote_occurrences SET email_id=?
        WHERE id=? AND user_id=? AND mail_account_id=? AND email_id=? AND presence='present'`,
      [op.email_id, found.id, userId, accountId, found.email_id]);
      if (adopted.affectedRows !== 1) throw new Error('Destination adoption changed during settlement');
    }
    if (op.source_occurrence_id && op.source_occurrence_id !== found.id) await cx.execute(`UPDATE mail_remote_occurrences SET presence='absent',absent_at=UTC_TIMESTAMP()
      WHERE id=? AND user_id=? AND mail_account_id=? AND email_id=?`, [op.source_occurrence_id, userId, accountId, op.email_id]);
    await cx.execute(`UPDATE emails SET folder=?, remote_folder=?, remote_uid=?, remote_uidvalidity=?,remote_missing=FALSE,
      observation_revision=observation_revision+1 WHERE id=? AND user_id=? AND mail_account_id=?`,
      [op.target_folder, op.target_value, destination.uid!, destination.uidvalidity!, op.email_id, userId, accountId]);
    const proof = safeEvidence({ kind: mapped ? 'copyuid_verified' : 'scan_reconciled', verified: true,
      uid: destination.uid, uidvalidity: destination.uidvalidity, mailboxId: mailbox.id, sourceAbsent: source?.absent,
      mapping: mapped ? mapping : null });
    await cx.execute(`UPDATE mail_writebacks SET state='confirmed',status='done',error=NULL,evidence_json=?
      WHERE id=? AND user_id=? AND mail_account_id=?`, [JSON.stringify(proof), op.id, userId, accountId]);
    await finishAttempt(cx, attemptId, op, 'confirmed', proof);
    return { settled: true, operationId: op.id, emailId: op.email_id };
  }, executor);
}
async function reconcileObservedOccurrence({ executor, userId, accountId, emailId, mailboxId, epoch, uid,
  sourceAbsent = false, evidence = {} }: Omit<OperationIdentity, 'operationId'> & { executor?: SqlExecutor; emailId: string; mailboxId: string; epoch: number; uid: number; sourceAbsent?: boolean; evidence?: { folder?: string; mapping?: CopyUidMapping | null; verified?: boolean; unique?: boolean } }) {
  // Scanner calls this after committing/upserting its verified occurrence within the same transaction.
  return transaction(async cx => {
    const [rows] = await cx.execute<RowDataPacket[]>(`SELECT id FROM mail_writebacks WHERE user_id=? AND mail_account_id=? AND email_id=?
      AND action='move' AND dispatched=TRUE AND state IN ('reconciling','needs_attention','verifying','executing')
      ORDER BY intent_revision LIMIT 25 FOR UPDATE`, [userId, accountId, emailId]);
    const result = [];
    for (const row of rows) result.push(await settleMoveEvidence({ operationId: row.id, userId, accountId, executor: cx,
      destination: { mailboxId, uidvalidity: epoch, uid, folder: evidence.folder }, source: { absent: sourceAbsent },
      mapping: evidence.mapping, evidence: { verified: evidence.verified === true, unique: evidence.unique === true } }));
    return result;
  }, executor);
}
export = { settleFlagObservation, settleMoveEvidence, reconcileObservedOccurrence, validMapping };
