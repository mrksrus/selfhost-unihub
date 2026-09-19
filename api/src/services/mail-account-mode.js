const enabled = value => value === true || value === 1 || value === '1' || value === 'true';

function mailAccountModeChange(account, body) {
  const current = account?.sync_mode || 'download';
  const mode = body.sync_mode === undefined ? current : body.sync_mode;
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!['download', 'sync'].includes(mode)) fail('Mail mode must be download or sync.');
  const changed = !!account && current !== mode;
  const requestedDelete = enabled(body.delete_emails_on_server);
  if (mode === 'sync' && requestedDelete) fail('Automatic server deletion is unavailable in Sync mode.');
  if (changed && mode === 'sync' && body.sync_mode_confirmed !== true) {
    fail('Confirm that Sync will follow server read status and folders, retain messages missing from the server, and stop automatic server deletion.');
  }
  if (changed && mode === 'download' && requestedDelete) fail('Save Download mode first, then explicitly enable server deletion if wanted.');
  const deleteSettingProvided = changed || mode === 'sync' || Object.hasOwn(body, 'delete_emails_on_server');
  return { mode, changed, deleteSettingProvided, deleteEnabled: mode === 'download' && !changed && (deleteSettingProvided ? requestedDelete : enabled(account?.delete_emails_on_server)) };
}
module.exports = { mailAccountModeChange };

// UID namespaces belong to one provider mailbox, not merely its display address.
function sameProviderMailbox(left, right) {
  const host = value => String(value || '').trim().toLowerCase();
  const login = account => String(account.username || account.email_address || '').trim();
  return host(left.imap_host) === host(right.imap_host)
    && Number(left.imap_port || 993) === Number(right.imap_port || 993)
    && login(left) === login(right)
    && host(left.email_address) === host(right.email_address);
}
module.exports.sameProviderMailbox = sameProviderMailbox;
