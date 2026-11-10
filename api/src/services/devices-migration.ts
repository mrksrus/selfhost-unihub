import crypto from 'node:crypto';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

import { deviceFromUserAgent } from './devices';
import { log } from '../log';

// Upgrade step 26 (0.29.0): devices as records (F5). Each session from before
// the step gets a device of its own, so nobody is signed out and every push
// channel keeps working; a 0.29 page then names its browser's device key and
// joins the sessions of one browser into one device again (services/devices.ts).
//
// sessions.device_id and push_subscriptions.device_id stay nullable in 0.29
// (expand): every 0.29 writer sets them and this step fills in the rest; a
// later version's step makes them required (contract).
//
// DDL commits on its own: each part checks whether an interrupted run already
// made it. The backfill commits per batch, a device together with its session.

// SESSION_DAYS (auth.ts): a session ends 21 days after its last use, which
// is how its last use is read back (sessions.ts listSessions).
const SESSION_DAYS = 21;
const BATCH = 500;

type Executor = Pick<PoolConnection, 'execute' | 'query' | 'beginTransaction' | 'commit' | 'rollback'>;

async function hasColumn(connection: Executor, table: string, column: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\` WHERE Field = ?`, [column]);
  return present.length > 0;
}
async function hasIndex(connection: Executor, table: string, name: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name]);
  return present.length > 0;
}

async function createDeviceTables(connection: Executor) {
  // key_hash: the SHA-256 of the key the device keeps (not a credential: the
  // session authenticates), unique per person, NULL for a device made from a
  // session of before 0.29. capabilities and lock_applied are what the device
  // reports, as it reports it; open_until is until when it counts as unlocked.
  await connection.execute(`CREATE TABLE IF NOT EXISTS devices (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    kind VARCHAR(16) NOT NULL,
    app_version VARCHAR(32) NULL,
    bridge_level SMALLINT UNSIGNED NULL,
    user_agent VARCHAR(512) NULL,
    capabilities LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL CHECK (json_valid(capabilities)),
    lock_applied LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL CHECK (json_valid(lock_applied)),
    lock_reported_at DATETIME NULL,
    open_until DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_device_key (user_id, key_hash),
    KEY idx_devices_last_seen (last_seen_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // The device scope of the settings registry (services/settings.ts).
  await connection.execute(`CREATE TABLE IF NOT EXISTS device_settings (
    device_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT NOT NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (device_id, setting_key),
    KEY idx_device_settings_user (user_id),
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // Removing a device ends its sessions; the sessions' push channels and
  // deliveries go with them, as before. One statement each, so a partial run
  // leaves the column with its key and constraint or nothing.
  if (!await hasColumn(connection, 'sessions', 'device_id')) {
    await connection.execute(`ALTER TABLE sessions ADD COLUMN device_id CHAR(36) NULL, ADD KEY idx_sessions_device (device_id),
      ADD CONSTRAINT fk_sessions_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE`);
  }
  if (!await hasColumn(connection, 'push_subscriptions', 'device_id')) {
    await connection.execute(`ALTER TABLE push_subscriptions ADD COLUMN device_id CHAR(36) NULL, ADD KEY idx_push_device (device_id),
      ADD CONSTRAINT fk_push_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE CASCADE`);
  }
}

// One device for each session that has none, with the session's user agent
// and dates.
async function backfillSessionDevices(connection: Executor): Promise<number> {
  let made = 0;
  for (;;) {
    const [sessions] = await connection.execute<(RowDataPacket & { id: string; user_agent: string | null })[]>(
      `SELECT id, user_agent FROM sessions WHERE device_id IS NULL ORDER BY id LIMIT ${BATCH}`);
    if (!sessions.length) return made;
    await connection.beginTransaction();
    try {
      for (const session of sessions) {
        const device = crypto.randomUUID();
        const { kind, app_version, bridge_level } = deviceFromUserAgent(session.user_agent);
        await connection.execute(`INSERT INTO devices (id, user_id, kind, app_version, bridge_level, user_agent, created_at, last_seen_at)
          SELECT ?, s.user_id, ?, ?, ?, LEFT(s.user_agent, 512), COALESCE(s.created_at, UTC_TIMESTAMP()),
            GREATEST(COALESCE(s.created_at, UTC_TIMESTAMP()), s.expires_at - INTERVAL ${SESSION_DAYS} DAY)
          FROM sessions s WHERE s.id = ? AND s.device_id IS NULL`, [device, kind, app_version, bridge_level, session.id]);
        const [bound] = await connection.execute<ResultSetHeader>('UPDATE sessions SET device_id = ? WHERE id = ? AND device_id IS NULL', [device, session.id]);
        made += bound.affectedRows;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Upgrade step 26: the device tables, a device for every session, every push
 * channel bound to its session's device, and one channel per device and
 * transport. A session that kept two channels of one transport (an endpoint
 * the browser replaced, an app registration that was not replaced) keeps the
 * one used last; the device registers again at its next start.
 */
async function addDevices(connection: Executor) {
  await createDeviceTables(connection);
  const devices = await backfillSessionDevices(connection);
  const [trimmed] = await connection.execute<ResultSetHeader>(`DELETE p FROM push_subscriptions p
    JOIN push_subscriptions q ON q.session_id = p.session_id AND q.transport = p.transport
      AND (q.updated_at > p.updated_at OR (q.updated_at = p.updated_at AND q.id > p.id))
    WHERE p.device_id IS NULL`);
  await connection.execute(`UPDATE push_subscriptions p JOIN sessions s ON s.id = p.session_id
    SET p.device_id = s.device_id, p.updated_at = p.updated_at WHERE p.device_id IS NULL`);
  if (!await hasIndex(connection, 'push_subscriptions', 'unique_push_device_transport')) {
    await connection.execute('ALTER TABLE push_subscriptions ADD UNIQUE KEY unique_push_device_transport (device_id, transport)');
  }
  if (devices || trimmed.affectedRows) log.info('DB', 'Upgrade 26 gave each signed-in session a device', { devices, replacedPushChannels: trimmed.affectedRows });
}

/** Step 26 is complete: the tables and keys exist, and no session or push channel is without its device. */
async function verifyDevices(connection: Executor) {
  for (const table of ['devices', 'device_settings']) {
    const [present] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    if (!present.length) throw new Error(`Table ${table} is missing`);
  }
  for (const [table, index] of [['sessions', 'idx_sessions_device'], ['push_subscriptions', 'idx_push_device'], ['push_subscriptions', 'unique_push_device_transport'], ['devices', 'unique_device_key']]) {
    if (!await hasIndex(connection, table, index)) throw new Error(`Index ${index} on ${table} is missing`);
  }
  for (const [table, constraint] of [['sessions', 'fk_sessions_device'], ['push_subscriptions', 'fk_push_device']]) {
    const [present] = await connection.execute<RowDataPacket[]>(`SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND REFERENCED_TABLE_NAME = 'devices' AND DELETE_RULE = 'CASCADE'`, [table, constraint]);
    if (!present.length) throw new Error(`${table}.device_id does not follow its device`);
  }
  const [[left]] = await connection.execute<(RowDataPacket & { sessions: number | string; channels: number | string })[]>(`SELECT
    (SELECT COUNT(*) FROM sessions WHERE device_id IS NULL) AS sessions,
    (SELECT COUNT(*) FROM push_subscriptions WHERE device_id IS NULL) AS channels`);
  if (Number(left.sessions) || Number(left.channels)) throw new Error(`${left.sessions} sessions and ${left.channels} push channels have no device`);
}

export { addDevices, verifyDevices };
