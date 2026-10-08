import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor, StoredFlag } from '../types';

function sameUidValidity(left: unknown, right: unknown) {
  return left != null && right != null && String(left) === String(right);
}

async function loadFolderSyncState(db: SqlExecutor, accountId: string, folderName: string, uidValidity: unknown) {
  const [rows] = await db.execute<(RowDataPacket & { initialized: StoredFlag; uidvalidity: unknown; last_uid: number | string | null })[]>(
    'SELECT uidvalidity, last_uid, initialized FROM mail_sync_state WHERE mail_account_id = ? AND source_folder = ?',
    [accountId, folderName]
  );
  const state = rows[0];
  const incremental = !!state?.initialized && sameUidValidity(state.uidvalidity, uidValidity);
  return { incremental, lastUid: incremental ? Number(state.last_uid) || 0 : 0 };
}

function buildFolderSearchCriteria(state: { incremental: boolean; lastUid: number }) {
  return state.incremental ? [['UID', `${state.lastUid + 1}:*`]] : ['ALL'];
}

async function saveFolderSyncState(db: SqlExecutor, accountId: string, folderName: string, uidValidity: string | number | bigint | null, lastUid: number) {
  await db.execute(
    `INSERT INTO mail_sync_state (mail_account_id, source_folder, uidvalidity, last_uid, initialized, last_synced_at)
     VALUES (?, ?, ?, ?, TRUE, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE uidvalidity = VALUES(uidvalidity), last_uid = VALUES(last_uid),
       initialized = TRUE, last_synced_at = UTC_TIMESTAMP()`,
    [accountId, folderName, uidValidity, lastUid]
  );
}

export { sameUidValidity, loadFolderSyncState, buildFolderSearchCriteria, saveFolderSyncState };
