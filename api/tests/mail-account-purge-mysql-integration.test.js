const test = require('node:test');
const assert = require('node:assert/strict');

// This file runs in its own test process against an empty disposable _test DB.
// ensureSchema needs synthetic first-run bootstrap inputs before config is loaded.
process.env.BOOTSTRAP_ADMIN_EMAIL = 'purge-fixture-admin@example.test';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-purge-fixture-admin-2026';
process.env.ENCRYPTION_KEY ||= 'mail-account-purge-mysql-test-key';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { getDb, setDb } = require('../src/state');

test('disconnect and delete removes the mail account, its mail and its linked calendar, and nothing of another user',
  { skip: !process.env.MYSQL_TEST_HOST }, async (t) => {
    const options = { host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
      user: process.env.MYSQL_TEST_USER || 'unihub_test', password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
      database: process.env.MYSQL_TEST_DATABASE || 'unihub_test', timezone: '+00:00' };
    const connection = await mysql.createConnection(options);
    const pool = mysql.createPool({ ...options, connectionLimit: 4 });
    const previous = getDb();
    let ownsDatabase = false;
    t.after(async () => {
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
    const lifecycle = require('../src/services/mail-account-lifecycle');
    const { setUserModules } = require('../src/services/module-settings');
    const calendarSync = require('../src/services/calendar-sync');

    // Each user has a connected mail account with two messages and a linked
    // calendar account holding one calendar with two events.
    const seed = async name => {
      const user = crypto.randomUUID(), mail = crypto.randomUUID(), calendarAccount = crypto.randomUUID(), calendar = crypto.randomUUID();
      await connection.execute('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)', [user, `${name}@example.test`, 'synthetic-hash']);
      await connection.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, username, imap_host, encrypted_password, is_active)
        VALUES (?, ?, ?, 'custom', ?, 'imap.example.test', ?, TRUE)`, [mail, user, `${name}@example.test`, `${name}@example.test`, encrypt('synthetic-password')]);
      for (const subject of ['First', 'Second']) {
        await connection.execute(`INSERT INTO emails (id, user_id, mail_account_id, from_address, to_addresses, subject)
          VALUES (?, ?, ?, 'sender@example.test', '[]', ?)`, [crypto.randomUUID(), user, mail, subject]);
      }
      await connection.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, mail_account_id, is_active)
        VALUES (?, ?, 'caldav', ?, ?, TRUE)`, [calendarAccount, user, `${name}@example.test`, mail]);
      await connection.execute('INSERT INTO calendar_calendars (id, user_id, account_id, name) VALUES (?, ?, ?, ?)', [calendar, user, calendarAccount, 'Work']);
      for (const title of ['Meeting', 'Review']) {
        await connection.execute(`INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time)
          VALUES (?, ?, ?, ?, '2026-10-05 09:00:00', '2026-10-05 10:00:00')`, [crypto.randomUUID(), user, calendar, title]);
      }
      return { user, mail, calendarAccount };
    };
    const owner = await seed('owner');
    const other = await seed('other');
    const paused = await seed('paused');
    const count = async (sql, params) => Number((await connection.execute(sql, params))[0][0].n);

    const preview = await lifecycle.purgePreview(owner.user, owner.mail, undefined, { disconnecting: true });
    assert.deepEqual({ emails: preview.email_count, calendars: preview.calendar_accounts, events: preview.calendar_events, blocked: preview.blocked },
      { emails: 2, calendars: 1, events: 2, blocked: false });
    assert.equal((await lifecycle.purgePreview(owner.user, owner.mail)).blocked, true, 'a plain purge still needs a disconnected account');
    await assert.rejects(lifecycle.disconnectAndPurgeAccount(other.user, owner.mail, 'owner@example.test'), error => error.status === 404);

    // With Calendar off, its data is not changed through the mail route: the
    // delete is refused before anything happens, including the disconnect.
    await setUserModules(owner.user, { modules: { calendar: { enabled: false } } });
    assert.match((await lifecycle.purgePreview(owner.user, owner.mail, undefined, { disconnecting: true })).reason, /Calendar is turned off/);
    await assert.rejects(lifecycle.disconnectAndPurgeAccount(owner.user, owner.mail, 'owner@example.test'), /Calendar is turned off/);
    assert.equal(await count('SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = ? AND is_active = TRUE', [owner.user]), 1);
    await setUserModules(owner.user, { modules: { calendar: { enabled: true } } });

    // A failing calendar delete rolls the whole purge back.
    await connection.execute(`CREATE TRIGGER purge_test_block BEFORE DELETE ON calendar_events FOR EACH ROW
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic calendar delete failure'`);
    await assert.rejects(lifecycle.disconnectAndPurgeAccount(owner.user, owner.mail, 'owner@example.test'), /synthetic calendar delete failure/);
    await connection.execute('DROP TRIGGER purge_test_block');
    assert.equal(await count('SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = ? AND disconnected_at IS NOT NULL', [owner.user]), 1,
      'The disconnect happened, the purge did not');
    assert.equal(await count('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?', [owner.user]), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?', [owner.user]), 2);

    // Retry of the now disconnected account: a plain purge removes everything.
    const result = await lifecycle.purgeAccount(owner.user, owner.mail, 'owner@example.test');
    assert.equal(result.purged, true);

    assert.equal(await count('SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = ?', [owner.user]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?', [owner.user]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_accounts WHERE user_id = ?', [owner.user]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?', [owner.user]), 0);

    assert.equal(await count('SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = ? AND is_active = TRUE', [other.user]), 1);

    // A restored calendar is not linked yet (backups keep only the mark): it is
    // counted, gated and deleted like a linked one. A calendar account added on
    // its own for the same address stays.
    const restored = await seed('restored');
    await connection.execute(`UPDATE calendar_accounts SET mail_account_id = NULL, provider_config = '{"mailLinked":true}' WHERE id = ?`, [restored.calendarAccount]);
    const standalone = crypto.randomUUID();
    await connection.execute(`INSERT INTO calendar_accounts (id, user_id, provider, account_email, provider_config, is_active)
      VALUES (?, ?, 'caldav', 'restored@example.test', '{"server":{"url":"https://dav.example.test"}}', TRUE)`, [standalone, restored.user]);
    await setUserModules(restored.user, { modules: { calendar: { enabled: false } } });
    assert.match((await lifecycle.purgePreview(restored.user, restored.mail, undefined, { disconnecting: true })).reason, /Calendar is turned off/);
    await setUserModules(restored.user, { modules: { calendar: { enabled: true } } });
    const restoredPreview = await lifecycle.purgePreview(restored.user, restored.mail, undefined, { disconnecting: true });
    assert.deepEqual([restoredPreview.calendar_accounts, restoredPreview.calendar_events, restoredPreview.blocked], [1, 2, false]);
    await lifecycle.disconnectAndPurgeAccount(restored.user, restored.mail, 'restored@example.test');
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_accounts WHERE id = ?', [restored.calendarAccount]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?', [restored.user]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_accounts WHERE id = ?', [standalone]), 1);

    // A linked calendar has no password of its own. Disconnecting mail leaves
    // the calendar row as it is; its sync then waits (noted as paused) until
    // the mail account is connected again, and a pause of its user is its own.
    const calendarRow = async id => (await connection.execute(
      'SELECT is_active, encrypted_password, sync_status, sync_error, mail_account_id FROM calendar_accounts WHERE id = ?', [id]))[0][0];
    await connection.execute('UPDATE calendar_accounts SET encrypted_password = NULL WHERE id IN (?, ?)', [paused.calendarAccount, other.calendarAccount]);
    await setUserModules(paused.user, { modules: { calendar: { enabled: false } } });
    await lifecycle.disconnectAccount(paused.user, paused.mail);
    await setUserModules(paused.user, { modules: { calendar: { enabled: true } } });
    const [[pausedRow]] = await connection.execute('SELECT * FROM calendar_accounts WHERE id = ?', [paused.calendarAccount]);
    assert.equal(Number(pausedRow.is_active), 1, 'Disconnecting mail does not switch the calendar off');
    await assert.rejects(calendarSync.resolveLogin(pausedRow), { code: 'MAIL_ACCOUNT_DISCONNECTED' });
    assert.deepEqual(await calendarSync.syncCalendarAccount(paused.calendarAccount, { userId: paused.user }), { skipped: true, reason: 'mail-disconnected' });
    const waiting = await calendarRow(paused.calendarAccount);
    assert.deepEqual([Number(waiting.is_active), waiting.encrypted_password, waiting.sync_status, waiting.sync_error],
      [1, null, 'paused', calendarSync.MAIL_DISCONNECTED_MESSAGE]);
    const listed = async userId => {
      const routes = require('../src/routes/calendar');
      const { accounts } = await routes['GET /api/calendar/accounts']({ url: '/api/calendar/accounts' }, userId);
      return accounts.filter(account => account.provider === 'caldav').map(account => [account.sync_status, account.sync_error]);
    };
    assert.deepEqual(await listed(paused.user), [['paused', calendarSync.MAIL_DISCONNECTED_MESSAGE]]);

    // Reconnected (a new password): the calendar uses it right away, with no
    // copy written, and is listed as waiting for its next sync.
    await connection.execute('UPDATE mail_accounts SET is_active = TRUE, disconnected_at = NULL, encrypted_password = ? WHERE id = ?',
      [encrypt('new-synthetic-password'), paused.mail]);
    const login = await calendarSync.resolveLogin(pausedRow);
    const [[mailLogin]] = await connection.execute('SELECT encrypted_password FROM mail_accounts WHERE id = ?', [paused.mail]);
    assert.deepEqual(login, { username: 'paused@example.test', encryptedPassword: mailLogin.encrypted_password });
    assert.equal((await calendarRow(paused.calendarAccount)).encrypted_password, null);
    assert.deepEqual(await listed(paused.user), [['pending', null]]);

    // A pause of the user: a sync while the mail account is disconnected
    // does not overwrite it.
    await connection.execute("UPDATE calendar_accounts SET is_active = FALSE, sync_status = 'paused', sync_error = NULL WHERE id = ?", [other.calendarAccount]);
    await lifecycle.disconnectAccount(other.user, other.mail);
    assert.deepEqual(await calendarSync.syncCalendarAccount(other.calendarAccount, { userId: other.user }), { skipped: true, reason: 'inactive' });
    const userPause = await calendarRow(other.calendarAccount);
    assert.deepEqual([Number(userPause.is_active), userPause.sync_error], [0, null]);

    // A restored mail calendar (link not restored, no password of its own)
    // finds its mail account the first time it needs a login.
    await connection.execute(`UPDATE calendar_accounts SET mail_account_id = NULL, provider_config = '{"mailLinked":true}' WHERE id = ?`, [paused.calendarAccount]);
    const [[unlinked]] = await connection.execute('SELECT * FROM calendar_accounts WHERE id = ?', [paused.calendarAccount]);
    assert.deepEqual(await calendarSync.resolveLogin(unlinked), login);
    assert.equal((await calendarRow(paused.calendarAccount)).mail_account_id, paused.mail);
    assert.equal(await count('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?', [other.user]), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?', [other.user]), 2);
  });
