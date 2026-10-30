import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';

import { TABLE_POLICIES, REFERENCES, assertRecoveryCatalog } from './backup-catalog';
import { EPHEMERAL_COLUMNS } from './mail-engine/recovery-policy';

interface ExcludedPolicy {
  treatment: string;
  reason: string;
  columns: readonly string[];
  introducedIn?: Readonly<Record<string, number>>;
  removedIn?: number;
}
interface InventoryField { treatment: string; introducedIn: number; removedIn: number }
interface ColumnRow { table_name: string; column_name: string }
interface RelationshipRow extends ColumnRow { parent_table: string; parent_column: string }

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
  audit_log: Object.freeze({ ...excluded('deliberately_excluded', 'The audit trail records what happened on this installation; a restore must neither carry it elsewhere nor rewrite it.',
    'id created_at actor_id action target_user_id ip_address request_id details'),
  introducedIn: Object.freeze(Object.fromEntries('id created_at actor_id action target_user_id ip_address request_id details'.split(' ').map(column => [column, 19]))) }),
  two_factor_challenges: excluded('security_only', 'Login challenges expire and must not be restored.', 'id user_id token_hash expires_at ip_address user_agent created_at'),
  system_settings: excluded('deliberately_excluded', 'Server administration and installation migration markers are outside user recovery.', 'setting_key setting_value updated_at'),
  mail_server_messages: excluded('rebuilt', 'Provider deletion bookkeeping is rediscovered; restore must not replay remote deletes.', 'id user_id mail_account_id email_id source_folder imap_uid imap_uidvalidity delete_status delete_attempts delete_error deleted_at created_at updated_at'),
  mail_sync_state: excluded('rebuilt', 'Provider UID progress is rediscovered after restore.', 'mail_account_id source_folder uidvalidity last_uid initialized last_synced_at'),
  recording_uploads: excluded('temporary', 'Incomplete upload chunks expire; only completed recordings are archived.', 'id user_id title description original_filename content_type total_bytes bytes_received duration_seconds source category recorded_at metadata tags temp_path expires_at created_at updated_at'),
  data_export_jobs: Object.freeze({ ...excluded('temporary', 'Archive jobs and download paths belong to the originating installation.', 'id user_id scope status phase progress cancel_requested requested_sections file_path file_size file_sha256 content_type encryption_enabled backup_uuid error created_at updated_at started_at completed_at downloaded_at mail_account_id'),
    introducedIn: Object.freeze({ mail_account_id: 10 }) }),
  backup_restore_jobs: excluded('temporary', 'A restore must not resume jobs from the originating installation.', 'id user_id source_type source_export_job_id status operation phase progress cancel_requested requested_sections conflict_mode calendar_mode credentials_mode archive_path archive_size archive_sha256 backup_uuid is_encrypted validation_result result_counts error attempt_count created_at updated_at started_at completed_at expires_at'),
  backup_archive_keys: excluded('security_only', 'Archive unlock keys are installation secrets with their own recovery password.', 'backup_uuid user_id export_job_id restore_job_id server_wrapped_key recovery_password_ciphertext recovery_password_revealed_at expires_at created_at updated_at'),
  // Created by upgrade step 15 (the notification service created them at
  // every start before 0.19.2, so older databases have them earlier).
  ...Object.fromEntries([
    ['notification_config', 'security_only', 'Push identity and scan cursors are generated by the destination server.', 'id public_key encrypted_private_key subject last_reminder_scan_at reminder_revision scanned_revision created_at'],
    ['push_subscriptions', 'security_only', 'Browser and app push credentials belong to a current authenticated session.', 'id user_id session_id endpoint endpoint_hash p256dh auth created_at updated_at transport'],
    ['notification_events', 'rebuilt', 'Expired or pending notifications must not be replayed during recovery.', 'id user_id event_key kind source_id payload expires_at created_at'],
    ['notification_deliveries', 'rebuilt', 'Delivery attempts belong to destination browser subscriptions.', 'event_id subscription_id status attempts available_at delivered_at last_error'],
    ['notification_reminders', 'rebuilt', 'Reminders are scheduled again from restored calendar events.', 'event_id user_id minutes due_at queued_at'],
  ].map(([name, treatment, reason, columns]) => [name, Object.freeze({ ...excluded(treatment, reason, columns),
    // The transport column comes with upgrade step 17 (Android devices).
    introducedIn: Object.fromEntries(columns.split(' ').map(column => [column, name === 'push_subscriptions' && column === 'transport' ? 17 : 15])) })])),
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
  // Upgrade step 20 (0.24.0).
  ...Object.fromEntries([
    ['setting_policies', 'deliberately_excluded', 'Administrator policies belong to the installation, not to one person; the instance backup carries them.', 'target_kind target_id setting_key setting_value locked updated_by updated_at'],
    ['mail_scheduled_sends', 'deliberately_excluded', 'A restore must not send mail again; the draft is restored and can be scheduled again.', 'id user_id email_id mail_account_id send_at status origin client_key attempts last_error created_at updated_at'],
  ].map(([name, treatment, reason, columns]) => [name, Object.freeze({ ...excluded(treatment, reason, columns),
    introducedIn: Object.fromEntries(columns.split(' ').map(column => [column, 20])) })])),
  // Upgrade step 21 (0.25.0).
  file_tickets: Object.freeze({ ...excluded('security_only', 'Download tickets are single-use credentials of a live session; a restore must not bring them back.',
    'id token_hash user_id session_id kind resource_id expires_at created_at'),
  introducedIn: Object.freeze(Object.fromEntries('id token_hash user_id session_id kind resource_id expires_at created_at'.split(' ').map(column => [column, 21]))) }),
  // The fixed 3+3 fields: copied into contact_values by upgrade step 22 and
  // dropped by step 23. Archives up to version 4 still carry them
  // (RETIRED_ARCHIVE_FIELDS); avatar_url was never filled.
  contacts: Object.freeze({ ...excluded('converted', 'Upgrade 22 copies the fixed email and phone fields into contact_values; upgrade 23 drops them.',
    'email email2 email3 phone phone2 phone3 avatar_url'), removedIn: 23 }),
  // Upgrade step 22 (0.26.0).
  ...Object.fromEntries([
    ['contact_merges', 'deliberately_excluded', 'Merge records are a 30-day undo on this installation; a restore brings back contacts, not their undo (0.28 decides the bin with D13).',
      'id user_id survivor_id merged_ids survivor_before survivor_version_after created_at purge_after undone_at'],
    ['bin_items', 'deliberately_excluded', 'The bin keeps merged-away contacts for 30 days on this installation; 0.28 decides how the bin is backed up (D13).',
      'id user_id module item_type item_id title reason group_id payload payload_version file_refs deleted_at purge_after restored_at'],
    ['contact_imports', 'temporary', 'A staged import file expires after 24 hours and belongs to this installation.',
      'id user_id status format file_path summary result progress created_at expires_at committed_at'],
  ].map(([name, treatment, reason, columns]) => [name, Object.freeze({ ...excluded(treatment, reason, columns),
    introducedIn: Object.fromEntries(columns.split(' ').map(column => [column, 22])) })])),
  // Upgrade step 24 (0.27.0).
  calendar_event_moves: Object.freeze({ ...excluded('deliberately_excluded', 'A move in progress writes to calendar servers; a restore must not replay provider writes. The task comes back as archived, in whichever calendar held it.',
    'id user_id event_id source_calendar_id source_object_id target_calendar_id target_uid target_href target_etag target_ics state attempts last_error next_attempt_at created_at updated_at'),
  introducedIn: Object.freeze(Object.fromEntries('id user_id event_id source_calendar_id source_object_id target_calendar_id target_uid target_href target_etag target_ics state attempts last_error next_attempt_at created_at updated_at'.split(' ').map(column => [column, 24]))) }),
});

// From upgrade step 20 on, a new table states who owns a row, whether it can
// be shared, its data class (F2), the module that gates it and what restore
// does with it (AGENTS.md, Building toward 1.0).
const DECLARATIONS_FROM = 20;
interface TableDeclaration {
  owner: 'user' | 'organisation' | 'installation';
  shareable: boolean;
  dataClass: 'local' | 'local-by-policy' | 'mirror' | 'org' | 'config' | 'installation' | 'ciphertext';
  module: string | null;
  restore: string;
}
const TABLE_DECLARATIONS: Readonly<Record<string, TableDeclaration>> = Object.freeze({
  mail_account_settings: { owner: 'user', shareable: false, dataClass: 'local', module: 'mail', restore: 'Restored with its mail account; folder references follow the restored folders.' },
  mail_templates: { owner: 'user', shareable: false, dataClass: 'local', module: 'mail', restore: 'Restored with the Mail section.' },
  calendar_settings: { owner: 'user', shareable: false, dataClass: 'local', module: 'calendar', restore: 'Restored with its calendar.' },
  setting_policies: { owner: 'installation', shareable: false, dataClass: 'config', module: null, restore: 'Not in personal backups; the instance backup carries it.' },
  mail_scheduled_sends: { owner: 'user', shareable: false, dataClass: 'installation', module: 'mail', restore: 'Never restored: the draft comes back unscheduled.' },
  // Each ticket's kind names the module that gates it (services/file-tickets.ts).
  file_tickets: { owner: 'user', shareable: false, dataClass: 'installation', module: null, restore: 'Never restored: a ticket is a single-use credential of a live session.' },
  // Upgrade step 22 (0.26.0): the vCard model of contacts (F12).
  contact_values: { owner: 'user', shareable: false, dataClass: 'local', module: 'contacts', restore: 'Restored with its contact, which it replaces wholesale; ids remapped.' },
  contact_properties: { owner: 'user', shareable: false, dataClass: 'local', module: 'contacts', restore: 'Restored with its contact, which it replaces wholesale; ids remapped.' },
  contact_photos: { owner: 'user', shareable: false, dataClass: 'local', module: 'contacts', restore: 'Restored with its contact and its photo files.' },
  contact_uid_aliases: { owner: 'user', shareable: false, dataClass: 'local', module: 'contacts', restore: 'Restored with the contact it points to.' },
  contact_duplicate_dismissals: { owner: 'user', shareable: false, dataClass: 'local', module: 'contacts', restore: 'Restored when both contacts are; ids remapped.' },
  contact_merges: { owner: 'user', shareable: false, dataClass: 'local', module: 'contacts', restore: 'Not archived in 0.26: a restore brings back contacts, not a 30-day undo.' },
  // Each item's module column names the module that gates it.
  bin_items: { owner: 'user', shareable: false, dataClass: 'local', module: null, restore: 'Not archived in 0.26; 0.28 decides the bin with D13.' },
  contact_imports: { owner: 'user', shareable: false, dataClass: 'installation', module: 'contacts', restore: 'Never restored: a staged import expires after 24 hours.' },
  // Upgrade step 24 (0.27.0). The hand order is UniHub's own overlay on
  // tasks, including mirrored ones: keyed by the provider identity (calendar,
  // UID, recurrence id) for those, so a re-sync or restore matches it again.
  task_order: { owner: 'user', shareable: false, dataClass: 'local', module: 'calendar', restore: 'Restored with the Calendar section; calendar and event ids remapped, the key rebuilt. A synced task\'s order matches its UID after the next sync.' },
  calendar_event_moves: { owner: 'user', shareable: false, dataClass: 'installation', module: 'calendar', restore: 'Never restored: a restore must not replay provider writes.' },
});

function assertTableDeclarations(fields: ReadonlyMap<string, InventoryField>) {
  const firstStep = new Map<string, number>();
  for (const [key, field] of fields) {
    const table = key.slice(0, key.indexOf('.'));
    firstStep.set(table, Math.min(firstStep.get(table) ?? Infinity, field.introducedIn));
  }
  for (const [table, step] of firstStep) {
    if (step >= DECLARATIONS_FROM && !TABLE_DECLARATIONS[table]) throw new Error(`Table ${table} lacks its declaration (owner, sharing, data class, module, restore)`);
  }
  for (const table of Object.keys(TABLE_DECLARATIONS)) {
    if ((firstStep.get(table) ?? 0) < DECLARATIONS_FROM) throw new Error(`Declared table ${table} is not a table from step ${DECLARATIONS_FROM} on`);
  }
}

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
  assertTableDeclarations(fields);
  return fields;
}

// includeNotifications is accepted for the frozen 0.16.0 baseline, which still
// passes it; the notification tables are now ordinary step-15 fields, so the
// throughMigration bound already covers them and the option has no effect.
function assertInventoryCoverage(rows: readonly ColumnRow[], { requireAll = true, throughMigration = Infinity }: { includeNotifications?: boolean; requireAll?: boolean; throughMigration?: number } = {}) {
  const fields = declaredFields();
  const removed = (policy: InventoryField) => Number.isFinite(policy.removedIn) && policy.removedIn <= throughMigration;
  const actual = new Set();
  const failures = [];
  for (const row of rows) {
    const key = `${row.table_name}.${row.column_name}`;
    actual.add(key);
    if (!fields.has(key)) failures.push(`Unclassified field ${key}`);
    else if (removed(fields.get(key)!)) failures.push(`Removed field still present ${key}`);
  }
  if (requireAll) for (const [key, policy] of fields) {
    if (policy.introducedIn > throughMigration || removed(policy)) continue;
    // A field a later step removes may already be gone when an earlier step
    // is verified again after an interrupted upgrade (step 23 drops the
    // fixed contact fields that steps 12 to 22 still list).
    if (Number.isFinite(policy.removedIn) && !actual.has(key)) continue;
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

export { NON_ARCHIVE_POLICIES, TABLE_DECLARATIONS, declaredFields, assertInventoryCoverage, assertArchiveRelationships, verifyDatabaseInventory };
