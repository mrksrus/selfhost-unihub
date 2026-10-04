const test = require('node:test');
const assert = require('node:assert/strict');

// This file runs in its own test process against an empty disposable _test DB.
// ensureSchema needs synthetic first-run bootstrap inputs before config is loaded.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'calendar-fixture-admin@example.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-calendar-fixture-admin-2026';
process.env.ENCRYPTION_KEY ||= 'calendar-sync-mysql-test-key';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { getDb, setDb } = require('../src/state');

const BASE = 'https://dav.example.test';
const CALENDAR_HREF = '/dav/calendars/person/work/';

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function eventIcs(uid, title, startMs) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UniHub test//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z',
    `DTSTART:${icsDate(startMs)}`, `DTEND:${icsDate(startMs + 3600000)}`, `SUMMARY:${title}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

test('calendar sync keeps unreadable entries, refuses unlinked writes, honours the calendar gate and links only mail calendars',
  { skip: !process.env.MYSQL_TEST_HOST }, async (t) => {
    const options = { host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
      database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', timezone: '+00:00' };
    const connection = await mysql.createConnection(options);
    const pool = mysql.createPool({ ...options, connectionLimit: 4 });
    const previous = getDb();
    const caldav = require('../src/services/caldav');
    const stubbed = ['listCalendars', 'listCalendarObjects', 'fetchCalendarObjects', 'putCalendarObject', 'deleteCalendarObject', 'findCalDavServer'];
    const originals = Object.fromEntries(stubbed.map(name => [name, caldav[name]]));
    let ownsDatabase = false;
    t.after(async () => {
      Object.assign(caldav, originals);
      setDb(previous);
      try {
        if (ownsDatabase) {
          await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
          try {
            const [tables] = await connection.query('SHOW TABLES');
            for (const row of tables) {
              const table = Object.values(row)[0];
              assert.match(table, /^[a-z_]+$/);
              await connection.execute(`DROP TABLE \`${table}\``);
            }
          } finally { await connection.execute('SET FOREIGN_KEY_CHECKS = 1'); }
        }
      } finally { await pool.end(); await connection.end(); }
    });
    assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Use an empty disposable test database');
    const [existing] = await connection.query('SHOW TABLES');
    assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
    ownsDatabase = true;
    setDb(pool);
    await require('../src/services/database').ensureSchema();

    const { encrypt } = require('../src/security/encryption');
    const calendarSync = require('../src/services/calendar-sync');
    const calendarAccounts = require('../src/services/calendar-accounts');
    const { setUserModules } = require('../src/services/module-settings');

    // One CalDAV server with one calendar; tests change its objects directly.
    const remote = { ctag: '1', objects: new Map() };
    const serverWrites = [];
    caldav.listCalendars = async () => [{ href: CALENDAR_HREF, url: `${BASE}${CALENDAR_HREF}`, displayName: 'Work', ctag: remote.ctag, readOnly: false }];
    caldav.listCalendarObjects = async () => [...remote.objects].map(([href, object]) => ({ href, url: `${BASE}${href}`, etag: object.etag }));
    caldav.fetchCalendarObjects = async ({ objects }) => objects.map(item => ({ href: item.href, etag: remote.objects.get(item.href).etag, ics: remote.objects.get(item.href).ics }));
    caldav.putCalendarObject = async args => { serverWrites.push(['put', args.url]); return { etag: '"put"' }; };
    caldav.deleteCalendarObject = async args => { serverWrites.push(['delete', args.url]); };

    const users = {};
    for (const name of ['sync', 'gate', 'link']) {
      users[name] = crypto.randomUUID();
      await connection.execute('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', [users[name], `${name}@example.test`, 'synthetic-hash']);
    }
    async function insertMail(userId, email) {
      const id = crypto.randomUUID();
      await connection.execute(
        "INSERT INTO mail_accounts (id, user_id, email_address, provider, imap_host, username, encrypted_password, is_active) VALUES (?, ?, ?, 'custom', 'imap.example.test', ?, ?, TRUE)",
        [id, userId, email, email, encrypt('synthetic-mail-password')]
      );
      return id;
    }
    async function insertCalDav(userId, email, config, mailAccountId = null, password = 'synthetic-dav-password') {
      const id = crypto.randomUUID();
      await connection.execute(
        `INSERT INTO calendar_accounts (id, user_id, provider, account_email, display_name, username, encrypted_password, base_url, provider_config, is_active, mail_account_id)
         VALUES (?, ?, 'caldav', ?, 'Calendar', ?, ?, ?, ?, TRUE, ?)`,
        [id, userId, email, email, encrypt(password), `${BASE}/dav/calendars/person/`, JSON.stringify(config), mailAccountId]
      );
      // Accounts are linked oldest first; keep creation order distinct.
      await new Promise(resolve => setTimeout(resolve, 1100));
      return id;
    }
    const current = { server: { url: BASE, source: 'discovered', label: 'dav.example.test' }, principalHref: '/dav/principals/person/' };
    const legacy = { principalHref: '/dav/principals/person/' };

    await t.test('an unreadable server copy keeps the last readable event and its ToDo state', async () => {
      const userId = users.sync;
      const accountId = await insertCalDav(userId, 'sync@example.test', current);
      const href = `${CALENDAR_HREF}meeting.ics`;
      const start = Date.now() + 2 * 86400000;
      remote.objects.set(href, { etag: '"a1"', ics: eventIcs('meeting@example.test', 'Planning', start) });
      const first = await calendarSync.syncCalendarAccount(accountId, { userId });
      assert.equal(first.unreadable, 0);
      const [[event]] = await connection.execute('SELECT id, title FROM calendar_events WHERE user_id = ?', [userId]);
      assert.equal(event.title, 'Planning');
      await connection.execute("UPDATE calendar_events SET todo_status = 'done' WHERE id = ?", [event.id]);

      remote.ctag = '2';
      remote.objects.set(href, { etag: '"a2"', ics: 'This is not a calendar object' });
      const second = await calendarSync.syncCalendarAccount(accountId, { userId });
      assert.equal(second.unreadable, 1);
      const [kept] = await connection.execute('SELECT id, title, todo_status FROM calendar_events WHERE user_id = ?', [userId]);
      assert.deepEqual(kept.map(row => ({ ...row })), [{ id: event.id, title: 'Planning', todo_status: 'done' }]);
      const [[object]] = await connection.execute('SELECT etag, ics FROM calendar_remote_objects WHERE account_id = ?', [accountId]);
      assert.equal(object.etag, '"a1"', 'the ETag of the unreadable copy is not kept, so it is downloaded again');
      assert.match(object.ics, /SUMMARY:Planning/);
      const [[account]] = await connection.execute('SELECT sync_status, sync_error FROM calendar_accounts WHERE id = ?', [accountId]);
      assert.equal(account.sync_status, 'error');
      assert.match(account.sync_error, /1 calendar entry could not be read/);
      const [[calendar]] = await connection.execute('SELECT remote_ctag FROM calendar_calendars WHERE account_id = ?', [accountId]);
      assert.equal(calendar.remote_ctag, null, 'the calendar is listed again on the next sync');

      // The server copy becomes readable again without a calendar change.
      remote.objects.set(href, { etag: '"a3"', ics: eventIcs('meeting@example.test', 'Planning (moved room)', start) });
      const third = await calendarSync.syncCalendarAccount(accountId, { userId });
      assert.equal(third.unreadable, 0);
      const [updated] = await connection.execute('SELECT id, title, todo_status FROM calendar_events WHERE user_id = ?', [userId]);
      assert.deepEqual(updated.map(row => ({ ...row })), [{ id: event.id, title: 'Planning (moved room)', todo_status: 'done' }]);
      const [[recovered]] = await connection.execute('SELECT sync_status, sync_error FROM calendar_accounts WHERE id = ?', [accountId]);
      assert.deepEqual({ ...recovered }, { sync_status: 'ok', sync_error: null });

      // 0.17.0 stored an unreadable copy with the server's current ETag. The
      // daily expansion finds it, and the next sync downloads it again.
      const [[workCalendar]] = await connection.execute('SELECT id FROM calendar_calendars WHERE account_id = ?', [accountId]);
      const storedHref = `${CALENDAR_HREF}review.ics`;
      remote.objects.set(storedHref, { etag: '"b1"', ics: eventIcs('review@example.test', 'Review', start) });
      await connection.execute(
        'INSERT INTO calendar_remote_objects (id, user_id, account_id, calendar_id, href, href_hash, etag, ics) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), userId, accountId, workCalendar.id, storedHref, crypto.createHash('sha256').update(storedHref).digest('hex'), '"b1"', 'This is not a calendar object']
      );
      await connection.execute('UPDATE calendar_calendars SET remote_expanded_on = NULL WHERE id = ?', [workCalendar.id]);
      assert.equal((await calendarSync.syncCalendarAccount(accountId, { userId })).unreadable, 1);
      assert.equal((await calendarSync.syncCalendarAccount(accountId, { userId })).unreadable, 0);
      const [titles] = await connection.execute('SELECT title FROM calendar_events WHERE user_id = ? ORDER BY title', [userId]);
      assert.deepEqual(titles.map(row => row.title), ['Planning (moved room)', 'Review']);

      // An event from before 0.17 has a reference but no server copy yet.
      const legacyEventId = crypto.randomUUID();
      await connection.execute(
        "INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, 'Old import', UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL 1 HOUR)",
        [legacyEventId, userId, workCalendar.id]
      );
      await connection.execute(
        "INSERT INTO calendar_event_external_refs (id, user_id, event_id, calendar_id, account_id, provider, external_event_id) VALUES (?, ?, ?, ?, ?, 'caldav', 'old-import')",
        [crypto.randomUUID(), userId, legacyEventId, workCalendar.id, accountId]
      );
      const [[legacyEvent]] = await connection.execute('SELECT * FROM calendar_events WHERE id = ?', [legacyEventId]);
      serverWrites.length = 0;
      await assert.rejects(calendarSync.pushEventDelete({ userId, event: legacyEvent, scope: 'occurrence' }), { code: 'CALENDAR_SYNC_PENDING', status: 409 });
      await assert.rejects(calendarSync.pushEventMove({ userId, event: legacyEvent, targetCalendarId: crypto.randomUUID(), changes: {} }), { code: 'CALENDAR_SYNC_PENDING' });
      await assert.rejects(calendarSync.pushEventUpdate({ userId, event: legacyEvent, changes: { title: 'Renamed' }, scope: 'occurrence' }), { code: 'CALENDAR_SYNC_PENDING' });
      assert.deepEqual(serverWrites, []);
      // A linked event is still deleted on the server.
      await calendarSync.pushEventDelete({ userId, event: { ...event, calendar_id: workCalendar.id }, scope: 'occurrence' });
      assert.deepEqual(serverWrites, [['delete', `${BASE}${href}`]]);
    });

    await t.test('an owed first sync waits for the module, not for background sync', async () => {
      const userId = crypto.randomUUID();
      await connection.execute('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', [userId, 'first@example.test', 'synthetic-hash']);
      const accountId = await insertCalDav(userId, 'first@example.test', current);
      await connection.execute("UPDATE calendar_accounts SET sync_status = 'pending' WHERE id = ?", [accountId]);
      const scheduled = () => calendarSync.syncCalendarAccount(accountId, { userId, reason: 'scheduled' });

      await setUserModules(userId, { modules: { calendar: { enabled: false } } });
      assert.deepEqual(await scheduled(), { skipped: true, reason: 'paused' });
      await setUserModules(userId, { modules: { calendar: { enabled: true, background: false } } });
      assert.equal((await scheduled()).ok, true, 'The owed first sync runs with background sync off');
      // Once synced, scheduled syncs follow the background setting again.
      assert.deepEqual(await scheduled(), { skipped: true, reason: 'paused' });
    });

    await t.test('turning a mail calendar off follows the Calendar module and restore gate', async () => {
      const userId = users.gate;
      const mailId = await insertMail(userId, 'gate@example.test');
      const accountId = await insertCalDav(userId, 'gate@example.test', { ...current, mailLinked: true }, mailId);
      const count = async () => Number((await connection.execute('SELECT COUNT(*) AS n FROM calendar_accounts WHERE id = ?', [accountId]))[0][0].n);

      await setUserModules(userId, { modules: { calendar: { enabled: false } } });
      await assert.rejects(calendarAccounts.setMailCalendar(userId, mailId, { enabled: false }), { code: 'CALENDAR_MODULE_DISABLED' });
      await assert.rejects(calendarAccounts.getMailCalendarLink(userId, mailId), { code: 'CALENDAR_MODULE_DISABLED' });
      assert.equal(await count(), 1);

      await setUserModules(userId, { modules: { calendar: { enabled: true } } });
      const restoreId = crypto.randomUUID();
      await connection.execute(
        "INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '[\"calendar\"]')",
        [restoreId, userId]
      );
      await assert.rejects(calendarAccounts.setMailCalendar(userId, mailId, { enabled: false }), { code: 'CALENDAR_RESTORING' });
      assert.equal(await count(), 1);
      await connection.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);

      const off = await calendarAccounts.setMailCalendar(userId, mailId, { enabled: false });
      assert.equal(off.enabled, false);
      assert.equal(await count(), 0);
    });

    await t.test('only calendars that belonged to a mail account are linked by address', async () => {
      const userId = users.link;
      const mailId = await insertMail(userId, 'link@example.test');
      // Added on the Calendar page with the same address: never taken over.
      const standalone = await insertCalDav(userId, 'LINK@example.test', current);
      let link = await calendarAccounts.getMailCalendarLink(userId, mailId);
      assert.equal(link.enabled, false);
      const config = value => typeof value === 'string' ? JSON.parse(value) : value;
      const mailLink = async id => (await connection.execute('SELECT mail_account_id, provider_config, encrypted_password FROM calendar_accounts WHERE id = ?', [id]))[0][0];
      assert.equal((await mailLink(standalone)).mail_account_id, null);

      // Connected before 0.17: no server entry in its configuration.
      const older = await insertCalDav(userId, 'link@example.test', legacy);
      link = await calendarAccounts.getMailCalendarLink(userId, mailId);
      assert.equal(link.account.id, older);
      const linked = await mailLink(older);
      assert.equal(linked.mail_account_id, mailId);
      assert.equal(config(linked.provider_config).mailLinked, true, 'the mark survives a backup');
      assert.equal(linked.encrypted_password, null, 'Linked, it uses the mail login and keeps no password of its own');
      assert.equal((await mailLink(standalone)).mail_account_id, null);

      // Restored from a backup: the link column is empty but the mark is kept.
      const otherMail = await insertMail(userId, 'restored@example.test');
      const restored = await insertCalDav(userId, 'restored@example.test', { ...current, mailLinked: true });
      link = await calendarAccounts.getMailCalendarLink(userId, otherMail);
      assert.equal(link.account.id, restored);

      // Restored from a 0.17.0 backup: neither link nor mark, so looking does
      // not link it, even with the mail account's login. Turning the calendar
      // on takes it over in place with its events and ToDo state.
      const archiveMail = await insertMail(userId, 'archive@example.test');
      const restoredLogin = await insertCalDav(userId, 'archive@example.test', current, null, 'synthetic-mail-password');
      link = await calendarAccounts.getMailCalendarLink(userId, archiveMail);
      assert.equal(link.enabled, false);
      assert.equal((await mailLink(restoredLogin)).mail_account_id, null);
      await calendarSync.syncCalendarAccount(restoredLogin, { userId });
      const [[restoredEvent]] = await connection.execute("SELECT id FROM calendar_events WHERE user_id = ? AND title = 'Review'", [userId]);
      await connection.execute("UPDATE calendar_events SET todo_status = 'done' WHERE id = ?", [restoredEvent.id]);
      caldav.findCalDavServer = async () => ({
        server: current.server, credentialScope: BASE, hint: null,
        discovery: { baseUrl: `${BASE}/dav/calendars/person/`, principalHref: current.principalHref, calendars: await caldav.listCalendars() },
      });
      const backgroundSync = calendarSync.syncCalendarAccountInBackground;
      calendarSync.syncCalendarAccountInBackground = () => {};
      try {
        link = await calendarAccounts.setMailCalendar(userId, archiveMail, { enabled: true });
      } finally { calendarSync.syncCalendarAccountInBackground = backgroundSync; }
      assert.equal(link.account.id, restoredLogin);
      const adopted = await mailLink(restoredLogin);
      assert.equal(adopted.mail_account_id, archiveMail);
      assert.equal(config(adopted.provider_config).mailLinked, true);
      assert.equal(adopted.encrypted_password, null);
      // Its sync logs in with the mail login.
      const listCalendars = caldav.listCalendars, logins = [];
      caldav.listCalendars = async args => { logins.push([args.username, args.password]); return listCalendars(args); };
      try { assert.equal((await calendarSync.syncCalendarAccount(restoredLogin, { userId })).ok, true); } finally { caldav.listCalendars = listCalendars; }
      assert.deepEqual(logins, [['archive@example.test', 'synthetic-mail-password']]);
      // A later mail login change, then the address set again: still the same
      // account (matched by the mail login, not the one it was connected with),
      // with its events and ToDo state.
      await connection.execute("UPDATE mail_accounts SET username = 'renamed-login' WHERE id = ?", [archiveMail]);
      calendarSync.syncCalendarAccountInBackground = () => {};
      try {
        link = await calendarAccounts.setMailCalendar(userId, archiveMail, { enabled: true, caldav_url: `${BASE}/dav/` });
      } finally { calendarSync.syncCalendarAccountInBackground = backgroundSync; }
      assert.equal(link.account.id, restoredLogin);
      assert.equal((await connection.execute("SELECT todo_status FROM calendar_events WHERE id = ?", [restoredEvent.id]))[0][0].todo_status, 'done');
      const [[keptTodo]] = await connection.execute('SELECT todo_status FROM calendar_events WHERE id = ?', [restoredEvent.id]);
      assert.equal(keptTodo.todo_status, 'done');

      // Linked by 0.17.0 without the mark: the 0.17.1 upgrade adds it, so a
      // backup taken right after upgrading can link it again.
      const thirdMail = await insertMail(userId, 'unmarked@example.test');
      const unmarked = await insertCalDav(userId, 'unmarked@example.test', current, thirdMail);
      // Restored by 0.18.1 and not linked again yet: only marked, with a copy
      // of the mail password, and switched off by a mail disconnect.
      const restoredCopy = await insertCalDav(userId, 'gone@example.test', { ...current, mailLinked: true }, null, 'copied-mail-password');
      await connection.execute("UPDATE calendar_accounts SET is_active = FALSE, sync_status = 'paused', sync_error = ? WHERE id = ?",
        [calendarSync.MAIL_DISCONNECTED_MESSAGE, restoredCopy]);
      // Connected from mail before 0.17 and never linked: its copy goes while a
      // mail account with its address exists; without one it is its own.
      await insertMail(userId, 'prior@example.test');
      const priorCopy = await insertCalDav(userId, 'prior@example.test', legacy, null, 'copied-mail-password');
      const priorAlone = await insertCalDav(userId, 'alone@example.test', legacy, null, 'own-password');
      await connection.execute('DELETE FROM schema_migrations WHERE id >= 13');
      await require('../src/services/database').ensureSchema();
      const password = async id => (await connection.execute('SELECT encrypted_password FROM calendar_accounts WHERE id = ?', [id]))[0][0].encrypted_password;
      assert.equal(await password(priorCopy), null);
      assert.notEqual(await password(priorAlone), null);
      assert.deepEqual(config((await mailLink(unmarked)).provider_config), { ...current, mailLinked: true });
      assert.equal(config((await mailLink(standalone)).provider_config).mailLinked, undefined);
      const [[upgraded]] = await connection.execute('SELECT encrypted_password, is_active, sync_status, sync_error FROM calendar_accounts WHERE id = ?', [restoredCopy]);
      assert.deepEqual({ ...upgraded, is_active: Number(upgraded.is_active) }, { encrypted_password: null, is_active: 1, sync_status: 'pending', sync_error: null });
      assert.notEqual((await connection.execute('SELECT encrypted_password FROM calendar_accounts WHERE id = ?', [standalone]))[0][0].encrypted_password, null,
        'A calendar added on its own keeps its password');
    });
  });
