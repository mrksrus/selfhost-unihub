import type { MailAccountIdentity } from '../types';
import type { PolicyActor } from './settings';
import type { EffectivePolicy, PolicyKey } from '../contracts/policies';

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
type ModeChange = ReturnType<typeof mailAccountModeChange>;

// The data-safety policies of a mail account's mode (F13), which depend on
// the body and so are checked here rather than at the request boundary. An
// existing account keeps the mode and switch it has whatever the policies
// say now (D39): only a change to them is refused. An administrator acting
// for the person (actor.adminId) is not stopped.

type PolicyOf = <K extends PolicyKey>(key: K) => EffectivePolicy<K>;

/**
 * A new account's body under the policies for new accounts: a mode that
 * new accounts must use (mail.mode.new_accounts) and a required deletion at
 * the provider (mail.provider_delete) are filled in where the body names
 * none, and a body that names another is refused.
 */
function newAccountInput<T extends Record<string, unknown>>(policy: PolicyOf, body: T): T {
  const { policyForbids } = require('./settings') as typeof import('./settings');
  const next: Record<string, unknown> = { ...body };
  const forced = policy('mail.mode.new_accounts');
  if (forced.value !== 'user_choice') {
    const mode = forced.value === 'sync' ? 'sync' : 'download';
    const deleting = forced.value === 'download_delete';
    if (next.sync_mode !== undefined && next.sync_mode !== mode) throw policyForbids('mail.mode.new_accounts', forced.reason!);
    if (deleting && Object.hasOwn(next, 'delete_emails_on_server') && !enabled(next.delete_emails_on_server)) throw policyForbids('mail.mode.new_accounts', forced.reason!);
    next.sync_mode = mode;
    if (deleting) next.delete_emails_on_server = true;
  }
  const deletion = policy('mail.provider_delete');
  if (deletion.value === 'required' && (next.sync_mode ?? 'download') === 'download') {
    if (Object.hasOwn(next, 'delete_emails_on_server') && !enabled(next.delete_emails_on_server)) throw policyForbids('mail.provider_delete', deletion.reason!);
    next.delete_emails_on_server = true;
  }
  return next as T;
}

async function modePolicyInput<T extends Record<string, unknown>>(userId: string, body: T, { adminId }: PolicyActor = {}): Promise<T> {
  if (adminId) return body;
  const { resolvePolicies } = require('./settings') as typeof import('./settings');
  const policies = await resolvePolicies(userId);
  return newAccountInput(key => policies[key], body);
}

/**
 * At a new account's final check (final-step.ts), with the policies read
 * under the rules lock: the mode and provider deletion it was prepared with
 * must meet what those policies require now. A policy saved meanwhile that
 * forces another mode or requires deletion is refused with POLICY_FORBIDS
 * and its reason; sent again, the request is filled in by it. A policy
 * relaxed meanwhile refuses nothing: the prepared values are still allowed,
 * only no longer the default. (Allowed modes, and deletion allowed at all,
 * are the final check's policy keys, modePolicyKeys.) An administrator's
 * actor is not stopped.
 */
function assertNewAccountMode(policy: PolicyOf, prepared: ModeChange, { adminId }: PolicyActor = {}) {
  if (adminId) return;
  const { policyForbids } = require('./settings') as typeof import('./settings');
  const refuse = (key: 'mail.mode.new_accounts' | 'mail.provider_delete', reason: string | null | undefined) => policyForbids(key, reason ?? 'Your administrator does not allow this.');
  const forced = policy('mail.mode.new_accounts');
  if (forced.value !== 'user_choice') {
    const mode = forced.value === 'sync' ? 'sync' : 'download';
    if (prepared.mode !== mode || (forced.value === 'download_delete' && !prepared.deleteEnabled)) throw refuse('mail.mode.new_accounts', forced.reason);
  }
  const deletion = policy('mail.provider_delete');
  if (deletion.value === 'required' && prepared.mode === 'download' && !prepared.deleteEnabled) throw refuse('mail.provider_delete', deletion.reason);
}

/**
 * Refuses with POLICY_FORBIDS a new account in a mode that is not allowed,
 * a switch to such a mode, and turning deletion at the provider on while it
 * is not allowed. Turning it off, and every other change, stays possible.
 */
// The policies a new account or a change of `account` needs: its mode, and
// provider deletion turned on. Asked early (assertModeAllowed) and again in
// the transaction that writes it (final-step.ts).
function modePolicyKeys(account: MailAccountIdentity | null | undefined, change: ModeChange) {
  const keys: ('mail.mode.download' | 'mail.mode.sync' | 'mail.provider_delete')[] = [];
  if (!account || change.changed) keys.push(change.mode === 'sync' ? 'mail.mode.sync' : 'mail.mode.download');
  if (change.deleteEnabled && !(account && enabled(account.delete_emails_on_server))) keys.push('mail.provider_delete');
  return keys;
}

async function assertModeAllowed(userId: string, account: MailAccountIdentity | null | undefined, change: ModeChange, actor: PolicyActor = {}) {
  const { assertAllowed } = require('./settings') as typeof import('./settings');
  await assertAllowed(userId, modePolicyKeys(account, change), actor);
}

export { mailAccountModeChange, addressConfirmed, sameProviderMailbox, modePolicyInput, assertModeAllowed, modePolicyKeys, assertNewAccountMode };
