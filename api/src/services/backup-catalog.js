// Recovery declarations are shared by export, section scoping and restore locks.
// columns is an explicit archive allowlist. fieldPolicies describes import behavior;
// metadata retained for inspection need not overwrite destination operational state.
const SECTION_POLICIES = Object.freeze({
  settings: { tables: ["user", "user_settings"], fileKinds: [] },
  contacts: { tables: ["contacts"], fileKinds: [] },
  calendar: { tables: ["calendar_accounts", "calendar_calendars", "calendar_events", "calendar_event_subtasks", "calendar_event_attendees", "calendar_event_external_refs"], fileKinds: [] },
  mail: { tables: ["mail_accounts", "mail_folders", "mail_folder_remote_boxes", "mail_sender_rules", "emails", "email_attachments", "mail_email_scores", "mail_folder_reconciliations", "mail_folder_recovery_items", "mail_folder_rule_overrides"], fileKinds: ["email_attachment", "raw_email"] },
  recordings: { tables: ["recordings", "recording_tags", "recording_tag_links", "recording_transcription_jobs"], fileKinds: ["recording"] },
  games: { tables: ["tetris_scores"], fileKinds: [] },
});

function table(section, columns, keyColumns = ['id'], overrides = {}, introducedIn = {}) {
  const names = columns.split(' ');
  return Object.freeze({ section, columns: Object.freeze(names), keyColumns,
    introducedIn: Object.freeze(introducedIn),
    ownership: names.includes('user_id') ? 'user_id' : 'owned_parents',
    fieldPolicies: Object.freeze(Object.fromEntries(names.map(column => [column, overrides[column] || (column === 'id' || column.endsWith('_id') && column !== 'message_id' && column !== 'external_id' && column !== 'external_event_id' && column !== 'content_id' ? 'remap' : column.startsWith('encrypted_') ? 'credential' : ['created_at', 'updated_at'].includes(column) ? 'rebuild' : 'preserve')]))),
  });
}

const TABLE_POLICIES = Object.freeze({
  user: table('settings', 'id email full_name avatar_url role is_active email_verified timezone created_at updated_at', ["id"], {"email": "destination_identity", "role": "destination_identity", "is_active": "destination_identity", "email_verified": "destination_identity"}),
  user_settings: table('settings', 'user_id setting_key setting_value updated_at', ["user_id", "setting_key"], {}),
  contacts: table('contacts', 'id user_id first_name last_name email email2 email3 phone phone2 phone3 company job_title notes avatar_url is_favorite created_at updated_at', ["id"], {}),
  calendar_accounts: table('calendar', 'id user_id provider account_email display_name username encrypted_password discovery_url base_url encrypted_access_token encrypted_refresh_token token_expires_at provider_config capabilities is_active sync_status sync_error last_synced_at created_at updated_at', ["id"], {}),
  calendar_calendars: table('calendar', 'id user_id account_id name external_id color is_visible auto_todo_enabled read_only is_primary sync_token created_at updated_at', ["id"], {}),
  calendar_events: table('calendar', 'id user_id calendar_id title description start_time end_time all_day location color recurrence reminder_minutes reminders todo_status is_todo_only done_at created_at updated_at', ["id"], {}),
  calendar_event_subtasks: table('calendar', 'id event_id user_id title is_done position created_at updated_at', ["id"], {}),
  calendar_event_attendees: table('calendar', 'id user_id event_id email display_name response_status is_organizer optional_attendee comment created_at updated_at', ["id"], {}),
  calendar_event_external_refs: table('calendar', 'id user_id event_id calendar_id account_id provider external_event_id external_etag external_updated_at last_synced_at created_at updated_at', ["id"], {}),
  mail_accounts: table('mail', 'id user_id email_address display_name provider username imap_host imap_port smtp_host smtp_port encrypted_password sync_fetch_limit sync_mode sync_status delete_emails_on_server server_delete_enabled_at server_delete_grace_until server_delete_last_run_at allow_self_signed trusted_imap_fingerprint256 trusted_smtp_fingerprint256 is_active last_synced_at created_at updated_at', ["id"], {"delete_emails_on_server": "reset_server_deletion", "server_delete_enabled_at": "reset_server_deletion", "server_delete_grace_until": "reset_server_deletion", "server_delete_last_run_at": "reset_server_deletion", "sync_status": "reset_sync_progress"}, { sync_mode: 3, sync_status: 3 }),
  mail_folders: table('mail', 'id user_id slug display_name is_system position created_at updated_at mail_account_id special_use', ["id"], {}),
  mail_folder_remote_boxes: table('mail', 'folder_id mail_account_id remote_name created_at updated_at', ["folder_id", "mail_account_id"], {}),
  mail_sender_rules: table('mail', 'id user_id mail_account_id match_type match_value target_folder priority is_active created_at updated_at', ["id"], {}),
  emails: table('mail', 'id user_id mail_account_id message_id subject from_address from_name to_addresses cc_addresses bcc_addresses body_text body_html folder source_folder imap_uid imap_uidvalidity raw_storage_path raw_sha256 is_read is_starred is_draft has_attachments received_at created_at filing_account_id is_legacy import_complete remote_folder remote_uid remote_uidvalidity remote_missing', ["id"], {"raw_storage_path": "restored_file", "body_html": "remap_inline_attachments", "import_complete": "require_raw_file"}, { remote_folder: 3, remote_uid: 3, remote_uidvalidity: 3, remote_missing: 3 }),
  email_attachments: table('mail', 'id email_id user_id filename content_type size_bytes storage_path content_id created_at', ["id"], {"storage_path": "restored_file"}),
  mail_email_scores: table('mail', 'id email_id user_id score_version total_score risk_level spf_result dkim_result dmarc_result language_risk_score sender_reputation_score source_risk_score classifier_confidence reasons metadata scored_at created_at updated_at', ["id"], {}),
  mail_folder_reconciliations: table('mail', 'mail_account_id user_id inventory previous_mappings completed_at', ["mail_account_id"], {"previous_mappings": "remap_journal", "completed_at": "preserve"}),
  mail_folder_recovery_items: table('mail', 'email_id user_id source_account_id original_folder original_filing_account_id target_folder target_account_id action created_at', ["email_id"], { created_at: 'preserve', original_filing_account_id: 'remap_optional_history', target_account_id: 'remap_optional_history' }),
  mail_folder_rule_overrides: table('mail', 'rule_id mail_account_id target_folder', ["rule_id", "mail_account_id"], {}),
  recordings: table('recordings', 'id user_id title description original_filename content_type size_bytes duration_seconds storage_path source category recorded_at metadata created_at updated_at', ["id"], {"storage_path": "restored_file", "created_at": "preserve"}),
  recording_tags: table('recordings', 'id user_id name color created_at updated_at', ["id"], {}),
  recording_tag_links: table('recordings', 'recording_id tag_id user_id created_at', ["recording_id", "tag_id"], {}),
  recording_transcription_jobs: Object.freeze({ ...table('recordings', 'id user_id recording_id status provider model language transcript_text error created_at updated_at', ['id'], { status: 'completed_only', error: 'reset', created_at: 'preserve', updated_at: 'preserve' }), rowPolicy: 'Only completed transcripts are exported; queued, running and failed attempts are not resumed.' }),
  tetris_scores: table('games', 'user_id score lines level achieved_at', ["user_id"], {}),
});


// References describe archive IDs, including logical links without SQL FKs.
// user_id is always rebound to the authenticated destination, never copied.
const REFERENCES = Object.freeze({
  calendar_calendars: { account_id: 'calendar_accounts' },
  calendar_events: { calendar_id: 'calendar_calendars' },
  calendar_event_subtasks: { event_id: 'calendar_events' },
  calendar_event_attendees: { event_id: 'calendar_events' },
  calendar_event_external_refs: { event_id: 'calendar_events', calendar_id: 'calendar_calendars', account_id: 'calendar_accounts' },
  mail_folders: { mail_account_id: 'mail_accounts' },
  mail_folder_remote_boxes: { folder_id: 'mail_folders', mail_account_id: 'mail_accounts' },
  mail_sender_rules: { mail_account_id: 'mail_accounts' },
  emails: { mail_account_id: 'mail_accounts', filing_account_id: 'mail_accounts' },
  email_attachments: { email_id: 'emails' },
  mail_email_scores: { email_id: 'emails' },
  mail_folder_reconciliations: { mail_account_id: 'mail_accounts' },
  mail_folder_recovery_items: { email_id: 'emails', source_account_id: 'mail_accounts', original_filing_account_id: 'mail_accounts', target_account_id: 'mail_accounts' },
  mail_folder_rule_overrides: { rule_id: 'mail_sender_rules', mail_account_id: 'mail_accounts' },
  recording_tag_links: { recording_id: 'recordings', tag_id: 'recording_tags' },
  recording_transcription_jobs: { recording_id: 'recordings' },
});
const FILE_POLICIES = Object.freeze({
  email_attachment: { table: 'email_attachments', column: 'storage_path' },
  raw_email: { table: 'emails', column: 'raw_storage_path' },
  recording: { table: 'recordings', column: 'storage_path' },
});
const WRITE_PATHS = Object.freeze({
  settings: ['/api/settings', '/api/auth/profile'],
  contacts: ['/api/contacts', '/api/settings/clear-contacts'],
  calendar: ['/api/calendar', '/api/settings/clear-calendar'],
  mail: ['/api/mail', '/api/settings/clear-mail-accounts'],
  recordings: ['/api/recordings', '/api/settings/clear-recordings'],
  games: ['/api/games'],
});

const BACKGROUND_WRITERS = Object.freeze({
  settings: [], contacts: [], games: [], recordings: [],
  mail: ['mail.syncMailAccount', 'mail.runMailServerDeletionPass', 'notifications.deliverPending'],
  calendar: ['notifications.reconcileReminders', 'notifications.enqueueDueReminders', 'notifications.deliverPending'],
});
const WRITE_ROUTES = Object.entries(WRITE_PATHS).flatMap(([section, paths]) => paths.map(path => ({ section, path })))
  .sort((a, b) => b.path.length - a.path.length);

function getRestoreSectionForWrite(pathname) {
  if (pathname.startsWith('/api/backup/')) return null;
  if (pathname === '/api/settings/account') return '*';
  // Specific destructive settings actions take precedence over /api/settings.
  return WRITE_ROUTES
    .find(({ path }) => pathname === path || pathname.startsWith(path + '/'))?.section || null;
}

function assertRecoveryCatalog({ sections = SECTION_POLICIES, tables = TABLE_POLICIES, references = REFERENCES, files = FILE_POLICIES, writePaths = WRITE_PATHS, backgroundWriters = BACKGROUND_WRITERS } = {}) {
  const seen = new Set();
  const seenFiles = new Set();
  const fail = message => { throw new Error(`Invalid recovery catalog: ${message}`); };
  for (const [section, policy] of Object.entries(sections)) {
    if (!Array.isArray(backgroundWriters[section])) fail(`${section} has no background-writer declaration`);
    if (!Array.isArray(writePaths[section]) || !writePaths[section].length) fail(`${section} has no write protection declaration`);
    for (const name of policy.tables) {
      if (!tables[name] || tables[name].section !== section || seen.has(name)) fail(`invalid or duplicate section table ${name}`);
      seen.add(name);
    }
    for (const kind of policy.fileKinds) {
      if (!files[kind] || tables[files[kind].table]?.section !== section || seenFiles.has(kind)) fail(`invalid file kind ${kind}`);
      seenFiles.add(kind);
    }
  }
  for (const [name, policy] of Object.entries(tables)) {
    if (!seen.has(name)) fail(`${name} is not exported by any section`);
    if (!policy.keyColumns.length || policy.keyColumns.some(key => !policy.columns.includes(key))) fail(`${name} has invalid keys`);
    for (const [column, treatment] of Object.entries(policy.fieldPolicies)) {
      if ((treatment === 'remap' || treatment === 'remap_optional_history') && !['id', 'user_id'].includes(column) && !references[name]?.[column]) fail(`missing reference ${name}.${column}`);
      if (treatment === 'restored_file' && !Object.values(files).some(file => file.table === name && file.column === column)) fail(`missing file policy ${name}.${column}`);
    }
  }
  for (const [name, fields] of Object.entries(references)) for (const [column, target] of Object.entries(fields)) {
    if (!tables[name]?.columns.includes(column) || !tables[target] || tables[name].section !== tables[target].section) fail(`invalid reference ${name}.${column}`);
  }
  for (const [kind, file] of Object.entries(files)) {
    if (!seenFiles.has(kind) || tables[file.table]?.fieldPolicies[file.column] !== 'restored_file') fail(`unhandled file ${kind}`);
  }
  if (Object.keys(writePaths).some(section => !sections[section])) fail('unknown write section');
}
assertRecoveryCatalog();

function normalizeBackupSections(value = 'full') {
  if (value == null) value = 'full';
  const all = Object.keys(SECTION_POLICIES);
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const sections = new Set();
  for (const item of source) {
    const section = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (section === 'full') { for (const name of all) sections.add(name); }
    else if (section === 'todo') sections.add('calendar');
    else if (Object.hasOwn(SECTION_POLICIES, section)) sections.add(section);
    else throw Object.assign(new Error(`Unsupported backup section: ${String(item)}`), { status: 400, code: 'BACKUP_SECTION_UNSUPPORTED' });
  }
  if (!sections.size) throw Object.assign(new Error('Select at least one backup section.'), { status: 400, code: 'BACKUP_SECTION_UNSUPPORTED' });
  return Array.from(sections);
}

module.exports = { SECTION_POLICIES, TABLE_POLICIES, REFERENCES, FILE_POLICIES, WRITE_PATHS, BACKGROUND_WRITERS, assertRecoveryCatalog, getRestoreSectionForWrite, normalizeBackupSections };
