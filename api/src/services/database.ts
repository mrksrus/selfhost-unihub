import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { db, setDb, getDb } from '../state';
import { JWT_SECRET, ENCRYPTION_KEY } from '../config';
import { safeJsonParse } from './calendar';
import { getDatabaseConfig } from './database-config';
import { supportedServer, unsupportedServerMessage } from './database-version';
import { runMigrations } from './database-migrations';
import { BASELINE } from './database-baseline';
import { verifyDatabaseInventory } from './data-inventory';

type FieldRow = RowDataPacket & { Field: string };
type CountRow = RowDataPacket & { n: number | string };
type CalendarAccountRow = RowDataPacket & { id: string; provider_config: unknown; mail_account_id?: string | null };

function isPlaceholderSecret(value: unknown) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized.includes('change_me') || normalized === 'changeme';
}

function quoteIdentifier(identifier: string) {
  const normalized = String(identifier || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `\`${normalized}\``;
}

// Stored times are UTC: CURRENT_TIMESTAMP defaults are compared with
// UTC_TIMESTAMP(), and mysql2's `timezone` option only converts values on the
// client. Pin each session so a server not configured for UTC cannot shift due
// times by hours. The 'connection' event fires before the new connection is
// handed out, and the connection runs commands in order, so this SET precedes
// every app query on it.
//
// MariaDB 11.6+ also turns innodb_snapshot_isolation on by default: a locking
// read or update then fails with "Record has changed since last read" when
// another transaction committed that row after this one's first read. UniHub's
// transactions expect such reads to see the latest committed row (MySQL and
// older MariaDB behavior). Releases without the setting reject it with 1193.
const UNKNOWN_SYSTEM_VARIABLE = 1193;
function useUtcSessions(pool: Pool) {
  pool.pool.on('connection', connection => {
    connection.query("SET time_zone = '+00:00'", error => {
      if (!error) return;
      console.error('[DB] Could not set the session time zone to UTC:', error.message);
      connection.destroy();
    });
    connection.query('SET innodb_snapshot_isolation = OFF', error => {
      if (!error || error.errno === UNKNOWN_SYSTEM_VARIABLE) return;
      console.error('[DB] Could not turn off snapshot isolation for the session:', error.message);
      connection.destroy();
    });
  });
  return pool;
}

async function initDatabase() {
  if (isPlaceholderSecret(JWT_SECRET)) {
    console.error('✗ Missing or placeholder JWT_SECRET. Set a strong random JWT secret before starting.');
    process.exit(1);
  }
  if (isPlaceholderSecret(ENCRYPTION_KEY)) {
    console.error('✗ Missing or placeholder ENCRYPTION_KEY. Set a strong random encryption key before starting.');
    process.exit(1);
  }
  const databaseConfig = getDatabaseConfig();
  if (!databaseConfig) {
    console.error('✗ Missing database configuration. Set DATABASE_URL or MYSQL_* in docker-compose.yml.');
    process.exit(1);
  }

  if (isPlaceholderSecret(databaseConfig.password)) {
    console.error('✗ Missing or placeholder database password. Set a real database password before starting.');
    process.exit(1);
  }
  const poolConfig = {
    // Connection options (inherited by pool)
    host: databaseConfig.host,
    port: databaseConfig.port,
    user: databaseConfig.user,
    password: databaseConfig.password,
    database: databaseConfig.database,
    timezone: '+00:00', // interpret DATETIME as UTC (we store UTC)
    
    // Pool-specific options only
    waitForConnections: true,
    connectionLimit: 50, // Maximum number of connections in the pool
    queueLimit: 0, // Unlimited queue (0 = no limit)
    idleTimeout: 300000, // 5 minutes - close idle connections
    maxIdle: 5, // Keep max 5 idle connections
  };

  // Retry connection — the database may still be starting
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      setDb(useUtcSessions(mysql.createPool(poolConfig)));
      await db.execute('SELECT 1');
      console.log('✓ Database connected');
      break;
    } catch (error) {
      // Clean up the failed pool before retrying
      if (getDb()) { await db.end().catch(() => {}); setDb(null); }
      if (attempt === 20) {
        console.error('✗ Database connection failed after 20 attempts:', (error as Error).message);
        process.exit(1);
      }
      // Faster retry intervals: 2s for first 5 attempts, then 3s
      const waitTime = attempt <= 5 ? 2000 : 3000;
      console.log(`⏳ Waiting for database (attempt ${attempt}/20)…`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }

  // Refuse before any schema work, so a MySQL database is never half-converted.
  const [[server]] = await db.query<(RowDataPacket & { version: string })[]>('SELECT VERSION() AS version');
  if (!supportedServer(server.version)) {
    console.error('✗ ' + unsupportedServerMessage(server.version));
    process.exit(1);
  }

  await ensureSchema();
}

// A new database starts from the 0.16.0 baseline (steps 1 to 11, see
// database-baseline.ts); the steps below apply to it and to every database
// created by an earlier release.
async function ensureSchema() {
  await runMigrations(getDb()!, [
    {
      // 0.17.0: CalDAV and ICS calendars sync continuously. Server copies of
      // calendar objects are kept so changes can be detected and written back.
      id: 12,
      name: 'calendar-sync',
      up: async (connection: PoolConnection) => {
        const changes = [
          ['calendar_accounts', 'mail_account_id', 'ALTER TABLE calendar_accounts ADD COLUMN mail_account_id CHAR(36) NULL'],
          ['calendar_accounts', 'next_sync_at', 'ALTER TABLE calendar_accounts ADD COLUMN next_sync_at DATETIME NULL'],
          ['calendar_calendars', 'remote_ctag', 'ALTER TABLE calendar_calendars ADD COLUMN remote_ctag VARCHAR(255) NULL'],
          ['calendar_calendars', 'remote_expanded_on', 'ALTER TABLE calendar_calendars ADD COLUMN remote_expanded_on DATE NULL'],
          ['calendar_event_external_refs', 'remote_object_id', 'ALTER TABLE calendar_event_external_refs ADD COLUMN remote_object_id CHAR(36) NULL'],
          ['calendar_event_external_refs', 'recurrence_id', 'ALTER TABLE calendar_event_external_refs ADD COLUMN recurrence_id VARCHAR(64) NULL'],
        ];
        for (const [table, column, sql] of changes) {
          const [fields] = await connection.execute<FieldRow[]>(`SHOW COLUMNS FROM ${quoteIdentifier(table)}`);
          if (!fields.some(field => field.Field === column)) await connection.execute(sql);
        }
        await connection.execute(`CREATE TABLE IF NOT EXISTS calendar_remote_objects (
          id CHAR(36) PRIMARY KEY,
          user_id CHAR(36) NOT NULL,
          account_id CHAR(36) NOT NULL,
          calendar_id CHAR(36) NOT NULL,
          href TEXT NOT NULL,
          href_hash CHAR(64) NOT NULL,
          etag VARCHAR(255) NULL,
          uid VARCHAR(500) NULL,
          ics MEDIUMTEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (account_id) REFERENCES calendar_accounts(id) ON DELETE CASCADE,
          FOREIGN KEY (calendar_id) REFERENCES calendar_calendars(id) ON DELETE CASCADE,
          UNIQUE KEY uq_calendar_remote_object (calendar_id, href_hash),
          INDEX idx_calendar_remote_objects_account (account_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const indexes = [
          ['calendar_accounts', 'idx_calendar_accounts_mail', 'ALTER TABLE calendar_accounts ADD INDEX idx_calendar_accounts_mail (user_id, mail_account_id)'],
          ['calendar_event_external_refs', 'idx_event_refs_remote_object', 'ALTER TABLE calendar_event_external_refs ADD INDEX idx_event_refs_remote_object (remote_object_id)'],
        ];
        for (const [table, name, sql] of indexes) {
          const [present] = await connection.execute<RowDataPacket[]>(`SHOW INDEX FROM ${quoteIdentifier(table)} WHERE Key_name = ?`, [name]);
          if (!present.length) await connection.execute(sql);
        }
      },
      verify: async (connection: PoolConnection) => {
        await verifyDatabaseInventory(connection, { includeNotifications: false, throughMigration: 12 });
      },
    },
    {
      // 0.17.1: backups keep provider_config but not mail_account_id. Accounts
      // linked by 0.17.0 are marked mailLinked, so a restore links them again.
      id: 13,
      name: 'calendar-mail-link-marker',
      up: async (connection: PoolConnection) => {
        for (const row of await unmarkedMailCalendars(connection)) {
          const config = (safeJsonParse(row.provider_config, {}) || {}) as Record<string, unknown>;
          await connection.execute('UPDATE calendar_accounts SET provider_config = ? WHERE id = ?', [JSON.stringify({ ...config, mailLinked: true }), row.id]);
        }
      },
      verify: async (connection: PoolConnection) => {
        if ((await unmarkedMailCalendars(connection)).length) throw new Error('Linked calendar accounts without the mailLinked mark remain');
      },
    },
    {
      // 0.18.2: a calendar linked to a mail account reads the mail login when
      // it needs it, instead of keeping a copy. The copies go, and calendars
      // that were switched off only because their mail account was
      // disconnected are on again (they wait while it stays disconnected).
      // Mail calendars not linked yet (restored, or from before 0.17) are
      // included; they find their mail account when first used.
      id: 14,
      name: 'calendar-linked-login',
      up: async (connection: PoolConnection) => {
        // A link to a deleted mail account (all mail accounts cleared) goes:
        // the calendar finds a mail account with its address again.
        // It stays marked and drops a CalDAV password, like at runtime.
        const [stale] = await connection.execute<(CalendarAccountRow & { mail_account_id: string })[]>(`SELECT ca.id, ca.provider_config, ca.mail_account_id FROM calendar_accounts ca
          LEFT JOIN mail_accounts m ON m.id = ca.mail_account_id AND m.user_id = ca.user_id WHERE ca.mail_account_id IS NOT NULL AND m.id IS NULL`);
        for (const row of stale) {
          await connection.execute(`UPDATE calendar_accounts SET mail_account_id = NULL, provider_config = ?,
              encrypted_password = IF(provider = 'caldav', NULL, encrypted_password) WHERE id = ? AND mail_account_id = ?`,
          [JSON.stringify({ ...((safeJsonParse(row.provider_config, {}) || {}) as Record<string, unknown>), mailLinked: true }), row.id, row.mail_account_id]);
        }
        const { sql, params } = await mailCalDavScope(connection);
        await connection.execute(`UPDATE calendar_accounts SET is_active = TRUE, sync_status = 'pending', sync_error = NULL, next_sync_at = NULL
          WHERE ${sql} AND is_active = FALSE AND sync_error = ?`,
        [...params, 'The mail account is disconnected. Reconnect it to resume calendar sync.']);
        await connection.execute(`UPDATE calendar_accounts SET encrypted_password = NULL WHERE ${sql} AND encrypted_password IS NOT NULL`, params);
      },
      verify: async (connection: PoolConnection) => {
        const { sql, params } = await mailCalDavScope(connection);
        const [[left]] = await connection.execute<CountRow[]>(`SELECT COUNT(*) AS n FROM calendar_accounts WHERE ${sql} AND encrypted_password IS NOT NULL`, params);
        if (Number(left.n) !== 0) throw new Error('Mail calendar accounts still hold a copied password');
        const [[stale]] = await connection.execute<CountRow[]>(`SELECT COUNT(*) AS n FROM calendar_accounts ca
          LEFT JOIN mail_accounts m ON m.id = ca.mail_account_id AND m.user_id = ca.user_id WHERE ca.mail_account_id IS NOT NULL AND m.id IS NULL`);
        if (Number(stale.n) !== 0) throw new Error('Calendar accounts still link a deleted mail account');
      },
    },
  ], BASELINE);
}

// CalDAV accounts of a mail account: linked; marked and not linked again yet
// after a restore; or connected before 0.17 (no server entry, never linked)
// while a mail account with their address exists.
async function mailCalDavScope(connection: PoolConnection) {
  const [unlinked] = await connection.execute<(CalendarAccountRow & { has_mail: number | string })[]>(`SELECT ca.id, ca.provider_config,
      EXISTS (SELECT 1 FROM mail_accounts m WHERE m.user_id = ca.user_id AND LOWER(m.email_address) = LOWER(ca.account_email)) AS has_mail
    FROM calendar_accounts ca WHERE ca.provider = 'caldav' AND ca.mail_account_id IS NULL`);
  const ids = unlinked.filter(row => {
    const config = (safeJsonParse(row.provider_config, {}) || {}) as { mailLinked?: unknown; server?: unknown };
    return config.mailLinked === true || (!config.server && Number(row.has_mail));
  }).map(row => row.id);
  const marked = ids.length ? ` OR id IN (${ids.map(() => '?').join(', ')})` : '';
  return { sql: `provider = 'caldav' AND (mail_account_id IS NOT NULL${marked})`, params: ids };
}

async function unmarkedMailCalendars(connection: PoolConnection) {
  const [rows] = await connection.execute<CalendarAccountRow[]>('SELECT id, provider_config FROM calendar_accounts WHERE mail_account_id IS NOT NULL');
  return rows.filter(row => ((safeJsonParse(row.provider_config, {}) || {}) as { mailLinked?: unknown }).mailLinked !== true);
}

async function ensurePerformanceIndexes() {
  const emailIndexMigrations = [
    ['idx_emails_user_date', 'CREATE INDEX idx_emails_user_date ON emails(user_id, received_at DESC, id)'],
    ['idx_emails_user_account_date', 'CREATE INDEX idx_emails_user_account_date ON emails(user_id, mail_account_id, received_at DESC, id)'],
    ['idx_emails_user_folder_date', 'CREATE INDEX idx_emails_user_folder_date ON emails(user_id, folder, received_at DESC, id)'],
    ['idx_emails_user_account_folder_date', 'CREATE INDEX idx_emails_user_account_folder_date ON emails(user_id, mail_account_id, folder, received_at DESC, id)'],
    ['idx_emails_user_starred_date', 'CREATE INDEX idx_emails_user_starred_date ON emails(user_id, is_starred, received_at DESC)'],
    ['idx_emails_user_read_folder_account', 'CREATE INDEX idx_emails_user_read_folder_account ON emails(user_id, is_read, folder, mail_account_id)'],
  ];

  console.log('[DB] Checking mail performance indexes...');
  for (const [indexName, createIndexSql] of emailIndexMigrations) {
    try {
      await db.execute(createIndexSql);
      console.log(`[DB] Created mail performance index ${indexName}`);
    } catch (error) {
      const message = String((error as Error | null)?.message || '');
      if (!message.includes('Duplicate key name')) {
        console.warn(`[DB] Could not create mail performance index ${indexName}: ${message}`);
      }
    }
  }
  console.log('[DB] Mail performance indexes ready');
}

export {
  initDatabase,
  useUtcSessions,
  ensureSchema,
  ensurePerformanceIndexes,
};
