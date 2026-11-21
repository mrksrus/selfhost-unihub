import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

// Upgrade step 33: a chat device waits until it joins. chat_devices gains
// approved_at (null while it waits) and the three columns of an open
// approval: the waiting device's one-time public key, the history key an
// approving device sealed to it, and when it asked. Every chat device that
// exists now is joined, from when it enrolled.
// DDL commits on its own: the column is checked before it is added again.

type Executor = Pick<PoolConnection, 'execute'>;

async function hasApproval(connection: Executor) {
  const [present] = await connection.execute<RowDataPacket[]>("SHOW COLUMNS FROM chat_devices WHERE Field = 'approved_at'");
  return present.length > 0;
}

async function addChatDeviceApproval(connection: Executor) {
  if (!await hasApproval(connection)) {
    await connection.execute(`ALTER TABLE chat_devices ADD COLUMN approved_at DATETIME NULL,
      ADD COLUMN pair_public VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD COLUMN pair_sealed VARCHAR(2048) CHARACTER SET ascii COLLATE ascii_bin NULL,
      ADD COLUMN pair_requested_at DATETIME NULL`);
  }
  await connection.execute('UPDATE chat_devices SET approved_at = created_at WHERE approved_at IS NULL');
}

async function verifyChatDeviceApproval(connection: Executor) {
  if (!await hasApproval(connection)) throw new Error('chat_devices is not changed for device approval');
}

export { addChatDeviceApproval, verifyChatDeviceApproval };
