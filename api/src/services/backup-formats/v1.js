// Historical 0.9.23.0–0.10.2 data schema. These archives never contained the
// provider-folder mapping table. Do not infer mappings from ambiguous names.
function readV1(backup) {
  const data = backup.data;
  if (['mail_accounts', 'mail_folders', 'emails'].some(table => Object.hasOwn(data, table))) {
    data.mail_folder_remote_boxes ??= [];
  }
  return backup;
}

module.exports = { readV1 };
