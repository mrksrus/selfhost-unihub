import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// Upgrade step 34: voice calls. No existing row changes meaning.
// - chat_calls: one call of a direct chat, its two people and their two
//   devices (emptied when they go), its state and outcome, and its entry in
//   the chat once it ended (the call goes with the entry).
// - chat_call_signals: what the two devices send each other while the call
//   is set up; deleted when it ends.
// - chat_messages.group_id may be empty: a call's entry belongs to no group.
// DDL commits on its own: each part is checked or harmless to run again.

type Executor = Pick<PoolConnection, 'execute'>;

async function addChatCalls(connection: Executor) {
  await connection.execute('ALTER TABLE chat_messages MODIFY group_id CHAR(36) NULL');
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_calls (
    id CHAR(36) NOT NULL PRIMARY KEY,
    conversation_id CHAR(36) NOT NULL,
    caller_user_id CHAR(36) NULL,
    callee_user_id CHAR(36) NULL,
    caller_chat_device_id CHAR(36) NULL,
    answered_chat_device_id CHAR(36) NULL,
    state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    outcome VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at DATETIME NOT NULL,
    answered_at DATETIME NULL,
    ended_at DATETIME NULL,
    alive_at DATETIME NOT NULL,
    message_id CHAR(36) NULL,
    UNIQUE KEY uq_chat_calls_message (message_id),
    KEY idx_chat_calls_caller (caller_user_id, state),
    KEY idx_chat_calls_callee (callee_user_id, state),
    KEY idx_chat_calls_state (state, created_at),
    KEY fk_chat_calls_conversation (conversation_id),
    KEY fk_chat_calls_caller_device (caller_chat_device_id),
    KEY fk_chat_calls_answered_device (answered_chat_device_id),
    CONSTRAINT fk_chat_calls_conversation FOREIGN KEY (conversation_id) REFERENCES chat_conversations (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_calls_caller FOREIGN KEY (caller_user_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_chat_calls_callee FOREIGN KEY (callee_user_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_chat_calls_caller_device FOREIGN KEY (caller_chat_device_id) REFERENCES chat_devices (id) ON DELETE SET NULL,
    CONSTRAINT fk_chat_calls_answered_device FOREIGN KEY (answered_chat_device_id) REFERENCES chat_devices (id) ON DELETE SET NULL,
    CONSTRAINT fk_chat_calls_message FOREIGN KEY (message_id) REFERENCES chat_messages (id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_call_signals (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    call_id CHAR(36) NOT NULL,
    from_chat_device_id CHAR(36) NULL,
    payload TEXT NOT NULL,
    created_at DATETIME NOT NULL,
    KEY idx_chat_call_signals_call (call_id, id),
    KEY fk_chat_call_signals_device (from_chat_device_id),
    CONSTRAINT fk_chat_call_signals_call FOREIGN KEY (call_id) REFERENCES chat_calls (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_call_signals_device FOREIGN KEY (from_chat_device_id) REFERENCES chat_devices (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function verifyChatCalls(connection: Executor) {
  const [[group]] = await connection.execute<RowDataPacket[]>("SHOW COLUMNS FROM chat_messages WHERE Field = 'group_id'");
  if (group?.Null !== 'YES') throw new Error('chat_messages is not changed for calls');
  for (const table of ['chat_calls', 'chat_call_signals']) {
    const [present] = await connection.execute<RowDataPacket[]>(`SHOW TABLES LIKE '${table}'`);
    if (!present.length) throw new Error(`Table ${table} is missing`);
  }
}

// Upgrade step 35: group calls. chat_call_members holds each person who was
// rung for a group chat's call or joined it, with the device and the sender
// number while they are in it. No existing row changes.
async function addChatCallMembers(connection: Executor) {
  await connection.execute(`CREATE TABLE IF NOT EXISTS chat_call_members (
    call_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    chat_device_id CHAR(36) NULL,
    state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sender TINYINT UNSIGNED NULL,
    joined_at DATETIME NULL,
    left_at DATETIME NULL,
    alive_at DATETIME NULL,
    PRIMARY KEY (call_id, user_id),
    KEY idx_chat_call_members_user (user_id, state),
    KEY fk_chat_call_members_device (chat_device_id),
    CONSTRAINT fk_chat_call_members_call FOREIGN KEY (call_id) REFERENCES chat_calls (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_call_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_call_members_device FOREIGN KEY (chat_device_id) REFERENCES chat_devices (id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function verifyChatCallMembers(connection: Executor) {
  const [present] = await connection.execute<RowDataPacket[]>("SHOW TABLES LIKE 'chat_call_members'");
  if (!present.length) throw new Error('Table chat_call_members is missing');
}

export { addChatCalls, verifyChatCalls, addChatCallMembers, verifyChatCallMembers };
