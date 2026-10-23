'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
// Requires an empty disposable MariaDB schema ending in _test. The real
// schema, settings service and notification pipeline; only the Web Push send
// is replaced, so `sent` holds exactly what a browser would receive.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

const one = async (db: FixtureValue, sql: string, params: FixtureValue[] = []) => (await db.execute(sql, params))[0][0];
const decode = (value: FixtureValue) => typeof value === 'string' ? JSON.parse(value) : value;

test('notification filters and privacy levels: mail folders by role and id, accounts, calendars, reminder level and policy floor',
  { skip: !process.env.MYSQL_TEST_HOST, timeout: 60000 }, async t => {
    assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Disposable schema only');
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'filters-bootstrap@example.test';
    process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-bootstrap-only';
    process.env.ENCRYPTION_KEY ||= 'notification-filter-test-key';
    const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD,
      database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 8 });
    const state = require('../dist/src/state') as typeof import('../src/state'), priorDb = state.getDb();
    const webPush = require('web-push');
    const originalSend = webPush.sendNotification;
    const sent: string[] = [];
    webPush.sendNotification = async (_subscription: FixtureValue, payload: string) => { sent.push(payload); return { statusCode: 201 }; };
    let ownsSchema = false;
    t.after(async () => {
      webPush.sendNotification = originalSend;
      try {
        if (ownsSchema) {
          const cx = await pool.getConnection();
          try {
            await cx.query('SET FOREIGN_KEY_CHECKS=0');
            try { for (const table of (await cx.query<RowDataPacket[]>('SHOW TABLES'))[0]) {
              const name = Object.values(table)[0]; assert.match((name as string), /^[a-z_]+$/);
              await cx.query(`DROP TABLE \`${name}\``);
            } } finally { await cx.query('SET FOREIGN_KEY_CHECKS=1'); }
          } finally { cx.release(); }
        }
      } finally { state.setDb(priorDb); await pool.end(); }
    });
    assert.equal((await pool.query<RowDataPacket[]>('SHOW TABLES'))[0].length, 0, 'Use an empty disposable test database');
    ownsSchema = true; state.setDb(pool);
    await (require('../dist/src/services/database') as typeof import('../src/services/database')).ensureSchema();
    const notifications = require('../dist/src/services/notifications') as typeof import('../src/services/notifications');
    const { updateSettings } = require('../dist/src/services/settings') as typeof import('../src/services/settings');
    const { ensureDefaultMailFoldersForUser, registerCustomImapFoldersForUser } = require('../dist/src/services/mail-folders') as typeof import('../src/services/mail-folders');
    const { ensureDefaultLocalCalendarForUser } = require('../dist/src/services/calendar') as typeof import('../src/services/calendar');
    const { reminderKey } = require('../dist/src/services/notification-rules') as typeof import('../src/services/notification-rules');

    // One person with a signed-in browser that turned notifications on, and two mail accounts.
    const userId = crypto.randomUUID(), sessionId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [userId, 'owner@example.test', 'synthetic']);
    const { sessionKey } = require('../dist/src/services/sessions') as typeof import('../src/services/sessions');
    await pool.execute<ResultSetHeader>('INSERT INTO sessions (id,user_id,token,expires_at) VALUES (?,?,?,?)', [sessionId, userId, sessionKey('owner-session'), new Date(Date.now() + 10 * 86400000)]);
    const keyBytes = Buffer.alloc(65, 1); keyBytes[0] = 4;
    await notifications.subscribe(userId, 'owner-session', { endpoint: 'https://fcm.googleapis.com/fcm/send/filters-browser',
      keys: { p256dh: keyBytes.toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') } });
    const work = crypto.randomUUID(), home = crypto.randomUUID();
    for (const [id, address, mode] of [[work, 'work@example.test', 'sync'], [home, 'home@example.test', 'download']]) {
      await pool.execute<ResultSetHeader>(`INSERT INTO mail_accounts (id,user_id,email_address,provider,sync_mode,is_active) VALUES (?,?,?,'custom',?,TRUE)`, [id, userId, address, mode]);
    }
    // Each account's Junk as the folder discovery registers it: a custom
    // folder of that account whose server reported the \Junk special use.
    await ensureDefaultMailFoldersForUser(userId);
    await registerCustomImapFoldersForUser(userId, work, ['Junk', 'Newsletters'], pool, new Map([['Junk', 'junk']]), true);
    await registerCustomImapFoldersForUser(userId, home, ['Spam'], pool, new Map([['Spam', 'junk']]), true);
    const folder = async (accountId: string | null, displayName: string) => one(pool, `SELECT id, slug, special_use FROM mail_folders WHERE user_id = ? AND display_name = ?
      AND ${accountId ? 'mail_account_id = ?' : 'mail_account_id IS NULL'}`, accountId ? [userId, displayName, accountId] : [userId, displayName]);
    const workJunk = await folder(work, 'Junk'), homeJunk = await folder(home, 'Spam'), newsletters = await folder(work, 'Newsletters');
    assert.deepEqual([workJunk.special_use, homeJunk.special_use, newsletters.special_use], ['junk', 'junk', null]);
    const inbox = await folder(null, 'Inbox');

    const subjects: string[] = [];
    async function arrive(accountId: string, slug: string, subject: string) {
      const emailId = crypto.randomUUID();
      subjects.push(subject);
      await pool.execute<ResultSetHeader>(`INSERT INTO emails (id, user_id, mail_account_id, subject, from_name, from_address, to_addresses, folder, is_read)
        VALUES (?, ?, ?, ?, 'Alex Example', 'alex@example.test', '[]', ?, FALSE)`, [emailId, userId, accountId, subject, slug]);
      return { emailId, eventId: await notifications.enqueueMailNotification({ userId, emailId }) };
    }
    const stored = async (eventId: string) => decode((await one(pool, 'SELECT payload FROM notification_events WHERE id = ?', [eventId])).payload);
    const deliveryStatus = async (eventId: string) => (await one(pool, 'SELECT status FROM notification_deliveries WHERE event_id = ?', [eventId])).status;
    const setMail = (accountId: string, values: Record<string, unknown>) => updateSettings('mail_account', userId, accountId, { values });
    const pass = async () => { await notifications.processNotificationJobs(); await notifications.processNotificationJobs(); };
    const sentPayloads = () => sent.map(text => JSON.parse(text));

    // Defaults: Junk (each account's own), Sent, Drafts, Trash and Archive are
    // left out by role; the inbox and other folders notify.
    const defaults: Record<string, boolean> = {};
    for (const [label, accountId, slug] of [['inbox', work, 'inbox'], ['newsletters', work, newsletters.slug], ['work junk', work, workJunk.slug],
      ['home junk', home, homeJunk.slug], ['sent', work, 'sent'], ['drafts', home, 'drafts'], ['trash', work, 'trash'], ['archive', home, 'archive'], ['home inbox', home, 'inbox']]) {
      defaults[label] = !!(await arrive(accountId, slug, `Default ${label}`)).eventId;
    }
    assert.deepEqual(defaults, { inbox: true, newsletters: true, 'work junk': false, 'home junk': false, sent: false, drafts: false, trash: false, archive: false, 'home inbox': true });

    // "Notify except selected" with chosen folders: by id and by role.
    await setMail(work, { notify_folders: [`folder:${newsletters.id}`, 'role:sent'] });
    assert.equal((await arrive(work, newsletters.slug, 'Chosen newsletters')).eventId, null);
    assert.equal((await arrive(work, 'sent', 'Chosen sent')).eventId, null);
    assert.ok((await arrive(work, workJunk.slug, 'Junk no longer excluded')).eventId, 'only the chosen folders are left out');
    assert.ok((await arrive(work, 'inbox', 'Chosen inbox')).eventId);
    // "Notify only for selected".
    await setMail(work, { notify_folder_mode: 'only', notify_folders: [`folder:${inbox.id}`] });
    assert.ok((await arrive(work, 'inbox', 'Only inbox')).eventId);
    assert.equal((await arrive(work, newsletters.slug, 'Only, not newsletters')).eventId, null);
    assert.equal((await arrive(work, 'trash', 'Only, not trash')).eventId, null);
    await setMail(work, { notify_folder_mode: 'except', notify_folders: ['role:junk', 'role:sent', 'role:drafts', 'role:trash', 'role:archive'] });
    // An account switched off entirely; the other account is unaffected.
    await setMail(home, { notify_enabled: false });
    assert.equal((await arrive(home, 'inbox', 'Home switched off')).eventId, null);
    assert.ok((await arrive(work, 'inbox', 'Work still on')).eventId);
    await setMail(home, { notify_enabled: true });
    await pass();
    const before = sent.length;

    // Rechecked before delivery: moved to Junk, or the account switched off meanwhile.
    const moved = await arrive(work, 'inbox', 'Moved to junk before delivery');
    const quiet = await arrive(home, 'inbox', 'Account off before delivery');
    assert.ok(moved.eventId && quiet.eventId);
    await pool.execute('UPDATE emails SET folder = ? WHERE id = ?', [workJunk.slug, moved.emailId]);
    await setMail(home, { notify_enabled: false });
    await pass();
    assert.equal(await deliveryStatus(moved.eventId!), 'cancelled');
    assert.equal(await deliveryStatus(quiet.eventId!), 'cancelled');
    assert.equal(sent.length, before, 'neither was sent');
    await setMail(home, { notify_enabled: true });
    // A held arrival filed to Junk before its content arrived is never released.
    const heldId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>(`INSERT INTO emails (id, user_id, mail_account_id, subject, from_name, from_address, to_addresses, folder, is_read)
      VALUES (?, ?, ?, '(Loading message)', NULL, 'unknown', '[]', 'inbox', FALSE)`, [heldId, userId, work]);
    assert.ok(await notifications.enqueueMailNotification({ userId, emailId: heldId, held: true }));
    await pool.execute('UPDATE emails SET folder = ?, subject = ? WHERE id = ?', [workJunk.slug, 'Held then junk', heldId]);
    const connection = await pool.getConnection();
    try { assert.equal(await notifications.releaseMailNotification({ userId, emailId: heldId }, connection), null); } finally { connection.release(); }

    // How much a mail notification shows: rendered on the server, so a hidden
    // sender or subject is in no field of the stored or the sent payload.
    const levels: Record<string, { stored: FixtureValue; sentText: string }> = {};
    for (const level of ['full', 'sender', 'none']) {
      await setMail(work, { notify_detail: level });
      const mail = await arrive(work, 'inbox', `Salary review ${level}`);
      await pass();
      const sentText = sent.find(text => JSON.parse(text).emailId === mail.emailId)!;
      assert.ok(sentText, `sent at ${level}`);
      levels[level] = { stored: await stored(mail.eventId!), sentText };
    }
    assert.deepEqual([levels.full.stored.title, levels.full.stored.body], ['New Email', 'Alex Example: Salary review full']);
    assert.deepEqual([levels.sender.stored.title, levels.sender.stored.body], ['New Email', 'Alex Example']);
    assert.deepEqual([levels.none.stored.title, levels.none.stored.body], ['New Email', '']);
    for (const level of ['sender', 'none']) {
      for (const text of [JSON.stringify(levels[level].stored), levels[level].sentText]) assert.doesNotMatch(text, /Salary review/, `no subject at ${level}`);
    }
    for (const text of [JSON.stringify(levels.none.stored), levels.none.sentText]) assert.doesNotMatch(text, /Alex|alex@example/, 'no sender at none');
    assert.equal(JSON.parse(levels.none.sentText).url, `/mail?email=${JSON.parse(levels.none.sentText).emailId}`, 'still opens the message');

    // A stricter level chosen after queuing applies to the delivery and the stored copy.
    await setMail(work, { notify_detail: 'full' });
    const changed = await arrive(work, 'inbox', 'Bonus letter');
    assert.equal((await stored(changed.eventId!)).body, 'Alex Example: Bonus letter');
    await setMail(work, { notify_detail: 'none' });
    await pass();
    const changedText = sent.find(text => JSON.parse(text).emailId === changed.emailId)!;
    assert.doesNotMatch(changedText, /Bonus letter|Alex/);
    assert.doesNotMatch(JSON.stringify(await stored(changed.eventId!)), /Bonus letter|Alex/);
    // A held arrival is released at the account's level.
    await setMail(work, { notify_detail: 'sender' });
    const releasedId = crypto.randomUUID();
    await pool.execute<ResultSetHeader>(`INSERT INTO emails (id, user_id, mail_account_id, subject, from_name, from_address, to_addresses, folder, is_read)
      VALUES (?, ?, ?, '(Loading message)', NULL, 'unknown', '[]', 'inbox', FALSE)`, [releasedId, userId, work]);
    const releasedEvent = await notifications.enqueueMailNotification({ userId, emailId: releasedId, held: true });
    await pool.execute("UPDATE emails SET subject = 'Contract draft', from_name = 'Alex Example' WHERE id = ?", [releasedId]);
    const releasing = await pool.getConnection();
    try { assert.equal(await notifications.releaseMailNotification({ userId, emailId: releasedId }, releasing), releasedEvent); } finally { releasing.release(); }
    assert.deepEqual([(await stored(releasedEvent!)).body, (await stored(releasedEvent!)).held], ['Alex Example', undefined]);

    // An installation policy floor raises the level: the person chose full,
    // the administrator allows at most the sender.
    await setMail(work, { notify_detail: 'full' });
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'mail_account.notify_detail', 'sender', 0)");
    const floored = await arrive(work, 'inbox', 'Under a policy');
    assert.equal((await stored(floored.eventId!)).body, 'Alex Example');
    await pass();
    assert.doesNotMatch(sent.find(text => JSON.parse(text).emailId === floored.emailId)!, /Under a policy/);
    await pool.execute("DELETE FROM setting_policies WHERE setting_key = 'mail_account.notify_detail'");

    // Calendars: new events and to-dos link to the exact item; a calendar
    // switched off announces nothing and cancels what was queued.
    const { calendarId } = await ensureDefaultLocalCalendarForUser(userId);
    const { accountId: calendarAccount } = await ensureDefaultLocalCalendarForUser(userId);
    const quietCalendar = crypto.randomUUID();
    await pool.execute<ResultSetHeader>(`INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id, color, is_visible, auto_todo_enabled, read_only, is_primary)
      VALUES (?, ?, ?, 'Side projects', 'local-side', '#2563eb', TRUE, TRUE, FALSE, FALSE)`, [quietCalendar, userId, calendarAccount]);
    async function calendarItem(calendar: string, title: string, { todo = false, start = new Date(Date.now() + 86400000), reminders = null as number[] | null } = {}) {
      const id = crypto.randomUUID();
      await pool.execute<ResultSetHeader>(`INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, reminders, is_todo_only)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, userId, calendar, title, start, new Date(start.getTime() + 3600000), reminders ? JSON.stringify(reminders) : null, todo]);
      return { id, eventId: await notifications.enqueueCalendarNotification({ userId, eventId: id }) };
    }
    const meeting = await calendarItem(calendarId, 'Board meeting');
    const chore = await calendarItem(calendarId, 'File taxes', { todo: true });
    assert.deepEqual([(await stored(meeting.eventId!)).url, (await stored(meeting.eventId!)).dedupeKey, (await stored(meeting.eventId!)).body],
      [`/calendar?event=${meeting.id}`, `calendar:${meeting.id}`, 'Board meeting']);
    assert.deepEqual([(await stored(chore.eventId!)).url, (await stored(chore.eventId!)).dedupeKey, (await stored(chore.eventId!)).title],
      [`/todo?event=${chore.id}`, `todo:${chore.id}`, 'New ToDo']);
    const pendingSide = await calendarItem(quietCalendar, 'Side launch');
    assert.ok(pendingSide.eventId);
    await updateSettings('calendar', userId, quietCalendar, { values: { notify_enabled: false } });
    assert.equal((await calendarItem(quietCalendar, 'Side retro')).eventId, null);
    await pass();
    assert.equal(await deliveryStatus(pendingSide.eventId!), 'cancelled');
    assert.equal(await deliveryStatus(meeting.eventId!), 'sent');

    // Reminders: the calendar's switch, and the person's level ('none' shows
    // only "Event reminder"); the title stays on the server.
    await updateSettings('user', userId, userId, { values: { reminder_notification_detail: 'none' } });
    const now = new Date(Math.floor((Date.now() - 5000) / 1000) * 1000);
    const due = await calendarItem(calendarId, 'Dentist appointment', { start: now, reminders: [0] });
    const muted = await calendarItem(quietCalendar, 'Muted standup', { start: now, reminders: [0] });
    await pass();
    const reminders = sentPayloads().filter(item => item.kind === 'reminder');
    assert.deepEqual(reminders.map(item => [item.eventId, item.title, item.body]), [[due.id, 'Event reminder', '']]);
    assert.equal(reminders[0].url, `/calendar?event=${due.id}`);
    assert.equal(reminders[0].dedupeKey, reminderKey({ id: due.id, start_time: now }, 0));
    const reminderEvents = (await pool.execute<RowDataPacket[]>("SELECT source_id, payload FROM notification_events WHERE kind = 'reminder'"))[0];
    assert.deepEqual(reminderEvents.map(row => row.source_id), [due.id], 'the switched-off calendar queued no reminder');
    assert.doesNotMatch(JSON.stringify(decode(reminderEvents[0].payload)), /Dentist/);
    assert.ok((await one(pool, 'SELECT queued_at FROM notification_reminders WHERE event_id = ?', [muted.id])).queued_at, 'and does not hold up later reminders');
    // New calendar items follow the same level.
    const hidden = await calendarItem(calendarId, 'Surprise party');
    assert.deepEqual([(await stored(hidden.eventId!)).title, (await stored(hidden.eventId!)).body], ['New Calendar Event', '']);

    // No payload ever carried a hidden subject outside the levels that show it.
    for (const text of sent) assert.doesNotMatch(text, /Salary review (sender|none)|Bonus letter|Under a policy|Dentist|Surprise party/);
    assert.ok(subjects.length > 20);
  });
