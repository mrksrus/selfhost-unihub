import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import AdminGroups from '@/pages/AdminGroups';
import GroupPage from '@/pages/GroupPage';
import MyGroupsPage from '@/pages/MyGroupsPage';
import type { User } from '@/contexts/auth-context';
import { OWNER, SERVER_OWNER, mountSignedIn, person, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

// Groups (0.30) as their four kinds of viewer see them: an administrator
// (Server › Groups), the group's manager, a plain member, and someone
// outside it. The server decides what each gets (can_manage, 404); the page
// shows that and offers nothing more.

const state = vi.hoisted(() => ({ toast: vi.fn(), user: null as unknown, navigate: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: state.user, isOffline: false }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, modules: [], pages: [] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const SUPPORT = { id: 'grp-support', name: 'Support', description: 'Customer support, both shifts', member_count: 3, manager_count: 1, has_policies: true };
const FINANCE = { id: 'grp-finance', name: 'Finance', description: null, member_count: 1, manager_count: 0, has_policies: false };
const MEMBERS = [
  { id: 'user-alex', email: 'alex@example.com', full_name: 'Alex Example', role: 'manager', added_at: '2026-03-02T10:00:00.000Z' },
  { id: 'user-blair', email: 'blair@example.com', full_name: 'Blair Example', role: 'member', added_at: '2026-03-02T10:00:00.000Z' },
  { id: 'user-casey', email: 'casey@example.com', full_name: null, role: 'member', added_at: '2026-04-11T10:00:00.000Z' },
];
const PEOPLE = [person({ id: 'user-admin', email: 'admin@example.com' }), person({ id: 'user-alex', email: 'alex@example.com' }), person({ id: 'user-drew', email: 'drew@example.com', is_active: false, status: 'inactive' })];
/** Alex: no Server permission, manager of Support. */
const MANAGER: User = { ...OWNER, id: 'user-alex', email: 'alex@example.com', full_name: 'Alex Example', permissions: [], manages_groups: true };
const MEMBER: User = { ...OWNER, id: 'user-blair', email: 'blair@example.com', full_name: 'Blair Example', permissions: [], manages_groups: false };

const signInAs = (user: User) => { state.user = user; return user; };
const mountGroup = (user: User, { admin = false, id = 'grp-support' } = {}) => mountSignedIn(<GroupPage admin={admin} />, { user: signInAs(user), path: `${admin ? '/admin' : ''}/groups/${id}`, routePath: `${admin ? '/admin' : ''}/groups/:id` });

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/groups') return { data: { groups: [SUPPORT, FINANCE] } };
    if (path === '/admin/users') return { data: { users: PEOPLE } };
    if (path === '/groups') return { data: { groups: [{ ...SUPPORT, role: 'manager' }, { ...FINANCE, role: 'member' }] } };
    if (path === '/groups/grp-support') return { data: { group: SUPPORT, can_manage: true, members: MEMBERS } };
    if (path.startsWith('/groups/grp-support/candidates')) return { data: { people: [{ id: 'user-drew', email: 'drew@example.com', full_name: 'Drew Example' }, { id: 'user-erin', email: 'erin@example.com', full_name: null }] } };
    if (path === '/policies/effective') return policiesAnswer();
    throw new Error(`unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockResolvedValue({ data: { group: { ...FINANCE, id: 'grp-new', name: 'Night shift' } } });
  vi.mocked(api.put).mockResolvedValue({ data: { group: SUPPORT } });
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Server › Groups', () => {
  it('lists Everyone first with the active people, then each group with its members, managers and whether it sets rules', { timeout: 20_000 }, async () => {
    mountSignedIn(<AdminGroups />, { user: signInAs(SERVER_OWNER) });
    const list = await screen.findByRole('list', { name: 'Groups' }, { timeout: 10_000 });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // Everyone is the installation: its rules are the Policies page. Inactive people are not in it.
    await waitFor(() => expect(rows[0]).toHaveTextContent('2 people'));
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', '/admin/policies');
    expect(rows[1]).toHaveTextContent('Support');
    expect(rows[1]).toHaveTextContent('3 members, 1 manager, own rules');
    expect(rows[2]).toHaveTextContent('1 member, no manager');
    expect(within(rows[1]).getByRole('link')).toHaveAttribute('href', '/admin/groups/grp-support');
  });

  it('creates a group from its name and description', { timeout: 20_000 }, async () => {
    mountSignedIn(<AdminGroups />, { user: signInAs(SERVER_OWNER) });
    fireEvent.click(await screen.findByRole('button', { name: 'New group' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'New group' });
    const create = within(dialog).getByRole('button', { name: 'Create group' });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' Night shift ' } });
    fireEvent.click(create);
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/admin/groups', { name: 'Night shift', description: null }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Night shift created' })));
  });

  it('an administrator names a manager, removes a member after confirming, and deletes the group with their password', { timeout: 30_000 }, async () => {
    mountGroup(SERVER_OWNER, { admin: true });
    fireEvent.click(await screen.findByRole('switch', { name: 'Blair Example: manager' }, { timeout: 10_000 }));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/admin/groups/grp-support/managers/user-blair', { manager: true }));
    // Members link to their person page here.
    expect(screen.getByRole('link', { name: 'Alex Example' })).toHaveAttribute('href', '/admin/users/user-alex');

    fireEvent.click(screen.getByRole('button', { name: 'Remove casey@example.com' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Remove casey@example.com from Support?' });
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledExactlyOnceWith('/groups/grp-support/members/user-casey'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete group' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Support?' });
    // What goes with it is said before the password: its rules, so its members may get looser ones.
    expect(dialog).toHaveTextContent('which may be looser');
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-own-password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete group' }));
    await waitFor(() => expect(api.delete).toHaveBeenLastCalledWith('/admin/groups/grp-support', { current_password: 'admin-own-password' }));
  });
});

describe('a group for its manager, a member and a stranger', () => {
  it('the manager adds people found by name, keeping a tick while the search changes', { timeout: 30_000 }, async () => {
    mountGroup(MANAGER);
    fireEvent.click(await screen.findByRole('button', { name: 'Add people' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Add people to Support' });
    const add = within(dialog).getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /Drew Example/ }, { timeout: 5_000 }));
    fireEvent.change(within(dialog).getByLabelText('Name or email'), { target: { value: 'erin' } });
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/groups/grp-support/candidates?q=erin', expect.anything()), { timeout: 5_000 });
    expect(within(dialog).getByRole('checkbox', { name: /Drew Example/ })).toBeChecked();
    fireEvent.click(await within(dialog).findByRole('checkbox', { name: /erin@example.com/ }, { timeout: 5_000 }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 2 people' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledExactlyOnceWith('/groups/grp-support/members', { user_ids: ['user-drew', 'user-erin'] }));
  });

  it('the manager renames the group and removes members, but names no manager, removes none, sees no rules editor and cannot delete it', { timeout: 30_000 }, async () => {
    mountGroup(MANAGER);
    await screen.findByText('Blair Example', {}, { timeout: 10_000 });
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Rules' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete group' })).not.toBeInTheDocument();
    // A manager (themselves included) leaves only through an administrator.
    expect(screen.getByRole('button', { name: 'Remove Alex Example' })).toBeDisabled();
    expect(screen.getByText('Only an administrator removes a manager.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Blair Example' })).toBeEnabled();
    // No person page for a manager: names are not links into Server › People.
    expect(screen.queryByRole('link', { name: 'Blair Example' })).not.toBeInTheDocument();
    expect(screen.getByText(/This group has rules of its own/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename group' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Support');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Customer support' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/groups/grp-support', { name: 'Customer support', description: 'Customer support, both shifts' }));
  });

  it('a change the server refuses, because the manager was demoted meanwhile, shows its sentence and changes nothing here', { timeout: 20_000 }, async () => {
    vi.mocked(api.delete).mockResolvedValue({ error: 'You do not manage this group.', status: 403, code: 'GROUP_FORBIDDEN' });
    mountGroup(MANAGER);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Blair Example' }, { timeout: 10_000 }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not change the group', description: 'You do not manage this group.', variant: 'destructive' })));
  });

  it('a member who manages nothing sees the managers and no way to change the group', { timeout: 20_000 }, async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => path === '/policies/effective' ? policiesAnswer() : { data: { group: SUPPORT, can_manage: false, members: [MEMBERS[0]] } });
    mountGroup(MEMBER);
    expect(await screen.findByRole('heading', { name: 'Managers' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText('Alex Example')).toBeInTheDocument();
    for (const name of ['Add people', 'Rename', 'Delete group', 'Remove Alex Example']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('a group out of the person\'s sight reads as no such group', { timeout: 20_000 }, async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => path === '/policies/effective' ? policiesAnswer() : { error: 'Group not found', status: 404, code: 'GROUP_NOT_FOUND' });
    mountGroup(MEMBER, { id: 'grp-finance' });
    expect(await screen.findByText('No such group', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add people' })).not.toBeInTheDocument();
  });

  it('Your groups lists the person\'s groups with their role in each', { timeout: 20_000 }, async () => {
    mountSignedIn(<MyGroupsPage />, { user: signInAs(MANAGER) });
    const list = await screen.findByRole('list', { name: 'Your groups' }, { timeout: 10_000 });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('You manage it, 3 members');
    expect(within(rows[0]).getByRole('link')).toHaveAttribute('href', '/groups/grp-support');
    expect(rows[1]).toHaveTextContent('Member');
  });
});
