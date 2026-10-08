import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor, StoredFlag } from '../../types';
interface BackfillRow { id: string; user_id: string; mail_account_id: string; is_legacy?: StoredFlag; remote_missing?: StoredFlag; remote_folder?: string | null; remote_uid?: number | string | bigint | null; remote_uidvalidity?: number | string | bigint | null; is_read?: StoredFlag; is_starred?: StoredFlag; is_draft?: StoredFlag; state?: string | null; status?: string; dispatched?: StoredFlag }

// Additive MariaDB mail engine schema. DDL autocommits; every step is repeatable.
import imported1 = require('node:crypto');
const { randomUUID } = imported1;
import imported2 = require('./repository-identity');
const { assertUid32 } = imported2;

async function columns(db: SqlExecutor, table: string) {
  const [rows] = await db.execute<RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\``);
  return new Set(rows.map(row => row.Field));
}
async function addColumns(db: SqlExecutor, table: string, definitions: readonly (readonly [string, string])[]) {
  const existing = await columns(db, table);
  const missing = definitions.filter(([name]) => !existing.has(name));
  // One ALTER per table, avoiding repeated rebuilds on slow disks.
  if (missing.length) await db.execute(`ALTER TABLE \`${table}\` ${missing.map(([, ddl]) => `ADD COLUMN ${ddl}`).join(', ')}`);
}
async function indexExists(db: SqlExecutor, table: string, name: string) {
  const [rows] = await db.execute<RowDataPacket[]>(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name]);
  return rows.length > 0;
}
async function migrateMailEngineSchema(db: SqlExecutor) {
  await addColumns(db, 'mail_accounts', [
    ['disconnected_at', 'disconnected_at DATETIME NULL'],
    ['engine_version', 'engine_version INT NOT NULL DEFAULT 11'],
  ]);
  await addColumns(db, 'emails', [
    ['observation_revision', 'observation_revision BIGINT NOT NULL DEFAULT 0'],
    ['observed_modseq', 'observed_modseq VARCHAR(32) NULL'],
    ['raw_format', "raw_format VARCHAR(24) NOT NULL DEFAULT 'legacy_normalized'"],
    ['raw_bytes', 'raw_bytes BIGINT NULL'],
    ['raw_verified', 'raw_verified BOOLEAN NOT NULL DEFAULT FALSE'],
    ['content_state', "content_state VARCHAR(24) NOT NULL DEFAULT 'legacy'"],
  ]);
  await addColumns(db, 'mail_writebacks', [
    ['state', 'state VARCHAR(24) NULL DEFAULT NULL'], // NULL denotes not yet classified legacy row.
    ['is_current', 'is_current BOOLEAN NOT NULL DEFAULT FALSE'],
    ['intent_revision', 'intent_revision BIGINT NOT NULL DEFAULT 0'],
    ['client_key', 'client_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL'],
    ['source_occurrence_id', 'source_occurrence_id CHAR(36) NULL'],
    ['evidence_json', 'evidence_json JSON NULL'],
  ]);
  // The legacy folder mapping also has a unique provider-name index. Its old
  // utf8mb4_bin collation is PAD SPACE, conflating trailing-space IMAP paths;
  // the NO PAD binary collation keeps them apart.
  const [folderNames] = await db.execute<RowDataPacket[]>("SHOW FULL COLUMNS FROM `mail_folder_remote_boxes` WHERE Field = 'remote_name'");
  if (folderNames.length !== 1) throw new Error('Missing mail_folder_remote_boxes.remote_name');
  if (folderNames[0].Collation !== 'utf8mb4_nopad_bin') await db.execute(`ALTER TABLE mail_folder_remote_boxes
    MODIFY COLUMN remote_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL`);
  // One index ALTER: lookup before dropping old uniqueness, plus canonical queue scan.
  const indexChanges = [];
  if (!await indexExists(db, 'mail_writebacks', 'idx_mail_writeback_email_action'))
    indexChanges.push('ADD INDEX idx_mail_writeback_email_action (email_id, action, is_current, created_at)');
  if (!await indexExists(db, 'mail_writebacks', 'idx_mail_writeback_state'))
    indexChanges.push('ADD INDEX idx_mail_writeback_state (state, mail_account_id, available_at)');
  if (await indexExists(db, 'mail_writebacks', 'uq_mail_writeback')) indexChanges.push('DROP INDEX uq_mail_writeback');
  if (indexChanges.length) await db.execute(`ALTER TABLE mail_writebacks ${indexChanges.join(', ')}`);
  const definitions = [
    `CREATE TABLE IF NOT EXISTS mail_remote_mailboxes (
      id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, mail_account_id CHAR(36) NOT NULL,
      remote_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
      delimiter VARCHAR(16) NULL, special_use VARCHAR(64) NULL, provider_mailbox_id VARCHAR(255) NULL,
      uidvalidity BIGINT UNSIGNED NULL, state VARCHAR(24) NOT NULL DEFAULT 'active',
      epoch_revision BIGINT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
      UNIQUE KEY uq_remote_mailbox (mail_account_id, remote_name), INDEX idx_remote_mailbox_owner (user_id, mail_account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS mail_remote_occurrences (
      id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, mail_account_id CHAR(36) NOT NULL,
      mailbox_id CHAR(36) NOT NULL, uidvalidity BIGINT UNSIGNED NOT NULL, uid BIGINT UNSIGNED NOT NULL,
      email_id CHAR(36) NOT NULL, observed_flags JSON NULL, observed_modseq VARCHAR(32) NULL,
      gmail_msgid VARCHAR(32) NULL, presence VARCHAR(24) NOT NULL DEFAULT 'present',
      observation_revision BIGINT NOT NULL DEFAULT 0,
      observed_at DATETIME NULL, absent_at DATETIME NULL, quarantine_reason VARCHAR(64) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (mailbox_id) REFERENCES mail_remote_mailboxes(id) ON DELETE CASCADE,
      FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE,
      UNIQUE KEY uq_occurrence_tuple (mailbox_id, uidvalidity, uid),
      INDEX idx_occurrence_owner_item (user_id, mail_account_id, email_id, presence),
      INDEX idx_occurrence_window (mailbox_id, uidvalidity, uid, presence),
      INDEX idx_occurrence_gmail (mail_account_id, gmail_msgid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS mail_gmail_messages (
      mail_account_id CHAR(36) NOT NULL, gmail_msgid VARCHAR(32) NOT NULL, user_id CHAR(36) NOT NULL,
      email_id CHAR(36) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (mail_account_id, gmail_msgid),
      FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS mail_engine_cursors (
      mailbox_id CHAR(36) NOT NULL, stream VARCHAR(16) NOT NULL, user_id CHAR(36) NOT NULL,
      mail_account_id CHAR(36) NOT NULL, uidvalidity BIGINT UNSIGNED NOT NULL,
      window_start BIGINT UNSIGNED NOT NULL DEFAULT 0, window_end BIGINT UNSIGNED NOT NULL DEFAULT 0,
      covered_through BIGINT UNSIGNED NOT NULL DEFAULT 0, checkpoint VARCHAR(32) NULL,
      sweep_generation BIGINT UNSIGNED NOT NULL DEFAULT 0, coverage_json JSON NULL,
      last_covered_at DATETIME NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (mailbox_id, stream),
      FOREIGN KEY (mailbox_id) REFERENCES mail_remote_mailboxes(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS mail_engine_accounts (
      mail_account_id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, generation BIGINT NOT NULL DEFAULT 0,
      lease_owner VARCHAR(128) NULL, lease_until DATETIME NULL, paused_reason VARCHAR(255) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_engine_account_lease (lease_until)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS mail_engine_jobs (
      id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, mail_account_id CHAR(36) NOT NULL,
      mailbox_id CHAR(36) NULL, operation_id CHAR(36) NULL, kind VARCHAR(32) NOT NULL,
      priority INT NOT NULL DEFAULT 50, state VARCHAR(24) NOT NULL DEFAULT 'queued',
      phase VARCHAR(64) NULL, due_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      lease_owner VARCHAR(128) NULL, lease_until DATETIME NULL, worker_generation BIGINT NULL,
      cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE, processed BIGINT NOT NULL DEFAULT 0,
      total BIGINT NULL, coverage_json JSON NULL, error VARCHAR(255) NULL,
      started_at DATETIME NULL, completed_at DATETIME NULL, heartbeat_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (mailbox_id) REFERENCES mail_remote_mailboxes(id) ON DELETE SET NULL,
      FOREIGN KEY (operation_id) REFERENCES mail_writebacks(id) ON DELETE SET NULL,
      INDEX idx_job_due (state, due_at, priority, mail_account_id),
      INDEX idx_job_lease (state, lease_until),
      INDEX idx_job_account (user_id, mail_account_id, state, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS mail_operation_attempts (
      id CHAR(36) PRIMARY KEY, operation_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
      mail_account_id CHAR(36) NOT NULL, worker_generation BIGINT NOT NULL, dispatch_fence CHAR(36) NOT NULL,
      outcome VARCHAR(32) NOT NULL DEFAULT 'prepared', transmission VARCHAR(32) NOT NULL DEFAULT 'unknown',
      evidence_json JSON NULL, started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dispatched_at DATETIME NULL, completed_at DATETIME NULL,
      FOREIGN KEY (operation_id) REFERENCES mail_writebacks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (mail_account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
      INDEX idx_attempt_operation (operation_id, started_at), INDEX idx_attempt_account (mail_account_id, outcome)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS mail_command_receipts (
      user_id CHAR(36) NOT NULL, client_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_hash CHAR(64) NOT NULL, response_json JSON NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, client_key), FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS mail_engine_quarantine (
      source_table VARCHAR(32) NOT NULL, source_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
      mail_account_id CHAR(36) NOT NULL, reason VARCHAR(64) NOT NULL, evidence_json JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (source_table, source_id, reason),
      INDEX idx_quarantine_account (user_id, mail_account_id, reason)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS mail_engine_migration_progress (
      source_table VARCHAR(32) PRIMARY KEY, last_id CHAR(36) NOT NULL DEFAULT '',
      processed BIGINT NOT NULL DEFAULT 0, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ];
  for (const sql of definitions) await db.execute(sql);
}

async function migrateManualMailRefresh(db: SqlExecutor) {
  await addColumns(db, 'mail_engine_jobs', [
    ['manual_refresh', 'manual_refresh BOOLEAN NOT NULL DEFAULT FALSE'],
  ]);
}

async function verifyManualMailRefresh(db: SqlExecutor) {
  await verifyMailEngineSchema(db);
  if (!(await columns(db, 'mail_engine_jobs')).has('manual_refresh'))
    throw new Error('Missing mail_engine_jobs.manual_refresh');
}

// 0.13.0: per-account Sync retention windows and the upgrade safety gate.
// Existing accounts keep sync_policy_confirmed_at NULL: nothing is deleted for
// absence or retention until the user confirms per account.
async function migrateMailSyncPolicy(db: SqlExecutor) {
  await addColumns(db, 'mail_accounts', [
    ['sync_window_days', 'sync_window_days INT NULL'],
    ['trash_window_days', 'trash_window_days INT NULL DEFAULT 30'],
    ['sync_policy_confirmed_at', 'sync_policy_confirmed_at DATETIME NULL'],
  ]);
  await addColumns(db, 'mail_remote_occurrences', [
    ['internal_date', 'internal_date DATETIME NULL'],
  ]);
  await addColumns(db, 'data_export_jobs', [
    ['mail_account_id', 'mail_account_id CHAR(36) NULL'],
  ]);
}
async function verifyMailSyncPolicy(db: SqlExecutor) {
  for (const [table, names] of [['mail_accounts', ['sync_window_days', 'trash_window_days', 'sync_policy_confirmed_at']],
    ['mail_remote_occurrences', ['internal_date']], ['data_export_jobs', ['mail_account_id']]] as const) {
    const present = await columns(db, table);
    for (const name of names) if (!present.has(name)) throw new Error(`Missing ${table}.${name}`);
  }
  const [[trash]] = await db.execute<RowDataPacket[]>("SHOW COLUMNS FROM mail_accounts WHERE Field = 'trash_window_days'");
  if (String(trash?.Default) !== '30') throw new Error('mail_accounts.trash_window_days must default to 30');
}

// Never suppress unexpected SQL errors. The progress checkpoint and each bounded
// batch are committed together so process death cannot skip accepted records.
async function backfillMailEngine(db: Pool | PoolConnection, { batchSize = 200 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new RangeError('batchSize must be 1..1000');
  const pool = typeof (db as Pool).getConnection === 'function' ? db as Pool : null;
  for (const source of ['emails', 'mail_writebacks']) {
    while (true) {
      const cx = pool ? await pool.getConnection() : db as PoolConnection;
      let started = false;
      try {
        await cx.beginTransaction(); started = true;
        await cx.execute('INSERT IGNORE INTO mail_engine_migration_progress (source_table) VALUES (?)', [source]);
        const [[progress]] = await cx.execute<RowDataPacket[]>('SELECT last_id FROM mail_engine_migration_progress WHERE source_table = ? FOR UPDATE', [source]);
        const [rows] = await cx.execute<(RowDataPacket & BackfillRow)[]>(source === 'emails' ?
          `SELECT e.id, e.user_id, e.mail_account_id, e.remote_folder, e.remote_uid, e.remote_uidvalidity,
                  e.source_folder, e.imap_uid, e.imap_uidvalidity, e.remote_missing, e.is_draft,
                  e.is_legacy, e.is_read, e.is_starred, a.sync_mode
           FROM emails e JOIN mail_accounts a ON a.id = e.mail_account_id
           WHERE e.id > ? ORDER BY e.id LIMIT ?` :
          `SELECT id, user_id, mail_account_id, email_id, action, status, dispatched, remote_folder,
                  remote_uid, remote_uidvalidity, state FROM mail_writebacks WHERE id > ? ORDER BY id LIMIT ?`,
        // mysql2 encodes JS numbers as DOUBLE; MySQL's prepared LIMIT rejects
        // that binding on supported 8.x servers. A validated decimal string is
        // accepted losslessly without interpolating caller input into SQL.
        [progress.last_id, String(batchSize)]);
        for (const row of rows) {
          if (source === 'emails') await backfillEmail(cx, row);
          else await backfillWriteback(cx, row);
        }
        if (rows.length) await cx.execute('UPDATE mail_engine_migration_progress SET last_id = ?, processed = processed + ? WHERE source_table = ?', [rows.at(-1)!.id, rows.length, source]);
        await cx.commit(); started = false;
        if (!rows.length) break;
      } catch (error) {
        if (started) await cx.rollback();
        throw error;
      } finally { if (pool) cx.release(); }
    }
  }
}
async function quarantine(db: SqlExecutor, source: string, row: BackfillRow, reason: string, evidence: Record<string, unknown> = {}) {
  await db.execute(`INSERT INTO mail_engine_quarantine (source_table,source_id,user_id,mail_account_id,reason,evidence_json)
    VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE source_id = source_id`,
  [source, row.id, row.user_id, row.mail_account_id, reason, JSON.stringify(evidence)]);
}
async function backfillEmail(db: SqlExecutor, row: BackfillRow) {
  // source_* is provenance. It may refer to a moved/deleted copy or to local
  // legacy filing; it is never evidence of current remote membership.
  if (Number(row.is_legacy) === 1 || Number(row.remote_missing) === 1) return;
  const folder = row.remote_folder;
  const uid = row.remote_uid;
  const epoch = row.remote_uidvalidity;
  if (folder == null && uid == null && epoch == null) return; // local-only archive
  if (!folder || !isUid32Value(uid) || !isUid32Value(epoch)) {
    await quarantine(db, 'emails', row, 'invalid_remote_tuple', { folder: folder || null, uid: String(uid ?? ''), epoch: String(epoch ?? '') });
    return;
  }
  const { ensureMailbox } = require('./repository');
  const mailbox = await ensureMailbox({ userId: row.user_id, accountId: row.mail_account_id, folderName: folder, epoch, metadata: { allowEpochChange: false } }, db);
  if (Number(mailbox.uidvalidity) !== Number(epoch) || mailbox.state === 'quarantined') {
    await quarantine(db, 'emails', row, 'stale_epoch', { mailboxId: mailbox.id, epoch: String(epoch) });
    await db.execute("UPDATE mail_remote_occurrences SET presence = 'quarantined', quarantine_reason = 'ambiguous_legacy_epoch' WHERE mailbox_id = ? AND presence = 'present'", [mailbox.id]);
    await db.execute("UPDATE mail_remote_mailboxes SET state = 'quarantined' WHERE id = ?", [mailbox.id]);
    return;
  }
  const [existing] = await db.execute<RowDataPacket[]>('SELECT id,email_id FROM mail_remote_occurrences WHERE mailbox_id = ? AND uidvalidity = ? AND uid = ? FOR UPDATE', [mailbox.id, epoch, uid]);
  if (existing.length && existing[0].email_id !== row.id) {
    await quarantine(db, 'emails', row, 'duplicate_remote_tuple', { mailboxId: mailbox.id, existingOccurrenceId: existing[0].id });
    await quarantine(db, 'emails', { ...row, id: existing[0].email_id }, 'duplicate_remote_tuple', { mailboxId: mailbox.id, existingOccurrenceId: existing[0].id });
    await db.execute("UPDATE mail_remote_occurrences SET presence='quarantined', quarantine_reason='duplicate_remote_tuple' WHERE id = ?", [existing[0].id]);
    return;
  }
  if (!existing.length) {
    const flags = [];
    if (Number(row.is_read) === 1) flags.push('\\Seen');
    if (Number(row.is_starred) === 1) flags.push('\\Flagged');
    if (Number(row.is_draft) === 1) flags.push('\\Draft');
    await db.execute(`INSERT INTO mail_remote_occurrences
      (id,user_id,mail_account_id,mailbox_id,uidvalidity,uid,email_id,observed_flags,observed_at)
      VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,
    [randomUUID(), row.user_id, row.mail_account_id, mailbox.id, epoch, uid, row.id, JSON.stringify(flags)]);
  }
}
function isUid32Value(value: unknown): value is string | number | bigint { try { assertUid32(value); return true; } catch { return false; } }
async function backfillWriteback(db: SqlExecutor, row: BackfillRow) {
  if (row.state != null) return; // already classified; never alter a new command.
  const status = String(row.status);
  const dispatched = Number(row.dispatched) === 1;
  const state = status === 'done' ? 'confirmed' : dispatched ? 'reconciling' : status === 'pending' ? 'queued' : 'needs_attention';
  const current = state === 'queued' || state === 'reconciling' || state === 'needs_attention';
  const valid = isUid32Value(row.remote_uid) && isUid32Value(row.remote_uidvalidity) && !!row.remote_folder;
  if (!valid) await quarantine(db, 'mail_writebacks', row, 'invalid_source_tuple', { status, dispatched });
  const safeState = !valid && state === 'queued' ? 'needs_attention' : state;
  await db.execute(`UPDATE mail_writebacks SET state = ?, is_current = ?, intent_revision = 1,
    evidence_json = JSON_OBJECT('legacy_status', ?, 'legacy_dispatched', ?)
    WHERE id = ? AND state IS NULL`, [safeState, current ? 1 : 0, status, dispatched ? 1 : 0, row.id]);
}
async function verifyMailEngineSchema(db: SqlExecutor) {
  const [mappingNames] = await db.execute<RowDataPacket[]>("SHOW FULL COLUMNS FROM `mail_folder_remote_boxes` WHERE Field = 'remote_name'");
  if (mappingNames[0]?.Collation !== 'utf8mb4_nopad_bin') throw new Error('Legacy mailbox mapping still has PAD SPACE collation');
  for (const [table, fields] of [
    ['mail_accounts', ['disconnected_at', 'engine_version']],
    ['emails', ['observation_revision', 'observed_modseq', 'raw_format', 'raw_bytes', 'raw_verified', 'content_state']],
    ['mail_writebacks', ['state', 'is_current', 'intent_revision', 'client_key', 'source_occurrence_id', 'evidence_json']],
  ] as const) {
    const found = await columns(db, table);
    for (const field of fields) if (!found.has(field)) throw new Error(`Missing ${table}.${field}`);
  }
  for (const table of ['mail_remote_mailboxes', 'mail_remote_occurrences', 'mail_gmail_messages', 'mail_engine_cursors', 'mail_engine_accounts', 'mail_engine_jobs', 'mail_operation_attempts', 'mail_command_receipts', 'mail_engine_quarantine', 'mail_engine_migration_progress']) {
    const [rows] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS found FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [table]);
    if (Number(rows[0].found) !== 1) throw new Error(`Missing ${table}`);
  }
  if (await indexExists(db, 'mail_writebacks', 'uq_mail_writeback')) throw new Error('Legacy writeback unique index still present');
}
export = { migrateMailEngineSchema, backfillMailEngine, verifyMailEngineSchema,
  migrateManualMailRefresh, verifyManualMailRefresh, migrateMailSyncPolicy, verifyMailSyncPolicy };
