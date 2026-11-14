import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// Upgrade step 27 (0.30.0): the organisation (F3, the first slice of F4). It
// adds tables and columns and changes no row:
// - the owner role (users.role) with a key that lets one person at most
//   hold it, and the start of a person's two-factor grace;
// - groups and their members, organisation data that only the instance
//   backup carries (data-inventory.ts);
// - setup links and login attempts, installation state that an instance
//   restore clears;
// - the hash of the rules a person last confirmed (policy_notices).
// The services that fill them come with their features; choosing the owner
// is a later step that ships with the role checks.
//
// DDL commits on its own: each part checks whether an interrupted run
// already made it. New foreign keys carry names of their own.

type Executor = Pick<PoolConnection, 'execute'>;

async function hasColumn(connection: Executor, table: string, column: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\` WHERE Field = ?`, [column]);
  return present.length > 0;
}
async function hasIndex(connection: Executor, table: string, name: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name]);
  return present.length > 0;
}
async function hasTable(connection: Executor, table: string) {
  const [present] = await connection.execute<RowDataPacket[]>('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
  return present.length > 0;
}
async function roleColumnType(connection: Executor): Promise<string> {
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'`);
  return String(rows[0]?.type ?? '');
}

async function addOrganisation(connection: Executor) {
  // The owner role. owner_marker is 1 for the owner and NULL for everyone
  // else, so its unique key refuses a second owner whatever writes the row.
  if (!(await roleColumnType(connection)).includes("'owner'")) {
    await connection.execute("ALTER TABLE users MODIFY role ENUM('user','admin','owner') NOT NULL DEFAULT 'user'");
  }
  if (!await hasColumn(connection, 'users', 'owner_marker')) {
    await connection.execute("ALTER TABLE users ADD COLUMN owner_marker TINYINT AS (IF(role = 'owner', 1, NULL)) PERSISTENT, ADD UNIQUE KEY unique_users_owner (owner_marker)");
  }
  // When two-factor authentication became required for a person who has
  // none: their 7-day grace counts from here. NULL while no grace runs.
  if (!await hasColumn(connection, 'users', 'two_factor_required_since')) {
    await connection.execute('ALTER TABLE users ADD COLUMN two_factor_required_since DATETIME NULL');
  }

  // Groups of the organisation (F3). A person can be in several; deleting a
  // group or a person takes the memberships with it.
  await connection.execute(`CREATE TABLE IF NOT EXISTS org_groups (
    id CHAR(36) NOT NULL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NULL,
    created_by CHAR(36) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_org_groups_name (name),
    CONSTRAINT fk_org_groups_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS org_group_members (
    group_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    role ENUM('member','manager') NOT NULL DEFAULT 'member',
    added_by CHAR(36) NULL,
    added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id),
    KEY idx_org_group_members_user (user_id),
    CONSTRAINT fk_org_group_members_group FOREIGN KEY (group_id) REFERENCES org_groups (id) ON DELETE CASCADE,
    CONSTRAINT fk_org_group_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_org_group_members_added_by FOREIGN KEY (added_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Setup links: one live link per person, only its SHA-256 kept.
  await connection.execute(`CREATE TABLE IF NOT EXISTS invites (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_by CHAR(36) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    used_at DATETIME NULL,
    UNIQUE KEY unique_invites_user (user_id),
    UNIQUE KEY unique_invites_token (token_hash),
    KEY idx_invites_expires (expires_at),
    CONSTRAINT fk_invites_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_invites_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Sign-in attempt budgets (security/login-limits.ts), kept across a
  // restart. The identity (an address, an account) is stored hashed.
  await connection.execute(`CREATE TABLE IF NOT EXISTS login_attempts (
    scope VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    identity_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    window_ends_at DATETIME(3) NOT NULL,
    PRIMARY KEY (scope, identity_hash),
    KEY idx_login_attempts_window (window_ends_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // The rules a person confirmed, as a hash of their list: with group rules
  // a notice is due only for people whose own rules changed.
  if (!await hasColumn(connection, 'policy_notices', 'rules_hash')) {
    await connection.execute('ALTER TABLE policy_notices ADD COLUMN rules_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL');
  }
}

/** Step 27 is complete: the role, the columns, the tables and their keys exist. */
async function verifyOrganisation(connection: Executor) {
  if (!(await roleColumnType(connection)).includes("'owner'")) throw new Error('users.role has no owner');
  for (const [table, column] of [['users', 'owner_marker'], ['users', 'two_factor_required_since'], ['policy_notices', 'rules_hash']]) {
    if (!await hasColumn(connection, table, column)) throw new Error(`${table}.${column} is missing`);
  }
  for (const table of ['org_groups', 'org_group_members', 'invites', 'login_attempts']) {
    if (!await hasTable(connection, table)) throw new Error(`Table ${table} is missing`);
  }
  for (const [table, index] of [['users', 'unique_users_owner'], ['org_groups', 'unique_org_groups_name'], ['org_group_members', 'idx_org_group_members_user'],
    ['invites', 'unique_invites_user'], ['invites', 'unique_invites_token'], ['login_attempts', 'idx_login_attempts_window']]) {
    if (!await hasIndex(connection, table, index)) throw new Error(`Index ${index} on ${table} is missing`);
  }
}

// Upgrade step 28 (0.30.0): the installation's owner. The earliest-created
// active administrator becomes owner (the bootstrap administrator on a new
// installation), else the earliest administrator; an installation without
// administrators has no owner. Ships with the permission checks, so the owner
// keeps every administrator's right.
async function chooseOwner(connection: Executor) {
  const [owners] = await connection.execute<RowDataPacket[]>("SELECT 1 FROM users WHERE role = 'owner' LIMIT 1");
  if (owners.length) return;
  const [admins] = await connection.execute<RowDataPacket[]>("SELECT id FROM users WHERE role = 'admin' ORDER BY is_active DESC, created_at, id LIMIT 1");
  if (admins.length) await connection.execute("UPDATE users SET role = 'owner' WHERE id = ? AND role = 'admin'", [admins[0].id]);
}

/** Step 28 is complete: exactly one owner whenever there is an administrator. */
async function verifyOwner(connection: Executor) {
  const [[counts]] = await connection.execute<RowDataPacket[]>("SELECT SUM(role = 'owner') AS owners, SUM(role IN ('owner', 'admin')) AS admins FROM users");
  if (Number(counts.admins ?? 0) > 0 && Number(counts.owners ?? 0) !== 1) throw new Error('The installation has administrators but no owner');
}

export { addOrganisation, verifyOrganisation, chooseOwner, verifyOwner };
