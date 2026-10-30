// Upgrade steps 22 and 23 (0.26.0): contacts become the vCard 4.0 model (F12).
// Step 22 adds the columns and tables and copies the fixed 3+3 email and
// phone columns into contact_values in one transaction; step 23 drops the
// fixed columns once step 22's check has passed. Both repeat safely after an
// interruption: DDL is guarded, and only contacts without values are copied.
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import crypto from 'node:crypto';
import { nameKey, valueKey } from './contact-keys';

type LegacyRow = RowDataPacket & {
  id: string; user_id: string; first_name: string | null; last_name: string | null;
  email: string | null; email2: string | null; email3: string | null;
  phone: string | null; phone2: string | null; phone3: string | null;
};
type ValueRow = RowDataPacket & { contact_id: string; kind: 'email' | 'phone'; position: number; value: string; value_key: string; legacy_slot: number | null };

const LEGACY_SLOTS = { email: ['email', 'email2', 'email3'], phone: ['phone', 'phone2', 'phone3'] } as const;
// Step 23's drops, one statement each (data-inventory.test.cts reads them).
const LEGACY_DROPS: readonly [string, string][] = [
  ['email', 'ALTER TABLE contacts DROP COLUMN email'],
  ['email2', 'ALTER TABLE contacts DROP COLUMN email2'],
  ['email3', 'ALTER TABLE contacts DROP COLUMN email3'],
  ['phone', 'ALTER TABLE contacts DROP COLUMN phone'],
  ['phone2', 'ALTER TABLE contacts DROP COLUMN phone2'],
  ['phone3', 'ALTER TABLE contacts DROP COLUMN phone3'],
  ['avatar_url', 'ALTER TABLE contacts DROP COLUMN avatar_url'],
];
const LEGACY_COLUMNS = LEGACY_DROPS.map(([column]) => column);
const BATCH = 500;

async function hasColumn(connection: SqlExecutor, table: string, column: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\` WHERE Field = ?`, [column]);
  return rows.length > 0;
}
async function hasIndex(connection: SqlExecutor, table: string, name: string) {
  const [rows] = await connection.execute<RowDataPacket[]>(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name]);
  return rows.length > 0;
}

// A legacy slot counts when it holds more than whitespace; it is copied as
// stored (no trimming, deduplication or format check), so the 3+3 projection
// old apps read stays what they saw before the upgrade.
function legacyValues(row: LegacyRow, kind: 'email' | 'phone') {
  return LEGACY_SLOTS[kind].map(slot => row[slot]).filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

async function addContactModel(connection: SqlExecutor) {
  const columns: [string, string][] = [
    ['uid', 'ALTER TABLE contacts ADD COLUMN uid VARCHAR(255) NULL'],
    ['uid_hash', 'ALTER TABLE contacts ADD COLUMN uid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL'],
    ['version', 'ALTER TABLE contacts ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1'],
    ['display_name', 'ALTER TABLE contacts ADD COLUMN display_name VARCHAR(255) NULL'],
    ['middle_name', 'ALTER TABLE contacts ADD COLUMN middle_name VARCHAR(255) NULL'],
    ['name_prefix', 'ALTER TABLE contacts ADD COLUMN name_prefix VARCHAR(255) NULL'],
    ['name_suffix', 'ALTER TABLE contacts ADD COLUMN name_suffix VARCHAR(255) NULL'],
    ['department', 'ALTER TABLE contacts ADD COLUMN department VARCHAR(255) NULL'],
    ['birthday', 'ALTER TABLE contacts ADD COLUMN birthday VARCHAR(32) NULL'],
    ['anniversary', 'ALTER TABLE contacts ADD COLUMN anniversary VARCHAR(32) NULL'],
    ['name_key', "ALTER TABLE contacts ADD COLUMN name_key VARCHAR(255) NOT NULL DEFAULT ''"],
  ];
  for (const [column, sql] of columns) if (!await hasColumn(connection, 'contacts', column)) await connection.execute(sql);
  await connection.execute("ALTER TABLE contacts MODIFY first_name VARCHAR(255) NOT NULL DEFAULT '', MODIFY last_name VARCHAR(255) NULL");
  if (!await hasIndex(connection, 'contacts', 'uq_contacts_uid')) await connection.execute('ALTER TABLE contacts ADD UNIQUE KEY uq_contacts_uid (user_id, uid_hash)');
  if (!await hasIndex(connection, 'contacts', 'idx_contacts_name_key')) await connection.execute('ALTER TABLE contacts ADD KEY idx_contacts_name_key (user_id, name_key)');

  // One row per labelled value (F12). value_key is the normalised form the
  // duplicate engine, search and restore matching compare (contact-keys.ts).
  // legacy_slot (1 to 3, emails and phones only) is the place the value holds
  // in the 3+3 fields of the 0.24.3 to 0.25.1 apps (services/contacts.ts).
  await connection.execute(`CREATE TABLE IF NOT EXISTS contact_values (
    id CHAR(36) NOT NULL PRIMARY KEY,
    contact_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    kind ENUM('email','phone','address','url','impp','related','nickname','category') NOT NULL,
    position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    is_preferred TINYINT(1) NOT NULL DEFAULT 0,
    label VARCHAR(32) NOT NULL DEFAULT '',
    custom_label VARCHAR(100) NULL,
    value VARCHAR(2048) NOT NULL,
    value_key VARCHAR(255) NOT NULL DEFAULT '',
    po_box VARCHAR(255) NULL,
    extended VARCHAR(255) NULL,
    street TEXT NULL,
    locality VARCHAR(255) NULL,
    region VARCHAR(255) NULL,
    postal_code VARCHAR(255) NULL,
    country VARCHAR(255) NULL,
    params JSON NULL,
    vcard_group VARCHAR(64) NULL,
    legacy_slot TINYINT UNSIGNED NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_contact_values_legacy_slot (contact_id, kind, legacy_slot),
    KEY idx_contact_values_contact (contact_id, kind, position),
    KEY idx_contact_values_key (user_id, kind, value_key),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // Every vCard property UniHub does not show, written back on export.
  await connection.execute(`CREATE TABLE IF NOT EXISTS contact_properties (
    id CHAR(36) NOT NULL PRIMARY KEY,
    contact_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    vcard_group VARCHAR(64) NULL,
    name VARCHAR(64) NOT NULL,
    params JSON NULL,
    value MEDIUMTEXT NOT NULL,
    source_version VARCHAR(8) NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_contact_properties_contact (contact_id, position),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // The converted photo; its files live under uploads/contact-photos/<user_id>/.
  await connection.execute(`CREATE TABLE IF NOT EXISTS contact_photos (
    contact_id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    width SMALLINT UNSIGNED NOT NULL,
    height SMALLINT UNSIGNED NOT NULL,
    bytes INT UNSIGNED NOT NULL,
    thumb_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    source VARCHAR(16) NOT NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_contact_photos_sha (user_id, sha256),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // "Not the same person", stored once per pair with contact_a < contact_b.
  await connection.execute(`CREATE TABLE IF NOT EXISTS contact_duplicate_dismissals (
    contact_a CHAR(36) NOT NULL,
    contact_b CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (contact_a, contact_b),
    KEY idx_contact_dismissals_user (user_id),
    KEY idx_contact_dismissals_b (contact_b),
    FOREIGN KEY (contact_a) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_b) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // The UIDs of merged-away contacts, so a re-import finds their survivor.
  await connection.execute(`CREATE TABLE IF NOT EXISTS contact_uid_aliases (
    user_id CHAR(36) NOT NULL,
    uid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    uid VARCHAR(255) NOT NULL,
    contact_id CHAR(36) NOT NULL,
    merge_id CHAR(36) NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, uid_hash),
    KEY idx_contact_uid_aliases_contact (contact_id),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // A merge and the survivor as it was before, for 30 days of undo. No FK to
  // the survivor: it may be deleted later while the record waits for purge.
  await connection.execute(`CREATE TABLE IF NOT EXISTS contact_merges (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    survivor_id CHAR(36) NOT NULL,
    merged_ids JSON NOT NULL,
    survivor_before LONGTEXT NOT NULL,
    survivor_version_after INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    purge_after DATETIME NOT NULL,
    undone_at DATETIME NULL,
    KEY idx_contact_merges_user (user_id, created_at),
    KEY idx_contact_merges_purge (purge_after),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // The bin (P-31, D13). Generic from the start; in 0.26 only contacts
  // merged away enter it. purge_after NULL is "kept for good" (0.28).
  await connection.execute(`CREATE TABLE IF NOT EXISTS bin_items (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    module VARCHAR(32) NOT NULL,
    item_type VARCHAR(32) NOT NULL,
    item_id CHAR(36) NOT NULL,
    title VARCHAR(255) NOT NULL DEFAULT '',
    reason VARCHAR(32) NOT NULL,
    group_id CHAR(36) NULL,
    payload LONGTEXT NOT NULL,
    payload_version TINYINT UNSIGNED NOT NULL DEFAULT 1,
    file_refs JSON NULL,
    deleted_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    purge_after DATETIME NULL,
    restored_at DATETIME NULL,
    KEY idx_bin_items_purge (user_id, purge_after),
    KEY idx_bin_items_item (user_id, item_type, item_id),
    KEY idx_bin_items_group (group_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // A staged import file and its preview, kept 24 hours.
  await connection.execute(`CREATE TABLE IF NOT EXISTS contact_imports (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'staged',
    format VARCHAR(16) NULL,
    file_path TEXT NULL,
    summary JSON NULL,
    result JSON NULL,
    progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    committed_at DATETIME NULL,
    KEY idx_contact_imports_user (user_id),
    KEY idx_contact_imports_expires (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

// Copies the 3+3 values of every contact that has no contact_values yet, and
// gives every contact its uid and name key, in one transaction: an
// interrupted copy leaves nothing behind and the next start does it again.
async function copyLegacyContactValues(connection: PoolConnection) {
  // Replayed after step 23 dropped the fixed fields: their copy is complete.
  if (!await hasColumn(connection, 'contacts', 'email')) return;
  await connection.beginTransaction();
  try {
    let after = '';
    for (;;) {
      const [rows] = await connection.execute<LegacyRow[]>(`SELECT c.id, c.user_id, c.first_name, c.last_name, c.email, c.email2, c.email3, c.phone, c.phone2, c.phone3
        FROM contacts c WHERE c.id > ? AND NOT EXISTS (SELECT 1 FROM contact_values v WHERE v.contact_id = c.id)
        ORDER BY c.id LIMIT ${BATCH}`, [after]);
      if (!rows.length) break;
      after = rows[rows.length - 1].id;
      const values = rows.flatMap(row => (['email', 'phone'] as const).flatMap(kind => legacyValues(row, kind)
        .map((value, position) => [crypto.randomUUID(), row.id, row.user_id, kind, position, value, valueKey(kind, value), position + 1])));
      if (values.length) {
        await connection.query('INSERT INTO contact_values (id, contact_id, user_id, kind, position, value, value_key, legacy_slot) VALUES ?', [values]);
      }
      const keyed = rows.map(row => [row.id, nameKey({ given: row.first_name, family: row.last_name })]).filter(([, key]) => key);
      if (keyed.length) {
        await connection.execute(`UPDATE contacts SET name_key = CASE id ${keyed.map(() => 'WHEN ? THEN ?').join(' ')} END WHERE id IN (${keyed.map(() => '?').join(', ')})`,
          [...keyed.flat(), ...keyed.map(([id]) => id)]);
      }
    }
    await connection.execute("UPDATE contacts SET uid = CONCAT('urn:uuid:', id) WHERE uid IS NULL");
    await connection.execute('UPDATE contacts SET uid_hash = SHA2(uid, 256) WHERE uid_hash IS NULL');
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  }
}

// Every legacy value is present as a child row of its contact, at its
// position and in the old apps' place for it, with the same text, and
// nothing else was added; every contact has a uid.
async function verifyLegacyContactCopy(connection: SqlExecutor) {
  let after = '';
  let checked = 0;
  const legacy = await hasColumn(connection, 'contacts', 'email');
  while (legacy) {
    const [rows] = await connection.execute<LegacyRow[]>(`SELECT id, user_id, first_name, last_name, email, email2, email3, phone, phone2, phone3
      FROM contacts WHERE id > ? ORDER BY id LIMIT ${BATCH}`, [after]);
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    const [stored] = await connection.execute<ValueRow[]>(`SELECT contact_id, kind, position, value, value_key, legacy_slot FROM contact_values
      WHERE contact_id IN (${rows.map(() => '?').join(', ')}) ORDER BY contact_id, kind, position`, rows.map(row => row.id));
    const byContact = new Map<string, ValueRow[]>();
    for (const value of stored) byContact.set(value.contact_id, [...(byContact.get(value.contact_id) || []), value]);
    for (const row of rows) {
      const actual = byContact.get(row.id) || [];
      for (const kind of ['email', 'phone'] as const) {
        const expected = legacyValues(row, kind);
        const copied = actual.filter(value => value.kind === kind);
        if (copied.length !== expected.length || copied.some((value, index) => value.position !== index || Number(value.legacy_slot) !== index + 1 || value.value !== expected[index] || value.value_key !== valueKey(kind, expected[index]))) {
          throw new Error(`Contact ${row.id}: its ${kind} values were not copied completely`);
        }
      }
      if (actual.some(value => value.kind !== 'email' && value.kind !== 'phone')) throw new Error(`Contact ${row.id}: unexpected values after the copy`);
    }
    checked += rows.length;
  }
  const [[missing]] = await connection.execute<(RowDataPacket & { n: number | string })[]>('SELECT COUNT(*) AS n FROM contacts WHERE uid IS NULL OR uid_hash IS NULL');
  if (Number(missing.n) !== 0) throw new Error('Contacts without a uid remain');
  return checked;
}

async function dropLegacyContactColumns(connection: SqlExecutor) {
  if (await hasIndex(connection, 'contacts', 'idx_contacts_email')) await connection.execute('ALTER TABLE contacts DROP INDEX idx_contacts_email');
  for (const [column, sql] of LEGACY_DROPS) if (await hasColumn(connection, 'contacts', column)) await connection.execute(sql);
  // Every writer sets them from now on (services/contacts.ts, restore).
  await connection.execute('ALTER TABLE contacts MODIFY uid VARCHAR(255) NOT NULL, MODIFY uid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL');
}

async function verifyLegacyColumnsDropped(connection: SqlExecutor) {
  for (const column of LEGACY_COLUMNS) if (await hasColumn(connection, 'contacts', column)) throw new Error(`contacts.${column} is still present`);
  if (await hasIndex(connection, 'contacts', 'idx_contacts_email')) throw new Error('Index idx_contacts_email on contacts is still present');
}

export { addContactModel, copyLegacyContactValues, verifyLegacyContactCopy, dropLegacyContactColumns, verifyLegacyColumnsDropped, LEGACY_COLUMNS };
