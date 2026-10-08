// Validated archive rows share the SQL table representation. Ownership IDs and
// file/progress seams are explicit; per-table SQL column types can be tightened further.
import type { RowDataPacket } from 'mysql2/promise';
import type { ArchiveEnvelope, BackupPayload, BackupFileSource, SqlExecutor, StoredFlag } from '../types';

export interface RestoreRow extends RowDataPacket {
  id: string;
  user_id: string;
  mail_account_id: string;
  email_id: string;
  folder_id: string;
  rule_id: string;
  recording_id: string;
  tag_id: string;
  event_id: string;
  account_id: string;
  calendar_id: string;
  encrypted_password: string | null;
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  imap_host?: string | null;
  imap_port?: string | number | null;
  smtp_host?: unknown;
  smtp_port?: unknown;
  base_url: string | null;
  discovery_url: string | null;
}
export type RestoreTable = 'calendar_accounts' | 'calendar_calendars' | 'calendar_event_attendees' | 'calendar_event_external_refs' | 'calendar_event_subtasks' | 'calendar_events' | 'contacts' | 'email_attachments' | 'emails' | 'mail_accounts' | 'mail_email_scores' | 'mail_folder_remote_boxes' | 'mail_folders' | 'mail_sender_rules' | 'recording_tag_links' | 'recording_tags' | 'recording_transcription_jobs' | 'recordings' | 'user_settings';
export type RestoreData = BackupPayload['data'] & Partial<Record<RestoreTable, RestoreRow[]>> & { user?: RestoreRow };
export interface RestoreArchive extends ArchiveEnvelope {
  data: RestoreData;
  account_only_sections?: unknown;
  portable_credentials?: Parameters<typeof import('../services/backup-container').decryptPortableCredentialBundle>[0];
}
export interface ImportOptions {
  mode?: string;
  sections?: unknown;
  conflict_mode?: unknown;
  calendar_mode?: unknown;
  credentials_mode?: unknown;
  fileBuffersByPath?: Map<string, Buffer> | null;
  fileSourcesByPath?: Map<string, BackupFileSource> | null;
  portableCredentialKey?: Buffer | null;
  checkCancelled?: (() => Promise<unknown>) | null;
  onProgress?: ((phase: string, progress: number) => Promise<unknown>) | null;
  restoreJobId?: string | null;
  beforeCommit?: ((connection: SqlExecutor, result: Record<string, unknown>) => Promise<unknown>) | null;
  startAccountSync?: (userId: string, accounts: RestoredAccounts) => void;
}
export interface RestoredAccounts { mailAccountIds: string[]; calendarAccountIds: string[] }

export interface ImportResult extends Record<string, unknown> {
  dry_run: boolean;
  valid: boolean;
  errors?: string[];
  warnings: string[];
  counts: Record<string, number>;
  import_sections: string[];
  restored_files?: number;
}

// Mail engine rows of an archive (backup-mail-engine, backup-mail-recovery).
export interface MailRestoreRow extends Record<string, unknown> {
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
export type MailRestoreData = Record<string, MailRestoreRow[] | undefined>;
export interface MailRestoreContext {
  accountIds: Map<string, string>;
  emailIds: Map<string, string>;
  writtenEmailIds: Set<string>;
  restoredPaths: Map<string, string>;
  checkCancelled: () => Promise<unknown>;
  warnings: string[];
}
