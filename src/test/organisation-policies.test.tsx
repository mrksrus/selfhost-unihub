import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import AdminPolicies from '@/pages/AdminPolicies';
import type { AdminPoliciesResponse } from '@/lib/admin-api';
import { DEFAULT_POLICY_VALUES, POLICY_KEYS } from '@/lib/policies-api';
import { SERVER_OWNER, mountSignedIn, person, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

// Server › Policies by scope (0.30): Everyone or one group. A group's page
// offers only values at least as strict as Everyone's, names Everyone's
// beside each row, and gives a rule up by choosing Everyone's value. Saving
// "two-factor authentication required" first says whom it reaches.

const state = vi.hoisted(() => ({ toast: vi.fn(), user: null as unknown }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: state.user, isOffline: false }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, modules: [], pages: [] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const VALUES: Record<string, unknown[]> = {
  'mail.mode.new_accounts': ['user_choice', 'download', 'download_delete', 'sync'], 'mail.provider_delete': ['user_choice', 'forbidden', 'required'],
  'backup.download_mail': ['user_choice', 'always'], 'backup.server_retention_days': [null, 30, 90, 365], 'accounts.admin_manage': ['available'],
  'app_lock.required': [[]], 'app_lock.max_background': ['none', '900', '300', '60', '0'],
  'auth.two_factor': ['optional', 'required'], 'auth.password_min_length': [12, 14, 16, 20], 'auth.session_max_days': ['none', '30', '14', '7', '1'], 'notifications.detail': ['full', 'sender', 'none'],
};
type Policies = AdminPoliciesResponse['policies'];
/** Everyone's answer, with these keys set. */
function everyone(set: Record<string, unknown> = {}, extra: Record<string, object> = {}): AdminPoliciesResponse {
  return { revision: 3, policies: Object.fromEntries(POLICY_KEYS.map(key => [key, {
    value: key in set ? set[key] : DEFAULT_POLICY_VALUES[key], source: key in set ? 'policy' : 'default', default: DEFAULT_POLICY_VALUES[key], values: VALUES[key] ?? ['allowed', 'forbidden'],
    effect: key === 'auth.two_factor' ? 'People without two-factor authentication have 7 days to set it up; then they can use nothing else until they do.' : null, ...extra[key],
  }])) as Policies };
}
/** A group's answer as the server gives it: its own value or Everyone's, `default` Everyone's, only values at least as strict. */
function ofGroup(base: AdminPoliciesResponse, set: Record<string, unknown> = {}): AdminPoliciesResponse {
  return { ...base, policies: Object.fromEntries(Object.entries(base.policies).map(([key, policy]) => {
    const from = Math.max(0, (policy.values as unknown[]).findIndex(value => JSON.stringify(value) === JSON.stringify(policy.value)));
    return [key, { ...policy, default: policy.value, value: key in set ? set[key] : policy.value, source: key in set ? 'policy' : 'default', values: key === 'mail.mode.new_accounts' ? policy.values : (policy.values as unknown[]).slice(from) }];
  })) as Policies };
}
const SUPPORT = { id: 'grp-support', name: 'Support', description: null, member_count: 3, manager_count: 1, has_policies: true };
const FINANCE = { id: 'grp-finance', name: 'Finance', description: null, member_count: 1, manager_count: 0, has_policies: false };
const inSupport = [{ id: 'grp-support', name: 'Support', role: 'member' as const }];
const PEOPLE = [
  person({ id: 'user-admin', email: 'admin@example.com', full_name: 'Avery Admin', role: 'owner', two_factor_enabled: true }),
  person({ id: 'user-alex', email: 'alex@example.com', full_name: 'Alex Example', groups: inSupport }),
  person({ id: 'user-blair', email: 'blair@example.com', full_name: 'Blair Example', groups: inSupport, two_factor_grace_ends_at: '2026-06-20T09:00:00.000Z' }),
  person({ id: 'user-casey', email: 'casey@example.com', full_name: 'Casey Example', groups: inSupport, two_factor_enabled: true }),
  person({ id: 'user-drew', email: 'drew@example.com', full_name: 'Drew Example' }),
  person({ id: 'user-gone', email: 'gone@example.com', is_active: false, status: 'inactive', groups: inSupport }),
];
let installation = everyone();
let support = ofGroup(installation);

const mount = (path = '/admin/policies') => { state.user = SERVER_OWNER; return mountSignedIn(<AdminPolicies />, { user: SERVER_OWNER, path, routePath: '/admin/policies' }); };
const choose = async (row: string, option: string | RegExp) => {
  fireEvent.click(screen.getByRole('combobox', { name: row }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
};
const save = async (title: string | RegExp) => {
  fireEvent.click(within(await screen.findByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save changes…' }));
  return screen.findByRole('dialog', { name: title });
};
const confirm = (dialog: HTMLElement) => {
  fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-own-password' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
};

beforeEach(() => {
  stubBrowserApis();
  installation = everyone();
  support = ofGroup(installation);
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/policies') return { data: installation };
    if (path === '/admin/groups/grp-support/policies') return { data: support };
    if (path === '/admin/groups') return { data: { groups: [SUPPORT, FINANCE] } };
    if (path === '/admin/users') return { data: { users: PEOPLE } };
    if (path === '/policies/effective') return policiesAnswer();
    throw new Error(`unexpected GET ${path}`);
  });
  vi.mocked(api.put).mockImplementation(async (path: string) => ({ data: path === '/admin/policies' ? installation : support }));
  vi.mocked(api.post).mockResolvedValue({ data: { acknowledged_revision: 3 } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Server › Policies by scope', () => {
  it('Everyone: the new rules are rows with their choices, and requiring two-factor authentication says whom it reaches before the password', { timeout: 40_000 }, async () => {
    mount();
    expect(await screen.findByRole('combobox', { name: 'Two-factor authentication' }, { timeout: 10_000 })).toHaveTextContent('Optional (default)');
    expect(screen.getByRole('combobox', { name: 'Shortest password' })).toHaveTextContent('12 characters (default)');
    expect(screen.getByRole('combobox', { name: 'Longest time signed in' })).toHaveTextContent('No limit (default)');
    expect(screen.getByRole('combobox', { name: 'Notifications show at most' })).toHaveTextContent('Everything (default)');
    for (const row of ['Mail', 'Calendar and ToDo', 'Contacts', 'Recordings and Music', 'Music page', 'Contacts on the phone', 'Offline reading']) {
      expect(screen.getByRole('combobox', { name: row })).toHaveTextContent('Allowed (default)');
    }
    await choose('Two-factor authentication', 'Required');
    // The server's effect of the chosen value shows under the row.
    expect(screen.getByText(/have 7 days to set it up; then they can use nothing else/)).toBeInTheDocument();
    await choose('Shortest password', '14 characters');
    const dialog = await save('Save the changed rules?');
    // Everyone active without it: Alex, Blair and Drew of five; Blair is already in their 7 days from another rule.
    const preview = within(dialog).getByTestId('two-factor-preview');
    expect(preview).toHaveTextContent('3 of 5 people this covers have no two-factor authentication.');
    expect(within(preview).getByRole('list', { name: 'Already in their 7 days' })).toHaveTextContent(/Blair Example: until (20 June|June 20)/);
    confirm(dialog);
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/admin/policies', { values: { 'auth.two_factor': 'required', 'auth.password_min_length': 14 }, current_password: 'admin-own-password' }));
  });

  it('Everyone: a rule a group makes stricter names the group, and a disagreement between groups is flagged', { timeout: 20_000 }, async () => {
    installation = everyone({}, {
      'auth.session_max_days': { groups: [{ id: 'grp-support', name: 'Support', value: '14' }] },
      'mail.mode.new_accounts': { conflict: true, groups: [{ id: 'grp-support', name: 'Support', value: 'download' }, { id: 'grp-finance', name: 'Finance', value: 'sync' }] },
    });
    mount();
    await screen.findByRole('combobox', { name: 'Longest time signed in' }, { timeout: 10_000 });
    expect(screen.getByText('Stricter in Support (14 days).')).toBeInTheDocument();
    expect(screen.getByText('Stricter in Support (Download), Finance (Sync).')).toBeInTheDocument();
    expect(screen.getByText('Some people are in groups that disagree here. For them, this value applies.')).toBeInTheDocument();
  });

  it('a group: only values at least as strict as Everyone\'s are offered, Everyone\'s is named, and a save sends the group\'s values', { timeout: 40_000 }, async () => {
    installation = everyone({ 'auth.session_max_days': '14', 'backup.delete': 'forbidden' });
    support = ofGroup(installation);
    mount('/admin/policies?group=grp-support');
    const sessions = await screen.findByRole('combobox', { name: 'Longest time signed in' }, { timeout: 10_000 });
    expect(screen.getByRole('combobox', { name: 'Rules for' })).toHaveTextContent('Support');
    expect(sessions).toHaveTextContent('14 days (as everyone)');
    expect(screen.getByText('Everyone: 14 days.')).toBeInTheDocument();
    fireEvent.click(sessions);
    // Looser than Everyone's 14 days is not there to choose.
    expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['14 days (as everyone)', '7 days', '1 day']);
    fireEvent.click(screen.getByRole('option', { name: '7 days' }));
    // Everyone already forbids deleting backups: the group has nothing looser to offer.
    fireEvent.click(screen.getByRole('combobox', { name: 'Deleting backups' }));
    expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['Not allowed (as everyone)']);
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });

    await choose('Two-factor authentication', 'Required');
    const dialog = await save('Save the changed rules of Support?');
    // The group's active members without it: Alex and Blair of three (the inactive one is not counted).
    expect(within(dialog).getByTestId('two-factor-preview')).toHaveTextContent('2 of 3 people this covers have no two-factor authentication.');
    confirm(dialog);
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/admin/groups/grp-support/policies', { values: { 'auth.session_max_days': '7', 'auth.two_factor': 'required' }, current_password: 'admin-own-password' }));
  });

  it('a group gives a rule up by choosing Everyone\'s value: the key is cleared, not set', { timeout: 30_000 }, async () => {
    support = ofGroup(installation, { 'offline.copies': 'forbidden', 'auth.two_factor': 'required' });
    mount('/admin/policies?group=grp-support');
    const offline = await screen.findByRole('combobox', { name: 'Offline reading' }, { timeout: 10_000 });
    expect(offline).toHaveTextContent('Not allowed');
    await choose('Offline reading', 'Allowed (as everyone)');
    await choose('Shortest password', '16 characters');
    confirm(await save('Save the changed rules of Support?'));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/admin/groups/grp-support/policies', { values: { 'auth.password_min_length': 16 }, clear: ['offline.copies'], current_password: 'admin-own-password' }));
  });

  it('the app lock of a group adds to what Everyone must lock and cannot take from it', { timeout: 30_000 }, async () => {
    installation = everyone({ 'app_lock.required': ['mail'] });
    support = ofGroup(installation);
    mount('/admin/policies?group=grp-support');
    const list = await screen.findByRole('list', { name: 'Required modules' }, { timeout: 10_000 });
    expect(within(list).getByRole('checkbox', { name: 'Mail' })).toBeChecked();
    expect(within(list).getByRole('checkbox', { name: 'Mail' })).toBeDisabled();
    fireEvent.click(within(list).getByRole('checkbox', { name: 'Contacts' }));
    confirm(await save('Save the changed rules of Support?'));
    await waitFor(() => expect(api.put).toHaveBeenCalledExactlyOnceWith('/admin/groups/grp-support/policies', { values: { 'app_lock.required': ['mail', 'contacts'] }, current_password: 'admin-own-password' }));
  });

  it('changing the scope starts from that scope\'s rules and drops the other\'s unsaved changes', { timeout: 30_000 }, async () => {
    mount();
    await screen.findByRole('combobox', { name: 'Offline reading' }, { timeout: 10_000 });
    await choose('Offline reading', 'Not allowed');
    expect(await screen.findByRole('region', { name: 'Unsaved changes' })).toBeInTheDocument();
    await choose('Rules for', /^Support/);
    await screen.findByText(/Rules for the members of Support/, {}, { timeout: 10_000 });
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Offline reading' })).toHaveTextContent('Allowed (as everyone)');
  });
});
