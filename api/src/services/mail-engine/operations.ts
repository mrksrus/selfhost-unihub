// Durable provider operation executor. IMAP is never called inside a SQL transaction.
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { SqlExecutor, StoredFlag } from '../../types';
import type { OperationRow } from '../../types/mail-engine';
import type { ProtocolConnection } from '../../types/imap-protocol';

import { db } from '../../state';
import * as transport from './transport';
import * as reconciliation from './reconciliation';
import * as runtime from './runtime';
import { isSectionRestoreActive } from '../restore-locks';
import { isModuleEnabled, isModuleBackgroundEnabled } from '../module-settings';

interface StateContext {
  attemptId?: string;
  transmission?: string | null;
  evidence?: Record<string, unknown> | null;
  due?: number | null;
  generation?: number | null;
  workerId?: string | null;
  jobId?: string | null;
  clearDispatch?: boolean;
  bump?: boolean;
}
const transaction = <T>(fn: (connection: SqlExecutor) => Promise<T>): Promise<T> => (require('./repository') as typeof import('./repository')).withTransaction(fn, db); // retries deadlocks
const bitFlag: Record<string, string> = { read: '\\Seen', star: '\\Flagged' };
// The IMAP session survived a failed command and can serve the next operation.
function transportUsable(connection: ProtocolConnection) {
  return (require('../mail-imap-guard') as typeof import('../mail-imap-guard')).imapSessionUsable(connection);
}
const safeText = (error: unknown): string => {
  if (error && typeof error !== 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(String((error as NodeJS.ErrnoException).code || ''))) return (error as NodeJS.ErrnoException).code!;
  if (typeof error === 'string' && error.length <= 240 && (/^[A-Z][A-Z0-9_]{1,63}$/.test(error) || /^[A-Za-z0-9 ,.';:()-]+$/.test(error))) return error;
  return 'Provider command or connection unavailable';
};
const same = (a: unknown, b: unknown) => String(a) === String(b);
function retryDelay(attempts: number) { return Math.min(3600, 15 * (2 ** Math.min(8, Math.max(0, attempts - 1)))); }
const stopped = () => Object.assign(new Error('Operation worker cancelled or fenced'), { code: 'MAIL_WORKER_FENCED' });
async function providerReady(op: OperationRow, generation: number, workerId: string | null | undefined, jobId: string | null | undefined, signal?: AbortSignal) {
  if (signal?.aborted) throw stopped();
  const fence = await runtime.assertFence({ accountId: op.mail_account_id, workerId: workerId!,
    generation: Number(generation), jobId });
  if (signal?.aborted || fence.cancellationRequested || await isSectionRestoreActive(op.user_id, 'mail')
    || !await isModuleEnabled(op.user_id, 'mail')) throw stopped();
}
async function accountFence(cx: SqlExecutor, op: OperationRow, generation: number | null | undefined, workerId: string | null | undefined, jobId: string | null | undefined) {
  if (!workerId || !Number.isSafeInteger(Number(generation)) || Number(generation) < 1) return false;
  try { await runtime.assertFence({ accountId: op.mail_account_id, workerId: workerId!, generation: Number(generation), jobId }, cx); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'MAIL_WORKER_FENCED') return false; throw error; }
  const [[a]] = await cx.execute<RowDataPacket[]>(`SELECT e.generation, a.is_active, a.sync_mode, a.disconnected_at FROM mail_engine_accounts e
    JOIN mail_accounts a ON a.id=e.mail_account_id AND a.user_id=e.user_id
    WHERE e.mail_account_id=? AND e.user_id=? FOR UPDATE`, [op.mail_account_id, op.user_id]);
  return !!a && same(a.generation, generation) && Number(a.is_active) === 1 && a.sync_mode === 'sync' && !a.disconnected_at;
}
// Committed operation states reach the owner's open tabs as a refetch hint.
async function publishedState(op: OperationRow, state: string, committed: Promise<boolean>) {
  const changed = await committed;
  if (changed) (require('../server-events') as typeof import('../server-events')).publishMailOperation(op.user_id,
    { accountId: op.mail_account_id, operationIds: [op.id], state });
  return changed;
}
async function setState(op: OperationRow, state: string, error: string | null = null, { attemptId, transmission = null, evidence = null, due = null, generation, workerId, jobId, clearDispatch = false, bump = false }: StateContext = {}) {
  return publishedState(op, state, transaction(async cx => {
    const [[row]] = await cx.execute<(RowDataPacket & OperationRow)[]>(`SELECT * FROM mail_writebacks WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE`, [op.id, op.user_id, op.mail_account_id]);
    // A user cancel or newer intent may land while this worker holds a stale copy.
    if (!row || ['confirmed', 'cancelled', 'superseded'].includes(row.state) || !await accountFence(cx, op, generation, workerId, jobId)) return false;
    const status = ['confirmed', 'superseded', 'cancelled'].includes(state) ? 'done'
      : ['needs_attention', 'rejected'].includes(state) ? 'conflict' : 'pending';
    await cx.execute(`UPDATE mail_writebacks SET state=?,status=?,error=?,evidence_json=COALESCE(?,evidence_json),dispatched=IF(?,FALSE,dispatched),available_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? SECOND),attempts=attempts+?
      WHERE id=? AND user_id=? AND mail_account_id=?`,
    [state, status, error && safeText(error), evidence && JSON.stringify(evidence), clearDispatch, due || 0, bump ? 1 : 0, op.id, op.user_id, op.mail_account_id]);
    if (attemptId) await cx.execute(`UPDATE mail_operation_attempts SET outcome=?,transmission=?,evidence_json=?,
      completed_at=IF(? IN ('reconciling','needs_attention','verifying','executing'),NULL,UTC_TIMESTAMP())
      WHERE id=? AND operation_id=? AND user_id=? AND mail_account_id=? AND completed_at IS NULL`,
    [state, transmission, evidence && JSON.stringify(evidence), state, attemptId, op.id, op.user_id, op.mail_account_id]);
    if (!attemptId && state === 'needs_attention') await cx.execute(`UPDATE mail_operation_attempts SET outcome='needs_attention'
      WHERE operation_id=? AND user_id=? AND mail_account_id=? AND completed_at IS NULL`,
    [op.id, op.user_id, op.mail_account_id]);
    // Attention is a bounded worker outcome, not proof of the remote effect.
    // Keep the original transmission/evidence and its unresolved timestamp;
    // a later verified reconciliation can still settle this same attempt.
    return true;
  }));
}
// No provider progress was possible on this pass (evidence must settle first).
// Back off so the 1s due scan cannot become a login loop; a bounded count of
// stalls ends in an actionable attention state instead of waiting forever.
async function stall(op: OperationRow, reason: string, ctx: StateContext) {
  const attempts = Number(op.attempts || 0) + 1;
  await setState(op, attempts >= 8 ? 'needs_attention' : Number(op.dispatched) ? op.state : 'retry_wait', reason,
    { ...ctx, due: retryDelay(attempts), bump: true });
  return { needsSync: true };
}
async function beginDispatch(op: OperationRow, generation: number, observedModseq: string | null, workerId: string | null | undefined, jobId: string | null | undefined) {
  return transaction(async cx => {
    const [[row]] = await cx.execute<(RowDataPacket & OperationRow)[]>(`SELECT * FROM mail_writebacks WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE`, [op.id, op.user_id, op.mail_account_id]);
    if (!row || !Number(row.is_current) || row.dispatched || !['queued', 'retry_wait'].includes(row.state)
      || !await accountFence(cx, row, generation, workerId, jobId)) throw Object.assign(new Error('Stale intent or account fence'), { code: 'STALE_FENCE' });
    const attempt = await runtime.beginOperationAttempt({ operationId: row.id, userId: row.user_id,
      accountId: row.mail_account_id, workerId: workerId!, generation: Number(generation) }, cx);
    await cx.execute('UPDATE mail_writebacks SET dispatch_modseq=? WHERE id=? AND user_id=? AND mail_account_id=?',
      [observedModseq, row.id, row.user_id, row.mail_account_id]);
    return attempt.id;
  });
}
async function loadLatest(op: OperationRow, generation: number, workerId: string | null | undefined, jobId: string | null | undefined) {
  return transaction(async cx => {
    const [[row]] = await cx.execute<(RowDataPacket & OperationRow)[]>(`SELECT * FROM mail_writebacks WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE`,
      [op.id, op.user_id, op.mail_account_id]);
    if (!row || !await accountFence(cx, row, generation, workerId, jobId)) return null;
    return row;
  });
}
async function readSource(connection: ProtocolConnection, op: OperationRow, signal: AbortSignal | undefined, ready: () => Promise<unknown> = async () => {}, readOnly = false) {
  const [[email]] = await db.execute<RowDataPacket[]>('SELECT observation_revision FROM emails WHERE id=? AND user_id=? AND mail_account_id=?',
    [op.email_id, op.user_id, op.mail_account_id]);
  if (!email) return { staleEpoch: true };
  await ready();
  const box = await transport.selectMailbox(connection, { folder: op.remote_folder!, readOnly, signal });
  if (!same(box.uidvalidity, op.remote_uidvalidity)) return { staleEpoch: true };
  await ready();
  const data = await transport.fetchMetadataWindow(connection, { folder: op.remote_folder!, uidvalidity: box.uidvalidity,
    startUid: Number(op.remote_uid), endUid: Number(op.remote_uid), maxMessages: 1 }, { signal });
  return { box, item: data.items.find(row => same(row.uid, op.remote_uid)) || null,
    observationRevision: email.observation_revision };
}
interface OperationResult { needsSync?: boolean; connectionFailed?: boolean; }
async function applyFlag(op: OperationRow, connection: ProtocolConnection, generation: number, signal?: AbortSignal, workerId?: string | null, jobId?: string | null): Promise<OperationResult> {
  const ready = () => providerReady(op, generation, workerId, jobId, signal);
  const before = await readSource(connection, op, signal, ready);
  if (before.staleEpoch || !before.item) {
    await setState(op, 'needs_attention', 'Source UID or mailbox epoch changed; identity must be re-established', { generation, workerId, jobId });
    return { needsSync: true };
  }
  const latest = await loadLatest(op, generation, workerId, jobId);
  if (!latest) return { connectionFailed: false };
  const desired = latest.target_value === '1', flag = bitFlag[latest.action];
  if (!flag) throw new Error('Invalid action');
  const hasFlag = before.item.flags.includes(flag);
  if (!Number(latest.is_current)) {
    // Its provider effect may have happened, but an older request must not dispatch
    // after a newer explicit value is accepted. Leave the newer overlay untouched.
    await setState(latest, 'superseded', null, { generation, workerId, jobId, evidence: { kind: 'older_flag_readback', observed: hasFlag } });
    return {};
  }
  if (hasFlag === desired) {
    const result = await reconciliation.settleFlagObservation({ operationId: latest.id, userId: latest.user_id,
      accountId: latest.mail_account_id, workerGeneration: generation, workerId, jobId, source: { folder: latest.remote_folder,
        uid: latest.remote_uid, uidvalidity: latest.remote_uidvalidity }, flags: before.item.flags,
      modseq: before.item.modseq, observationRevision: before.observationRevision });
    if (result.settled || result.reason === 'stale_or_missing') return {};
    return stall(latest, 'Provider flag matches; waiting for sync to confirm local identity', { generation, workerId, jobId });
  }
  // A flag delta sets a value idempotently. Refresh and re-evaluate the *latest*
  // intent after a lost ACK; no full flags replacement or two-attempt discard.
  if (Number(latest.dispatched)) {
    await setState(latest, Number(latest.attempts) >= 8 ? 'needs_attention' : 'retry_wait',
      'Provider flag differs after interrupted write; checking latest request',
      { generation, workerId, jobId, clearDispatch: Number(latest.attempts) < 8, due: retryDelay(Number(latest.attempts) + 1) });
    return { needsSync: true };
  }
  let attemptId: string | undefined;
  try {
    await ready();
    const result = await transport.setFlag(connection, { uid: Number(latest.remote_uid), uidvalidity: Number(latest.remote_uidvalidity),
      sourceFolder: latest.remote_folder!, flag, value: desired,
      modseq: before.box.capabilities.condstore ? before.item.modseq : null }, {
      signal, beforeDispatch: async () => {
        await ready();
        attemptId = await beginDispatch(latest, generation, before.item!.modseq, workerId, jobId);
        await ready();
      },
    });
    if (result.modified) {
      await setState(latest, 'retry_wait', 'Conditional flag changed; refreshing provider flags',
        { generation, workerId, jobId, attemptId, transmission: result.transmission, evidence: { kind: 'modified' },
          clearDispatch: true, due: retryDelay(Number(latest.attempts) + 1) });
      // Never use stale pre-STORE state; a fresh readback next pass decides latest intent.
      return { needsSync: true };
    }
    if (result.completion !== 'ok') {
      await setState(latest, result.transmission === 'not_sent' ? 'retry_wait' : 'reconciling', 'Provider flag acknowledgement uncertain',
        { generation, workerId, jobId, attemptId, transmission: result.transmission, clearDispatch: result.transmission === 'not_sent',
          due: retryDelay(Number(latest.attempts) + 1) });
      return { needsSync: true, connectionFailed: result.completion === 'lost' };
    }
    const after = await readSource(connection, latest, signal, ready);
    if (!after.item || after.staleEpoch || after.item.flags.includes(flag) !== desired) {
      await setState(latest, 'retry_wait', 'Flag readback differs; refreshing latest intent',
        { generation, workerId, jobId, attemptId, transmission: result.transmission, due: retryDelay(Number(latest.attempts) + 1) });
      return { needsSync: true };
    }
    const settled = await reconciliation.settleFlagObservation({ operationId: latest.id, userId: latest.user_id,
      accountId: latest.mail_account_id, attemptId, workerGeneration: generation, workerId, jobId, source: { folder: latest.remote_folder,
        uid: latest.remote_uid, uidvalidity: latest.remote_uidvalidity }, flags: after.item.flags, modseq: after.item.modseq,
      observationRevision: before.observationRevision });
    if (!settled.settled) await setState(latest, 'reconciling', 'Observation changed during verification',
      { generation, workerId, jobId, attemptId, due: retryDelay(Number(latest.attempts) + 1) });
    return { needsSync: !settled.settled };
  } catch (error) {
    await setState(latest, (error as NodeJS.ErrnoException).code === 'MAIL_EPOCH_STALE' ? 'needs_attention' : attemptId ? 'reconciling' : 'retry_wait', safeText(error),
      { generation, workerId, jobId, attemptId, transmission: attemptId ? 'possible' : 'not_sent', due: retryDelay(Number(latest.attempts) + 1) });
    return { needsSync: !!attemptId, connectionFailed: (error as NodeJS.ErrnoException).code !== 'STALE_FENCE' };
  }
}
async function applyMove(op: OperationRow, connection: ProtocolConnection, generation: number, signal?: AbortSignal, workerId?: string | null, jobId?: string | null): Promise<OperationResult> {
  const ready = () => providerReady(op, generation, workerId, jobId, signal);
  if (Number(op.dispatched)) {
    // A dispatched MOVE is read-only on every subsequent pass; never repeat it.
    return reconcileMoveOutcome(op, connection, generation, signal, workerId, jobId);
  }
  const ctx = { generation, workerId, jobId };
  const [prior] = await db.execute<RowDataPacket[]>(`SELECT id,state FROM mail_writebacks WHERE user_id=? AND mail_account_id=? AND email_id=?
    AND action='move' AND intent_revision<? AND dispatched=TRUE AND state NOT IN ('confirmed','cancelled','superseded','rejected')
    ORDER BY intent_revision DESC LIMIT 25`, [op.user_id, op.mail_account_id, op.email_id, op.intent_revision]);
  // A prior MOVE's effect must settle first: the message may already have left
  // this source. Once its bounded check ended unresolved, waiting could be
  // forever, so this intent asks the user instead (retry after the outcome
  // check or sync; or discard). It is never dispatched on a guessed location.
  const unresolved = prior.find(row => row.state === 'needs_attention');
  if (unresolved) {
    await setState(op, 'needs_attention', 'Earlier move outcome is unconfirmed; check it, then retry or discard this move',
      { ...ctx, evidence: { kind: 'blocked_by_unconfirmed_move', prior: unresolved.id } });
    return {};
  }
  if (prior.length) return stall(op, 'Waiting for earlier move outcome check', ctx);
  const [[email]] = await db.execute<RowDataPacket[]>('SELECT remote_folder,remote_uid,remote_uidvalidity FROM emails WHERE id=? AND user_id=? AND mail_account_id=?',
    [op.email_id, op.user_id, op.mail_account_id]);
  if (!email) return stall(op, 'Message is unavailable locally', ctx);
  if (email.remote_folder !== op.remote_folder || !same(email.remote_uid, op.remote_uid)
    || !same(email.remote_uidvalidity, op.remote_uidvalidity)) {
    const rebased = await transaction(async cx => {
      const [[row]] = await cx.execute<(RowDataPacket & OperationRow)[]>('SELECT * FROM mail_writebacks WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE',
        [op.id, op.user_id, op.mail_account_id]);
      if (!row || row.dispatched || !Number(row.is_current) || !await accountFence(cx, row, generation, workerId, jobId)) return false;
      const [[actual]] = await cx.execute<RowDataPacket[]>('SELECT remote_folder,remote_uid,remote_uidvalidity FROM emails WHERE id=? AND user_id=? AND mail_account_id=? FOR UPDATE',
        [op.email_id, op.user_id, op.mail_account_id]);
      if (!actual?.remote_folder || !Number(actual.remote_uidvalidity)) return false;
      const [[occ]] = await cx.execute<RowDataPacket[]>(`SELECT o.id FROM mail_remote_occurrences o JOIN mail_remote_mailboxes m ON m.id=o.mailbox_id
        WHERE o.email_id=? AND o.user_id=? AND o.mail_account_id=? AND o.presence='present'
        AND BINARY m.remote_name=BINARY ? AND o.uid=? AND o.uidvalidity=? LIMIT 1`,
      [op.email_id, op.user_id, op.mail_account_id, actual.remote_folder, actual.remote_uid, actual.remote_uidvalidity]);
      if (!occ) return false;
      await cx.execute(`UPDATE mail_writebacks SET remote_folder=?,remote_uid=?,remote_uidvalidity=?,source_occurrence_id=?,
        evidence_json=JSON_OBJECT('kind','rebased_after_verified_prior_move','original_folder',remote_folder,
          'original_uid',remote_uid,'original_uidvalidity',remote_uidvalidity)
        WHERE id=? AND user_id=? AND mail_account_id=?`,
      [actual.remote_folder, actual.remote_uid, actual.remote_uidvalidity, occ.id, op.id, op.user_id, op.mail_account_id]);
      Object.assign(op, actual, { source_occurrence_id: occ.id }); return true;
    });
    if (!rebased) return stall(op, 'Message location changed; waiting for sync to verify it', ctx);
  }
  const before = await readSource(connection, op, signal, ready);
  if (before.staleEpoch || !before.item) {
    await setState(op, 'needs_attention', 'Source UID or mailbox epoch changed before MOVE', { generation, workerId, jobId });
    return { needsSync: true };
  }
  const latest = await loadLatest(op, generation, workerId, jobId);
  if (!latest || !Number(latest.is_current)) return {};
  if (latest.target_value === latest.remote_folder) {
    // Same mailbox does not require a network mutation; still verify source.
    await setState(latest, 'confirmed', null, { generation, workerId, jobId, evidence: { kind: 'same_mailbox' } });
    return {};
  }
  let attemptId: string | undefined, moveOutcome: Awaited<ReturnType<typeof transport.nativeMove>> | undefined;
  try {
    await ready();
    const outcome = moveOutcome = await transport.nativeMove(connection, { uid: Number(latest.remote_uid), uidvalidity: Number(latest.remote_uidvalidity),
      sourceFolder: latest.remote_folder!, targetFolder: latest.target_value }, { signal, beforeDispatch: async () => {
        await ready();
        attemptId = await beginDispatch(latest, generation, null, workerId, jobId);
        await ready();
      } });
    if (outcome.transmission === 'not_sent') {
      await setState(latest, outcome.completion === 'unsupported' ? 'needs_attention' : 'retry_wait',
        outcome.completion === 'unsupported' ? 'Native MOVE unavailable; no fallback mutation sent' : 'MOVE not sent',
        { generation, workerId, jobId, attemptId, transmission: 'not_sent', clearDispatch: true,
          due: retryDelay(Number(latest.attempts) + 1) });
      return {};
    }
    if (outcome.completion === 'ok' && outcome.mappingStatus === 'valid' && outcome.mapping) {
      await ready();
      const box = await transport.selectMailbox(connection, { folder: latest.target_value, readOnly: true, signal });
      if (same(box.uidvalidity, outcome.mapping.uidvalidity)) {
        const uid = outcome.mapping.destinationUids[0];
        await ready();
        const result = await transport.fetchMetadataWindow(connection, { folder: latest.target_value, uidvalidity: box.uidvalidity,
          startUid: uid, endUid: uid, maxMessages: 1 }, { signal });
        if (result.items.length === 1 && same(result.items[0].uid, uid)) {
          // A new destination MUST first be associated by verified COPYUID, never
          // by raw-hash collision; the shared settlement merges scan-first safely.
          const { ensureMailbox, upsertOccurrence } = require('./repository') as typeof import('./repository');
          const settled = await transaction(async cx => {
            const mailbox = await ensureMailbox({ userId: latest.user_id, accountId: latest.mail_account_id,
              folderName: latest.target_value, epoch: box.uidvalidity }, cx);
            const [[existing]] = await cx.execute<RowDataPacket[]>(`SELECT id FROM mail_remote_occurrences
              WHERE mailbox_id=? AND uidvalidity=? AND uid=? FOR UPDATE`, [mailbox.id, box.uidvalidity, uid]);
            if (!existing) await upsertOccurrence({ userId: latest.user_id, accountId: latest.mail_account_id, mailboxId: mailbox.id,
              epoch: box.uidvalidity, uid, emailId: latest.email_id, flags: result.items[0].flags,
              modseq: result.items[0].modseq }, cx);
            return reconciliation.settleMoveEvidence({ operationId: latest.id, userId: latest.user_id, accountId: latest.mail_account_id,
              attemptId, workerGeneration: generation, workerId, jobId, mapping: outcome.mapping,
              destination: { mailboxId: mailbox.id, uidvalidity: box.uidvalidity, uid, folder: latest.target_value },
              source: { absent: true }, evidence: { verified: true }, executor: cx });
          });
          if (settled.settled) return { needsSync: true };
          if (settled.reason === 'placeholder_has_other_identity_or_intents' || settled.reason === 'newer_dispatched_placement') {
            await setState(latest, 'needs_attention', 'Mapped destination has independent local history; manual review required',
              { generation, workerId, jobId, attemptId, transmission: outcome.transmission,
                evidence: { kind: 'move_outcome', completion: outcome.completion, mappingStatus: outcome.mappingStatus, mapping: outcome.mapping } });
            return {};
          }
        }
      }
    }
    await setState(latest, 'reconciling', 'MOVE outcome requires source and destination verification',
      { generation, workerId, jobId, attemptId, transmission: outcome.transmission, evidence: { kind: 'move_outcome',
        completion: outcome.completion, mappingStatus: outcome.mappingStatus, mapping: outcome.mapping || null } });
    return { needsSync: true, connectionFailed: outcome.completion === 'lost' };
  } catch (error) {
    await setState(latest, (error as NodeJS.ErrnoException).code === 'MAIL_EPOCH_STALE' ? 'needs_attention' : attemptId ? 'reconciling' : 'retry_wait', safeText(error),
      { generation, workerId, jobId, attemptId, transmission: attemptId ? 'possible' : 'not_sent',
        evidence: moveOutcome && { kind: 'move_outcome', completion: moveOutcome.completion,
          mappingStatus: moveOutcome.mappingStatus, mapping: moveOutcome.mapping || null },
        due: retryDelay(Number(latest.attempts) + 1) });
    return { needsSync: !!attemptId, connectionFailed: (error as NodeJS.ErrnoException).code !== 'STALE_FENCE' };
  }
}
async function reconcileMoveOutcome(op: OperationRow, connection: ProtocolConnection, generation: number, signal?: AbortSignal, workerId?: string | null, jobId?: string | null): Promise<OperationResult> {
  const ready = () => providerReady(op, generation, workerId, jobId, signal);
  const latest = await loadLatest(op, generation, workerId, jobId);
  if (!latest || latest.state === 'confirmed') return {};
  let recorded;
  try { recorded = typeof latest.evidence_json === 'string' ? JSON.parse(latest.evidence_json) : latest.evidence_json; }
  catch { recorded = null; }
  const mapping = recorded?.kind === 'move_outcome' && recorded.completion === 'ok' && recorded.mappingStatus === 'valid'
    ? recorded.mapping : null;
  // A single read of the exact source and a finite destination window. This
  // does not pretend that a missing COPYUID can be reconstructed from a hash.
  const source = await readSource(connection, latest, signal, ready, true);
  await ready();
  const box = await transport.selectMailbox(connection, { folder: latest.target_value, readOnly: true, signal });
  const mappedUid = mapping?.destinationUids?.[0];
  const upper = box.uidnext ? Number(box.uidnext) - 1 : 0;
  const start = mappedUid || Math.max(1, upper - 127), end = mappedUid || upper;
  let items: Awaited<ReturnType<typeof transport.fetchMetadataWindow>>['items'] = [];
  if (end >= start && end > 0) {
    await ready();
    const reply = await transport.fetchMetadataWindow(connection, { folder: latest.target_value, uidvalidity: box.uidvalidity,
      startUid: start, endUid: end, maxMessages: 128 }, { signal });
    items = reply.items;
  }
  if (mapping && same(mapping.uidvalidity, box.uidvalidity) && items.length === 1 && same(items[0].uid, mappedUid)
    && reconciliation.validMapping(mapping, latest, { uidvalidity: box.uidvalidity, uid: mappedUid })) {
    const { ensureMailbox, upsertOccurrence } = require('./repository') as typeof import('./repository');
    const result = await transaction(async cx => {
      // The operation and its source are fenced again by settleMoveEvidence.
      await runtime.assertFence({ accountId: latest.mail_account_id, workerId: workerId!, generation, jobId }, cx);
      const mailbox = await ensureMailbox({ userId: latest.user_id, accountId: latest.mail_account_id,
        folderName: latest.target_value, epoch: box.uidvalidity }, cx);
      const [[existing]] = await cx.execute<RowDataPacket[]>(`SELECT id FROM mail_remote_occurrences WHERE mailbox_id=? AND uidvalidity=? AND uid=? FOR UPDATE`,
        [mailbox.id, box.uidvalidity, mappedUid]);
      if (!existing) await upsertOccurrence({ userId: latest.user_id, accountId: latest.mail_account_id,
        mailboxId: mailbox.id, epoch: box.uidvalidity, uid: mappedUid, emailId: latest.email_id,
        flags: items[0].flags, modseq: items[0].modseq }, cx);
      return reconciliation.settleMoveEvidence({ operationId: latest.id, userId: latest.user_id,
        accountId: latest.mail_account_id, workerGeneration: generation, workerId, jobId, mapping,
        destination: { mailboxId: mailbox.id, uidvalidity: box.uidvalidity, uid: mappedUid, folder: latest.target_value },
        source: { absent: !source.staleEpoch && !source.item }, evidence: { verified: true }, executor: cx });
    });
    if (result.settled) return { needsSync: true };
  }
  await setState(latest, 'needs_attention', mapping
    ? 'Mapped MOVE destination could not be safely associated; manual review required'
    : 'MOVE has no correlated COPYUID; bounded source and destination checks cannot prove identity',
  { generation, workerId, jobId, evidence: { kind: 'bounded_move_check',
    sourceEpochValid: !source.staleEpoch, sourcePresent: !!source.item,
    destinationEpoch: box.uidvalidity, destinationWindow: end >= start ? [start, end] : null,
    destinationCount: items.length, mapping: mapping || null, prior: recorded?.kind || null } });
  return {};
}
async function processDueOperations(account: { id: string; user_id: string }, connection: ProtocolConnection, { background = false, workerGeneration = null, workerId = null, jobId = null,
  operationId = null, signal }: { background?: boolean; workerGeneration?: number | null; workerId?: string | null; jobId?: string | null; operationId?: string | null; signal?: AbortSignal } = {}) {
  // A process-local lock is not an account lease. Refuse legacy unfenced writes.
  if (!workerId || !workerGeneration) throw Object.assign(new Error('Durable account lease required for provider writes'), { code: 'MAIL_WORKER_FENCED' });
  const fence = await runtime.assertFence({ accountId: account.id, workerId: workerId!, generation: Number(workerGeneration), jobId });
  if (signal?.aborted || fence.cancellationRequested) throw stopped();
  const [ops] = await db.execute<(RowDataPacket & OperationRow)[]>(`SELECT * FROM mail_writebacks WHERE mail_account_id=? AND user_id=?
    AND ((is_current=TRUE AND state IN ('queued','retry_wait')) OR (action='move' AND dispatched=TRUE AND state IN ('executing','verifying'))
      OR (action='move' AND dispatched=TRUE AND state='reconciling')
      OR (action IN ('read','star') AND dispatched=TRUE AND state IN ('executing','verifying','reconciling')))
    AND available_at<=UTC_TIMESTAMP() ${operationId ? 'AND id=?' : ''} ORDER BY created_at,id LIMIT 25`,
  operationId ? [account.id, account.user_id, operationId] : [account.id, account.user_id]);
  let needsSync = false, connectionFailed = false;
  for (const op of ops) {
    const lease = await runtime.assertFence({ accountId: account.id, workerId: workerId!, generation: Number(workerGeneration), jobId });
    if (signal?.aborted || lease.cancellationRequested || await isSectionRestoreActive(account.user_id, 'mail')
      || !await (background ? isModuleBackgroundEnabled : isModuleEnabled)(account.user_id, 'mail')) break;
    try {
      const result = op.action === 'move' ? await applyMove(op, connection, workerGeneration, signal, workerId, jobId)
        : await applyFlag(op, connection, workerGeneration, signal, workerId, jobId);
      needsSync ||= !!result.needsSync; connectionFailed ||= !!result.connectionFailed;
      if (connectionFailed) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'MAIL_WORKER_FENCED' || signal?.aborted) { connectionFailed = true; break; }
      // Operator log only (never stored): the stored/UI text is reduced by safeText.
      console.error(`[MAIL OPERATION] ${op.action} ${op.id} failed:`, (error as NodeJS.ErrnoException).code || (error as Error).name || 'Error',
        String((error as Error).message || '').slice(0, 200));
      // Count every failure so a persistent provider refusal backs off and
      // ends in attention instead of being retried at the same pace forever.
      const attempts = Number(op.attempts) + 1;
      await setState(op, op.dispatched ? 'reconciling' : attempts >= 8 ? 'needs_attention' : 'retry_wait', safeText(error),
        { generation: workerGeneration, workerId, jobId, due: retryDelay(attempts), bump: !op.dispatched });
      // A per-message refusal must not block the rest of the account's queue.
      if (!transportUsable(connection)) { connectionFailed = true; break; }
    }
  }
  return { needsSync, connectionFailed };
}
async function deferAccountOffline(accountId: string, userId: string, error: unknown) {
  // A transport connect error cannot consume and silently discard accepted work.
  const [result] = await db.execute<ResultSetHeader>(`UPDATE mail_writebacks SET state='retry_wait',status='pending',error=?,
    available_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL LEAST(3600,15*POW(2,LEAST(8,attempts))) SECOND),attempts=attempts+1
    WHERE mail_account_id=? AND user_id=? AND is_current=TRUE AND dispatched=FALSE
    AND state IN ('queued','retry_wait') AND available_at<=UTC_TIMESTAMP()`, [safeText(error), accountId, userId]);
  // Uncertain dispatched work keeps its state; only its next read-only check waits.
  await db.execute(`UPDATE mail_writebacks SET available_at=DATE_ADD(UTC_TIMESTAMP(), INTERVAL LEAST(3600,15*POW(2,LEAST(8,attempts))) SECOND)
    WHERE mail_account_id=? AND user_id=? AND dispatched=TRUE AND state IN ('executing','verifying','reconciling')
    AND available_at<=UTC_TIMESTAMP()`, [accountId, userId]);
  return result.affectedRows;
}
export {
  processDueOperations,
  deferAccountOffline,
  retryDelay,
  applyFlag,
  applyMove,
  beginDispatch,
};
