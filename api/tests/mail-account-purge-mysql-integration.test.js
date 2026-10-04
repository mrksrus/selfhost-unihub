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
    const calendarAccounts = require('../src/services/calendar-accounts');

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
    const count = async (sql, params) => Number((await connection.execute(sql, params))[0][0].n);

    const preview = await lifecycle.purgePreview(owner.user, owner.mail, undefined, { disconnecting: true });
    assert.deepEqual({ emails: preview.email_count, calendars: preview.calendar_accounts, events: preview.calendar_events, blocked: preview.blocked },
      { emails: 2, calendars: 1, events: 2, blocked: false });
    assert.equal((await lifecycle.purgePreview(owner.user, owner.mail)).blocked, true, 'a plain purge still needs a disconnected account');
    await assert.rejects(lifecycle.disconnectAndPurgeAccount(other.user, owner.mail, owner.mail), error => error.status === 404);

    const result = await lifecycle.disconnectAndPurgeAccount(owner.user, owner.mail, owner.mail);
    assert.equal(result.purged, true);
    await calendarAccounts.removeLinkedCalendars(owner.user, owner.mail);

    assert.equal(await count('SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = ?', [owner.user]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?', [owner.user]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_accounts WHERE user_id = ?', [owner.user]), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?', [owner.user]), 0);

    assert.equal(await count('SELECT COUNT(*) AS n FROM mail_accounts WHERE user_id = ? AND is_active = TRUE', [other.user]), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM emails WHERE user_id = ?', [other.user]), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_events WHERE user_id = ?', [other.user]), 2);
  });
