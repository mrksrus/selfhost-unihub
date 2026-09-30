// The schema 3 restore model separates provider identity from local filing.
function readV3(backup, { legacyDefaults = false } = {}) {
  if (legacyDefaults) {
    for (const folder of backup.data.mail_folders || []) {
      folder.mail_account_id ??= null;
      folder.special_use ??= null;
    }
    for (const email of backup.data.emails || []) {
      email.filing_account_id ??= null;
      email.is_legacy ??= false;
    }
  }
  for (const account of backup.data.mail_accounts || []) {
    account.sync_mode ??= 'download';
    account.sync_status = account.sync_mode === 'sync' ? 'pending' : 'idle';
  }
  for (const email of backup.data.emails || []) {
    if (email.remote_folder === undefined) email.remote_folder = email.source_folder ?? null;
    if (email.remote_uid === undefined) email.remote_uid = email.imap_uid ?? null;
    if (email.remote_uidvalidity === undefined) email.remote_uidvalidity = email.imap_uidvalidity ?? null;
    email.remote_missing ??= false;
  }
  return backup;
}
module.exports = { readV3 };
