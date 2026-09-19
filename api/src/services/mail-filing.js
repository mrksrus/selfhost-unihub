// Provider identity remains on stored mail_account_id. Local views use filing_account_id.
function filingAccountId(email) {
  return email.filing_account_id ?? email.mail_account_id ?? null;
}

function presentMailFiling(email) {
  const visible = { ...email };
  for (const key of ['source_folder', 'imap_uid', 'imap_uidvalidity', 'remote_folder', 'remote_uid', 'remote_uidvalidity', 'raw_storage_path', 'raw_sha256']) delete visible[key];
  return {
    ...visible,
    remote_missing: email.remote_missing === true || email.remote_missing === 1 || email.remote_missing === '1',
    source_mail_account_id: Object.hasOwn(email, 'source_mail_account_id') ? email.source_mail_account_id : email.mail_account_id,
    mail_account_id: filingAccountId(email),
    is_legacy: email.is_legacy === true || email.is_legacy === 1 || email.is_legacy === '1',
  };
}

function folderAcceptsAccount(folder, accountId, connections = new Map()) {
  if (!folder || !accountId) return false;
  if (folder.is_system === true || folder.is_system === 1 || folder.is_system === '1') return true;
  return folder.mail_account_id === accountId || (connections.get(folder.slug) || []).includes(accountId);
}

module.exports = { filingAccountId, presentMailFiling, folderAcceptsAccount };
