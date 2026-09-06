function sameUidValidity(left, right) {
  return left != null && right != null && String(left) === String(right);
}

async function loadFolderSyncState(db, accountId, folderName, uidValidity) {
  const [rows] = await db.execute(
    'SELECT uidvalidity, last_uid, initialized FROM mail_sync_state WHERE mail_account_id = ? AND source_folder = ?',
    [accountId, folderName]
  );
  const state = rows[0];
  const incremental = !!state?.initialized && sameUidValidity(state.uidvalidity, uidValidity);
  return { incremental, lastUid: incremental ? Number(state.last_uid) || 0 : 0 };
}

function buildFolderSearchCriteria(state) {
  return state.incremental ? [['UID', `${state.lastUid + 1}:*`]] : ['ALL'];
}

async function saveFolderSyncState(db, accountId, folderName, uidValidity, lastUid) {
  await db.execute(
    `INSERT INTO mail_sync_state (mail_account_id, source_folder, uidvalidity, last_uid, initialized, last_synced_at)
     VALUES (?, ?, ?, ?, TRUE, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE uidvalidity = VALUES(uidvalidity), last_uid = VALUES(last_uid),
       initialized = TRUE, last_synced_at = UTC_TIMESTAMP()`,
    [accountId, folderName, uidValidity, lastUid]
  );
}

module.exports = { sameUidValidity, loadFolderSyncState, buildFolderSearchCriteria, saveFolderSyncState };
