// Explicit recovery inventory for the additive mail-engine migration (6).
// Provider mappings/attempts are exported as evidence, not executable restore jobs.
const ARCHIVE_COLUMNS = Object.freeze({
  mail_remote_mailboxes: 'id user_id mail_account_id remote_name delimiter special_use provider_mailbox_id uidvalidity state epoch_revision created_at updated_at',
  mail_remote_occurrences: 'id user_id mail_account_id mailbox_id uidvalidity uid email_id observed_flags observed_modseq gmail_msgid presence observation_revision observed_at absent_at quarantine_reason created_at updated_at internal_date',
  mail_gmail_messages: 'mail_account_id gmail_msgid user_id email_id created_at',
  mail_writebacks: 'id user_id mail_account_id email_id action target_value base_value target_folder remote_folder remote_uid remote_uidvalidity status attempts dispatched dispatch_modseq error available_at created_at updated_at state is_current intent_revision client_key source_occurrence_id evidence_json',
  mail_operation_attempts: 'id operation_id user_id mail_account_id worker_generation dispatch_fence outcome transmission evidence_json started_at dispatched_at completed_at',
  mail_command_receipts: 'user_id client_key request_hash response_json created_at updated_at',
  mail_engine_quarantine: 'source_table source_id user_id mail_account_id reason evidence_json created_at',
});
const ARCHIVE_KEYS = Object.freeze({
  mail_gmail_messages: ['mail_account_id', 'gmail_msgid'],
  mail_command_receipts: ['user_id', 'client_key'],
  mail_engine_quarantine: ['source_table', 'source_id', 'reason'],
});
const EPHEMERAL_COLUMNS = Object.freeze({
  mail_engine_cursors: 'mailbox_id stream user_id mail_account_id uidvalidity window_start window_end covered_through checkpoint sweep_generation coverage_json last_covered_at updated_at',
  mail_engine_accounts: 'mail_account_id user_id generation lease_owner lease_until paused_reason updated_at',
  mail_engine_jobs: 'id user_id mail_account_id mailbox_id operation_id kind priority state phase due_at lease_owner lease_until worker_generation cancellation_requested processed total coverage_json error started_at completed_at heartbeat_at created_at updated_at manual_refresh',
  mail_engine_migration_progress: 'source_table last_id processed updated_at',
});
const EXTRA_COLUMNS = Object.freeze({
  mail_accounts: 'disconnected_at engine_version',
  emails: 'observation_revision observed_modseq raw_format raw_bytes raw_verified content_state',
});
// Archive fields added by later numbered migrations (default: 5/6 as above).
const LATER_ARCHIVE_FIELDS = Object.freeze({ 'mail_remote_occurrences.internal_date': 10 });
const NEW_OPERATION_COLUMNS = new Set('state is_current intent_revision client_key source_occurrence_id evidence_json'.split(' '));
export = { LATER_ARCHIVE_FIELDS, ARCHIVE_COLUMNS, ARCHIVE_KEYS, EPHEMERAL_COLUMNS, EXTRA_COLUMNS, NEW_OPERATION_COLUMNS };
