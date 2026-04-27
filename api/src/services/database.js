const mysql = require('mysql2/promise');
const { db, setDb, getDb } = require('../state');
const {
  JWT_SECRET,
  ENCRYPTION_KEY,
  BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD,
} = require('../config');
const { hashPassword } = require('../auth');
const { backfillCalendarOwnership } = require('./calendar');

function getDatabaseConfig() {
  if (process.env.DATABASE_URL) {
    const dbUrl = new URL(process.env.DATABASE_URL);
    return {
      host: dbUrl.hostname,
      port: parseInt(dbUrl.port, 10) || 3306,
      user: decodeURIComponent(dbUrl.username),
      password: decodeURIComponent(dbUrl.password),
      database: dbUrl.pathname.slice(1),
    };
  }

  const host = process.env.MYSQL_HOST;
  const port = process.env.MYSQL_PORT || '3306';
  const database = process.env.MYSQL_DATABASE;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;

  if (!host || !database || !user || !password) {
    return null;
  }

  return {
    host,
    port: parseInt(port, 10) || 3306,
    user,
    password,
    database,
  };
}

function isPlaceholderSecret(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized.includes('change_me') || normalized === 'changeme';
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
    console.error('✗ Missing or placeholder database password. Set a real MySQL password before starting.');
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

  // Retry connection — MySQL may still be starting
  // Reduced retry time since MySQL startup is optimized
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      setDb(mysql.createPool(poolConfig));
      await db.execute('SELECT 1');
      console.log('✓ Database connected');
      break;
    } catch (error) {
      // Clean up the failed pool before retrying
      if (getDb()) { await db.end().catch(() => {}); setDb(null); }
      if (attempt === 20) {
        console.error('✗ Database connection failed after 20 attempts:', error.message);
        process.exit(1);
      }
      // Faster retry intervals: 2s for first 5 attempts, then 3s
      const waitTime = attempt <= 5 ? 2000 : 3000;
      console.log(`⏳ Waiting for database (attempt ${attempt}/20)…`);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }

  await ensureSchema();
}

// ── Auto-create tables & seed admin user on first run ─────────────
async function ensureSchema() {
  console.log('Checking database schema…');

  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    avatar_url TEXT,
    role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
    is_active BOOLEAN DEFAULT TRUE,
    email_verified BOOLEAN DEFAULT FALSE,
    timezone VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_email (email),
    INDEX idx_users_active (is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  try {
    await db.execute(`ALTER TABLE users ADD COLUMN timezone VARCHAR(64) NULL`);
  } catch (error) {
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: users.timezone column may already exist');
    }
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS sessions (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    token VARCHAR(512) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_sessions_token (token),
    INDEX idx_sessions_user (user_id),
    INDEX idx_sessions_expires (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS contacts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    email VARCHAR(255),
    email2 VARCHAR(255),
    email3 VARCHAR(255),
    phone VARCHAR(50),
    phone2 VARCHAR(50),
    phone3 VARCHAR(50),
    company VARCHAR(255),
    job_title VARCHAR(255),
    notes TEXT,
    avatar_url TEXT,
    is_favorite BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_contacts_user (user_id),
    INDEX idx_contacts_name (first_name, last_name),
    INDEX idx_contacts_email (email),
    INDEX idx_contacts_favorite (user_id, is_favorite),
    INDEX idx_contacts_user_fav_name (user_id, is_favorite, first_name, last_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Backfill composite index for faster sorted contact lists on existing installs
  try {
    await db.execute(
      'ALTER TABLE contacts ADD INDEX idx_contacts_user_fav_name (user_id, is_favorite, first_name, last_name)'
    );
  } catch (e) {
    // Ignore if index already exists or ALTER not supported
  }

  // Backfill extra email/phone slots for existing installs
  try {
    await db.execute('ALTER TABLE contacts ADD COLUMN email2 VARCHAR(255)');
  } catch (e) {}
  try {
    await db.execute('ALTER TABLE contacts ADD COLUMN email3 VARCHAR(255)');
  } catch (e) {}
  try {
    await db.execute('ALTER TABLE contacts ADD COLUMN phone2 VARCHAR(50)');
  } catch (e) {}
  try {
    await db.execute('ALTER TABLE contacts ADD COLUMN phone3 VARCHAR(50)');
  } catch (e) {}

  await db.execute(`CREATE TABLE IF NOT EXISTS calendar_accounts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    provider VARCHAR(32) NOT NULL COMMENT 'local, google, microsoft, icloud, ical',
    account_email VARCHAR(255),
    display_name VARCHAR(255),
    encrypted_access_token TEXT,
    encrypted_refresh_token TEXT,
    token_expires_at DATETIME NULL,
    provider_config JSON DEFAULT NULL COMMENT 'provider-specific configuration',
    capabilities JSON DEFAULT NULL COMMENT 'feature flags/capabilities for this account',
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_calendar_accounts_user (user_id),
    INDEX idx_calendar_accounts_provider (provider),
    INDEX idx_calendar_accounts_active (user_id, is_active)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS calendar_calendars (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    account_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    external_id VARCHAR(500) NULL,
    color VARCHAR(20) DEFAULT '#22c55e',
    is_visible BOOLEAN DEFAULT TRUE,
    auto_todo_enabled BOOLEAN DEFAULT TRUE,
    read_only BOOLEAN DEFAULT FALSE,
    is_primary BOOLEAN DEFAULT FALSE,
    sync_token TEXT NULL COMMENT 'provider incremental sync token',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES calendar_accounts(id) ON DELETE CASCADE,
    INDEX idx_calendar_calendars_user (user_id),
    INDEX idx_calendar_calendars_account (account_id),
    UNIQUE KEY unique_calendar_external (account_id, external_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS calendar_events (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    calendar_id CHAR(36) NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    all_day BOOLEAN DEFAULT FALSE,
    location VARCHAR(500),
    color VARCHAR(20) DEFAULT '#22c55e',
    recurrence VARCHAR(100),
    reminder_minutes INT,
    reminders JSON DEFAULT NULL COMMENT 'Array of reminder minutes before event: [0, 15, 60] for default + 15min + 1hr before',
    todo_status VARCHAR(20) DEFAULT NULL COMMENT 'done, changed, time_moved, cancelled',
    is_todo_only BOOLEAN DEFAULT FALSE COMMENT 'True for standalone todos without calendar dates',
    done_at DATETIME NULL COMMENT 'Timestamp when task was marked as done',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_events_user (user_id),
    INDEX idx_events_start (start_time),
    INDEX idx_events_user_time (user_id, start_time, end_time),
    INDEX idx_events_calendar (calendar_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  
  // Add calendar_id column if it doesn't exist
  try {
    await db.execute('ALTER TABLE calendar_events ADD COLUMN calendar_id CHAR(36) NULL AFTER user_id');
  } catch (error) {
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: calendar_id column may already exist');
    }
  }

  // Add index for calendar_id if it doesn't exist
  try {
    await db.execute('CREATE INDEX idx_events_calendar ON calendar_events(calendar_id)');
  } catch (error) {}

  // Add todo_status column if it doesn't exist (for existing installations)
  try {
    await db.execute(`ALTER TABLE calendar_events ADD COLUMN todo_status VARCHAR(20) DEFAULT NULL COMMENT 'done, changed, time_moved, cancelled'`);
  } catch (error) {
    // Column already exists, ignore error
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: todo_status column may already exist');
    }
  }
  
  // Add reminders JSON column if it doesn't exist (for existing installations)
  try {
    await db.execute(`ALTER TABLE calendar_events ADD COLUMN reminders JSON DEFAULT NULL COMMENT 'Array of reminder minutes before event: [0, 15, 60] for default + 15min + 1hr before'`);
  } catch (error) {
    // Column already exists, ignore error
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: reminders column may already exist');
    }
  }
  
  // Add is_todo_only column if it doesn't exist (for existing installations)
  try {
    await db.execute(`ALTER TABLE calendar_events ADD COLUMN is_todo_only BOOLEAN DEFAULT FALSE COMMENT 'True for standalone todos without calendar dates'`);
  } catch (error) {
    // Column already exists, ignore error
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: is_todo_only column may already exist');
    }
  }
  
  // Add done_at column if it doesn't exist (for existing installations)
  try {
    await db.execute(`ALTER TABLE calendar_events ADD COLUMN done_at DATETIME NULL COMMENT 'Timestamp when task was marked as done'`);
  } catch (error) {
    // Column already exists, ignore error
    if (!error.message.includes('Duplicate column name')) {
      console.log('[DB] Note: done_at column may already exist');
    }
  }

  // Add FK after both tables are ensured to exist.
  try {
    await db.execute(`
      ALTER TABLE calendar_events
      ADD CONSTRAINT fk_calendar_events_calendar_id
      FOREIGN KEY (calendar_id) REFERENCES calendar_calendars(id)
      ON DELETE SET NULL
    `);
  } catch (error) {}

  await db.execute(`CREATE TABLE IF NOT EXISTS calendar_event_subtasks (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    event_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL,
    is_done BOOLEAN DEFAULT FALSE,
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_subtasks_event (event_id),
    INDEX idx_subtasks_user (user_id),
    INDEX idx_subtasks_order (event_id, position)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS calendar_event_external_refs (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    event_id CHAR(36) NOT NULL,
    calendar_id CHAR(36) NOT NULL,
    account_id CHAR(36) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    external_event_id VARCHAR(500) NOT NULL,
    external_etag VARCHAR(255) NULL,
    external_updated_at DATETIME NULL,
    last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
    FOREIGN KEY (calendar_id) REFERENCES calendar_calendars(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES calendar_accounts(id) ON DELETE CASCADE,
    INDEX idx_event_refs_user (user_id),
    INDEX idx_event_refs_event (event_id),
    UNIQUE KEY unique_provider_event (account_id, external_event_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS calendar_event_attendees (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    event_id CHAR(36) NOT NULL,
    email VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NULL,
    response_status VARCHAR(32) DEFAULT 'needsAction' COMMENT 'needsAction, accepted, tentative, declined',
    is_organizer BOOLEAN DEFAULT FALSE,
    optional_attendee BOOLEAN DEFAULT FALSE,
    comment TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES calendar_events(id) ON DELETE CASCADE,
    INDEX idx_event_attendees_user (user_id),
    INDEX idx_event_attendees_event (event_id),
    UNIQUE KEY unique_event_attendee_email (event_id, email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS mail_accounts (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    email_address VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    provider VARCHAR(50) NOT NULL,
    username VARCHAR(255),
    imap_host VARCHAR(255),
    imap_port INT DEFAULT 993,
    smtp_host VARCHAR(255),
    smtp_port INT DEFAULT 587,
    encrypted_password TEXT,
    sync_fetch_limit VARCHAR(16) NOT NULL DEFAULT '500',
    allow_self_signed BOOLEAN DEFAULT FALSE,
    trusted_imap_fingerprint256 VARCHAR(128),
    trusted_smtp_fingerprint256 VARCHAR(128),
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_mail_accounts_user (user_id),
    INDEX idx_mail_accounts_email (email_address),
    UNIQUE KEY unique_user_email (user_id, email_address)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  
  // Add username column if it doesn't exist (migration for existing installs)
  try {
    await db.execute(`ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS username VARCHAR(255) AFTER provider`);
  } catch (e) {
    // Column might already exist or unsupported syntax, ignore
  }
  try {
    await db.execute(`ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS allow_self_signed BOOLEAN DEFAULT FALSE AFTER encrypted_password`);
  } catch (e) {
    // Ignore when unsupported or already exists
  }
  try {
    const [imapFingerprintCols] = await db.execute(`SHOW COLUMNS FROM mail_accounts LIKE 'trusted_imap_fingerprint256'`);
    if (!Array.isArray(imapFingerprintCols) || imapFingerprintCols.length === 0) {
      await db.execute(`ALTER TABLE mail_accounts ADD COLUMN trusted_imap_fingerprint256 VARCHAR(128) AFTER allow_self_signed`);
    }
  } catch (e) {
    // Ignore migration failures and continue startup
  }
  try {
    const [smtpFingerprintCols] = await db.execute(`SHOW COLUMNS FROM mail_accounts LIKE 'trusted_smtp_fingerprint256'`);
    if (!Array.isArray(smtpFingerprintCols) || smtpFingerprintCols.length === 0) {
      await db.execute(`ALTER TABLE mail_accounts ADD COLUMN trusted_smtp_fingerprint256 VARCHAR(128) AFTER trusted_imap_fingerprint256`);
    }
  } catch (e) {
    // Ignore migration failures and continue startup
  }
  try {
    // Version-safe migration (MySQL variants may not support ADD COLUMN IF NOT EXISTS)
    const [syncFetchLimitCols] = await db.execute(`SHOW COLUMNS FROM mail_accounts LIKE 'sync_fetch_limit'`);
    if (!Array.isArray(syncFetchLimitCols) || syncFetchLimitCols.length === 0) {
      await db.execute(`ALTER TABLE mail_accounts ADD COLUMN sync_fetch_limit VARCHAR(16) NOT NULL DEFAULT '500' AFTER encrypted_password`);
    }
  } catch (e) {
    // Ignore when unsupported or already exists
  }
  try {
    await db.execute(
      `UPDATE mail_accounts
       SET sync_fetch_limit = '500'
       WHERE sync_fetch_limit IS NULL
          OR sync_fetch_limit NOT IN ('100', '500', '1000', '2000', 'all')`
    );
  } catch (e) {
    // Ignore migration failures and continue startup
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS mail_folders (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    slug VARCHAR(64) NOT NULL,
    display_name VARCHAR(128) NOT NULL,
    is_system BOOLEAN DEFAULT TRUE,
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_mail_folder_user_slug (user_id, slug),
    INDEX idx_mail_folders_user (user_id),
    INDEX idx_mail_folders_order (user_id, position)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS mail_sender_rules (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    mail_account_id CHAR(36) NULL,
    match_type ENUM('domain', 'email') NOT NULL,
    match_value VARCHAR(255) NOT NULL,
    target_folder VARCHAR(64) NOT NULL,
    priority INT NOT NULL DEFAULT 100,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
    INDEX idx_mail_sender_rules_user (user_id, is_active),
    INDEX idx_mail_sender_rules_account (mail_account_id, is_active),
    INDEX idx_mail_sender_rules_match (match_type, match_value),
    INDEX idx_mail_sender_rules_target (target_folder),
    INDEX idx_mail_sender_rules_priority (priority)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS emails (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    user_id CHAR(36) NOT NULL,
    mail_account_id CHAR(36) NOT NULL,
    message_id VARCHAR(500),
    subject TEXT,
    from_address VARCHAR(255) NOT NULL,
    from_name VARCHAR(255),
    to_addresses JSON NOT NULL,
    cc_addresses JSON,
    bcc_addresses JSON,
    body_text LONGTEXT,
    body_html LONGTEXT,
    folder VARCHAR(64) DEFAULT 'inbox',
    source_folder VARCHAR(255) NULL,
    imap_uid BIGINT NULL,
    imap_uidvalidity BIGINT NULL,
    raw_storage_path TEXT NULL,
    raw_sha256 CHAR(64) NULL,
    is_read BOOLEAN DEFAULT FALSE,
    is_starred BOOLEAN DEFAULT FALSE,
    is_draft BOOLEAN DEFAULT FALSE,
    has_attachments BOOLEAN DEFAULT FALSE,
    received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
    INDEX idx_emails_user (user_id),
    INDEX idx_emails_account (mail_account_id),
    INDEX idx_emails_folder (mail_account_id, folder),
    INDEX idx_emails_imap_uid (mail_account_id, source_folder, imap_uid),
    INDEX idx_emails_date (received_at DESC),
    INDEX idx_emails_unread (user_id, is_read, received_at DESC),
    FULLTEXT INDEX ft_emails_search (subject, body_text)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const emailColumnMigrations = [
    ['source_folder', `ALTER TABLE emails ADD COLUMN source_folder VARCHAR(255) NULL AFTER folder`],
    ['imap_uid', `ALTER TABLE emails ADD COLUMN imap_uid BIGINT NULL AFTER source_folder`],
    ['imap_uidvalidity', `ALTER TABLE emails ADD COLUMN imap_uidvalidity BIGINT NULL AFTER imap_uid`],
    ['raw_storage_path', `ALTER TABLE emails ADD COLUMN raw_storage_path TEXT NULL AFTER imap_uidvalidity`],
    ['raw_sha256', `ALTER TABLE emails ADD COLUMN raw_sha256 CHAR(64) NULL AFTER raw_storage_path`],
  ];
  for (const [columnName, alterSql] of emailColumnMigrations) {
    try {
      const [columns] = await db.execute(`SHOW COLUMNS FROM emails LIKE ?`, [columnName]);
      if (!Array.isArray(columns) || columns.length === 0) {
        await db.execute(alterSql);
      }
    } catch (e) {
      // Continue startup if a migration is unsupported or already applied.
    }
  }
  try {
    await db.execute(`ALTER TABLE emails MODIFY COLUMN folder VARCHAR(64) DEFAULT 'inbox'`);
  } catch (e) {
    // Ignore if the column is already compatible or ALTER is unsupported.
  }
  try {
    await db.execute('CREATE INDEX idx_emails_imap_uid ON emails(mail_account_id, source_folder, imap_uid)');
  } catch (e) {
    // Ignore duplicate index errors.
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS email_attachments (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    content_type VARCHAR(100),
    size_bytes BIGINT,
    storage_path TEXT,
    content_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_attachments_email (email_id),
    INDEX idx_attachments_user (user_id),
    INDEX idx_attachments_content_id (content_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await db.execute(`CREATE TABLE IF NOT EXISTS mail_email_scores (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    email_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    score_version VARCHAR(32) NOT NULL DEFAULT 'v1',
    total_score DECIMAL(6,2) NOT NULL DEFAULT 0,
    risk_level VARCHAR(32) NULL,
    spf_result VARCHAR(64) NULL,
    dkim_result VARCHAR(64) NULL,
    dmarc_result VARCHAR(64) NULL,
    language_risk_score DECIMAL(6,2) NULL,
    sender_reputation_score DECIMAL(6,2) NULL,
    source_risk_score DECIMAL(6,2) NULL,
    classifier_confidence DECIMAL(6,2) NULL,
    reasons JSON NULL,
    metadata JSON NULL,
    scored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_mail_email_score (email_id, score_version),
    INDEX idx_mail_email_scores_user (user_id, scored_at DESC),
    INDEX idx_mail_email_scores_risk (risk_level),
    INDEX idx_mail_email_scores_total (total_score DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Migrations for older installs
  try {
    await db.execute(`ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS content_id VARCHAR(255) AFTER storage_path`);
  } catch (e) {
    // Ignore when unsupported or already exists
  }
  try {
    await db.execute(`ALTER TABLE email_attachments ADD COLUMN IF NOT EXISTS user_id CHAR(36) NULL AFTER email_id`);
  } catch (e) {
    // Ignore when unsupported or already exists
  }
  try {
    await db.execute(
      `UPDATE email_attachments a
       INNER JOIN emails e ON a.email_id = e.id
       SET a.user_id = e.user_id
       WHERE a.user_id IS NULL`
    );
  } catch (e) {
    // Ignore migration failures and continue startup
  }
  try {
    await db.execute(`ALTER TABLE email_attachments MODIFY COLUMN user_id CHAR(36) NOT NULL`);
  } catch (e) {
    // Ignore if already NOT NULL or unsupported
  }
  try {
    await db.execute(`CREATE INDEX idx_attachments_user ON email_attachments(user_id)`);
  } catch (e) {
    // Ignore duplicate index errors
  }
  try {
    await db.execute(`CREATE INDEX idx_attachments_content_id ON email_attachments(content_id)`);
  } catch (e) {
    // Ignore duplicate index errors
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  
  // Initialize default signup mode if not set
  const [signupModeSetting] = await db.execute(
    'SELECT setting_value FROM system_settings WHERE setting_key = ?',
    ['signup_mode']
  );
  if (signupModeSetting.length === 0) {
    await db.execute(
      'INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)',
      ['signup_mode', 'open'] // Default: open signups
    );
  }

  // Bootstrap admin user from environment if no users exist yet
  const [rows] = await db.execute('SELECT COUNT(*) as count FROM users');
  if (rows[0].count === 0) {
    if (!BOOTSTRAP_ADMIN_EMAIL || !BOOTSTRAP_ADMIN_PASSWORD) {
      console.error('✗ Missing BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD for first-run setup.');
      process.exit(1);
    }
    if (BOOTSTRAP_ADMIN_PASSWORD.length < 12) {
      console.error('✗ BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
      process.exit(1);
    }
    const adminHash = await hashPassword(BOOTSTRAP_ADMIN_PASSWORD);
    await db.execute(
      `INSERT INTO users (id, email, password_hash, full_name, email_verified, role)
       VALUES (UUID(), ?, ?, 'Bootstrap Admin', TRUE, 'admin')`,
      [BOOTSTRAP_ADMIN_EMAIL, adminHash]
    );
    console.log(`✓ Bootstrap admin created (${BOOTSTRAP_ADMIN_EMAIL})`);
  }

  await backfillCalendarOwnership(db);

  console.log('✓ Database schema ready');
}

module.exports = {
  getDatabaseConfig,
  isPlaceholderSecret,
  initDatabase,
  ensureSchema,
};
