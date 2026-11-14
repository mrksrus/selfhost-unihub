import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { copyText } from '@/lib/platform';
import AdminUsers from '@/pages/AdminUsers';
import AdminUserDetail from '@/pages/AdminUserDetail';
import type { User } from '@/contexts/auth-context';
import { ADMIN, SERVER_OWNER, mountSignedIn, person, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

// Server › People (0.30): the list, Add person with a setup link or an
// initial password, roles and what only the owner may do, and a person's
// groups and devices. The network is mocked; the rights come from the
// permissions the server gave the signed-in person.

const state = vi.hoisted(() => ({ toast: vi.fn(), user: null as unknown }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: state.user, isOffline: false }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, modules: [], pages: [] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/platform', async original => ({ ...(await original<typeof import('@/lib/platform')>()), copyText: vi.fn(async () => true) }));

const SUPPORT = { id: 'grp-support', name: 'Support' };
const FINANCE = { id: 'grp-finance', name: 'Finance' };
const PEOPLE = [
  person({ id: 'user-admin', email: 'admin@example.com', full_name: 'Avery Admin', role: 'owner', two_factor_enabled: true, last_active_at: '2026-06-15T08:00:00.000Z' }),
  person({ id: 'user-grace', email: 'grace@example.com', full_name: 'Grace Hopper', role: 'admin', two_factor_enabled: true }),
  person({ id: 'user-alex', email: 'alex@example.com', full_name: 'Alex Example', groups: [{ ...SUPPORT, role: 'manager' }, { ...FINANCE, role: 'member' }], two_factor_grace_ends_at: '2026-06-20T09:00:00.000Z' }),
  person({ id: 'user-blair', email: 'blair@example.com', full_name: 'Blair Example', groups: [{ ...SUPPORT, role: 'member' }], two_factor_enabled: true }),
  person({ id: 'user-casey', email: 'casey@example.com', full_name: 'Casey Example', status: 'invited' }),
  person({ id: 'user-drew', email: 'drew@example.com', full_name: 'Drew Example', status: 'inactive', is_active: false }),
];
const GROUPS = [
  { ...SUPPORT, description: null, member_count: 2, manager_count: 1, has_policies: true },
  { ...FINANCE, description: null, member_count: 1, manager_count: 0, has_policies: false },
];
const LINK = { url: 'https://unihub.example.com/invite#synthetic-token-0123456789', expires_at: '2026-06-22T09:30:00.000Z' };
const DEVICES = [
  { id: 'dev-phone', kind: 'android', app_version: '0.30.0', user_agent: 'Mozilla/5.0 (Linux; Android 16; Pixel 8a; wv) UniHubAndroid/0.30.0 (30000)', created_at: '2026-05-20T18:00:00.000Z', last_seen_at: '2026-06-15T07:10:00.000Z', lock: null, notifications: true },
  { id: 'dev-laptop', kind: 'web', app_version: null, user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', created_at: '2026-05-02T09:00:00.000Z', last_seen_at: '2026-06-14T09:00:00.000Z', lock: null, notifications: false },
];

function signInAs(user: User) { state.user = user; return user; }
const row = (name: string) => screen.getByRole('link', { name }).closest('li')!;
const openMenu = async (email: string) => {
  fireEvent.pointerDown(await screen.findByRole('button', { name: `Actions for ${email}` }, { timeout: 10_000 }), { button: 0, ctrlKey: false });
  return screen.findByRole('menu');
};
const typePassword = (scope: HTMLElement, value = 'admin-own-password') => fireEvent.change(within(scope).getByLabelText('Your password'), { target: { value } });

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/users') return { data: { users: PEOPLE } };
    if (path === '/admin/groups') return { data: { groups: GROUPS } };
    if (path === '/policies/effective') return policiesAnswer();
    if (/^\/admin\/users\/[^/]+\/devices$/.test(path)) return { data: { devices: DEVICES } };
    if (/^\/admin\/users\/[^/]+\/accounts$/.test(path)) return { data: { mail_accounts: [], calendar_accounts: [] } };
    if (/^\/admin\/users\/[^/]+\/backups$/.test(path)) return { data: { jobs: [] } };
    if (/^\/admin\/users\/[^/]+\/bin$/.test(path)) return { data: { items: [], retention: '30', next_cursor: null } };
    throw new Error(`unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockResolvedValue({ data: {} });
  vi.mocked(api.put).mockResolvedValue({ data: {} });
  vi.mocked(api.delete).mockResolvedValue({ data: { ended: 1 } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Server › People', () => {
  it('lists everyone with role, groups, sign-in and last activity, and filters by group', { timeout: 20_000 }, async () => {
    mountSignedIn(<AdminUsers />, { user: signInAs(SERVER_OWNER) });
    await screen.findByRole('link', { name: 'Alex Example' }, { timeout: 10_000 });
    expect(row('Avery Admin')).toHaveTextContent('(you)');
    expect(row('Avery Admin')).toHaveTextContent('Role: Owner');
    expect(row('Grace Hopper')).toHaveTextContent('Role: Administrator');
    expect(row('Alex Example')).toHaveTextContent('Groups: Support (manager), Finance');
    // Required two-factor authentication not set up yet: the day the 7 days end.
    expect(row('Alex Example')).toHaveTextContent(/Sign-in: 2FA due by (20 June|June 20)/);
    expect(row('Casey Example')).toHaveTextContent('Sign-in: Invited');
    expect(row('Drew Example')).toHaveTextContent('Sign-in: Inactive');
    expect(row('Drew Example')).toHaveTextContent('Last active: never');
    expect(screen.getByText('6 people on this server.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /^Finance/ }));
    expect(within(screen.getByRole('list', { name: 'People' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Alex Example' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^No group/ }));
    expect(screen.queryByRole('link', { name: 'Alex Example' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Casey Example' })).toBeInTheDocument();
  });

  it('adds a person with a setup link: the account is created with its groups and the link is shown once to copy', { timeout: 30_000 }, async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { user: person({ id: 'user-robin', email: 'robin@example.com', full_name: 'Robin Example', status: 'invited' }), setup_link: LINK } });
    mountSignedIn(<AdminUsers />, { user: signInAs(SERVER_OWNER) });
    fireEvent.click(await screen.findByRole('button', { name: 'Add person' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Add person' });
    const submit = within(dialog).getByRole('button', { name: 'Add person' });
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: ' robin@example.com ' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Robin Example' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Support' }));
    // The setup link is the default way in; nothing is sent without the administrator's own password.
    expect(within(dialog).getByRole('radio', { name: /^Setup link/ })).toBeChecked();
    expect(submit).toBeDisabled();
    typePassword(dialog);
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/users', { email: 'robin@example.com', full_name: 'Robin Example', role: 'user', group_ids: ['grp-support'], current_password: 'admin-own-password' }));

    const shown = await screen.findByRole('dialog', { name: 'Setup link for Robin Example' });
    expect(within(shown).getByRole('textbox', { name: 'Setup link' })).toHaveValue(LINK.url);
    expect(shown).toHaveTextContent(/It works once, until (22 June|June 22)/);
    expect(shown).toHaveTextContent('It is not shown again.');
    fireEvent.click(within(shown).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(LINK.url));
    expect(await within(shown).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    fireEvent.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText(LINK.url)).not.toBeInTheDocument());
  });

  it('adds a person with an initial password of the minimum length, and then shows no link', { timeout: 30_000 }, async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => path === '/policies/effective'
      ? policiesAnswer({ 'auth.password_min_length': { value: 14, allowed: true, reason: 'Passwords need at least 14 characters, as your administrator set.' } })
      : path === '/admin/groups' ? { data: { groups: [] } } : { data: { users: PEOPLE } });
    vi.mocked(api.post).mockResolvedValue({ data: { user: person({ id: 'user-robin', email: 'robin@example.com' }), setup_link: null } });
    mountSignedIn(<AdminUsers />, { user: signInAs(SERVER_OWNER) });
    fireEvent.click(await screen.findByRole('button', { name: 'Add person' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Add person' });
    fireEvent.change(within(dialog).getByLabelText('Email'), { target: { value: 'robin@example.com' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Initial password/ }));
    await within(dialog).findByText('At least 14 characters.');
    typePassword(dialog);
    const submit = within(dialog).getByRole('button', { name: 'Add person' });
    fireEvent.change(within(dialog).getByLabelText('Their password'), { target: { value: 'thirteen-char' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Their password'), { target: { value: 'fourteen-chars' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/users', { email: 'robin@example.com', full_name: null, role: 'user', group_ids: [], password: 'fourteen-chars', current_password: 'admin-own-password' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'robin@example.com added' })));
    expect(screen.queryByRole('dialog', { name: /Setup link/ })).not.toBeInTheDocument();
  });

  it('an administrator who is not the owner cannot make administrators, and the owner cannot be deactivated or deleted: greyed with the reason', { timeout: 30_000 }, async () => {
    mountSignedIn(<AdminUsers />, { user: signInAs({ ...ADMIN, id: 'user-grace', email: 'grace@example.com' }) });
    let menu = await openMenu('blair@example.com');
    const make = within(menu).getByRole('menuitem', { name: /Make administrator/ });
    expect(make).toHaveAttribute('aria-disabled', 'true');
    expect(make).toHaveTextContent('Only the owner makes or removes administrators.');
    fireEvent.keyDown(menu, { key: 'Escape' });

    menu = await openMenu('admin@example.com');
    for (const name of [/Deactivate/, /Delete person/]) {
      const entry = within(menu).getByRole('menuitem', { name });
      expect(entry).toHaveAttribute('aria-disabled', 'true');
      expect(entry).toHaveTextContent('The owner cannot be deactivated or deleted.');
    }
    // The owner's role has no entry at all: it changes only by handing ownership over.
    expect(within(menu).queryByRole('menuitem', { name: /^(Make administrator|Remove administrator rights)/ })).not.toBeInTheDocument();
    fireEvent.keyDown(menu, { key: 'Escape' });

    // The same in Add person: the Administrator role is there, greyed.
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add person' });
    expect(within(dialog).getByText('Only the owner makes administrators.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Role' }));
    expect(await screen.findByRole('option', { name: 'Administrator' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('a person without a password gets a new setup link with the administrator\'s password, and a live link can be revoked', { timeout: 30_000 }, async () => {
    // The server knew no origin for the request: the link is a path, completed with this page's origin.
    vi.mocked(api.post).mockResolvedValue({ data: { setup_link: { ...LINK, url: '/invite#synthetic-token-0123456789' } } });
    mountSignedIn(<AdminUsers />, { user: signInAs(SERVER_OWNER) });
    fireEvent.click(within(await openMenu('casey@example.com')).getByRole('menuitem', { name: 'New setup link' }));
    const confirm = await screen.findByRole('dialog', { name: 'New setup link for casey@example.com?' });
    expect(within(confirm).getByTestId('confirm-target')).toHaveTextContent('Casey Example (casey@example.com)');
    typePassword(confirm);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/users/user-casey/setup-link', { current_password: 'admin-own-password' }));
    const shown = await screen.findByRole('dialog', { name: 'Setup link for Casey Example' });
    expect(within(shown).getByRole('textbox', { name: 'Setup link' })).toHaveValue(`${window.location.origin}/invite#synthetic-token-0123456789`);
    fireEvent.click(within(shown).getByRole('button', { name: 'Done' }));

    fireEvent.click(within(await openMenu('casey@example.com')).getByRole('menuitem', { name: 'Revoke setup link' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledExactlyOnceWith('/admin/users/user-casey/setup-link'));
  });
});

describe('Server › People › a person', () => {
  const mountPerson = (id: string, user: User = SERVER_OWNER) => mountSignedIn(<AdminUserDetail />, { user: signInAs(user), path: `/admin/users/${id}`, routePath: '/admin/users/:id' });

  it('shows the role in words, the sign-in state, and the groups with who manages', { timeout: 20_000 }, async () => {
    mountPerson('user-alex');
    expect(await screen.findByText(/^Password only\. Two-factor authentication is required: they have until (20 June|June 20) to set it up\.$/, {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make administrator' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Support: manager' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Finance: manager' })).not.toBeChecked();
  });

  it('adds the person to a group, names them manager and removes them, each through its own route', { timeout: 30_000 }, async () => {
    mountPerson('user-blair');
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Add to group' }, { timeout: 10_000 }), { button: 0, ctrlKey: false });
    // Only the groups the person is not in yet are offered.
    expect(screen.queryByRole('menuitem', { name: 'Support' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Finance' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/groups/grp-finance/members', { user_ids: ['user-blair'] }));
    fireEvent.click(screen.getByRole('switch', { name: 'Support: manager' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/admin/groups/grp-support/managers/user-blair', { manager: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove from Support' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledExactlyOnceWith('/groups/grp-support/members/user-blair'));
  });

  it('a refused group change shows the server\'s sentence', { timeout: 20_000 }, async () => {
    vi.mocked(api.put).mockResolvedValue({ error: 'These rules cannot hold together for Blair Example: new accounts use Sync, which Support does not allow.', status: 400, code: 'POLICY_CONFLICT' });
    mountPerson('user-blair');
    fireEvent.click(await screen.findByRole('switch', { name: 'Support: manager' }, { timeout: 10_000 }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not change the groups', description: expect.stringContaining('cannot hold together for Blair Example'), variant: 'destructive' })));
  });

  it('lists the person\'s devices and signs one out, then all, with the administrator\'s password', { timeout: 30_000 }, async () => {
    mountPerson('user-alex');
    expect(await screen.findByText('UniHub app 0.30.0 on Android', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText('Firefox on Linux')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out UniHub app 0.30.0 on Android' }));
    let dialog = await screen.findByRole('dialog', { name: 'Sign out UniHub app 0.30.0 on Android?' });
    expect(within(dialog).getByTestId('confirm-target')).toHaveTextContent('Alex Example (alex@example.com)');
    expect(api.delete).not.toHaveBeenCalled();
    typePassword(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledExactlyOnceWith('/admin/users/user-alex/devices/dev-phone', { current_password: 'admin-own-password' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    vi.mocked(api.delete).mockResolvedValue({ data: { ended: 2 } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all' }));
    dialog = await screen.findByRole('dialog', { name: 'Sign out every device of Alex Example?' });
    typePassword(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out all' }));
    await waitFor(() => expect(api.delete).toHaveBeenLastCalledWith('/admin/users/user-alex/devices', { current_password: 'admin-own-password' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '2 devices signed out' })));
  });

  it('the owner hands ownership to an active administrator with their password; nobody else is offered it', { timeout: 30_000 }, async () => {
    mountPerson('user-admin');
    fireEvent.click(await screen.findByRole('button', { name: 'Hand over ownership…' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Hand over ownership?' });
    typePassword(dialog);
    const submit = within(dialog).getByRole('button', { name: 'Hand over ownership' });
    // A password alone is not enough: the new owner is chosen first.
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'New owner' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.click(screen.getByRole('option', { name: 'Grace Hopper (grace@example.com)' }));
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/owner/transfer', { user_id: 'user-grace', current_password: 'admin-own-password' }));
  });

  it('for an administrator, the owner\'s page offers no hand-over and greys Deactivate and Delete with the reason', { timeout: 20_000 }, async () => {
    mountPerson('user-admin', { ...ADMIN, id: 'user-grace', email: 'grace@example.com' });
    expect(await screen.findByText('The owner cannot be deactivated or deleted. They hand ownership to another administrator first.', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete person' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Hand over ownership…' })).not.toBeInTheDocument();
  });
});
