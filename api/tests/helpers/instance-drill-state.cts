import type { RowDataPacket } from 'mysql2/promise';
// Piped into an installation by scripts/instance-backup-drill.mts and run there
// with its configuration.
//   DRILL_MODE=seed DRILL_ADMIN_ID=<id>: installation rows a fresh one does
//     not have: a policy (backup.download_mail = always, locked), stored as an
//     administrator's policy is (setting_policies; the admin routes come with
//     stream C2), two earlier instance backup runs, and mail upgrade progress
//     other than the defaults a new database starts with (nothing reads it
//     once the upgrade is done), and a shared address book with a group's
//     grant, a contact with a value, a kept property and a photo file, an
//     item in its bin, and a directory entry; calendars no person owns: an
//     archived organisation calendar with a group's share, an event with an
//     attendee, a repeating event (a series with a changed and a removed
//     date), an item in its bin, the administrator's view of it and own
//     reminders on an event and the series; a deleted organisation calendar;
//     a group calendar with the group's contribute share and a point a member
//     added; and the administrator's calendar shared with another person and
//     offered to them; a chat of two people with their accounts, a chat
//     device each with key packages, the conversation's grants and marks, a
//     group with its Welcome, messages (one edited, one deleted) and archive
//     copies.
//   DRILL_MODE=report: what belongs to the whole installation, not to one
//     person's recovery sections: every table the installation's data
//     inventory declares as owned by the installation or an organisation, row
//     by row (scripts/instance-drill-compare.mts compares them), a shared
//     book's rows in the person-owned contact tables and its photo files, the
//     rows of calendars no person owns, every series, view and personal
//     reminder, the offers and shares of people's calendars, every chat
//     table, the people,
//     each mail account's row, and what an instance restore resets
//     (docs/DATA_RECOVERY.md#after-an-instance-restore): sessions, tickets,
//     sign-in challenges, leases and provider work it must not replay.
//     Secrets and whole rows appear as hashes only.
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const apiRoot = process.env.UNIHUB_API_ROOT!;
const mysql = require(require.resolve('mysql2/promise', { paths: [apiRoot] })) as typeof import('mysql2/promise');
// The inventory of the release under test, as built into the installation.
const path = require('node:path') as typeof import('node:path');
const fs = require('node:fs') as typeof import('node:fs');
const { TABLE_DECLARATIONS, BOOK_ROWS, CALENDAR_ROWS } = require(path.join(apiRoot, 'src/services/data-inventory.js')) as typeof import('../../src/services/data-inventory');
const CHAT_TABLES = Object.keys(TABLE_DECLARATIONS).filter(table => TABLE_DECLARATIONS[table].module === 'chat').sort();
// Where the installation keeps a shared book's photos (services/contact-photos.ts photoPath).
const bookPhotos = path.resolve(process.env.CONTACT_PHOTOS_ROOT || '/app/uploads/contact-photos', 'books');

// BIGINTs arrive as strings (bigNumberStrings); a whole number past 2^53 here would hash with lost digits.
const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value, (_key, item) => {
  if (typeof item === 'number' && Number.isInteger(item) && !Number.isSafeInteger(item)) throw new Error(`${item} lost its precision before it was compared`);
  return Buffer.isBuffer(item) ? item.toString('base64') : item;
})).digest('hex');
// The columns an instance restore resets on a mail account (docs/DATA_RECOVERY.md#after-an-instance-restore).
// Plain values the comparison's rules and the drill read; none is a secret.
const PLAIN: Record<string, string[]> = { audit_log: ['action'], instance_backups: ['status', 'file_name', 'finished_at'], mail_engine_migration_progress: ['processed'], chat_devices: ['device_id'] };
const ACCOUNT_RESETS = ['is_active', 'delete_emails_on_server', 'server_delete_enabled_at', 'server_delete_grace_until', 'sync_policy_confirmed_at', 'updated_at'];

async function main() {
  const db = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, timezone: '+00:00', dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true });
  const rows = async (sql: string, params: unknown[] = []) => (await db.query<RowDataPacket[]>(sql, params))[0];
  const count = async (sql: string) => Number((await rows(sql))[0].n);
  try {
    if (process.env.DRILL_MODE === 'seed') {
      const admin = String(process.env.DRILL_ADMIN_ID || '');
      if (!/^[0-9a-f-]{36}$/.test(admin)) throw new Error('DRILL_ADMIN_ID is required');
      await db.execute(`INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked, updated_by)
        VALUES ('installation', '', 'policy.backup.download_mail', 'always', 1, ?)`, [admin]);
      // Earlier runs: one that failed, and a scheduled one whose file the retention removed.
      await db.execute(`INSERT INTO instance_backups (id, trigger_kind, actor_id, status, file_name, size_bytes, sha256, key_fingerprint, app_version, migration_id, error, started_at, finished_at, removed_at)
        SELECT UUID(), 'manual', ?, 'failed', NULL, NULL, NULL, 'drillearlier0001', '0.27.0', MAX(id), 'The destination was full.', '2026-01-02 03:30:00', '2026-01-02 03:31:00', NULL FROM schema_migrations
        UNION ALL SELECT UUID(), 'schedule', NULL, 'succeeded', 'unihub-instance-20260103T033000Z-0.27.0.uhib', 4096, REPEAT('a', 64), 'drillearlier0001', '0.27.0', MAX(id), NULL,
          '2026-01-03 03:30:00', '2026-01-03 03:32:00', '2026-01-10 03:33:00' FROM schema_migrations`, [admin]);
      // The organisation (0.30): a group with its manager come back; a setup
      // link and a sign-in attempt budget do not.
      await db.execute("INSERT INTO org_groups (id, name, description, created_by) VALUES (UUID(), 'Drill group', 'Synthetic', ?)", [admin]);
      await db.execute("INSERT INTO org_group_members (group_id, user_id, role, added_by) SELECT id, ?, 'manager', ? FROM org_groups WHERE name = 'Drill group'", [admin, admin]);
      await db.execute('INSERT INTO invites (id, user_id, token_hash, created_by, expires_at) VALUES (UUID(), ?, SHA2(UUID(), 256), ?, UTC_TIMESTAMP() + INTERVAL 7 DAY)', [admin, admin]);
      await db.execute("INSERT INTO login_attempts (scope, identity_hash, attempts, window_ends_at) VALUES ('password', SHA2('drill', 256), 3, UTC_TIMESTAMP(3) + INTERVAL 1 DAY)");
      // Past 2^53, where a JavaScript number would round it to ...992.
      await db.execute("UPDATE mail_engine_migration_progress SET last_id = '00000000-0000-4000-8000-00000000d211', processed = IF(source_table = 'emails', 9007199254740993, processed + 7)");
      // Shared address books (0.31): the group edits a book; its contact, photo, bin and the directory come back.
      const [book, contact] = [crypto.randomUUID(), crypto.randomUUID()];
      const photo = Buffer.from('synthetic drill photo');
      const sha = crypto.createHash('sha256').update(photo).digest('hex');
      await db.execute("INSERT INTO address_books (id, name, description, created_by) VALUES (?, 'Drill book', 'Synthetic', ?)", [book, admin]);
      await db.execute(`INSERT INTO grants (id, resource_kind, resource_id, principal_kind, principal_id, permission, granted_by)
        SELECT UUID(), 'address_book', ?, 'group', id, 'edit', ? FROM org_groups WHERE name = 'Drill group'`, [book, admin]);
      await db.execute("INSERT INTO contacts (id, address_book_id, uid, uid_hash, first_name, name_key) VALUES (?, ?, ?, SHA2(?, 256), 'Drill', 'drill')", [contact, book, `urn:uuid:${contact}`, `urn:uuid:${contact}`]);
      await db.execute("INSERT INTO contact_values (id, contact_id, address_book_id, kind, value, value_key) VALUES (UUID(), ?, ?, 'email', 'drill@example.test', 'drill@example.test')", [contact, book]);
      await db.execute("INSERT INTO contact_properties (id, contact_id, address_book_id, name, value) VALUES (UUID(), ?, ?, 'X-DRILL', 'kept')", [contact, book]);
      fs.mkdirSync(path.join(bookPhotos, book), { recursive: true });
      fs.writeFileSync(path.join(bookPhotos, book, `${sha}.jpg`), photo);
      await db.execute("INSERT INTO contact_photos (contact_id, address_book_id, sha256, width, height, bytes, thumb_sha256, source) VALUES (?, ?, ?, 1, 1, ?, ?, 'upload')", [contact, book, sha, photo.length, sha]);
      await db.execute("INSERT INTO bin_items (id, address_book_id, module, item_type, item_id, title, reason, payload) VALUES (UUID(), ?, 'contacts', 'contact', UUID(), 'Drill binned', 'deleted', '{}')", [book]);
      await db.execute("INSERT INTO directory_entries (user_id, phone, job_title, department, updated_by) VALUES (?, '+1 555 0100', 'Drill lead', 'Drills', ?)", [admin, admin]);
      // Shared calendars: the organisation's, the group's and a person's, with what belongs to the organisation on each.
      const [org, gone, team, series, first, changed] = Array.from({ length: 6 }, () => crypto.randomUUID());
      const [[other]] = await db.query<RowDataPacket[]>('SELECT id FROM users WHERE id <> ? ORDER BY created_at, id LIMIT 1', [admin]);
      const [[account]] = await db.query<RowDataPacket[]>("SELECT id FROM calendar_accounts WHERE user_id = ? AND provider = 'local' ORDER BY created_at LIMIT 1", [admin]);
      if (!account || !other) throw new Error('The drill needs the administrator\'s local calendar account and a second person');
      await db.execute("INSERT INTO calendar_calendars (id, name, color, archived_at) VALUES (?, 'Drill organisation calendar', '#0f766e', '2026-01-05 10:00:00')", [org]);
      await db.execute("INSERT INTO calendar_calendars (id, name, deleted_at) VALUES (?, 'Drill deleted calendar', '2026-01-06 10:00:00')", [gone]);
      await db.execute("INSERT INTO calendar_calendars (id, group_id, name) SELECT ?, id, 'Drill group calendar' FROM org_groups WHERE name = 'Drill group'", [team]);
      await db.execute(`INSERT INTO grants (id, resource_kind, resource_id, principal_kind, principal_id, permission, granted_by)
        SELECT UUID(), 'calendar', ?, 'group', id, 'read', ? FROM org_groups WHERE name = 'Drill group'
        UNION ALL SELECT UUID(), 'calendar', ?, 'group', id, 'contribute', ? FROM org_groups WHERE name = 'Drill group'`, [org, admin, team, admin]);
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniHub//Drill//EN', 'BEGIN:VEVENT', `UID:${series}@drill.example.test`,
        'DTSTART;TZID=Europe/Berlin:20260105T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;TZID=Europe/Berlin:20260119T090000', 'SUMMARY:Drill stand-up', 'END:VEVENT',
        'BEGIN:VEVENT', `UID:${series}@drill.example.test`, 'RECURRENCE-ID;TZID=Europe/Berlin:20260112T090000', 'DTSTART;TZID=Europe/Berlin:20260112T100000', 'DURATION:PT1H',
        'SUMMARY:Drill stand-up (moved)', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
      await db.execute('INSERT INTO calendar_series (id, calendar_id, uid, ics) VALUES (?, ?, ?, ?)', [series, org, `${series}@drill.example.test`, ics]);
      await db.execute(`INSERT INTO calendar_events (id, calendar_id, title, start_time, end_time, recurrence, series_id, recurrence_id, uid) VALUES
        (?, ?, 'Drill stand-up', '2026-01-05 08:00:00', '2026-01-05 09:00:00', 'FREQ=WEEKLY;COUNT=4', ?, '20260105T080000Z', ?),
        (?, ?, 'Drill stand-up (moved)', '2026-01-12 09:00:00', '2026-01-12 10:00:00', 'FREQ=WEEKLY;COUNT=4', ?, '20260112T080000Z', ?)`,
      [first, org, series, `${series}@drill.example.test`, changed, org, series, `${series}@drill.example.test`]);
      await db.execute("INSERT INTO calendar_event_attendees (id, event_id, email, display_name) VALUES (UUID(), ?, 'guest@example.test', 'Drill guest')", [first]);
      await db.execute("INSERT INTO calendar_event_subtasks (id, event_id, title, created_by) VALUES (UUID(), ?, 'Drill agenda point', ?)", [changed, other.id]);
      await db.execute("INSERT INTO bin_items (id, calendar_id, module, item_type, item_id, title, reason, payload) VALUES (UUID(), ?, 'calendar', 'event', UUID(), 'Drill binned date', 'deleted', '{}')", [org]);
      await db.execute("INSERT INTO calendar_views (calendar_id, user_id, is_visible, color, notify_changes) VALUES (?, ?, FALSE, '#7c3aed', TRUE)", [org, admin]);
      await db.execute("INSERT INTO calendar_reminders (id, user_id, event_id, series_id, reminders) VALUES (UUID(), ?, ?, NULL, '[10]'), (UUID(), ?, NULL, ?, '[30]')", [admin, changed, admin, series]);
      const own = crypto.randomUUID();
      await db.execute("INSERT INTO calendar_calendars (id, user_id, account_id, name, offer_to, offer_by) VALUES (?, ?, ?, 'Drill shared calendar', ?, ?)", [own, admin, account.id, other.id, admin]);
      await db.execute("INSERT INTO grants (id, resource_kind, resource_id, principal_kind, principal_id, permission, granted_by) VALUES (UUID(), 'calendar', ?, 'user', ?, 'edit', ?)", [own, other.id, admin]);
      // Chat: opaque bytes stand in for keys, MLS data and sealed copies.
      const bytes = (length: number) => crypto.randomBytes(length).toString('base64url');
      const [conversation, chatGroup, adminChat, otherChat, adminDevice, otherDevice] = Array.from({ length: 6 }, () => crypto.randomUUID());
      const [sent, edit, gone2, deletion] = Array.from({ length: 4 }, () => crypto.randomUUID());
      for (const [user, device, chat] of [[admin, adminDevice, adminChat], [other.id, otherDevice, otherChat]]) {
        await db.execute("INSERT INTO devices (id, user_id, key_hash, kind, created_at, last_seen_at) VALUES (?, ?, SHA2(UUID(), 256), 'web', UTC_TIMESTAMP(), UTC_TIMESTAMP())", [device, user]);
        await db.execute('INSERT INTO chat_devices (id, user_id, device_id, preview_p256dh, preview_auth) VALUES (?, ?, ?, ?, ?)', [chat, user, device, bytes(65), bytes(16)]);
        await db.execute('INSERT INTO chat_key_packages (chat_device_id, key_package, last_resort) VALUES (?, ?, FALSE), (?, ?, TRUE)', [chat, bytes(313), chat, bytes(313)]);
        await db.execute('INSERT INTO chat_accounts (user_id, history_public, key_backup, backup_salt, backup_rounds, backup_format) VALUES (?, ?, ?, ?, 600000, 1)', [user, bytes(65), bytes(60), bytes(16)]);
      }
      await db.execute("INSERT INTO chat_conversations (id, kind, direct_key, current_group_id, last_seq, created_by) VALUES (?, 'direct', ?, ?, 4, ?)",
        [conversation, [admin, other.id].sort().join(':'), chatGroup, admin]);
      await db.execute(`INSERT INTO grants (id, resource_kind, resource_id, principal_kind, principal_id, permission, granted_by)
        VALUES (UUID(), 'conversation', ?, 'user', ?, 'member', ?), (UUID(), 'conversation', ?, 'user', ?, 'member', ?)`, [conversation, admin, admin, conversation, other.id, admin]);
      await db.execute('INSERT INTO chat_members (conversation_id, user_id, read_seq, delivered_seq) VALUES (?, ?, 4, 4), (?, ?, 2, 3)', [conversation, admin, conversation, other.id]);
      await db.execute('INSERT INTO chat_groups (id, conversation_id, welcome) VALUES (?, ?, ?)', [chatGroup, conversation, bytes(900)]);
      await db.execute('INSERT INTO chat_group_devices (group_id, chat_device_id, joined_at) VALUES (?, ?, UTC_TIMESTAMP()), (?, ?, NULL)', [chatGroup, adminChat, chatGroup, otherChat]);
      await db.execute(`INSERT INTO chat_messages (id, conversation_id, seq, group_id, sender_user_id, sender_chat_device_id, kind, replaces, ciphertext) VALUES
        (?, ?, 1, ?, ?, ?, 'message', NULL, ?), (?, ?, 2, ?, ?, ?, 'message', ?, ?), (?, ?, 3, ?, ?, ?, 'message', NULL, NULL), (?, ?, 4, ?, ?, ?, 'delete', ?, NULL)`,
      [sent, conversation, chatGroup, admin, adminChat, bytes(402), edit, conversation, chatGroup, admin, adminChat, sent, bytes(402),
        gone2, conversation, chatGroup, other.id, otherChat, deletion, conversation, chatGroup, other.id, otherChat, gone2]);
      await db.execute('INSERT INTO chat_archive (user_id, message_id, sealed) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
        [admin, sent, bytes(500), admin, edit, bytes(500), other.id, sent, bytes(500)]);
      console.log(JSON.stringify({ seeded: ['setting_policies', 'instance_backups', 'mail_engine_migration_progress', 'org_groups', 'org_group_members', 'invites', 'login_attempts',
        'address_books', 'grants', 'directory_entries', ...BOOK_ROWS.tables.map(table => `${table} of books`), 'photo files of books',
        ...CALENDAR_ROWS.tables.map(table => `${table} of organisation calendars`), 'calendar_series', 'calendar_views', 'calendar_reminders', 'calendar offers', ...CHAT_TABLES] }));
      return;
    }
    if (process.env.DRILL_MODE !== 'report') throw new Error('DRILL_MODE is seed or report');
    type Reported = { owner: string; rows: { key: string; columns: Record<string, string>; plain: Record<string, string | null> }[] };
    const installation: Record<string, Reported> = {};
    const report = async (table: string, owner: string, where = 'TRUE'): Promise<Reported> => {
      const key = (await rows(`SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`, [table])).map(row => String(row.COLUMN_NAME));
      if (!key.length) throw new Error(`${table} has no primary key to compare rows by`);
      return { owner, rows: (await rows(`SELECT * FROM \`${table}\` WHERE ${where} ORDER BY ${key.map(column => `\`${column}\``).join(', ')}`)).map(row => ({
        key: key.map(column => String(row[column])).join('/'),
        columns: Object.fromEntries(Object.entries(row).map(([column, value]) => [column, hash(value)])),
        plain: Object.fromEntries((PLAIN[table] || []).map(column => [column, row[column] == null ? null : String(row[column])])),
      })) };
    };
    for (const [table, declaration] of Object.entries(TABLE_DECLARATIONS).filter(([, declaration]) => declaration.owner !== 'user').sort()) {
      installation[table] = await report(table, declaration.owner);
    }
    // A shared book's rows in the person-owned tables, and its photo files, are the organisation's.
    for (const table of BOOK_ROWS.tables) installation[`${table} of books`] = await report(table, 'organisation', 'address_book_id IS NOT NULL');
    // Calendars no person owns and their rows; every series, view and personal reminder (no personal backup carries them); offers of people's calendars.
    for (const table of CALENDAR_ROWS.tables) {
      installation[`${table} of organisation calendars`] = await report(table, 'organisation', table === 'bin_items' ? 'user_id IS NULL AND calendar_id IS NOT NULL' : 'user_id IS NULL');
    }
    for (const table of ['calendar_series', 'calendar_views', 'calendar_reminders']) installation[table] = await report(table, 'organisation');
    installation['calendar offers'] = await report('calendar_calendars', 'organisation', 'offer_to IS NOT NULL');
    // A person's chat rows too: no personal backup carries them.
    for (const table of CHAT_TABLES) installation[table] ??= await report(table, 'user');
    const files = fs.existsSync(bookPhotos) ? (fs.readdirSync(bookPhotos, { recursive: true }) as string[]).filter(name => fs.statSync(path.join(bookPhotos, name)).isFile()).sort() : [];
    installation['photo files of books'] = { owner: 'organisation', rows: files.map(name => ({ key: name, columns: { content: hash(fs.readFileSync(path.join(bookPhotos, name))) }, plain: {} })) };
    const users = (await rows('SELECT * FROM users ORDER BY id')).map(row => ({ id: row.id, email: row.email, role: row.role, is_active: Number(row.is_active), row: hash(row) }));
    const mailAccounts = (await rows('SELECT * FROM mail_accounts ORDER BY id')).map(row => {
      const kept = Object.fromEntries(Object.entries(row).filter(([key]) => !ACCOUNT_RESETS.includes(key)));
      return { id: row.id, user_id: row.user_id, email_address: row.email_address, is_active: Number(row.is_active), delete_emails_on_server: Number(row.delete_emails_on_server),
        server_delete_enabled_at: row.server_delete_enabled_at ?? null, server_delete_grace_until: row.server_delete_grace_until ?? null,
        sync_policy_confirmed_at: row.sync_policy_confirmed_at ?? null, kept: hash(kept) };
    });
    console.log(JSON.stringify({
      users, mailAccounts, installation,
      policies: await rows('SELECT target_kind, target_id, setting_key, setting_value, locked FROM setting_policies ORDER BY target_kind, target_id, setting_key'),
      resets: {
        sessions: await count('SELECT COUNT(*) AS n FROM sessions'),
        devices: await count('SELECT COUNT(*) AS n FROM devices'),
        chatDevices: await count('SELECT COUNT(*) AS n FROM chat_devices WHERE device_id IS NOT NULL'),
        invites: await count('SELECT COUNT(*) AS n FROM invites'),
        fileTickets: await count('SELECT COUNT(*) AS n FROM file_tickets'),
        signInChallenges: await count('SELECT COUNT(*) AS n FROM two_factor_challenges'),
        leases: await count('SELECT (SELECT COUNT(*) FROM mail_engine_accounts WHERE lease_owner IS NOT NULL) + (SELECT COUNT(*) FROM mail_engine_jobs WHERE lease_owner IS NOT NULL) AS n'),
        runnableEngineJobs: await count("SELECT COUNT(*) AS n FROM mail_engine_jobs WHERE state IN ('queued', 'running', 'error')"),
        runnableWritebacks: await count("SELECT COUNT(*) AS n FROM mail_writebacks WHERE status = 'pending' OR is_current = TRUE"),
        calendarMoves: await count('SELECT COUNT(*) AS n FROM calendar_event_moves'),
        scheduledSends: await count("SELECT COUNT(*) AS n FROM mail_scheduled_sends WHERE status IN ('scheduled', 'sending')"),
        providerDeletions: await count("SELECT COUNT(*) AS n FROM mail_server_messages WHERE delete_status = 'pending'"),
      },
    }));
  } finally { await db.end(); }
}
main().catch((error: Error) => { console.error(error.stack || error.message); process.exit(1); });
