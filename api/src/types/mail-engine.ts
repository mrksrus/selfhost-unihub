import type { Pool } from 'mysql2/promise';
import type { SqlExecutor, StoredFlag } from '../types';

export type EngineExecutor = SqlExecutor & Partial<Pick<Pool, 'getConnection'>>;
export interface MailboxInput { userId: string; accountId: string; mailboxId: string; epoch: string | number | bigint }
export interface OccurrenceInput extends MailboxInput { uid: string | number | bigint }
export interface CursorInput extends MailboxInput { stream: string }
export interface MailboxMetadata {
  delimiter?: string | null;
  specialUse?: string | null;
  providerMailboxId?: string | null;
  allowEpochChange?: boolean;
  localFolderSlug?: string;
}
export interface RemoteMailbox {
  id: string;
  user_id: string;
  mail_account_id: string;
  remote_name: string;
  uidvalidity: number | string | null;
  state: string;
  epoch_revision: number;
}
export interface RemoteOccurrence {
  id: string;
  email_id: string;
  uid: number;
  uidvalidity: number | string;
  presence: string;
  observed_modseq: string | null;
  observation_revision: number;
  observed_flags: string;
  gmail_msgid: string | null;
}
export interface MailCursor {
  mailbox_id: string;
  stream: string;
  uidvalidity: string | number;
  covered_through: number;
  checkpoint: string | null;
  sweep_generation: number;
  window_start: number;
  window_end: number;
  coverage_json: unknown;
}

export interface EngineJob {
  id: string;
  user_id: string;
  mail_account_id: string;
  mailbox_id: string | null;
  operation_id: string | null;
  kind: string;
  state: string;
  phase: string | null;
  priority: number;
  worker_generation: number | string | null;
  coverage_json?: unknown;
  started_at?: Date | string | null;
  updated_at?: Date | string | null;
  completed_at?: Date | string | null;
  cancellation_requested?: unknown;
  error?: string | null;
  lease_owner?: string | null;
  manual_refresh: number;
  processed: number;
  total: number | null;
}
/** A job returned by claimDueJob: running under this worker's lease. */
export type ClaimedJob = EngineJob & { worker_generation: number; lease_owner: string };
export interface JobOwner { userId: string; accountId: string }
export interface WorkerFence { accountId: string; workerId: string; generation: number; jobId?: string | null }
export interface EnqueueJob extends JobOwner {
  mailboxId?: string | null;
  operationId?: string | null;
  kind?: string;
  priority?: number;
  dueAt?: Date | null;
  foreground?: boolean;
  manualRefresh?: boolean;
}

export interface ProviderOperation {
  id: string;
  user_id: string;
  mail_account_id: string;
  email_id: string;
  action: string;
  state: string;
  target_value: string;
  target_folder: string | null;
  remote_folder: string | null;
  remote_uid: string | number | bigint | null;
  remote_uidvalidity: string | number | bigint | null;
  source_occurrence_id?: string | null;
  intent_revision: number;
  created_at: Date | string;
}
/** A full mail_writebacks row (SELECT *). */
export interface OperationRow extends ProviderOperation {
  is_current: StoredFlag;
  dispatched: StoredFlag;
  attempts: number;
  evidence_json?: unknown;
}
