import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import { db, setDb, getDb } from '../state';
import { JWT_SECRET, ENCRYPTION_KEY } from '../config';
import { safeJsonParse } from './calendar';
import { getDatabaseConfig } from './database-config';
import { supportedServer, unsupportedServerMessage } from './database-version';
import { runMigrations } from './database-migrations';
import type { Migration } from './database-migrations';
import { BASELINE } from './database-baseline';
import { verifyDatabaseInventory } from './data-inventory';
import { withTransaction } from './transactions';
import { addContactModel, copyLegacyContactValues, verifyLegacyContactCopy, dropLegacyContactColumns, verifyLegacyColumnsDropped } from './contacts-migration';
import { log } from '../log';

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
      log.error('DB', 'Could not set the session time zone to UTC', error);
      connection.destroy();
    });
    connection.query('SET innodb_snapshot_isolation = OFF', error => {
      if (!error || error.errno === UNKNOWN_SYSTEM_VARIABLE) return;
      log.error('DB', 'Could not turn off snapshot isolation for the session', error);
      connection.destroy();
    });
  });
  return pool;
}

const POOL_CONNECTION_LIMIT = 50;

async function initDatabase() {
  // Startup refusals are thrown, not exited here: server.ts logs the cause and
  // exits 1, and a script or test calling initDatabase sees an ordinary rejection.
  if (isPlaceholderSecret(JWT_SECRET)) {
    throw new Error('Missing or placeholder JWT_SECRET. Set a strong random JWT secret before starting.');
  }
  if (isPlaceholderSecret(ENCRYPTION_KEY)) {
    throw new Error('Missing or placeholder ENCRYPTION_KEY. Set a strong random encryption key before starting.');
  }
  const databaseConfig = getDatabaseConfig();
  if (!databaseConfig) {
    throw new Error('Missing database configuration. Set DATABASE_URL or MYSQL_* in docker-compose.yml.');
  }

  if (isPlaceholderSecret(databaseConfig.password)) {
    throw new Error('Missing or placeholder database password. Set a real database password before starting.');
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
    connectionLimit: POOL_CONNECTION_LIMIT,
    queueLimit: 0, // Unlimited queue (0 = no limit)
    idleTimeout: 300000, // 5 minutes - close idle connections
    maxIdle: 5, // Keep max 5 idle connections
  };

  // Retry connection — the database may still be starting
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      setDb(useUtcSessions(mysql.createPool(poolConfig)));
      await db.execute('SELECT 1');
      log.info('DB', 'Connected');
      break;
    } catch (error) {
      // Clean up the failed pool before retrying
      if (getDb()) { await db.end().catch(() => {}); setDb(null); }
      if (attempt === 20) {
        throw new Error(`Database connection failed after 20 attempts: ${(error as Error).message}`);
      }
      // Faster retry intervals: 2s for first 5 attempts, then 3s
      const waitTime = attempt <= 5 ? 2000 : 3000;
      log.info('DB', 'Waiting for the database', { attempt, of: 20 });
      await new Promise(r => setTimeout(r, waitTime));
    }
  }

  // Refuse before any schema work, so a MySQL database is never half-converted.
  const [[server]] = await db.query<(RowDataPacket & { version: string })[]>('SELECT VERSION() AS version');
  if (!supportedServer(server.version)) {
    throw new Error(unsupportedServerMessage(server.version));
  }

  await ensureSchema();
}

interface PoolInternals {
  _allConnections?: { length: number };
  _freeConnections?: { length: number };
  _connectionQueue?: { length: number };
}

/** Connection counts of the pool: mysql2 keeps them in private fields only. */
function poolStats() {
  const pool = (getDb() as unknown as { pool?: PoolInternals } | null)?.pool;
  const total = pool?._allConnections?.length ?? 0;
  const free = pool?._freeConnections?.length ?? 0;
  return { total, active: total - free, free, queued: pool?._connectionQueue?.length ?? 0, limit: POOL_CONNECTION_LIMIT };
}

// A new database starts from the 0.16.0 baseline (steps 1 to 11, see
// database-baseline.ts); the steps below apply to it and to every database
// created by an earlier release.
const MIGRATIONS: readonly Migration[] = [
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
      await verifyDatabaseInventory(connection, { throughMigration: 12 });
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
  {
    // 0.19.2: the notification tables (created at every start by the
    // notification service until now) and the mail list indexes (added
    // after listen, with errors only logged) become ordinary upgrade steps,
    // so startup has one schema path. Existing databases already have all
    // of them; a new database gets them here.
    id: 15,
    name: 'notification-tables-and-mail-indexes',
    up: async (connection: PoolConnection) => {
      await createNotificationTables(connection);
      await createMailPerformanceIndexes(connection);
    },
    verify: async (connection: PoolConnection) => {
      await verifyDatabaseInventory(connection, { throughMigration: 15 });
      for (const [table, name] of [['calendar_events', NOTIFICATION_SCAN_INDEX], ...MAIL_PERFORMANCE_INDEXES.map(([name]) => ['emails', name])]) {
        if (!await hasIndex(connection, table, name)) throw new Error(`Index ${name} on ${table} is missing`);
      }
    },
  },
  {
    // 0.20.0: a task or event can come from an email. The link is a plain
    // id (no foreign key: a calendar-only restore must not depend on mail),
    // with a snapshot of the email's header so the task keeps its context
    // after the email is gone.
    id: 16,
    name: 'event-source-email',
    up: async (connection: PoolConnection) => {
      if (!await hasColumn(connection, 'calendar_events', 'source_email_id')) {
        await connection.execute('ALTER TABLE calendar_events ADD COLUMN source_email_id char(36) DEFAULT NULL');
      }
      if (!await hasColumn(connection, 'calendar_events', 'source_email_json')) {
        await connection.execute('ALTER TABLE calendar_events ADD COLUMN source_email_json longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(source_email_json))');
      }
      if (!await hasIndex(connection, 'calendar_events', 'idx_events_source_email')) {
        await connection.execute('ALTER TABLE calendar_events ADD KEY idx_events_source_email (user_id, source_email_id)');
      }
    },
    verify: async (connection: PoolConnection) => {
      await verifyDatabaseInventory(connection, { throughMigration: 16 });
      if (!await hasIndex(connection, 'calendar_events', 'idx_events_source_email')) throw new Error('Index idx_events_source_email on calendar_events is missing');
    },
  },
  {
    // 0.22.1: the Android app receives notifications over its own
    // connection to this server. A device is a push subscription whose
    // transport says how it is reached (notification-transports.ts).
    id: 17,
    name: 'android-notification-devices',
    up: addPushTransport,
    verify: async (connection: PoolConnection) => {
      await verifyDatabaseInventory(connection, { throughMigration: 17 });
    },
  },
  {
    id: 18,
    name: 'session-token-hashes',
    up: hashSessionTokens,
    verify: async (connection: PoolConnection) => {
      await verifyDatabaseInventory(connection, { throughMigration: 18 });
    },
  },
  {
    id: 19,
    name: 'audit-log',
    up: createAuditLog,
    verify: async (connection: PoolConnection) => {
      await verifyDatabaseInventory(connection, { throughMigration: 19 });
    },
  },
  {
    // 0.24.0: the settings registry's scoped values and policy store (F1), a
    // signature per mail account, threading headers and snooze on messages,
    // templates and scheduled sends.
    id: 20,
    name: 'settings-and-mail-essentials',
    up: addSettingsAndMailEssentials,
    verify: async (connection: PoolConnection) => {
      await verifyDatabaseInventory(connection, { throughMigration: 20 });
      for (const [table, name] of [['emails', 'idx_emails_user_thread'], ['emails', 'idx_emails_user_message_id'], ['emails', 'idx_emails_user_snoozed'], ['mail_scheduled_sends', 'idx_scheduled_sends_due']]) {
        if (!await hasIndex(connection, table, name)) throw new Error(`Index ${name} on ${table} is missing`);
      }
    },
  },
  {
    // 0.25.0: download tickets (F9), so the Android app fetches a file
    // without the session cookie (services/file-tickets.ts).
    id: 21,
    name: 'file-tickets',
    up: createFileTickets,
    verify: async (connection: PoolConnection) => {
      await verifyDatabaseInventory(connection, { throughMigration: 21 });
    },
  },
  {
    // 0.26.0: contacts hold the vCard 4.0 model (F12): any number of
    // labelled values, the remaining name parts, dates, kept properties,
    // photos, merges with undo (the first bin items) and staged imports. The
    // fixed 3+3 email and phone columns are copied into contact_values here
    // and dropped by step 23 (services/contacts-migration.ts).
    id: 22,
    name: 'contacts-vcard-model',
    up: async (connection: PoolConnection) => {
      await addContactModel(connection);
      await copyLegacyContactValues(connection);
    },
    verify: async (connection: PoolConnection) => {
      await verifyDatabaseInventory(connection, { throughMigration: 22 });
      await verifyLegacyContactCopy(connection);
    },
  },
  {
    id: 23,
    name: 'contacts-drop-legacy-columns',
    up: dropLegacyContactColumns,
    verify: async (connection: PoolConnection) => {
      await verifyLegacyColumnsDropped(connection);
      await verifyDatabaseInventory(connection, { throughMigration: 23 });
    },
  },
  {
    // 0.27.0: the hand order of tasks, an overlay keyed by the item's identity
    // (services/task-order.ts), and the journal of moves between calendars,
    // so a retried or interrupted move never makes a second copy.
    id: 24,
    name: 'task-order-and-moves',
    up: createTaskOrderAndMoves,
    verify: async (connection: PoolConnection) => {
      await verifyDatabaseInventory(connection, { throughMigration: 24 });
    },
  },
];
const LATEST_MIGRATION_ID = MIGRATIONS[MIGRATIONS.length - 1].id;

async function ensureSchema() {
  await runMigrations(getDb()!, MIGRATIONS, BASELINE);
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

async function hasColumn(connection: SqlExecutor, table: string, column: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SHOW COLUMNS FROM ${quoteIdentifier(table)} WHERE Field = ?`, [column]);
  return present.length > 0;
}
async function hasIndex(connection: SqlExecutor, table: string, name: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SHOW INDEX FROM ${quoteIdentifier(table)} WHERE Key_name = ?`, [name]);
  return present.length > 0;
}

// Web Push identity, device subscriptions, the notification outbox and the
// reminder schedule (docs/PWA.md). Idempotent: upgrade step 15 runs it on
// databases that have had these tables since 0.10.
const NOTIFICATION_SCAN_INDEX = 'idx_events_notification_scan';
async function createNotificationTables(connection: SqlExecutor) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS notification_config (
    id TINYINT PRIMARY KEY, public_key VARCHAR(128) NOT NULL, encrypted_private_key TEXT NOT NULL,
    subject VARCHAR(320) NOT NULL, last_reminder_scan_at DATETIME NULL,
    reminder_revision BIGINT NOT NULL DEFAULT 0, scanned_revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, session_id CHAR(36) NOT NULL,
    endpoint TEXT NOT NULL, endpoint_hash CHAR(64) NOT NULL UNIQUE,
    p256dh VARCHAR(128) NOT NULL, auth VARCHAR(64) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    INDEX idx_push_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS notification_events (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, event_key CHAR(64) NOT NULL,
    kind VARCHAR(24) NOT NULL, source_id CHAR(36) NULL, payload JSON NOT NULL,
    expires_at DATETIME NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_notification_event (user_id, event_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_notification_event_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS notification_deliveries (
    event_id CHAR(36) NOT NULL, subscription_id CHAR(36) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
    available_at DATETIME NOT NULL, delivered_at DATETIME NULL, last_error VARCHAR(120) NULL,
    PRIMARY KEY (event_id, subscription_id),
    FOREIGN KEY (event_id) REFERENCES notification_events(id) ON DELETE CASCADE,
    FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    INDEX idx_notification_due (status, available_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS notification_reminders (
    event_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL, minutes INT NOT NULL,
    due_at DATETIME NOT NULL, queued_at DATETIME NULL,
    PRIMARY KEY (event_id, minutes),
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_reminder_due (queued_at, due_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  if (!await hasIndex(connection, 'calendar_events', NOTIFICATION_SCAN_INDEX)) {
    await connection.execute(`CREATE INDEX ${NOTIFICATION_SCAN_INDEX} ON calendar_events(updated_at, start_time)`);
  }
}

// 'webpush' (a browser's push service) or 'android' (the app's connection to
// this server). Upgrade step 17.
// Sessions keep the SHA-256 of their token (services/sessions.ts). Existing
// sessions stay signed in: their stored token becomes its hash, which is what
// the next request's token hashes to. A stored value that is already 64 hex
// characters is a hash (a session token is a JWT with dots).
async function hashSessionTokens(connection: SqlExecutor) {
  await connection.execute("UPDATE sessions SET token = LOWER(SHA2(token, 256)) WHERE token NOT REGEXP '^[0-9a-f]{64}$'");
}

// Administration and account-security events (services/audit.ts). No foreign
// keys: an entry about a deleted user stays as evidence until it is pruned.
async function createAuditLog(connection: SqlExecutor) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS audit_log (
    id CHAR(36) NOT NULL DEFAULT UUID() PRIMARY KEY,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actor_id CHAR(36) NULL,
    action VARCHAR(64) NOT NULL,
    target_user_id CHAR(36) NULL,
    ip_address VARCHAR(45) NULL,
    request_id VARCHAR(64) NULL,
    details JSON NULL,
    KEY idx_audit_created (created_at),
    KEY idx_audit_target (target_user_id, created_at),
    KEY idx_audit_actor (actor_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// Upgrade step 20 (0.24.0). Scoped settings follow their record and its
// owner; policies belong to the installation (groups from 0.30 use the same
// rows with target_kind 'group').
async function addSettingsAndMailEssentials(connection: SqlExecutor) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS mail_account_settings (
    mail_account_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT NOT NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (mail_account_id, setting_key),
    KEY idx_mail_account_settings_user (user_id),
    FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS calendar_settings (
    calendar_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT NOT NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (calendar_id, setting_key),
    KEY idx_calendar_settings_user (user_id),
    FOREIGN KEY (calendar_id) REFERENCES calendar_calendars(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS setting_policies (
    target_kind VARCHAR(16) NOT NULL,
    target_id VARCHAR(36) NOT NULL DEFAULT '',
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT NOT NULL,
    locked TINYINT(1) NOT NULL DEFAULT 0,
    updated_by CHAR(36) NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (target_kind, target_id, setting_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS mail_templates (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    name VARCHAR(120) NOT NULL,
    subject TEXT NULL,
    body_html MEDIUMTEXT NULL,
    body_text MEDIUMTEXT NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_mail_template_name (user_id, name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // A draft that sends itself at send_at, once (client_key is its send-once
  // receipt), or (origin 'send_now') the reservation of a draft being sent by
  // hand, so the two never overlap. Installation-local work: a restore brings
  // the draft back, not the schedule.
  await connection.execute(`CREATE TABLE IF NOT EXISTS mail_scheduled_sends (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    email_id CHAR(36) NOT NULL,
    mail_account_id CHAR(36) NOT NULL,
    send_at DATETIME NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'scheduled',
    origin VARCHAR(16) NOT NULL DEFAULT 'schedule',
    client_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    last_error VARCHAR(255) NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_scheduled_send_email (email_id),
    KEY idx_scheduled_sends_due (status, send_at),
    KEY idx_scheduled_sends_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const columns: [string, string, string][] = [
    ['mail_accounts', 'signature_html', 'ALTER TABLE mail_accounts ADD COLUMN signature_html MEDIUMTEXT NULL'],
    ['mail_accounts', 'signature_text', 'ALTER TABLE mail_accounts ADD COLUMN signature_text TEXT NULL'],
    ['emails', 'in_reply_to', 'ALTER TABLE emails ADD COLUMN in_reply_to VARCHAR(998) NULL'],
    ['emails', 'references_header', 'ALTER TABLE emails ADD COLUMN references_header TEXT NULL'],
    ['emails', 'thread_key', 'ALTER TABLE emails ADD COLUMN thread_key CHAR(64) NULL'],
    ['emails', 'snoozed_until', 'ALTER TABLE emails ADD COLUMN snoozed_until DATETIME NULL'],
    ['emails', 'snooze_returned_at', 'ALTER TABLE emails ADD COLUMN snooze_returned_at DATETIME NULL'],
  ];
  for (const [table, column, sql] of columns) {
    if (!await hasColumn(connection, table, column)) await connection.execute(sql);
  }
  if (!await hasIndex(connection, 'emails', 'idx_emails_user_thread')) {
    await connection.execute('ALTER TABLE emails ADD KEY idx_emails_user_thread (user_id, thread_key)');
  }
  // Threading looks up a conversation's root message by its Message-ID
  // (services/mail-threading.ts).
  if (!await hasIndex(connection, 'emails', 'idx_emails_user_message_id')) {
    await connection.execute('ALTER TABLE emails ADD KEY idx_emails_user_message_id (user_id, message_id)');
  }
  if (!await hasIndex(connection, 'emails', 'idx_emails_user_snoozed')) {
    await connection.execute('ALTER TABLE emails ADD KEY idx_emails_user_snoozed (user_id, snoozed_until)');
  }
}

// Upgrade step 21 (0.25.0). A ticket is bound to the session that asked for
// it and goes with it; from 0.29 a device record takes the session's place.
async function createFileTickets(connection: SqlExecutor) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS file_tickets (
    id CHAR(36) NOT NULL PRIMARY KEY,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id CHAR(36) NOT NULL,
    session_id CHAR(36) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    resource_id VARCHAR(64) NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_file_ticket_token (token_hash),
    KEY idx_file_tickets_session (session_id),
    KEY idx_file_tickets_expires (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// A task's hand rank: keyed by its event for a task UniHub holds, by
// (calendar, UID, recurrence id) for a synced one, so the order survives a
// sync or restore that rebuilds the row. calendar_id is set only for synced
// items; a local item follows its event.
async function createTaskOrderAndMoves(connection: SqlExecutor) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS task_order (
    user_id CHAR(36) NOT NULL,
    item_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    calendar_id CHAR(36) NULL,
    event_id CHAR(36) NULL,
    remote_uid VARCHAR(500) NULL,
    recurrence_id VARCHAR(64) NOT NULL DEFAULT '',
    sort_rank BIGINT NOT NULL,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, item_key),
    KEY idx_task_order_rank (user_id, sort_rank),
    KEY idx_task_order_event (event_id),
    KEY idx_task_order_calendar (calendar_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (calendar_id) REFERENCES calendar_calendars(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // The move journal (services/calendar-move.ts): one open move per task.
  // Removing the source calendar (or its account) ends the move; so does
  // removing the source's server copy. A move still removing the old copy
  // outlives its task and its new calendar (event_id, target_calendar_id
  // become NULL), so the old copy never comes back. target_ics is the object
  // every attempt sends, under the UID fixed before the first; source_etag
  // is the old copy as the move found it, the only version it may delete.
  await connection.execute(`CREATE TABLE IF NOT EXISTS calendar_event_moves (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    event_id CHAR(36) NULL,
    source_calendar_id CHAR(36) NULL,
    source_object_id CHAR(36) NULL,
    source_etag VARCHAR(255) NULL,
    target_calendar_id CHAR(36) NULL,
    target_uid VARCHAR(255) NOT NULL,
    target_href TEXT NULL,
    target_etag VARCHAR(255) NULL,
    target_ics MEDIUMTEXT NULL,
    state ENUM('creating', 'removing') NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    last_error VARCHAR(255) NULL,
    next_attempt_at DATETIME NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_event_move (event_id),
    KEY idx_event_moves_due (state, next_attempt_at),
    KEY idx_event_moves_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE SET NULL,
    FOREIGN KEY (source_calendar_id) REFERENCES calendar_calendars(id) ON DELETE CASCADE,
    FOREIGN KEY (source_object_id) REFERENCES calendar_remote_objects(id) ON DELETE CASCADE,
    FOREIGN KEY (target_calendar_id) REFERENCES calendar_calendars(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function addPushTransport(connection: SqlExecutor) {
  if (!await hasColumn(connection, 'push_subscriptions', 'transport')) {
    await connection.execute("ALTER TABLE push_subscriptions ADD COLUMN transport VARCHAR(16) NOT NULL DEFAULT 'webpush'");
  }
}

// Mail list and unread-count indexes. The baseline creates them for new
// databases; upgrade step 15 adds any that an older start could not create.
const MAIL_PERFORMANCE_INDEXES: readonly [string, string][] = [
  ['idx_emails_user_date', 'CREATE INDEX idx_emails_user_date ON emails(user_id, received_at DESC, id)'],
  ['idx_emails_user_account_date', 'CREATE INDEX idx_emails_user_account_date ON emails(user_id, mail_account_id, received_at DESC, id)'],
  ['idx_emails_user_folder_date', 'CREATE INDEX idx_emails_user_folder_date ON emails(user_id, folder, received_at DESC, id)'],
  ['idx_emails_user_account_folder_date', 'CREATE INDEX idx_emails_user_account_folder_date ON emails(user_id, mail_account_id, folder, received_at DESC, id)'],
  ['idx_emails_user_starred_date', 'CREATE INDEX idx_emails_user_starred_date ON emails(user_id, is_starred, received_at DESC)'],
  ['idx_emails_user_read_folder_account', 'CREATE INDEX idx_emails_user_read_folder_account ON emails(user_id, is_read, folder, mail_account_id)'],
];
async function createMailPerformanceIndexes(connection: SqlExecutor) {
  for (const [name, sql] of MAIL_PERFORMANCE_INDEXES) {
    if (!await hasIndex(connection, 'emails', name)) await connection.execute(sql);
  }
}

export {
  poolStats,
  initDatabase,
  useUtcSessions,
  ensureSchema,
  MIGRATIONS,
  LATEST_MIGRATION_ID,
  createNotificationTables,
  addPushTransport,
  createMailPerformanceIndexes,
  withTransaction,
};
