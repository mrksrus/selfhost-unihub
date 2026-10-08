import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor, StoredFlag } from '../types';
import { randomUUID } from 'node:crypto';
import { resolveOwnedReference } from './backup-ownership';
import { ARCHIVE_COLUMNS } from './mail-engine/recovery-policy';

interface RestoreRow extends Record<string, unknown> {
  id: string;
  mail_account_id: string;
  email_id: string;
  rule_id: string;
  action: string;
  target_value: string;
  base_value?: string | null;
  target_folder: string | null;
  remote_folder: string | null;
  remote_uid: number | string | null;
  remote_uidvalidity: number | string | null;
  attempts?: number;
  dispatched?: StoredFlag;
  dispatch_modseq?: string | null;
  source_occurrence_id?: string | null;
  intent_revision?: number | string;
  client_key: string;
  request_hash: string;
  state?: string;
  status?: string;
  raw_bytes?: number | null;
  import_complete?: StoredFlag;
  source_account_id: string;
  original_filing_account_id?: string | null;
  target_account_id?: string | null;
  original_folder: string | null;
  created_at?: string | Date;
  completed_at?: string | Date;
}
type RestoreData = Record<string, RestoreRow[] | undefined>;
interface RestoreContext {
  accountIds: Map<string, string>;
  emailIds: Map<string, string>;
  writtenEmailIds: Set<string>;
  restoredPaths: Map<string, string>;
  checkCancelled: () => Promise<unknown>;
  warnings: string[];
}

const json = (value: unknown): unknown => {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
};
const bool = (value: unknown) => value === true || value === 1 || value === '1';

async function pauseMailRestore(connection: SqlExecutor, userId: string) {
  // A section restore already holds the mail restore exclusion guard. Preserve
  // all accepted commands; do not DELETE the installation's operation journal.
  // A restore can bring back local copies the server no longer has; Sync must
  // not remove them before the user confirms the account's policy again.
  await connection.execute<RowDataPacket[]>(`UPDATE mail_accounts SET is_active = FALSE, delete_emails_on_server = FALSE,
    server_delete_enabled_at = NULL, server_delete_grace_until = NULL, sync_policy_confirmed_at = NULL WHERE user_id = ?`, [userId]);
  // A canary hold survives; is_active = FALSE already forces revalidation
  // before the operator can release it.
  await connection.execute<RowDataPacket[]>(`UPDATE mail_engine_accounts SET generation = generation + 1,
    paused_reason = IF(paused_reason <=> ?, paused_reason, 'Restore requires provider identity revalidation'),
    lease_owner = NULL, lease_until = NULL WHERE user_id = ?`, [(require('./mail-engine/rollout') as typeof import('./mail-engine/rollout')).HOLD_REASON, userId]);
  await connection.execute<RowDataPacket[]>(`UPDATE mail_engine_jobs SET state = 'paused', cancellation_requested = TRUE,
    lease_owner = NULL, lease_until = NULL, error = 'Restore requires provider identity revalidation'
    WHERE user_id = ? AND state IN ('queued','running','error')`, [userId]);
  await connection.execute<RowDataPacket[]>(`UPDATE mail_writebacks SET state = 'needs_attention', status = 'conflict',
    is_current = FALSE,
    evidence_json = JSON_SET(COALESCE(evidence_json, JSON_OBJECT()), '$.restore_requires_revalidation', TRUE),
    error = 'Restore paused this accepted operation; verify provider identity and outcome before retrying'
    WHERE user_id = ? AND status <> 'done'
      AND (state IS NULL OR state NOT IN ('cancelled','superseded','rejected'))`, [userId]);
}

async function retainManifestRow(connection: SqlExecutor, userId: string, accountId: string | null, table: string, row: RestoreRow) {
  // Archive IDs are untrusted and may already belong to another user. Preserve
  // them inside the evidence, not as a globally colliding primary key.
  const sourceId = randomUUID();
  const allowed = (ARCHIVE_COLUMNS as Readonly<Record<string, string>>)[table].split(' ');
  const evidence = Object.fromEntries(allowed.filter(key => key !== 'user_id' && Object.hasOwn(row, key)).map(key => [key, row[key]]));
  await connection.execute<RowDataPacket[]>(`INSERT INTO mail_engine_quarantine
    (source_table,source_id,user_id,mail_account_id,reason,evidence_json)
    VALUES (?,?,?,?, 'restored_evidence', ?)
    ON DUPLICATE KEY UPDATE source_id = source_id`,
  [table, sourceId, userId, accountId, JSON.stringify({ archive: evidence, requires_provider_revalidation: true })]);
}

async function restoreMailEngineEvidence(connection: SqlExecutor, userId: string, data: RestoreData, {
  accountIds, emailIds, writtenEmailIds, restoredPaths, checkCancelled, warnings,
}: RestoreContext) {
  const operations = new Map<string, string>();
  const account = (id: string | null | undefined) => resolveOwnedReference(connection, userId, 'mail_accounts', id, accountIds);
  // Mappings and attempts remain inspectable evidence. They are deliberately
  // not restored as present occurrences, live leases or reusable checkpoints.
  for (const table of ['mail_remote_mailboxes', 'mail_remote_occurrences', 'mail_gmail_messages', 'mail_operation_attempts', 'mail_engine_quarantine']) {
    for (const row of data[table] || []) {
      await checkCancelled();
      const accountId = await account(row.mail_account_id);
      await retainManifestRow(connection, userId, accountId, table, row);
    }
  }
  for (const row of data.mail_writebacks || []) {
    await checkCancelled();
    if (!['read', 'star', 'move'].includes(row.action)) throw new Error('Invalid restored provider operation');
    const accountId = await account(row.mail_account_id);
    const emailId = await resolveOwnedReference(connection, userId, 'emails', row.email_id, emailIds);
    const [[email]] = await connection.execute<RowDataPacket[]>('SELECT mail_account_id FROM emails WHERE id = ? AND user_id = ?', [emailId, userId]);
    if (!email || email.mail_account_id !== accountId) throw new Error('Restored operation account does not match its email');
    const [[existing]] = await connection.execute<RowDataPacket[]>('SELECT id, email_id, mail_account_id, action, target_value FROM mail_writebacks WHERE id = ? AND user_id = ? FOR UPDATE', [row.id, userId]);
    if (existing && existing.email_id === emailId && existing.mail_account_id === accountId && existing.action === row.action && existing.target_value === row.target_value) {
      operations.set(row.id, existing.id);
      await retainManifestRow(connection, userId, accountId, 'mail_writebacks', row);
      continue; // Never overwrite the destination's newer outcome/history.
    }
    const id = randomUUID();
    operations.set(row.id, id);
    const confirmed = row.state === 'confirmed' || row.status === 'done';
    const evidence = { archive_operation_id: row.id, archive_evidence: json(row.evidence_json), archive_state: row.state || row.status,
      restore_requires_revalidation: !confirmed, source_occurrence_id: row.source_occurrence_id || null };
    await connection.execute<RowDataPacket[]>(`INSERT INTO mail_writebacks
      (id,user_id,mail_account_id,email_id,action,target_value,base_value,target_folder,remote_folder,remote_uid,remote_uidvalidity,
       status,attempts,dispatched,dispatch_modseq,error,available_at,state,is_current,intent_revision,client_key,evidence_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),?,FALSE,?,?,?)`,
    [id,userId,accountId,emailId,row.action,row.target_value,row.base_value ?? null,row.target_folder ?? null,row.remote_folder,
      row.remote_uid,row.remote_uidvalidity,confirmed ? 'done' : 'conflict',Number(row.attempts) || 0,bool(row.dispatched) ? 1 : 0,
      row.dispatch_modseq || null,confirmed ? null : 'Restored intent retained for review; provider effects must be checked before a new action',
      confirmed ? 'confirmed' : 'needs_attention',String(row.intent_revision || 0),row.client_key || null,JSON.stringify(evidence)]);
  }
  for (const row of data.mail_command_receipts || []) {
    await checkCancelled();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(row.client_key || '') || !/^[a-f0-9]{64}$/.test(row.request_hash || '')) throw new Error('Invalid restored operation receipt');
    const response = json(row.response_json) as ({ operation_ids?: string[] } & Record<string, unknown>) | null;
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid restored operation receipt response');
    const restoredResponse = { ...response, recovery_required: true,
      operation_ids: (response.operation_ids || []).map(id => operations.get(id) || id) };
    const [[existing]] = await connection.execute<RowDataPacket[]>('SELECT request_hash FROM mail_command_receipts WHERE user_id = ? AND client_key = ? FOR UPDATE', [userId,row.client_key]);
    if (existing) {
      if (existing.request_hash !== row.request_hash) throw new Error('Restored idempotency key conflicts with an existing accepted request');
      continue; // Current installation's receipt/response wins.
    }
    await connection.execute<RowDataPacket[]>(`INSERT INTO mail_command_receipts (user_id,client_key,request_hash,response_json)
      VALUES (?,?,?,?)`, [userId,row.client_key,row.request_hash,JSON.stringify(restoredResponse)]);
  }
  for (const row of data.emails || []) {
    if (!writtenEmailIds.has(row.id)) continue;
    const emailId = emailIds.get(row.id);
    const rawPath = restoredPaths.get(`raw_email:${row.id}`);
    if (!emailId || !rawPath) continue;
    await connection.execute<RowDataPacket[]>(`UPDATE emails SET raw_format = ?, raw_bytes = ?, raw_verified = FALSE,
      content_state = ?, observation_revision = observation_revision + 1, observed_modseq = NULL
      WHERE id = ? AND user_id = ?`,
    [typeof row.raw_format === 'string' ? row.raw_format : 'legacy_normalized', row.raw_bytes ?? null,
      bool(row.import_complete) ? 'complete' : 'legacy',emailId,userId]);
  }
  // New/replaced accounts may have been inserted after the initial pause. Never
  // start them merely because the archive says active or supplies credentials.
  await pauseMailRestore(connection, userId);
  if ((data.mail_accounts || []).length || (data.emails || []).length || (data.mail_writebacks || []).length) {
    warnings.push('Mail accounts are paused after restore. Retained mail is available; reconnect explicitly to revalidate provider identities. Prior operations, uncertain attempts and mappings are retained as quarantined evidence and are never blindly replayed.');
  }
}
export { pauseMailRestore, restoreMailEngineEvidence };
