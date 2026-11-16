import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// Upgrade step 29 (0.31.0): shared address books, the grants that reach them
// (F4) and the company directory's own fields. It adds tables and columns
// and changes no row:
// - address_books, owned by the organisation;
// - grants: who may read, edit or manage a shared resource, by principal;
// - directory_entries: the phone, job title and department a person shows
//   in the company directory;
// - the contact tables and the bin take a book's rows beside a person's:
//   each row has either user_id or address_book_id, never both.
//
// DDL commits on its own: each part checks whether an interrupted run
// already made it. Each existing table changes in one ALTER, so a large
// table is copied once. New foreign keys carry names of their own.

type Executor = Pick<PoolConnection, 'execute'>;

async function hasColumn(connection: Executor, table: string, column: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\` WHERE Field = ?`, [column]);
  return present.length > 0;
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

// The tables whose rows a person or a book owns, with the ALTER that lets a book own them.
const BOOK_ROWS: readonly [string, string][] = [
  ['contacts', `ALTER TABLE contacts ADD COLUMN address_book_id CHAR(36) NULL, MODIFY user_id CHAR(36) NULL,
    ADD UNIQUE KEY uq_contacts_book_uid (address_book_id, uid_hash),
    ADD CONSTRAINT fk_contacts_book FOREIGN KEY (address_book_id) REFERENCES address_books (id) ON DELETE CASCADE,
    ADD CONSTRAINT chk_contacts_owner CHECK ((user_id IS NULL) <> (address_book_id IS NULL))`],
  ['contact_values', `ALTER TABLE contact_values ADD COLUMN address_book_id CHAR(36) NULL, MODIFY user_id CHAR(36) NULL,
    ADD CONSTRAINT fk_contact_values_book FOREIGN KEY (address_book_id) REFERENCES address_books (id) ON DELETE CASCADE,
    ADD CONSTRAINT chk_contact_values_owner CHECK ((user_id IS NULL) <> (address_book_id IS NULL))`],
  ['contact_properties', `ALTER TABLE contact_properties ADD COLUMN address_book_id CHAR(36) NULL, MODIFY user_id CHAR(36) NULL,
    ADD CONSTRAINT fk_contact_properties_book FOREIGN KEY (address_book_id) REFERENCES address_books (id) ON DELETE CASCADE,
    ADD CONSTRAINT chk_contact_properties_owner CHECK ((user_id IS NULL) <> (address_book_id IS NULL))`],
  ['contact_photos', `ALTER TABLE contact_photos ADD COLUMN address_book_id CHAR(36) NULL, MODIFY user_id CHAR(36) NULL,
    ADD CONSTRAINT fk_contact_photos_book FOREIGN KEY (address_book_id) REFERENCES address_books (id) ON DELETE CASCADE,
    ADD CONSTRAINT chk_contact_photos_owner CHECK ((user_id IS NULL) <> (address_book_id IS NULL))`],
  ['bin_items', `ALTER TABLE bin_items ADD COLUMN address_book_id CHAR(36) NULL, MODIFY user_id CHAR(36) NULL,
    ADD CONSTRAINT fk_bin_items_book FOREIGN KEY (address_book_id) REFERENCES address_books (id) ON DELETE CASCADE,
    ADD CONSTRAINT chk_bin_items_owner CHECK ((user_id IS NULL) <> (address_book_id IS NULL))`],
];

async function addSharedContacts(connection: Executor) {
  // owner_kind and owner_id leave room for a person's own shareable book;
  // only the organisation owns books for now.
  await connection.execute(`CREATE TABLE IF NOT EXISTS address_books (
    id CHAR(36) NOT NULL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(500) NULL,
    owner_kind ENUM('org','user') NOT NULL DEFAULT 'org',
    owner_id CHAR(36) NULL,
    created_by CHAR(36) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at DATETIME NULL,
    KEY idx_address_books_deleted (deleted_at),
    CONSTRAINT fk_address_books_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // No foreign key to the resource (several kinds share the table): the
  // transaction that deletes a resource or a principal removes its grants.
  await connection.execute(`CREATE TABLE IF NOT EXISTS grants (
    id CHAR(36) NOT NULL PRIMARY KEY,
    resource_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    resource_id CHAR(36) NOT NULL,
    principal_kind ENUM('user','group','everyone') NOT NULL,
    principal_id VARCHAR(36) NOT NULL DEFAULT '',
    permission VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    granted_by CHAR(36) NULL,
    granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_grants_principal (resource_kind, resource_id, principal_kind, principal_id),
    KEY idx_grants_principal (principal_kind, principal_id),
    CONSTRAINT fk_grants_granted_by FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS directory_entries (
    user_id CHAR(36) NOT NULL PRIMARY KEY,
    phone VARCHAR(64) NULL,
    job_title VARCHAR(255) NULL,
    department VARCHAR(255) NULL,
    updated_by CHAR(36) NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_directory_entries_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_directory_entries_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  for (const [table, alter] of BOOK_ROWS) if (!await hasColumn(connection, table, 'address_book_id')) await connection.execute(alter);
}

/** Step 29 is complete: the tables, the book columns, their keys and owner checks exist. */
async function verifySharedContacts(connection: Executor) {
  for (const table of ['address_books', 'grants', 'directory_entries']) if (!await hasTable(connection, table)) throw new Error(`Table ${table} is missing`);
  for (const [table] of BOOK_ROWS) {
    if (!await hasColumn(connection, table, 'address_book_id')) throw new Error(`${table}.address_book_id is missing`);
    for (const name of [`fk_${table}_book`, `chk_${table}_owner`]) if (!await hasConstraint(connection, table, name)) throw new Error(`Constraint ${name} on ${table} is missing`);
  }
  if (!await hasConstraint(connection, 'contacts', 'uq_contacts_book_uid')) throw new Error('Key uq_contacts_book_uid on contacts is missing');
}

export { addSharedContacts, verifySharedContacts };
