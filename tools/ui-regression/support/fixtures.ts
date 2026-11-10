// Synthetic data and the /api router for the browser checks. Shapes follow the
// frontend's API types (src/lib/*-api.ts, src/hooks/use-*-queries.ts) and the
// offline snapshot reader (src/lib/offline.ts), which rebuilds the same
// responses. Names and addresses use reserved example domains only.

/** The fixed "now" of every run: Monday 15 June 2026, 09:30 UTC. */
export const FIXED_NOW = new Date('2026-06-15T09:30:00Z');
const at = (iso: string) => `2026-${iso}`;
const STAMP = at('06-01T08:00:00.000Z');
/** Defaults overridden by a row's own fields, typed as the result. */
const row = <B extends object, T extends object>(defaults: B, fields: T) => ({ ...defaults, ...fields }) as Omit<B, keyof T> & T;

export const USER = {
  id: 'user-ada', email: 'ada@example.com', full_name: 'Ada Example', role: 'user' as const,
  timezone: 'UTC', two_factor_enabled: false,
};

const MODULES = [
  { id: 'mail', label: 'Mail', visible: true, enabled: true, background: true, backgroundSupported: true },
  { id: 'calendar', label: 'Calendar and ToDo', visible: true, enabled: true, background: true, backgroundSupported: true },
  { id: 'contacts', label: 'Contacts', visible: true, enabled: true, background: false, backgroundSupported: false },
  { id: 'recordings', label: 'Recordings and Music', visible: true, enabled: true, background: false, backgroundSupported: false },
];
const PAGES = [
  { id: 'mail', label: 'Mail', module: 'mail', visible: true },
  { id: 'todo', label: 'ToDo', module: 'calendar', visible: true },
  { id: 'calendar', label: 'Calendar', module: 'calendar', visible: true },
  { id: 'contacts', label: 'Contacts', module: 'contacts', visible: true },
  { id: 'recordings', label: 'Recordings', module: 'recordings', visible: true },
  { id: 'music', label: 'Music', module: 'recordings', visible: true },
  { id: 'today', label: 'Today', module: null, visible: true },
];

const PREFERENCES = { email_link_behavior: 'internal', default_start_page: 'mail', default_mail_account_id: 'acct-work', accent_color: 'blue' };
// GET /settings/values (0.24): the same choices as resolved settings; the
// frontend fills every other setting with its default.
const SETTINGS = Object.fromEntries(Object.entries(PREFERENCES).map(([key, value]) => [key, { value, source: 'user', locked: false }]));

const MAIL_ACCOUNTS = [
  { id: 'acct-work', email_address: 'ada@work.example.com', display_name: 'Work', provider: 'imap', is_active: true,
    has_saved_password: true, last_synced_at: at('06-15T09:25:00.000Z'), sync_mode: 'sync', sync_status: 'ok',
    sync_policy_confirmed: true, sync_window_days: null, trash_window_days: 30, delete_emails_on_server: false, sync_warnings: [] },
  { id: 'acct-home', email_address: 'ada@home.example.org', display_name: 'Home', provider: 'imap', is_active: true,
    has_saved_password: true, last_synced_at: at('06-15T09:20:00.000Z'), sync_mode: 'download', sync_status: 'ok',
    delete_emails_on_server: false, sync_warnings: [] },
];

const FOLDERS = [
  { id: 'f-inbox', slug: 'inbox', display_name: 'Inbox', is_system: true, position: 0, special_use: '\\Inbox' },
  { id: 'f-starred', slug: 'starred', display_name: 'Starred', is_system: true, position: 1 },
  { id: 'f-sent', slug: 'sent', display_name: 'Sent', is_system: true, position: 2, special_use: '\\Sent' },
  { id: 'f-drafts', slug: 'drafts', display_name: 'Drafts', is_system: true, position: 3, special_use: '\\Drafts' },
  { id: 'f-archive', slug: 'archive', display_name: 'Archive', is_system: true, position: 4, special_use: '\\Archive' },
  { id: 'f-trash', slug: 'trash', display_name: 'Trash', is_system: true, position: 5, special_use: '\\Trash' },
  { id: 'f-projects', slug: 'projects', display_name: 'Projects', is_system: false, position: 6,
    mail_account_id: 'acct-work', connected_account_ids: ['acct-work'] },
];

const email = <T extends object>(id: string, account: string, minutesAgo: number, fields: T) => row({
  id, mail_account_id: account, folder: 'inbox', is_read: true, is_starred: false, is_draft: false,
  to_addresses: [account === 'acct-work' ? 'ada@work.example.com' : 'ada@home.example.org'],
  cc_addresses: [], bcc_addresses: [], body_html: null, has_attachments: false, attachments: [], tasks: [], task_count: 0,
  received_at: new Date(FIXED_NOW.getTime() - minutesAgo * 60_000).toISOString(),
}, fields);

export const EMAILS = [
  email('mail-1', 'acct-work', 12, {
    subject: 'Quarterly planning notes for the platform, infrastructure and documentation working groups, with the revised schedule',
    from_name: 'Grace Hopper', from_address: 'grace@example.com', is_read: false, has_attachments: true,
    attachments: [{ id: 'att-1', filename: 'planning-notes.pdf', content_type: 'application/pdf', size_bytes: 48213 }],
    body_text: 'Hi Ada,\n\nHere are the notes from Thursday. The revised schedule moves the documentation review to the second week of July so the platform group can finish the migration first.\n\nAction items:\n- Confirm the review dates with the infrastructure group\n- Share the updated roadmap draft by Friday\n- Book the large meeting room for the kickoff\n\nThanks,\nGrace',
  }),
  email('mail-2', 'acct-work', 55, {
    subject: 'Re: Design review', from_name: 'Alan Turing', from_address: 'alan@example.net', is_starred: true,
    body_text: 'The new layout works for me. One question about the panel width on small laptops.', task_count: 1,
  }),
  email('mail-3', 'acct-home', 140, {
    subject: 'Garden club meeting moved to Saturday', from_name: 'Katherine Johnson', from_address: 'katherine@example.org', is_read: false,
    body_text: 'We meet at ten in the community hall this week.',
  }),
  email('mail-4', 'acct-work', 600, {
    subject: 'Invoice 2026-0612', from_name: null, from_address: 'billing@example.com',
    body_text: 'Your invoice for June is attached.', has_attachments: true,
    attachments: [{ id: 'att-2', filename: 'invoice-2026-0612.pdf', content_type: 'application/pdf', size_bytes: 20480 }],
  }),
  email('mail-5', 'acct-home', 1500, {
    subject: 'Photos from the weekend', from_name: 'Margaret Hamilton', from_address: 'margaret@example.org',
    body_text: 'A few pictures from the hike.',
  }),
  email('mail-6', 'acct-work', 2900, {
    subject: 'Build status: all checks passed', from_name: 'CI Robot', from_address: 'ci@example.com',
    body_text: 'Pipeline 1234 finished successfully.',
  }),
];

const CALENDAR_ACCOUNT = {
  id: 'cal-acct-local', user_id: USER.id, provider: 'local', account_email: null, display_name: 'On this server',
  token_expires_at: null, provider_config: {}, capabilities: {}, is_active: true, sync_status: 'ok', sync_error: null,
  last_synced_at: null, next_sync_at: null, mail_account_id: null, created_at: STAMP, updated_at: STAMP,
};
// A calendar server account, so the list chooser (0.27) shows a second group
// and a calendar that takes no task without a date.
const CALDAV_ACCOUNT = {
  ...CALENDAR_ACCOUNT, id: 'cal-acct-work', provider: 'caldav', account_email: 'ada@work.example.com', display_name: 'Work',
  mail_account_id: 'acct-work', last_synced_at: at('06-15T09:20:00.000Z'),
};
// The choice fields of GET /calendar/calendars (api/src/contracts/tasks.ts,
// 0.27): where new items go and what each calendar can take.
const calendar = (id: string, name: string, color: string, primary = false, choice: Partial<{ default_for_tasks: boolean; default_for_events: boolean; write_block: string | null; takes_undated_tasks: boolean; auto_todo_enabled: boolean }> = {}) => ({
  id, user_id: USER.id, account_id: CALENDAR_ACCOUNT.id, name, external_id: null, color, is_visible: true,
  auto_todo_enabled: true, read_only: false, is_primary: primary, sync_token: null, account_provider: 'local',
  account_display_name: 'On this server', account_email: null, created_at: STAMP, updated_at: STAMP,
  default_for_tasks: false, default_for_events: false, write_block: null, takes_undated_tasks: true, ...choice,
});
const CALENDARS = [
  calendar('cal-personal', 'Personal', '#3b82f6', true, { default_for_tasks: true, default_for_events: true }),
  calendar('cal-work', 'Work', '#14b8a6'),
  { ...calendar('cal-team', 'Team', '#f59e0b', false, { takes_undated_tasks: false, auto_todo_enabled: false }),
    account_id: CALDAV_ACCOUNT.id, account_provider: 'caldav', account_display_name: 'Work', account_email: 'ada@work.example.com', external_id: '/calendars/ada/team/' },
];

const subtask = (eventId: string, id: string, title: string, done: boolean, position: number) => ({
  id, event_id: eventId, user_id: USER.id, title, is_done: done, position, created_at: STAMP, updated_at: STAMP,
});
const task = <T extends object>(id: string, fields: T) => row({
  id, user_id: USER.id, calendar_id: 'cal-personal', description: null, all_day: false, location: null, color: '#3b82f6',
  recurrence: null, reminder_minutes: null, reminders: null, todo_status: null, is_todo_only: false, done_at: null,
  created_at: STAMP, updated_at: STAMP, subtasks: [], attendees: [], source_email: null,
  start_time: at('06-20T10:00:00.000Z'), end_time: at('06-20T10:30:00.000Z'),
}, fields);

/** The task with everything a row can hold: description, source email and subtasks. */
export const RICH_TASK = task('task-today', {
  title: 'Confirm the documentation review dates', calendar_id: 'cal-work', color: '#14b8a6',
  description: 'Check with the infrastructure group first, then reply to Grace with two options for the second week of July.',
  start_time: at('06-15T14:00:00.000Z'), end_time: at('06-15T14:30:00.000Z'),
  source_email: { email_id: 'mail-1', subject: EMAILS[0].subject, from_name: 'Grace Hopper', from_address: 'grace@example.com',
    received_at: EMAILS[0].received_at, attachments: ['planning-notes.pdf'], account: 'ada@work.example.com', available: true },
  subtasks: [
    subtask('task-today', 'sub-1', 'Ask the infrastructure group', true, 0),
    subtask('task-today', 'sub-2', 'Pick two dates', false, 1),
    subtask('task-today', 'sub-3', 'Reply to Grace', false, 2),
  ],
});

export const TASKS = [
  task('task-overdue', {
    title: 'Send the signed lease renewal back to the property office', calendar_id: 'cal-personal',
    start_time: at('06-12T16:00:00.000Z'), end_time: at('06-12T16:30:00.000Z'),
  }),
  RICH_TASK,
  task('task-later', {
    title: 'Book the large meeting room for the kickoff', calendar_id: 'cal-work', color: '#14b8a6', all_day: true,
    start_time: at('06-22T00:00:00.000Z'), end_time: at('06-23T00:00:00.000Z'),
  }),
  task('task-undated', {
    title: 'Water the balcony plants', is_todo_only: true, description: 'Tomatoes need more than the herbs.',
    start_time: at('06-15T00:00:00.000Z'), end_time: at('06-15T00:00:00.000Z'),
  }),
];

const recording = <T extends object>(id: string, fields: T) => row({
  id, description: null, original_filename: null, content_type: 'audio/webm', size_bytes: 512000, duration_seconds: 95,
  source: 'recorded', category: 'none', metadata: {}, tags: [], created_at: STAMP, updated_at: STAMP,
  recorded_at: at('06-10T18:00:00.000Z'),
}, fields);
export const RECORDINGS = [
  recording('rec-1', { title: 'Morning idea about the garden layout', description: 'Raised beds along the fence, herbs near the door.',
    tags: ['garden', 'ideas'], category: 'memory', recorded_at: at('06-14T07:45:00.000Z'), duration_seconds: 74 }),
  recording('rec-2', { title: 'Song sketch in G', category: 'music', metadata: { chords: 'G  D  Em  C\nG  D  C' }, tags: ['sketch'],
    recorded_at: at('06-12T20:10:00.000Z'), duration_seconds: 182 }),
  recording('rec-3', { title: 'Reminder: renew passport', category: 'reminder', recorded_at: at('06-08T12:00:00.000Z'), duration_seconds: 21 }),
];

// Contacts in the vCard model of api/src/contracts/contacts.ts, plus the 3+3
// projection old apps read. Grace holds every kind of field for the detail
// and editor pictures; Alan and Jane have a duplicate each.
type Value = { id: string; value: string; label: string; custom_label: string | null; preferred: boolean };
const value = (id: string, text: string, label = '', preferred = false, custom_label: string | null = null): Value => ({ id, value: text, label, custom_label, preferred });
const emptyName = { display: null, given: null, family: null, middle: null, prefix: null, suffix: null };
const contact = <T extends object>(id: string, given: string, family: string | null, fields: T & { emails?: Value[]; phones?: Value[]; organization?: { name: string | null; department: string | null } }) => {
  const emails = fields.emails ?? [];
  const phones = fields.phones ?? [];
  const organization = fields.organization ?? { name: null, department: null };
  return row({
    id, uid: `urn:uuid:${id}`, version: 1, display_name: [given, family].filter(Boolean).join(' '),
    name: { ...emptyName, given, family }, organization, job_title: null, birthday: null, anniversary: null, notes: null, is_favorite: false,
    emails, phones, addresses: [], urls: [], impp: [], related: [], nicknames: [], categories: [], photo: null, kept_properties: 0,
    created_at: STAMP, updated_at: STAMP,
    first_name: given, last_name: family, company: organization.name,
    email: emails[0]?.value ?? null, email2: emails[1]?.value ?? null, email3: emails[2]?.value ?? null,
    phone: phones[0]?.value ?? null, phone2: phones[1]?.value ?? null, phone3: phones[2]?.value ?? null,
  }, fields);
};
export const CONTACTS = [
  contact('c-1', 'Grace', 'Hopper', {
    name: { ...emptyName, given: 'Grace', family: 'Hopper', prefix: 'Dr.', middle: 'Brewster' }, display_name: 'Grace Brewster Hopper',
    organization: { name: 'Example Labs', department: 'Research' }, job_title: 'Engineer', is_favorite: true,
    emails: [value('e-1', 'grace@example.com', 'work', true), value('e-2', 'grace.hopper@example.net', 'home')],
    phones: [value('p-1', '+1 555 0100', 'mobile', true), value('p-2', '+1 555 0101', 'work'), value('p-3', '+1 555 0102', 'custom', false, 'Ship')],
    addresses: [{ ...value('a-1', '', 'work'), po_box: null, extended: 'Building 4', street: '1 Example Street', locality: 'Exampleton', region: 'Example State', postal_code: '12345', country: 'Examplia' }],
    urls: [value('u-1', 'https://example.com/grace', 'homepage')], impp: [value('i-1', 'xmpp:grace@example.com', 'work')],
    related: [value('r-1', 'Alan Turing', 'colleague')], nicknames: [value('n-1', 'Amazing Grace', 'short_name')],
    birthday: { year: 1906, month: 12, day: 9 }, anniversary: { year: null, month: 6, day: 1 }, categories: ['Computing', 'Navy'],
    notes: 'Met at the Example Labs open day. Prefers email in the morning.', kept_properties: 2,
  }),
  contact('c-2', 'Alan', 'Turing', { organization: { name: 'Example University', department: null }, emails: [value('e-3', 'alan@example.net')], phones: [value('p-4', '+1 555 0103', 'mobile')] }),
  contact('c-3', 'Katherine', 'Johnson', { emails: [value('e-4', 'katherine@example.org', 'work')] }),
  contact('c-4', 'Margaret', 'Hamilton', { organization: { name: 'Example Labs', department: null }, emails: [value('e-5', 'margaret@example.org', 'work')] }),
  contact('c-5', 'Jane', 'Doe', { emails: [value('e-6', 'jane@example.com', 'home'), value('e-7', 'jane.doe@example.net', 'work')] }),
  contact('c-6', 'Alan', 'M. Turing', { display_name: 'Alan M. Turing', organization: { name: 'Example Institute', department: null }, emails: [value('e-8', 'ALAN@example.net', 'work')], phones: [value('p-5', '+1 555 0104', 'work')] }),
  contact('c-7', 'Jane', 'Doe', { phones: [value('p-6', '+1 555 0105', 'mobile')], emails: [value('e-9', 'jane@example.com')] }),
];
// A member as GET /api/contacts/duplicates sends it: `field_values` holds its
// value of each conflicting field as the server words it (the name with all its parts).
const member = (id: string, fieldValues: Record<string, string | null> = {}) => {
  const found = CONTACTS.find(entry => entry.id === id)!;
  return { id, version: found.version, display_name: found.display_name, organization: found.organization?.name ?? null,
    emails: (found.emails ?? []).map(entry => entry.value), phones: (found.phones ?? []).map(entry => entry.value), photo: null, field_values: fieldValues };
};
export const DUPLICATE_GROUPS = [
  // The family names differ ("Turing", "M. Turing"), so the name is chosen as well as the organisation.
  { id: 'dup-turing', confidence: 'high', large: false,
    members: [member('c-2', { name: 'Alan Turing', organization: 'Example University' }), member('c-6', { name: 'Alan M. Turing', organization: 'Example Institute' })],
    reasons: [{ kind: 'email', detail: 'alan@example.net', a: 'c-2', b: 'c-6' }, { kind: 'name_subset', detail: 'Alan Turing', a: 'c-2', b: 'c-6' }], conflicts: ['name', 'organization'], auto_merge: false },
  { id: 'dup-doe', confidence: 'high', large: false, members: [member('c-5'), member('c-7')],
    reasons: [{ kind: 'email', detail: 'jane@example.com', a: 'c-5', b: 'c-7' }, { kind: 'name', detail: 'Jane Doe', a: 'c-5', b: 'c-7' }], conflicts: [], auto_merge: true },
];
const KEPT_PROPERTIES = [
  { name: 'X-ABShowAs', group: null, params: null, value: 'PERSON' },
  { name: 'ROLE', group: null, params: null, value: 'Rear admiral' },
];


// ── 0.28 data safety: policies, backups, the bin, the admin pages ──
// The default rules allow everything; the pictures of the greyed state set
// one rule through the admin answer below (the policies page) and the
// person's answer (POLICIES_EFFECTIVE) alike.
const POLICY_DEFAULTS: Record<string, unknown> = {
  'mail.mode.download': 'allowed', 'mail.mode.sync': 'allowed', 'mail.mode.new_accounts': 'user_choice', 'mail.provider_delete': 'user_choice',
  'backup.download_mail': 'user_choice', 'backup.create': 'allowed', 'backup.restore': 'allowed', 'backup.delete': 'allowed', 'backup.server_retention_days': null,
  'accounts.add': 'allowed', 'accounts.remove': 'allowed', 'accounts.reset': 'allowed', 'accounts.admin_manage': 'available', 'account.delete': 'allowed', 'data.clear': 'allowed', 'bin.delete': 'allowed',
  'app_lock.required': [], 'app_lock.max_background': 'none', 'app_lock.screenshots': 'allowed',
};
const POLICY_VALUES: Record<string, unknown[]> = {
  'mail.mode.new_accounts': ['user_choice', 'download', 'download_delete', 'sync'], 'mail.provider_delete': ['user_choice', 'forbidden', 'required'],
  'backup.download_mail': ['user_choice', 'always'], 'backup.server_retention_days': [null, 30, 90, 365], 'accounts.admin_manage': ['available'],
  'app_lock.required': [[]], 'app_lock.max_background': ['none', '900', '300', '60', '0'],
};
/** The server's effects of the app lock rules (settings-registry.ts POLICY_EFFECTS), shown under a changed row. */
const APP_LOCK_EFFECTS: Record<string, string> = {
  'app_lock.required': 'People are asked to turn the app lock on at their next start; until then their devices cannot open the locked parts.',
  'app_lock.max_background': 'Devices set to lock later are asked to shorten the time.',
  'app_lock.screenshots': 'Applies in the Android app; browsers cannot block screenshots.',
};
/** One rule set for the pictures: deleting from the bin for good is not allowed. */
const POLICY_SET: Record<string, { value: unknown; reason: string }> = {
  'bin.delete': { value: 'forbidden', reason: 'Your administrator does not allow deleting items from the bin for good.' },
};
const POLICIES_EFFECTIVE = {
  policies: Object.fromEntries(Object.keys(POLICY_DEFAULTS).map(key => [key, key in POLICY_SET
    ? { value: POLICY_SET[key].value, source: 'policy', allowed: false, reason: POLICY_SET[key].reason }
    : { value: POLICY_DEFAULTS[key], source: 'default', allowed: true, reason: null }])),
  revision: 2, acknowledged_revision: 2, rules: [POLICY_SET['bin.delete'].reason],
};
const POLICIES_ADMIN = {
  policies: Object.fromEntries(Object.keys(POLICY_DEFAULTS).map(key => [key, {
    value: key in POLICY_SET ? POLICY_SET[key].value : POLICY_DEFAULTS[key], source: key in POLICY_SET ? 'policy' : 'default', default: POLICY_DEFAULTS[key],
    values: POLICY_VALUES[key] ?? ['allowed', 'forbidden'], effect: key === 'mail.mode.sync' ? 'Existing Sync accounts keep working.' : key === 'bin.delete' ? 'Items stay in the bin until restored.' : APP_LOCK_EFFECTS[key] ?? null,
  }])),
  bin_min_retention: { value: 'forever', source: 'default', default: 'forever', values: ['30', '90', 'forever'], applies: true, effect: 'Applies while deleting from the bin for good is not allowed; people may keep items longer.' },
  revision: 2,
};

const BACKUP_CAPABILITIES = {
  enabled: true, version: 7,
  sections: [{ id: 'settings', label: 'Settings' }, { id: 'contacts', label: 'Contacts' }, { id: 'calendar', label: 'Calendar and ToDo' }, { id: 'mail', label: 'Mail' }, { id: 'recordings', label: 'Recordings' }],
  exclusions: [],
  download_mail: { value: true, forced: false, reason: null, forced_account_ids: ['acct-home'] },
};
const backupJob = <T extends object>(id: string, fields: T) => row({
  id, scope: 'full', status: 'ready', phase: 'done', progress: 100, cancel_requested: false, requested_sections: [], file_size: 12_400_000, file_sha256: 'synthetic', content_type: 'application/vnd.unihub.backup',
  encryption_enabled: true, backup_uuid: `uuid-${id}`, recovery_password_available: false, recovery_password_revealed: true, server_unlock_available: true, keep_until: null,
  contents: { included: ['local', 'local-by-policy', 'config'], left_out: [
    { section: 'mail', what: 'Sync-mode mail', reason: 'It downloads again from the provider after the account reconnects.', count: 1204 },
    { section: 'calendar', what: 'Events and tasks of the calendar server', reason: 'They sync again from the calendar server.', count: 88 },
  ], notes: [] },
  error: null, created_at: at('06-14T03:30:00.000Z'), updated_at: at('06-14T03:35:00.000Z'), started_at: at('06-14T03:30:00.000Z'), completed_at: at('06-14T03:35:00.000Z'), downloaded_at: null,
}, fields);
const BACKUP_JOBS = [
  backupJob('bk-running', { status: 'running', phase: 'files', progress: 45, file_size: null, completed_at: null, created_at: at('06-15T09:28:00.000Z'), started_at: at('06-15T09:28:00.000Z'), recovery_password_available: true, recovery_password_revealed: false }),
  backupJob('bk-full', { recovery_password_available: true, recovery_password_revealed: false }),
  backupJob('bk-contacts', { scope: 'partial', requested_sections: ['contacts'], file_size: 320_000, created_at: at('06-10T18:00:00.000Z'), completed_at: at('06-10T18:00:20.000Z'),
    contents: { included: ['local'], left_out: [], notes: [] } }),
  backupJob('bk-old', { encryption_enabled: false, content_type: 'application/zip', contents: null, file_size: 48_000_000, created_at: at('05-02T10:00:00.000Z'), completed_at: at('05-02T10:04:00.000Z') }),
];

const binItem = <T extends object>(id: string, fields: T) => row({
  id, module: 'contacts', item_type: 'contact', title: '', reason: 'deleted', group_id: null, deleted_at: at('06-13T15:20:00.000Z'), purge_after: at('07-13T15:20:00.000Z'), provider: 'local', origin: null,
}, fields);
export const BIN_ITEMS = [
  binItem('bin-task', { module: 'calendar', item_type: 'task', title: 'Share the updated roadmap draft', provider: 'caldav', origin: 'Team', deleted_at: at('06-15T08:10:00.000Z'), purge_after: at('07-15T08:10:00.000Z') }),
  binItem('bin-contact', { title: 'Margaret Hamilton', deleted_at: at('06-14T11:00:00.000Z'), purge_after: at('07-14T11:00:00.000Z') }),
  binItem('bin-rec', { module: 'recordings', item_type: 'recording', title: 'Reminder: renew passport', deleted_at: at('06-13T15:20:00.000Z') }),
  binItem('bin-cal', { module: 'calendar', item_type: 'calendar', title: 'Garden club', reason: 'calendar_deleted', group_id: 'grp-garden', deleted_at: at('06-12T09:00:00.000Z'), purge_after: at('07-12T09:00:00.000Z') }),
  binItem('bin-cal-ev1', { module: 'calendar', item_type: 'event', title: 'Seed swap', reason: 'calendar_deleted', group_id: 'grp-garden', deleted_at: at('06-12T09:00:00.000Z'), purge_after: at('07-12T09:00:00.000Z') }),
  binItem('bin-cal-ev2', { module: 'calendar', item_type: 'event', title: 'Compost workshop', reason: 'calendar_deleted', group_id: 'grp-garden', deleted_at: at('06-12T09:00:00.000Z'), purge_after: at('07-12T09:00:00.000Z') }),
  binItem('bin-merge-a', { title: 'Jane Doe', reason: 'merged', group_id: 'grp-merge', deleted_at: at('06-11T16:45:00.000Z'), purge_after: at('07-11T16:45:00.000Z') }),
];

const INSTANCE_BACKUP = {
  enabled: true, missing: [], destination: '/backups/unihub', key_fingerprint: 'k1:7f3a…c9e2', time_utc: '03:30', keep: 14, schedule_source: 'environment', schedule_defaults: { time_utc: '03:30', keep: 14 }, next_run_at: at('06-16T03:30:00.000Z'),
  last_run: { id: 'ib-1', trigger: 'schedule', actor_email: null, status: 'succeeded', file_name: 'unihub-instance-20260615T0330Z-0.28.0.uhib', size_bytes: 1_310_000_000, app_version: '0.28.0', error: null, started_at: at('06-15T03:30:00.000Z'), finished_at: at('06-15T03:41:00.000Z') },
  last_success: null, kept: { count: 14, bytes: 18_000_000_000 }, running: false,
  restore_command: 'node /app/api/dist/scripts/instance-restore.js --file <backup.uhib> --key-file <instance key>',
  runs: [
    { id: 'ib-1', trigger: 'schedule', actor_email: null, status: 'succeeded', file_name: 'unihub-instance-20260615T0330Z-0.28.0.uhib', size_bytes: 1_310_000_000, app_version: '0.28.0', error: null, started_at: at('06-15T03:30:00.000Z'), finished_at: at('06-15T03:41:00.000Z') },
    { id: 'ib-0', trigger: 'manual', actor_email: 'ada@example.com', status: 'failed', file_name: null, size_bytes: null, app_version: '0.28.0', error: 'Not enough free space at the destination.', started_at: at('06-14T14:02:00.000Z'), finished_at: at('06-14T14:02:30.000Z') },
  ],
};

// ── 0.29 app lock: this person's devices and this device's lock settings ──
// The default device locks nothing, so every other picture is unchanged; the
// app lock pictures answer /devices/current with a lock through page.route.
const WEB_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
export const DEVICES = [
  { id: 'dev-laptop', current: true, kind: 'web', app_version: null, user_agent: WEB_UA, created_at: at('05-02T09:00:00.000Z'), last_seen_at: at('06-15T09:29:00.000Z'),
    lock: { scope: ['mail', 'contacts'], method: 'pin' }, notifications: true },
  { id: 'dev-phone', current: false, kind: 'android', app_version: '0.29.0', user_agent: 'Mozilla/5.0 (Linux; Android 16; Pixel 8a; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36 UniHubAndroid/0.29.0 (29000)',
    created_at: at('05-20T18:00:00.000Z'), last_seen_at: at('06-15T07:10:00.000Z'), lock: { scope: ['app'], method: 'biometric' }, notifications: true },
  { id: 'dev-tablet', current: false, kind: 'pwa', app_version: null, user_agent: 'Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    created_at: at('06-01T12:00:00.000Z'), last_seen_at: at('06-12T20:40:00.000Z'), lock: null, notifications: false },
];
const DEVICE_SETTINGS_OFF = {
  app_lock_scope: { value: [], source: 'default', locked: false },
  app_lock_relock_after: { value: '60', source: 'default', locked: false },
  app_lock_on_device_lock: { value: true, source: 'default', locked: false },
};
export const CURRENT_DEVICE = {
  device: { ...DEVICES[0], lock: null }, settings: DEVICE_SETTINGS_OFF,
  compliance: { meets: true, required: [], max_background: null, reason: null }, policy: { screenshots: 'allowed' },
};
/** The same device with Mail and Contacts locked under a rule that requires them and allows 5 minutes at most. */
export const CURRENT_DEVICE_LOCKED = {
  device: DEVICES[0],
  settings: {
    app_lock_scope: { value: ['mail', 'contacts'], source: 'user', locked: false, floor: ['mail', 'contacts'] },
    app_lock_relock_after: { value: '60', source: 'user', locked: false, floor: '300' },
    app_lock_on_device_lock: { value: true, source: 'default', locked: false },
  },
  compliance: { meets: true, required: ['mail', 'contacts'], max_background: '300', reason: 'Your administrator requires the app lock for Mail and Contacts.' },
  policy: { screenshots: 'allowed' },
};
/** The administrator's answer with the app lock rules set, for the Policies picture. */
export const POLICIES_ADMIN_APP_LOCK = {
  ...POLICIES_ADMIN,
  policies: { ...POLICIES_ADMIN.policies,
    'app_lock.required': { ...POLICIES_ADMIN.policies['app_lock.required'], value: ['mail', 'contacts'], source: 'policy' },
    'app_lock.max_background': { ...POLICIES_ADMIN.policies['app_lock.max_background'], value: '300', source: 'policy' },
  },
};

export interface ApiReply { status?: number; body: unknown }
type Handler = (url: URL, method: string, body: unknown) => ApiReply | undefined;
type Route = [method: string, path: RegExp, handler: Handler];

const ok = (body: unknown): ApiReply => ({ body });

function mailList(emails: typeof EMAILS, url: URL) {
  const account = url.searchParams.get('account_id');
  const folder = url.searchParams.get('folder') || 'inbox';
  const rows = emails.filter(row => (!account || account === 'all' || row.mail_account_id === account)
    && (folder === 'starred' ? row.is_starred : folder === 'all' || row.folder === folder));
  const limit = Number(url.searchParams.get('limit') || 50);
  const offset = Number(url.searchParams.get('offset') || 0);
  return {
    emails: rows.slice(offset, offset + limit).map(row => ({ ...row, body_html: null })),
    pagination: { total: rows.length, limit, offset, page: Math.floor(offset / limit) + 1, totalPages: Math.ceil(rows.length / limit), hasMore: offset + limit < rows.length },
  };
}

function unreadCounts(emails: typeof EMAILS) {
  const unreadByFolder: Record<string, number> = {};
  const unreadByFolderAccount: Record<string, Record<string, number>> = {};
  for (const row of emails.filter(row => !row.is_read)) {
    unreadByFolder[row.folder] = (unreadByFolder[row.folder] ?? 0) + 1;
    (unreadByFolderAccount[row.folder] ??= {})[row.mail_account_id] = (unreadByFolderAccount[row.folder][row.mail_account_id] ?? 0) + 1;
  }
  return { unreadByFolder, unreadByFolderAccount };
}

function savedDraft(id: string, body: unknown) {
  const { subject = '', attachments = [] } = (body ?? {}) as { subject?: string; attachments?: Array<{ client_id: string }> };
  return {
    draft: { id, subject, folder: 'drafts', attachments: [] },
    uploaded: attachments.map((file, index) => ({ client_id: file.client_id, id: `att-${id}-${index}` })),
  };
}

/**
 * Routes the reference screens use. A request without a route is
 * answered 501 and fails the test (see support/test.ts), so a new request in
 * the product shows up as a fixture to add, never as a silent real call.
 */
function defaultRoutes(emails: typeof EMAILS, admin = false): Route[] {
  const byId = (url: URL) => emails.find(entry => entry.id === decodeURIComponent(url.pathname.split('/')[4] ?? ''));
  return [
    ['GET', /^\/auth\/me$/, () => ok({ user: admin ? { ...USER, role: 'admin' } : USER, csrfToken: 'synthetic-csrf-token' })],
    ['GET', /^\/modules$/, () => ok({ modules: MODULES, pages: PAGES })],
    ['GET', /^\/settings\/preferences$/, () => ok({ preferences: PREFERENCES })],
    ['GET', /^\/settings\/values$/, () => ok({ settings: SETTINGS })],
    ['GET', /^\/settings\/values\/calendars$/, () => ok({ calendars: {} })],
    ['GET', /^\/mail\/templates$/, () => ok({ templates: [{ id: 'tpl-weekly', name: 'Weekly report', subject: 'Weekly report',
      body_html: '<p>Numbers attached.</p>', body_text: 'Numbers attached.', updated_at: at('06-14T08:00:00.000Z') }] })],
    ['GET', /^\/version$/, () => ok({ app: 'unihub', server: '0.21.4', android: null })],
    ['GET', /^\/mail\/accounts$/, () => ok({ accounts: MAIL_ACCOUNTS.map(account => ({ ...account,
      unread_count: emails.filter(row => row.mail_account_id === account.id && !row.is_read).length })) })],
    ['GET', /^\/mail\/folders$/, () => ok({ folders: FOLDERS.map(folder => ({ connected_account_ids: [], legacy_count: 0, mail_account_id: null, special_use: null, ...folder,
      total_count: emails.filter(row => row.folder === folder.slug).length,
      unread_count: emails.filter(row => row.folder === folder.slug && !row.is_read).length })) })],
    ['GET', /^\/mail\/unread-counts$/, () => ok(unreadCounts(emails))],
    ['GET', /^\/mail\/emails$/, url => ok(mailList(emails, url))],
    ['GET', /^\/mail\/emails\/[^/]+$/, url => {
      const row = byId(url);
      return row ? ok({ email: row }) : { status: 404, body: { error: 'Email not found' } };
    }],
    // Opening a message marks it read; the synthetic server accepts at once.
    ['PUT', /^\/mail\/emails\/[^/]+\/read$/, (url, _method, body) => {
      const row = byId(url);
      if (!row) return { status: 404, body: { error: 'Email not found' } };
      row.is_read = (body as { is_read?: boolean } | null)?.is_read !== false;
      return ok({ sync_pending: false, operation_ids: [] });
    }],
    // Draft saves (the composer's autosave): each uploaded file answers with the attachment it became.
    ['POST', /^\/mail\/drafts$/, (_url, _method, body) => ok(savedDraft('draft-synthetic', body))],
    ['PUT', /^\/mail\/drafts\/[^/]+$/, (url, _method, body) => ok(savedDraft(decodeURIComponent(url.pathname.split('/').pop()!), body))],
    ['GET', /^\/mail\/operations$/, () => ok({ found: false })],
    ['GET', /^\/mail\/sync\/status$/, () => ok({ accounts: MAIL_ACCOUNTS.map(account => ({
      account_id: account.id, job_id: null, state: 'idle', phase: null, processed: 0, total: null,
      started_at: null, updated_at: account.last_synced_at, error: null,
      coverage: { recent: { complete: true, current: true }, history: { complete: true, current: true }, flags: { complete: true, current: true }, bodies: { complete: true, current: true } },
    })) })],
    ['GET', /^\/mail\/writebacks$/, () => ok({ operations: [] })],
    ['GET', /^\/calendar\/accounts$/, () => ok({ accounts: [CALENDAR_ACCOUNT, CALDAV_ACCOUNT] })],
    ['GET', /^\/calendar\/calendars$/, () => ok({ calendars: CALENDARS })],
    ['GET', /^\/calendar\/events$/, url => ok({ events: url.searchParams.get('include_todos') === 'true' ? TASKS : TASKS.filter(row => !row.is_todo_only) })],
    ['GET', /^\/recordings$/, url => {
      const category = url.searchParams.get('category');
      return ok({ recordings: RECORDINGS.filter(row => !category || row.category === category) });
    }],
    // 0.28 data safety. The person's own rules; the bin by module; backups; the admin pages.
    ['GET', /^\/policies\/effective$/, () => ok(POLICIES_EFFECTIVE)],
    ['GET', /^\/bin$/, url => {
      const module = url.searchParams.get('module');
      return ok({ items: BIN_ITEMS.filter(item => !module || item.module === module), retention: '30' });
    }],
    ['GET', /^\/backup\/capabilities$/, () => ok(BACKUP_CAPABILITIES)],
    ['GET', /^\/backup\/jobs$/, () => ok({ jobs: BACKUP_JOBS })],
    ['GET', /^\/backup\/restore-jobs$/, () => ok({ jobs: [] })],
    ['GET', /^\/admin\/policies$/, () => ok(POLICIES_ADMIN)],
    // 0.29 app lock: the device routes. The reports are accepted and change nothing here.
    ['GET', /^\/devices$/, () => ok({ devices: DEVICES })],
    ['GET', /^\/devices\/current$/, () => ok(CURRENT_DEVICE)],
    ['POST', /^\/devices\/current\/key$/, () => ok({})],
    ['PUT', /^\/devices\/current\/lock$/, () => ok({})],
    ['POST', /^\/devices\/current\/lock-state$/, () => ok({})],
    ['GET', /^\/settings\/values\/device$/, () => ok({ device_id: DEVICES[0].id, settings: CURRENT_DEVICE.settings })],
    ['GET', /^\/admin\/instance-backup$/, () => ok(INSTANCE_BACKUP)],
    ['GET', /^\/contacts$/, url => {
      const offset = Number(url.searchParams.get('offset') || 0);
      return ok({ contacts: CONTACTS.slice(offset), has_more: false, offset });
    }],
    ['GET', /^\/contacts\/duplicates$/, () => ok({ groups: DUPLICATE_GROUPS })],
    ['GET', /^\/contacts\/merges$/, () => ok({ merges: [] })],
    ['GET', /^\/contacts\/[^/]+$/, url => {
      const found = CONTACTS.find(entry => `/contacts/${entry.id}` === url.pathname.replace(/^\/api/, ''));
      return found ? ok({ contact: { ...found, properties: found.kept_properties ? KEPT_PROPERTIES : [] } }) : { status: 404, body: { error: 'Not found' } };
    }],
  ];
}

export interface ApiRouter {
  handle(url: URL, method: string, body: unknown): ApiReply;
  /** How many requests were answered; the page has settled when it stops growing. */
  readonly requests: number;
  /** Requests the router could not answer; each fails the test. */
  readonly unhandled: string[];
}

export function createApiRouter({ admin = false } = {}): ApiRouter {
  // Each test gets its own copy, so a message read in one test is unread in the next.
  const routes = defaultRoutes(EMAILS.map(row => ({ ...row })), admin);
  const unhandled: string[] = [];
  let requests = 0;
  return {
    unhandled,
    get requests() { return requests; },
    handle(url, method, body) {
      requests++;
      const path = url.pathname.replace(/^\/api(?=\/)/, '');
      for (const [routeMethod, pattern, handler] of routes) {
        if (routeMethod !== method || !pattern.test(path)) continue;
        const reply = handler(url, method, body);
        if (reply) return reply;
      }
      unhandled.push(`${method} ${url.pathname}${url.search}`);
      return { status: 501, body: { error: `ui-regression: no synthetic fixture for ${method} ${path}` } };
    },
  };
}
