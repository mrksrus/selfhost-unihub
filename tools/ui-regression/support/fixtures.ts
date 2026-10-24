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
const calendar = (id: string, name: string, color: string, primary = false) => ({
  id, user_id: USER.id, account_id: CALENDAR_ACCOUNT.id, name, external_id: null, color, is_visible: true,
  auto_todo_enabled: true, read_only: false, is_primary: primary, sync_token: null, account_provider: 'local',
  account_display_name: 'On this server', account_email: null, created_at: STAMP, updated_at: STAMP,
});
const CALENDARS = [calendar('cal-personal', 'Personal', '#3b82f6', true), calendar('cal-work', 'Work', '#14b8a6')];

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

const contact = <T extends object>(id: string, first: string, last: string | null, fields: T) => row({
  id, first_name: first, last_name: last, email: null, email2: null, email3: null, phone: null, phone2: null, phone3: null,
  company: null, job_title: null, notes: null, avatar_url: null, is_favorite: false,
}, fields);
export const CONTACTS = [
  contact('c-1', 'Grace', 'Hopper', { email: 'grace@example.com', company: 'Example Labs', job_title: 'Engineer', is_favorite: true }),
  contact('c-2', 'Alan', 'Turing', { email: 'alan@example.net', phone: '+1 555 0100' }),
  contact('c-3', 'Katherine', 'Johnson', { email: 'katherine@example.org' }),
  contact('c-4', 'Margaret', 'Hamilton', { email: 'margaret@example.org', company: 'Example Labs' }),
  contact('c-5', 'Jane', 'Doe', { email: 'jane@example.com', email2: 'jane.doe@example.net' }),
];

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
function defaultRoutes(emails: typeof EMAILS): Route[] {
  const byId = (url: URL) => emails.find(entry => entry.id === decodeURIComponent(url.pathname.split('/')[4] ?? ''));
  return [
    ['GET', /^\/auth\/me$/, () => ok({ user: USER, csrfToken: 'synthetic-csrf-token' })],
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
    ['GET', /^\/calendar\/accounts$/, () => ok({ accounts: [CALENDAR_ACCOUNT] })],
    ['GET', /^\/calendar\/calendars$/, () => ok({ calendars: CALENDARS })],
    ['GET', /^\/calendar\/events$/, url => ok({ events: url.searchParams.get('include_todos') === 'true' ? TASKS : TASKS.filter(row => !row.is_todo_only) })],
    ['GET', /^\/recordings$/, url => {
      const category = url.searchParams.get('category');
      return ok({ recordings: RECORDINGS.filter(row => !category || row.category === category) });
    }],
    ['GET', /^\/contacts$/, url => {
      const offset = Number(url.searchParams.get('offset') || 0);
      return ok({ contacts: CONTACTS.slice(offset), has_more: false, offset });
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

export function createApiRouter(): ApiRouter {
  // Each test gets its own copy, so a message read in one test is unread in the next.
  const routes = defaultRoutes(EMAILS.map(row => ({ ...row })));
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
