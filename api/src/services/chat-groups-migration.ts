import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// Upgrade step 32: group chats and chat files. No existing row changes meaning.
// - chat_conversations: kind 'group' with a name (plain text, null for a
//   direct chat), and the retention in force with the moment deleting under
//   it starts (both null while messages are kept).
// - chat_members: what the chat notifies the person of.
// - chat_attachments: a file's ciphertext under chat/<conversation>/<id>,
//   its message once one names it, and its uploader (emptied when they are
//   deleted: the file stays for the others). Rows go before their message.
// DDL commits on its own: each part checks whether an interrupted run made it.

type Executor = Pick<PoolConnection, 'execute'>;

async function hasColumn(connection: Executor, table: string, column: string) {
  const [present] = await connection.execute<RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\` WHERE Field = ?`, [column]);
  return present.length > 0;
}

const ALTERS: readonly [string, string, string][] = [
  ['chat_conversations', 'name', `ALTER TABLE chat_conversations ADD COLUMN name VARCHAR(80) NULL,
    ADD COLUMN retention_days SMALLINT UNSIGNED NULL, ADD COLUMN retention_from DATETIME NULL`],
  ['chat_members', 'notify', "ALTER TABLE chat_members ADD COLUMN notify VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'all'"],
];

async function addChatGroups(connection: Executor) {
  for (const [table, column, alter] of ALTERS) if (!await hasColumn(connection, table, column)) await connection.execute(alter);
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_attachments (
    id CHAR(36) NOT NULL PRIMARY KEY,
    conversation_id CHAR(36) NOT NULL,
    message_id CHAR(36) NULL,
    uploader_user_id CHAR(36) NULL,
    size_bytes BIGINT UNSIGNED NOT NULL,
    storage_path VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_chat_attachments_conversation (conversation_id),
    KEY idx_chat_attachments_message (message_id, created_at),
    KEY idx_chat_attachments_uploader (uploader_user_id),
    CONSTRAINT fk_chat_attachments_conversation FOREIGN KEY (conversation_id) REFERENCES chat_conversations (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_attachments_message FOREIGN KEY (message_id) REFERENCES chat_messages (id),
    CONSTRAINT fk_chat_attachments_uploader FOREIGN KEY (uploader_user_id) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function verifyChatGroups(connection: Executor) {
  for (const [table, column] of ALTERS) if (!await hasColumn(connection, table, column)) throw new Error(`${table} is not changed for group chats`);
  if (!await hasColumn(connection, 'chat_attachments', 'uploader_user_id')) throw new Error('Table chat_attachments is missing');
}

export { addChatGroups, verifyChatGroups };
