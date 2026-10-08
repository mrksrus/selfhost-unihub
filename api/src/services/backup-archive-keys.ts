import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import imported1 = require('../state');
const { db } = imported1;

async function pruneArchiveKeyIfUnreferenced(userId: string | null | undefined, backupUuid: string | null | undefined) {
  if (!userId || !backupUuid) return false;
  const [[exportReferences], [restoreReferences]] = await Promise.all([
    db.execute<RowDataPacket[]>(
      `SELECT id FROM data_export_jobs
       WHERE user_id = ? AND backup_uuid = ?
       LIMIT 1`,
      [userId, backupUuid]
    ),
    db.execute<RowDataPacket[]>(
      `SELECT id FROM backup_restore_jobs
       WHERE user_id = ? AND backup_uuid = ? AND archive_path IS NOT NULL
       LIMIT 1`,
      [userId, backupUuid]
    ),
  ]);
  if (exportReferences.length || restoreReferences.length) return false;
  const [result] = await db.execute<ResultSetHeader>(
    'DELETE FROM backup_archive_keys WHERE backup_uuid = ? AND user_id = ?',
    [backupUuid, userId]
  );
  return Number(result?.affectedRows) > 0;
}

export = {
  pruneArchiveKeyIfUnreferenced,
};
