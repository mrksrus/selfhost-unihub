import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// Upgrade step 30: shared, group and organisation calendars and repeating
// local events. It adds tables and columns and changes no row; every
// existing calendar keeps its user_id and every event stays a single event.
// - calendar_calendars: no person owns a calendar with user_id and
//   account_id NULL; group_id (set null when the group goes) makes it a
//   group calendar, an organisation calendar without; a soft delete and an
//   archive mark; one pending ownership offer.
// - calendar_series: a repeating local event as iCalendar text; its dates are
//   calendar_events rows with series_id and recurrence_id.
// - user_id becomes nullable on a calendar's rows (NULL for a calendar no
//   person owns); a checklist point records who added it.
// - bin_items.calendar_id: a calendar's own bin (no foreign key: the purge
//   removes its items with the calendar).
// - notification_reminders: each person their own reminders on one event.
// - calendar_reminders and calendar_views: a person's own reminders on, and
//   view of, a calendar they reach.
//
// DDL commits on its own: each part checks whether an interrupted run
// already made it. Each existing table changes in one ALTER, so a large
// table is copied once. New foreign keys and checks carry names of their own.

type Executor = Pick<PoolConnection, 'execute'>;

async function hasColumn(connection: Executor, table: string, column: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\` WHERE Field = ?`, [column]);
  return present.length > 0;
}
async function nullable(connection: Executor, table: string, column: string) {
  const [[row]] = await connection.execute<RowDataPacket[]>(`SELECT IS_NULLABLE FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
  return row?.IS_NULLABLE === 'YES';
}
async function hasTable(connection: Executor, table: string) {
  const [present] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
  return present.length > 0;
}
async function hasConstraint(connection: Executor, table: string, name: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`, [table, name]);
  return present.length > 0;
}
async function primaryKey(connection: Executor, table: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT COLUMN_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`, [table]);
  return rows.map(row => String(row.COLUMN_NAME)).join(',');
}

// [table, whether the step already changed it, the one ALTER that changes it], in order.
const ALTERS: readonly [string, (connection: Executor) => Promise<boolean>, string][] = [
  ['calendar_calendars', connection => hasColumn(connection, 'calendar_calendars', 'group_id'),
    `ALTER TABLE calendar_calendars MODIFY user_id CHAR(36) NULL, MODIFY account_id CHAR(36) NULL,
      ADD COLUMN group_id CHAR(36) NULL, ADD COLUMN deleted_at DATETIME NULL, ADD COLUMN archived_at DATETIME NULL,
      ADD COLUMN offer_to CHAR(36) NULL, ADD COLUMN offer_by CHAR(36) NULL,
      ADD CONSTRAINT fk_calendar_calendars_group FOREIGN KEY (group_id) REFERENCES org_groups (id) ON DELETE SET NULL,
      ADD CONSTRAINT fk_calendar_calendars_offer_to FOREIGN KEY (offer_to) REFERENCES users (id) ON DELETE SET NULL,
      ADD CONSTRAINT fk_calendar_calendars_offer_by FOREIGN KEY (offer_by) REFERENCES users (id) ON DELETE SET NULL,
      ADD CONSTRAINT chk_calendar_calendars_owner CHECK ((user_id IS NULL) = (account_id IS NULL))`],
  ['calendar_events', connection => hasColumn(connection, 'calendar_events', 'series_id'),
    `ALTER TABLE calendar_events MODIFY user_id CHAR(36) NULL, ADD COLUMN series_id CHAR(36) NULL, ADD COLUMN recurrence_id VARCHAR(64) NULL,
      ADD UNIQUE KEY uq_calendar_events_series (series_id, recurrence_id),
      ADD CONSTRAINT fk_calendar_events_series FOREIGN KEY (series_id) REFERENCES calendar_series (id) ON DELETE CASCADE`],
  ['calendar_event_subtasks', connection => hasColumn(connection, 'calendar_event_subtasks', 'created_by'),
    `ALTER TABLE calendar_event_subtasks MODIFY user_id CHAR(36) NULL, ADD COLUMN created_by CHAR(36) NULL,
      ADD CONSTRAINT fk_calendar_event_subtasks_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL`],
  ['calendar_event_attendees', connection => nullable(connection, 'calendar_event_attendees', 'user_id'),
    'ALTER TABLE calendar_event_attendees MODIFY user_id CHAR(36) NULL'],
  // A person's item, a book's, or an item of a calendar no person owns.
  ['bin_items', connection => hasColumn(connection, 'bin_items', 'calendar_id'),
    `ALTER TABLE bin_items ADD COLUMN calendar_id CHAR(36) NULL, ADD KEY idx_bin_items_calendar (calendar_id),
      DROP CONSTRAINT chk_bin_items_owner,
      ADD CONSTRAINT chk_bin_items_owner CHECK ((user_id IS NOT NULL) + (address_book_id IS NOT NULL) + (user_id IS NULL AND calendar_id IS NOT NULL) = 1)`],
  ['notification_reminders', async connection => await primaryKey(connection, 'notification_reminders') === 'event_id,user_id,minutes',
    'ALTER TABLE notification_reminders DROP PRIMARY KEY, ADD PRIMARY KEY (event_id, user_id, minutes)'],
];

async function addSharedCalendars(connection: Executor) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS calendar_series (
    id CHAR(36) NOT NULL PRIMARY KEY,
    calendar_id CHAR(36) NOT NULL,
    uid VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
    ics MEDIUMTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_calendar_series_calendar FOREIGN KEY (calendar_id) REFERENCES calendar_calendars (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  for (const [, done, alter] of ALTERS) if (!await done(connection)) await connection.execute(alter);
  await connection.execute(`CREATE TABLE IF NOT EXISTS calendar_reminders (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    event_id CHAR(36) NULL,
    series_id CHAR(36) NULL,
    reminders JSON NOT NULL,
    UNIQUE KEY uq_calendar_reminders_event (user_id, event_id),
    UNIQUE KEY uq_calendar_reminders_series (user_id, series_id),
    CONSTRAINT fk_calendar_reminders_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_calendar_reminders_event FOREIGN KEY (event_id) REFERENCES calendar_events (id) ON DELETE CASCADE,
    CONSTRAINT fk_calendar_reminders_series FOREIGN KEY (series_id) REFERENCES calendar_series (id) ON DELETE CASCADE,
    CONSTRAINT chk_calendar_reminders_target CHECK ((event_id IS NULL) <> (series_id IS NULL))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS calendar_views (
    calendar_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    is_visible TINYINT(1) NOT NULL DEFAULT 1,
    color VARCHAR(20) NULL,
    notify_changes TINYINT(1) NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (calendar_id, user_id),
    KEY idx_calendar_views_user (user_id),
    CONSTRAINT fk_calendar_views_calendar FOREIGN KEY (calendar_id) REFERENCES calendar_calendars (id) ON DELETE CASCADE,
    CONSTRAINT fk_calendar_views_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

/** Step 30 is complete: the three tables and every changed table's columns, keys and checks exist. */
async function verifySharedCalendars(connection: Executor) {
  for (const table of ['calendar_series', 'calendar_reminders', 'calendar_views']) if (!await hasTable(connection, table)) throw new Error(`Table ${table} is missing`);
  for (const [table, done] of ALTERS) if (!await done(connection)) throw new Error(`${table} is not changed for shared calendars`);
  for (const [table, name] of [['calendar_calendars', 'fk_calendar_calendars_group'], ['calendar_calendars', 'chk_calendar_calendars_owner'],
    ['calendar_events', 'uq_calendar_events_series'], ['calendar_events', 'fk_calendar_events_series'], ['bin_items', 'chk_bin_items_owner'],
    ['calendar_reminders', 'chk_calendar_reminders_target']]) {
    if (!await hasConstraint(connection, table, name)) throw new Error(`Constraint ${name} on ${table} is missing`);
  }
  for (const [table, column] of [['calendar_calendars', 'user_id'], ['calendar_calendars', 'account_id'], ['calendar_events', 'user_id'], ['calendar_event_subtasks', 'user_id']]) {
    if (!await nullable(connection, table, column)) throw new Error(`${table}.${column} is still required`);
  }
}

export { addSharedCalendars, verifySharedCalendars };
