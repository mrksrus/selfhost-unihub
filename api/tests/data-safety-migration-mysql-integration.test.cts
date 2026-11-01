import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Upgrade step 25 on a database of 0.27 (step 24) with the rows real
// installations have: local tasks, a synced event, the occurrences of a
// recurring one, a synced row whose server copy is gone, calendars and
// recordings. Each must get the identity a later restore matches it by, also
// when the step runs again after an interruption, and rows made afterwards
// get one without the code that makes them naming it.
test('upgrade 25 gives every event, calendar and recording its stable identity, also after an interrupted run', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t, { migrate: false });
  const { runMigrations } = require('../dist/src/services/database-migrations') as typeof import('../src/services/database-migrations');
  const { MIGRATIONS } = require('../dist/src/services/database') as typeof import('../src/services/database');
  const { BASELINE } = require('../dist/src/services/database-baseline') as typeof import('../src/services/database-baseline');
  await runMigrations(pool, MIGRATIONS.filter(step => step.id <= 24), BASELINE);

  const id = () => crypto.randomUUID();
  const [alex, blair] = [id(), id()];
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'alex@example.test', 'x'), (?, 'blair@example.test', 'x')", [alex, blair]);
  const [localAccount, serverAccount, blairAccount] = [id(), id(), id()];
  await pool.execute(`INSERT INTO calendar_accounts (id, user_id, provider) VALUES (?, ?, 'local'), (?, ?, 'caldav'), (?, ?, 'local')`,
    [localAccount, alex, serverAccount, alex, blairAccount, blair]);
  const [errands, team, blairList] = [id(), id(), id()];
  await pool.execute(`INSERT INTO calendar_calendars (id, user_id, account_id, name, external_id) VALUES (?, ?, ?, 'Errands', NULL), (?, ?, ?, 'Team', '/dav/team/'), (?, ?, ?, 'Errands', NULL)`,
    [errands, alex, localAccount, team, alex, serverAccount, blairList, blair, blairAccount]);
  const event = async (user: string, calendar: string, title: string) => {
    const eventId = id();
    await pool.execute("INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, ?, '2026-11-02 09:00:00', '2026-11-02 10:00:00')", [eventId, user, calendar, title]);
    return eventId;
  };
  const synced = async (eventId: string, key: string, objectId: string | null) => pool.execute(`INSERT INTO calendar_event_external_refs
    (id, user_id, event_id, calendar_id, account_id, provider, external_event_id, remote_object_id) VALUES (?, ?, ?, ?, ?, 'caldav', ?, ?)`, [id(), alex, eventId, team, serverAccount, key, objectId]);
  const local = await event(alex, errands, 'Buy stamps');
  const blairs = await event(blair, blairList, 'Buy stamps');
  const single = await event(alex, team, 'Planning');
  const [weeklyA, weeklyB] = [await event(alex, team, 'Weekly'), await event(alex, team, 'Weekly')];
  const orphan = await event(alex, team, 'Copy gone');
  const [singleObject, weeklyObject] = [id(), id()];
  const uidOfWeekly = 'weekly-' + 'x'.repeat(300) + '@example.test';
  for (const [objectId, uid] of [[singleObject, 'planning@example.test'], [weeklyObject, uidOfWeekly]]) {
    await pool.execute(`INSERT INTO calendar_remote_objects (id, user_id, account_id, calendar_id, href, href_hash, uid, ics) VALUES (?, ?, ?, ?, ?, ?, ?, 'BEGIN:VCALENDAR')`,
      [objectId, alex, serverAccount, team, `/dav/team/${objectId}.ics`, crypto.createHash('sha256').update(objectId).digest('hex'), uid]);
  }
  await synced(single, `${singleObject}`, singleObject);
  await synced(weeklyA, `${weeklyObject}:1`, weeklyObject);
  await synced(weeklyB, `${weeklyObject}:2`, weeklyObject);
  await synced(orphan, 'legacy-ref', null);
  const recording = id();
  await pool.execute("INSERT INTO recordings (id, user_id, title, content_type, storage_path) VALUES (?, ?, 'Interview', 'audio/webm', 'recordings/x.webm')", [recording, alex]);

  // An interrupted step 25: the first column and part of the backfill ran, the step was not recorded.
  await pool.execute('ALTER TABLE calendar_events ADD COLUMN uid VARCHAR(500) NULL');
  await pool.execute('UPDATE calendar_events SET uid = id WHERE id = ?', [local]);
  await runMigrations(pool, MIGRATIONS, BASELINE);

  const [[step]] = await pool.query<RowDataPacket[]>('SELECT name FROM schema_migrations WHERE id = 25');
  assert.equal(step.name, 'backup-store-and-safety');
  const [events] = await pool.query<RowDataPacket[]>('SELECT id, uid FROM calendar_events');
  const uidOf = new Map(events.map(row => [row.id, row.uid]));
  assert.equal(uidOf.get(local), local, 'a local task keeps its id as identity');
  assert.equal(uidOf.get(blairs), blairs);
  assert.equal(uidOf.get(single), 'planning@example.test', 'a synced event takes its iCal UID');
  assert.equal(uidOf.get(weeklyA), uidOfWeekly, 'every occurrence shares the UID, at its full length');
  assert.equal(uidOf.get(weeklyB), uidOfWeekly);
  assert.equal(uidOf.get(orphan), orphan, 'a synced row without its server copy still gets an identity');
  const [calendars] = await pool.query<RowDataPacket[]>('SELECT id, uid FROM calendar_calendars');
  for (const row of calendars) assert.equal(row.uid, row.id);
  const [[recorded]] = await pool.query<RowDataPacket[]>('SELECT uid FROM recordings WHERE id = ?', [recording]);
  assert.equal(recorded.uid, recording);

  // Rows made after the upgrade by code that does not name an identity get a new one each.
  const [later, later2] = [await event(alex, errands, 'New task'), await event(alex, errands, 'New task')];
  const [fresh] = await pool.query<RowDataPacket[]>('SELECT uid FROM calendar_events WHERE id IN (?, ?)', [later, later2]);
  assert.equal(new Set(fresh.map(row => row.uid)).size, 2);
  for (const row of fresh) assert.match(row.uid, /^[0-9a-f-]{36}$/);
  await assert.rejects(pool.execute('UPDATE recordings SET uid = NULL WHERE id = ?', [recording]), /cannot be null|ER_BAD_NULL/i);

  // Starting again finds the step done.
  await runMigrations(pool, MIGRATIONS, BASELINE);
  const [[count]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 25');
  assert.equal(Number(count.n), 1);
});
