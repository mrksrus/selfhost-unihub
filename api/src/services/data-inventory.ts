import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
interface ExcludedPolicy { treatment: string; reason: string; columns: readonly string[]; introducedIn?: Readonly<Record<string, number>>; removedIn?: number }
interface InventoryField { treatment: string; introducedIn: number; removedIn: number }
interface ColumnRow { table_name: string; column_name: string }
interface RelationshipRow extends ColumnRow { parent_table: string; parent_column: string }

import imported1 = require('./backup-catalog');
const { TABLE_POLICIES, REFERENCES, assertRecoveryCatalog } = imported1;
import imported2 = require('./mail-engine/recovery-policy');
const { EPHEMERAL_COLUMNS } = imported2;

// Only non-archive data belongs here. Archive fields and their import treatment
// come from the same allowlist used by export; every excluded field is named.
// Fields present in the adopted baseline default to migration 1. Future fields
// declare introducedIn: { column_name: migrationId } on their owning policy so
// baseline verification never requires DDL from a later, pending upgrade.
// Dropped tables declare removedIn: the migration that drops them; from then on
// they must be absent.
function excluded(treatment: string, reason: string, columns: string): ExcludedPolicy {
  return Object.freeze({ treatment, reason, columns: Object.freeze(columns.split(' ')) });
}
const NON_ARCHIVE_POLICIES: Readonly<Record<string, ExcludedPolicy>> = Object.freeze({
  ...Object.fromEntries(Object.entries(EPHEMERAL_COLUMNS).map(([name, columns]) => [name, Object.freeze({
    ...excluded('rebuilt', 'Installation-local leases, jobs and coverage are invalid after restore; accepted intents and attempts are exported separately and quarantined.', columns),
    introducedIn: Object.fromEntries(columns.split(' ').map(column =>
      [column, name === 'mail_engine_jobs' && column === 'manual_refresh' ? 8 : 6])),
  })])),
  users: excluded('security_only', 'Login credentials and 2FA stay with the destination identity.', 'password_hash two_factor_enabled encrypted_two_factor_secret two_factor_recovery_codes'),
  // Calendar sync state is rediscovered from the server by the next sync. A
  // restored CalDAV account is linked to its mail account again by address.
  ...Object.fromEntries([
    ['calendar_accounts', 'Mail account links and sync schedules belong to this installation; the link is restored by address.', 'mail_account_id next_sync_at'],
    ['calendar_calendars', 'Server change markers are read again by the next calendar sync.', 'remote_ctag remote_expanded_on'],
    ['calendar_event_external_refs', 'Links to server copies are rebuilt by the next calendar sync.', 'remote_object_id recurrence_id'],
    ['calendar_remote_objects', 'Server copies of calendar entries are downloaded again by the next calendar sync.', 'id user_id account_id calendar_id href href_hash etag uid ics created_at updated_at'],
  ].map(([name, reason, columns]) => [name, Object.freeze({ ...excluded('rebuilt', reason, columns),
    introducedIn: Object.fromEntries(columns.split(' ').map(column => [column, 12])) })])),
  sessions: excluded('security_only', 'A restore must not resurrect authenticated sessions.', 'id user_id token expires_at ip_address user_agent created_at'),
  two_factor_challenges: excluded('security_only', 'Login challenges expire and must not be restored.', 'id user_id token_hash expires_at ip_address user_agent created_at'),
  system_settings: excluded('deliberately_excluded', 'Server administration and installation migration markers are outside user recovery.', 'setting_key setting_value updated_at'),
  mail_server_messages: excluded('rebuilt', 'Provider deletion bookkeeping is rediscovered; restore must not replay remote deletes.', 'id user_id mail_account_id email_id source_folder imap_uid imap_uidvalidity delete_status delete_attempts delete_error deleted_at created_at updated_at'),
  mail_sync_state: excluded('rebuilt', 'Provider UID progress is rediscovered after restore.', 'mail_account_id source_folder uidvalidity last_uid initialized last_synced_at'),
  recording_uploads: excluded('temporary', 'Incomplete upload chunks expire; only completed recordings are archived.', 'id user_id title description original_filename content_type total_bytes bytes_received duration_seconds source category recorded_at metadata tags temp_path expires_at created_at updated_at'),
  data_export_jobs: Object.freeze({ ...excluded('temporary', 'Archive jobs and download paths belong to the originating installation.', 'id user_id scope status phase progress cancel_requested requested_sections file_path file_size file_sha256 content_type encryption_enabled backup_uuid error created_at updated_at started_at completed_at downloaded_at mail_account_id'),
    introducedIn: Object.freeze({ mail_account_id: 10 }) }),
  backup_restore_jobs: excluded('temporary', 'A restore must not resume jobs from the originating installation.', 'id user_id source_type source_export_job_id status operation phase progress cancel_requested requested_sections conflict_mode calendar_mode credentials_mode archive_path archive_size archive_sha256 backup_uuid is_encrypted validation_result result_counts error attempt_count created_at updated_at started_at completed_at expires_at'),
  backup_archive_keys: excluded('security_only', 'Archive unlock keys are installation secrets with their own recovery password.', 'backup_uuid user_id export_job_id restore_job_id server_wrapped_key recovery_password_ciphertext recovery_password_revealed_at expires_at created_at updated_at'),
  notification_config: excluded('security_only', 'Push identity and scan cursors are generated by the destination server.', 'id public_key encrypted_private_key subject last_reminder_scan_at reminder_revision scanned_revision created_at'),
  push_subscriptions: excluded('security_only', 'Browser push credentials belong to a current authenticated session.', 'id user_id session_id endpoint endpoint_hash p256dh auth created_at updated_at'),
  notification_events: excluded('rebuilt', 'Expired or pending notifications must not be replayed during recovery.', 'id user_id event_key kind source_id payload expires_at created_at'),
  notification_deliveries: excluded('rebuilt', 'Delivery attempts belong to destination browser subscriptions.', 'event_id subscription_id status attempts available_at delivered_at last_error'),
  notification_reminders: excluded('rebuilt', 'Reminders are scheduled again from restored calendar events.', 'event_id user_id minutes due_at queued_at'),
  tetris_scores: excluded('deliberately_excluded', 'The Games module was removed in 0.12.0; existing scores stay in the database but are no longer used or exported.', 'user_id score lines level achieved_at'),
  ...Object.fromEntries(Object.entries({
    notes: 'id origin_key user_id title body revision trashed_at created_at updated_at',
    note_revisions: 'id user_id note_id revision title body created_at',
    note_attachments: 'id user_id note_id filename content_type size_bytes storage_path created_at',
    note_links: 'user_id note_id linked_note_id',
  }).map(([name, columns]) => [name, Object.freeze({
    ...excluded('deliberately_excluded', 'The Notes module was removed in 0.14.0; migration 11 drops its tables and files.', columns),
    introducedIn: Object.fromEntries(columns.split(' ').map(column => [column, 4])), removedIn: 11 })])),
  schema_migrations: excluded('deliberately_excluded', 'Database upgrade history describes this installation, never user archive contents.', 'id name completed_at'),
});
const NOTIFICATION_TABLES = new Set(['notification_config', 'push_subscriptions', 'notification_events', 'notification_deliveries', 'notification_reminders']);

function declaredFields() {
  assertRecoveryCatalog();
  const fields = new Map<string, InventoryField>();
  function add(table: string, column: string, policy: string, introducedIn = 1, removedIn = Infinity) {
    const key = `${table}.${column}`;
    if (!policy || !Number.isSafeInteger(introducedIn) || introducedIn < 1 || !(removedIn > introducedIn) || fields.has(key)) throw new Error(`Invalid or duplicate data policy: ${key}`);
    fields.set(key, { treatment: policy, introducedIn, removedIn });
  }
  for (const [key, policy] of Object.entries(TABLE_POLICIES)) {
    const table = key === 'user' ? 'users' : key;
    if (Object.keys(policy.fieldPolicies).length !== policy.columns.length) throw new Error(`Archive policy mismatch: ${table}`);
    for (const column of policy.columns) add(table, column, policy.fieldPolicies[column], policy.introducedIn?.[column]);
  }
  for (const [table, policy] of Object.entries(NON_ARCHIVE_POLICIES)) {
    if (!policy.reason) throw new Error(`Missing exclusion reason: ${table}`);
    for (const column of policy.columns) add(table, column, policy.treatment, policy.introducedIn?.[column], policy.removedIn);
  }
  return fields;
}

function assertInventoryCoverage(rows: readonly ColumnRow[], { includeNotifications = true, requireAll = true, throughMigration = Infinity } = {}) {
  const fields = declaredFields();
  const removed = (policy: InventoryField) => Number.isFinite(policy.removedIn) && policy.removedIn <= throughMigration;
  const actual = new Set();
  const failures = [];
  for (const row of rows) {
    if (!includeNotifications && NOTIFICATION_TABLES.has(row.table_name)) continue;
    const key = `${row.table_name}.${row.column_name}`;
    actual.add(key);
    if (!fields.has(key)) failures.push(`Unclassified field ${key}`);
    else if (removed(fields.get(key)!)) failures.push(`Removed field still present ${key}`);
  }
  if (requireAll) for (const [key, policy] of fields) {
    if (policy.introducedIn > throughMigration || removed(policy)) continue;
    if (!includeNotifications && NOTIFICATION_TABLES.has(key.split('.')[0])) continue;
    if (!actual.has(key)) failures.push(`Missing declared field ${key}`);
  }
  if (failures.length) throw new Error(`Database recovery inventory failed:\n${failures.join('\n')}`);
}

async function verifyDatabaseInventory(connection: SqlExecutor, options?: Parameters<typeof assertInventoryCoverage>[1]) {
  const [rows] = await connection.execute<(RowDataPacket & ColumnRow)[]>(`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`);
  assertInventoryCoverage(rows, options);
  const [references] = await connection.execute<(RowDataPacket & RelationshipRow)[]>(`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
    REFERENCED_TABLE_NAME AS parent_table, REFERENCED_COLUMN_NAME AS parent_column
    FROM information_schema.KEY_COLUMN_USAGE
    WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`);
  assertArchiveRelationships(references);
}

function assertArchiveRelationships(rows: readonly RelationshipRow[]) {
  for (const row of rows) {
    const table = row.table_name === 'users' ? 'user' : row.table_name;
    if (!TABLE_POLICIES[table]) continue; // Non-archive relationships are not restored.
    const parent = row.column_name === 'user_id' ? 'users' : REFERENCES[table]?.[row.column_name];
    if (!parent || parent !== row.parent_table || row.parent_column !== 'id') {
      throw new Error(`Unclassified recovery relationship ${row.table_name}.${row.column_name} -> ${row.parent_table}.${row.parent_column}`);
    }
  }
}

export = { NON_ARCHIVE_POLICIES, assertInventoryCoverage, assertArchiveRelationships, verifyDatabaseInventory };
