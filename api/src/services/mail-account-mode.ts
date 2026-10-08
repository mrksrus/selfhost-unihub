import type { MailAccountIdentity } from '../types';
const enabled = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true';

function mailAccountModeChange(account: MailAccountIdentity | null | undefined, body: Record<string, unknown>) {
  const current = account?.sync_mode || 'download';
  const mode = body.sync_mode === undefined ? current : body.sync_mode;
  const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };
  if (typeof mode !== 'string' || !['download', 'sync'].includes(mode)) fail('Mail mode must be download or sync.');
  const changed = !!account && current !== mode;
  const requestedDelete = enabled(body.delete_emails_on_server);
  if (mode === 'sync' && requestedDelete) fail('Automatic server deletion is unavailable in Sync mode.');
  // Sync makes the server the source of truth: local copies the server no
  // longer has (and, with windows, older mail) are removed. Switching requires
  // the account address typed by the user; that confirmation also confirms the
  // account's Sync policy (sync_policy_confirmed_at).
  if (changed && mode === 'sync' && !addressConfirmed(account, body.confirm_address)) {
    throw Object.assign(new Error('Type the account email address to confirm switching to Sync. Sync follows the server: local copies of mail deleted on the server, and mail outside the chosen windows, are removed from UniHub.'),
      { status: 400, requiresConfirmation: true });
  }
  if (changed && mode === 'download' && requestedDelete) fail('Save Download mode first, then explicitly enable server deletion if wanted.');
  const deleteSettingProvided = changed || mode === 'sync' || Object.hasOwn(body, 'delete_emails_on_server');
  return { mode: mode as string, changed, deleteSettingProvided, deleteEnabled: mode === 'download' && !changed && (deleteSettingProvided ? requestedDelete : enabled(account?.delete_emails_on_server)) };
}
function addressConfirmed(account: MailAccountIdentity | null | undefined, typed: unknown) {
  const expected = String(account?.email_address || '').trim().toLowerCase();
  return !!expected && typeof typed === 'string' && typed.trim().toLowerCase() === expected;
}


// UID namespaces belong to one provider mailbox, not merely its display address.
function sameProviderMailbox(left: MailAccountIdentity, right: MailAccountIdentity) {
  const host = (value: unknown) => String(value || '').trim().toLowerCase();
  const login = (account: MailAccountIdentity) => String(account.username || account.email_address || '').trim();
  return host(left.imap_host) === host(right.imap_host)
    && Number(left.imap_port || 993) === Number(right.imap_port || 993)
    && login(left) === login(right)
    && host(left.email_address) === host(right.email_address);
}
export = { mailAccountModeChange, addressConfirmed, sameProviderMailbox };
