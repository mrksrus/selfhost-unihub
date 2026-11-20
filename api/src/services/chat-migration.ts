import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// Upgrade step 31: end-to-end encrypted chat. It adds tables and changes no
// row. The server stores opaque bytes (base64url text) it cannot read:
// - chat_accounts: a person's history public key and the passphrase-wrapped
//   private half.
// - chat_devices: a device enrolled for chat. device_id is set null when its
//   device record goes (removed, pruned, an instance restore) or it signs
//   out; the row stays while a group names it, which is how a group is
//   known to be out of date.
// - chat_key_packages: MLS key packages a device published, each claimed once;
//   the last resort is reused.
// - chat_conversations, chat_members: a conversation (its people hold grants
//   of kind `conversation`) and each person's marks, written lazily.
// - chat_groups, chat_group_devices: an MLS group made by one device with one
//   Welcome for all its devices; a group never changes, a new one replaces it.
// - chat_messages: a conversation's entries in seq order; a deleted message
//   keeps its row without ciphertext.
// - chat_archive: each person's own copy of a message, sealed to their history key.
//
// DDL commits on its own; CREATE TABLE IF NOT EXISTS lets an interrupted run
// go on. Every foreign key carries a name of its own.

type Executor = Pick<PoolConnection, 'execute'>;

const BLOB = 'CHARACTER SET ascii COLLATE ascii_bin';
const CHAT_TABLES = ['chat_accounts', 'chat_devices', 'chat_key_packages', 'chat_conversations', 'chat_members', 'chat_groups', 'chat_group_devices', 'chat_messages', 'chat_archive'] as const;

async function addChat(connection: Executor) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_accounts (
    user_id CHAR(36) NOT NULL PRIMARY KEY,
    history_public VARCHAR(128) ${BLOB} NOT NULL,
    key_backup TEXT ${BLOB} NOT NULL,
    backup_salt VARCHAR(128) ${BLOB} NOT NULL,
    backup_rounds INT UNSIGNED NOT NULL,
    backup_format SMALLINT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_chat_accounts_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_devices (
    id CHAR(36) NOT NULL PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    device_id CHAR(36) NULL,
    preview_p256dh VARCHAR(128) ${BLOB} NULL,
    preview_auth VARCHAR(64) ${BLOB} NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_chat_devices_device (device_id),
    KEY idx_chat_devices_user (user_id),
    CONSTRAINT fk_chat_devices_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_devices_device FOREIGN KEY (device_id) REFERENCES devices (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_key_packages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    chat_device_id CHAR(36) NOT NULL,
    key_package TEXT ${BLOB} NOT NULL,
    last_resort TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_chat_key_packages_device (chat_device_id, last_resort, id),
    CONSTRAINT fk_chat_key_packages_device FOREIGN KEY (chat_device_id) REFERENCES chat_devices (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  // current_group_id has no foreign key: a group belongs to its conversation, not the other way round.
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_conversations (
    id CHAR(36) NOT NULL PRIMARY KEY,
    kind VARCHAR(16) ${BLOB} NOT NULL,
    direct_key VARCHAR(73) ${BLOB} NULL,
    current_group_id CHAR(36) NULL,
    last_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_by CHAR(36) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_chat_conversations_direct (direct_key),
    CONSTRAINT fk_chat_conversations_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_members (
    conversation_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    read_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
    delivered_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
    joined_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (conversation_id, user_id),
    KEY idx_chat_members_user (user_id),
    CONSTRAINT fk_chat_members_conversation FOREIGN KEY (conversation_id) REFERENCES chat_conversations (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_groups (
    id CHAR(36) NOT NULL PRIMARY KEY,
    conversation_id CHAR(36) NOT NULL,
    welcome MEDIUMTEXT ${BLOB} NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_chat_groups_conversation (conversation_id),
    CONSTRAINT fk_chat_groups_conversation FOREIGN KEY (conversation_id) REFERENCES chat_conversations (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_group_devices (
    group_id CHAR(36) NOT NULL,
    chat_device_id CHAR(36) NOT NULL,
    joined_at DATETIME NULL,
    PRIMARY KEY (group_id, chat_device_id),
    KEY idx_chat_group_devices_device (chat_device_id),
    CONSTRAINT fk_chat_group_devices_group FOREIGN KEY (group_id) REFERENCES chat_groups (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_group_devices_device FOREIGN KEY (chat_device_id) REFERENCES chat_devices (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_messages (
    id CHAR(36) NOT NULL PRIMARY KEY,
    conversation_id CHAR(36) NOT NULL,
    seq BIGINT UNSIGNED NOT NULL,
    group_id CHAR(36) NOT NULL,
    sender_user_id CHAR(36) NULL,
    sender_chat_device_id CHAR(36) NULL,
    kind VARCHAR(16) ${BLOB} NOT NULL DEFAULT 'message',
    replaces CHAR(36) NULL,
    format SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    ciphertext MEDIUMTEXT ${BLOB} NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_chat_messages_seq (conversation_id, seq),
    KEY idx_chat_messages_replaces (replaces),
    CONSTRAINT fk_chat_messages_conversation FOREIGN KEY (conversation_id) REFERENCES chat_conversations (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_messages_group FOREIGN KEY (group_id) REFERENCES chat_groups (id),
    CONSTRAINT fk_chat_messages_sender FOREIGN KEY (sender_user_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_chat_messages_sender_device FOREIGN KEY (sender_chat_device_id) REFERENCES chat_devices (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_archive (
    user_id CHAR(36) NOT NULL,
    message_id CHAR(36) NOT NULL,
    sealed MEDIUMTEXT ${BLOB} NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, message_id),
    KEY idx_chat_archive_message (message_id),
    CONSTRAINT fk_chat_archive_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_archive_message FOREIGN KEY (message_id) REFERENCES chat_messages (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

/** Step 31 is complete: the nine tables exist, and a removed device is marked by its foreign key. */
async function verifyChat(connection: Executor) {
  const [tables] = await connection.execute<RowDataPacket[]>(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN (${CHAT_TABLES.map(() => '?').join(', ')})`, [...CHAT_TABLES]);
  const present = new Set(tables.map(row => String(row.TABLE_NAME)));
  for (const table of CHAT_TABLES) if (!present.has(table)) throw new Error(`Table ${table} is missing`);
  const [[rule]] = await connection.execute<RowDataPacket[]>(`SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_chat_devices_device'`);
  if (rule?.DELETE_RULE !== 'SET NULL') throw new Error('chat_devices.device_id does not follow its device');
}

export { addChat, verifyChat };
