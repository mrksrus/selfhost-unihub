import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { api } from '@/lib/api';
import AdminPolicies from '@/pages/AdminPolicies';
import AdminInstanceBackup from '@/pages/AdminInstanceBackup';
import AdminUserDetail from '@/pages/AdminUserDetail';
import AdminUsers from '@/pages/AdminUsers';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { AuthContext, type AuthContextType } from '@/contexts/auth-context';
import { AdminMailAccountDialog } from '@/components/admin/AdminAccountDialogs';
import type { AdminPoliciesResponse } from '@/lib/admin-api';
import { instanceBackupQueryKey, type InstanceBackupStatus } from '@/lib/instance-backup-api';
import { DEFAULT_POLICY_VALUES, POLICY_KEYS } from '@/lib/policies-api';
import { ADMIN, mountSignedIn, policiesAnswer, stubBrowserApis, testClient } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-admin', email: 'admin@example.com', role: 'admin' } }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, modules: [], pages: [] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const VALUES: Record<string, unknown[]> = {
  'mail.mode.new_accounts': ['user_choice', 'download', 'download_delete', 'sync'], 'mail.provider_delete': ['user_choice', 'forbidden', 'required'],
  'backup.download_mail': ['user_choice', 'always'], 'backup.server_retention_days': [null, 30, 90, 365], 'accounts.admin_manage': ['available'],
};
const adminPolicies = (): AdminPoliciesResponse => ({
  revision: 3,
  policies: Object.fromEntries(POLICY_KEYS.map(key => [key, { value: DEFAULT_POLICY_VALUES[key], source: 'default', default: DEFAULT_POLICY_VALUES[key], values: VALUES[key] ?? ['allowed', 'forbidden'], effect: key === 'mail.mode.sync' ? 'Existing Sync accounts keep working.' : null }])) as AdminPoliciesResponse['policies'],
});
const instanceStatus = (fields: Partial<InstanceBackupStatus> = {}): InstanceBackupStatus => ({
  enabled: false, missing: ['destination', 'key'], destination: null, key_fingerprint: null, time_utc: '03:30', keep: 14, schedule_source: 'environment', schedule_defaults: { time_utc: '03:30', keep: 14 }, next_run_at: null, last_run: null, last_success: null,
  kept: { count: 0, bytes: 0 }, running: false, runs: [], restore_command: 'node /app/api/dist/scripts/instance-restore.js --file <backup.uhib> --key-file <key>', ...fields,
});
const USERS = [{ id: 'user-admin', email: 'admin@example.com', full_name: 'Avery Admin', role: 'admin', is_active: true, created_at: '2026-01-01T00:00:00.000Z' },
  { id: 'user-alex', email: 'alex@example.com', full_name: 'Alex Example', role: 'user', is_active: true, two_factor_enabled: true, created_at: '2026-01-02T00:00:00.000Z' },
  { id: 'user-blair', email: 'blair@example.com', full_name: 'Blair Example', role: 'user', is_active: true, created_at: '2026-01-03T00:00:00.000Z' }];
const BIN_ITEMS = [
  { id: 'bin-1', module: 'contacts', item_type: 'contact', title: 'Grace Hopper', reason: 'deleted', group_id: null, deleted_at: '2026-06-10T09:00:00.000Z', purge_after: '2026-07-10T09:00:00.000Z', provider: 'local', origin: null },
  { id: 'bin-2', module: 'calendar', item_type: 'event', title: 'Seed swap', reason: 'calendar_deleted', group_id: 'grp', deleted_at: '2026-06-11T09:00:00.000Z', purge_after: null, provider: 'local', origin: null },
  { id: 'bin-3', module: 'calendar', item_type: 'calendar', title: 'Garden club', reason: 'calendar_deleted', group_id: 'grp', deleted_at: '2026-06-11T09:00:00.000Z', purge_after: null, provider: 'local', origin: null },
];
const MAIL_ACCOUNT = { id: 'm1', email_address: 'alex@mail.example.com', display_name: null, provider: 'custom', sync_mode: 'sync', delete_emails_on_server: false, is_active: true, sync_status: 'ok', last_synced_at: null, disconnected_at: null };

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/policies') return { data: adminPolicies() };
    if (path === '/policies/effective') return policiesAnswer();
    if (path === '/admin/instance-backup') return { data: instanceStatus() };
    if (path === '/admin/users') return { data: { users: USERS } };
    if (path === '/admin/users/user-alex/accounts') return { data: { user_id: 'user-alex', mail_accounts: [MAIL_ACCOUNT], calendar_accounts: [] } };
    if (path === '/admin/users/user-alex/backups') return { data: { jobs: [] } };
    if (path === '/admin/users/user-alex/bin') return { data: { items: BIN_ITEMS, retention: '30' } };
    if (path === '/admin/users/user-blair/accounts') return { data: { user_id: 'user-blair', mail_accounts: [], calendar_accounts: [] } };
    if (path === '/admin/users/user-blair/backups') return { data: { jobs: [] } };
    if (path === '/admin/users/user-blair/bin') return { data: { items: [], retention: '30' } };
    throw new Error(`unexpected GET ${path}`);
  });
  vi.mocked(api.put).mockImplementation(async (path: string, body: unknown) => {
    if (path === '/admin/policies') {
      const answer = adminPolicies();
      for (const [key, value] of Object.entries((body as { values: Record<string, unknown> }).values)) answer.policies[key as keyof typeof answer.policies] = { ...answer.policies[key as keyof typeof answer.policies], value, source: 'policy' } as never;
      return { data: answer };
    }
    return { data: {} };
  });
  vi.mocked(api.post).mockResolvedValue({ data: { account: MAIL_ACCOUNT } });
  vi.mocked(api.delete).mockResolvedValue({ data: { deleted: 1 } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Server settings → Policies', () => {
  it('stages changes and saves only the changed keys with the administrator\'s password', { timeout: 20_000 }, async () => {
    mountSignedIn(<AdminPolicies />, { user: ADMIN });
    const create = await screen.findByRole('combobox', { name: 'Creating backups' });
    expect(create).toHaveTextContent('Allowed (default)');
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    fireEvent.click(create);
    fireEvent.click(await screen.findByRole('option', { name: 'Not allowed' }));
    const bar = await screen.findByRole('region', { name: 'Unsaved changes' });
    expect(bar).toHaveTextContent('1 rule changed');
    // The effect of a non-default value shows under its row.
    fireEvent.click(screen.getByRole('combobox', { name: 'Sync mode' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Not allowed' }));
    expect(screen.getByText(/Existing Sync accounts keep working/)).toBeInTheDocument();
    expect(bar).toHaveTextContent('2 rules changed');
    fireEvent.click(within(bar).getByRole('button', { name: 'Save changes…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the changed rules?' });
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/policies', { values: { 'backup.create': 'forbidden', 'mail.mode.sync': 'forbidden' }, current_password: 'admin-pw' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument());
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Policies saved' }));
  });

  // No longer an administrator (403 ADMIN_REQUIRED, caller-proof): nothing was saved; a word, the session read again, and out of the admin screens.
  it('a save refused because the caller is no longer an administrator leaves the admin screen with a word', { timeout: 20_000 }, async () => {
    vi.mocked(api.put).mockResolvedValueOnce({ error: 'Only an administrator can do this; nothing was changed.', status: 403, code: 'ADMIN_REQUIRED' } as never);
    const retrySession = vi.fn(async () => {});
    mountSignedIn(<Routes><Route path="/settings/admin/policies" element={<AdminPolicies />} /><Route path="/settings" element={<p>Settings home</p>} /></Routes>,
      { user: ADMIN, path: '/settings/admin/policies', auth: { retrySession } });
    const create = await screen.findByRole('combobox', { name: 'Creating backups' });
    fireEvent.click(create);
    fireEvent.click(await screen.findByRole('option', { name: 'Not allowed' }));
    const bar = await screen.findByRole('region', { name: 'Unsaved changes' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Save changes…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the changed rules?' });
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "You're no longer an administrator." })));
    expect(await screen.findByText('Settings home', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(retrySession).toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Policies saved' }));
  });

  it('the administrator\'s password leaves the mutation cache once the save is answered', { timeout: 20_000 }, async () => {
    const client = testClient();
    mountSignedIn(<AdminPolicies />, { user: ADMIN, client });
    fireEvent.click(await screen.findByRole('combobox', { name: 'Creating backups' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Not allowed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const variables = () => client.getMutationCache().getAll().map(mutation => JSON.stringify(mutation.state.variables ?? null));
    await waitFor(() => expect(variables().join(' ')).not.toContain('admin-pw'));
  });
});

describe('Server settings → Policies: the bin\'s minimum', () => {
  it('greys the minimum out until the bin rule forbids deleting, then saves it with the bin rule', { timeout: 20_000 }, async () => {
    const withMinimum = (values: Record<string, unknown> = {}, minimum: '30' | '90' | 'forever' = 'forever') => {
      const answer = adminPolicies() as AdminPoliciesResponse & { bin_min_retention: unknown };
      for (const [key, value] of Object.entries(values)) answer.policies[key as keyof typeof answer.policies] = { ...answer.policies[key as keyof typeof answer.policies], value, source: 'policy' } as never;
      answer.bin_min_retention = { value: minimum, source: minimum === 'forever' ? 'default' : 'policy', default: 'forever', values: ['30', '90', 'forever'], applies: answer.policies['bin.delete'].value === 'forbidden', effect: 'The automatic purge waits at least this long.' };
      return answer;
    };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/policies') return { data: withMinimum() };
      if (path === '/policies/effective') return policiesAnswer();
      throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(api.put).mockImplementation(async (path: string, body: unknown) => {
      const { values, bin_min_retention } = body as { values: Record<string, unknown>; bin_min_retention?: '30' | '90' | 'forever' };
      return path === '/admin/policies' ? { data: withMinimum(values, bin_min_retention) } : { data: {} };
    });
    mountSignedIn(<AdminPolicies />, { user: ADMIN });
    const minimum = await screen.findByRole('combobox', { name: 'Deleted items are kept at least' });
    expect(minimum).toBeDisabled();
    expect(minimum).toHaveTextContent('Until restored (default)');
    expect(screen.getByText(/Applies once "Users may empty the bin or delete for good" is not allowed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Users may empty the bin or delete for good' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Not allowed' }));
    await waitFor(() => expect(minimum).toBeEnabled());
    fireEvent.click(minimum);
    fireEvent.click(await screen.findByRole('option', { name: '90 days' }));
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('2 rules changed');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save the changed rules?' });
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/policies', { values: { 'bin.delete': 'forbidden' }, bin_min_retention: '90', current_password: 'admin-pw' }));
    // Saved: the row shows the server's answer and the bar is gone.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'Deleted items are kept at least' })).toHaveTextContent('90 days');
  });

  it('shows the minimum greyed out with the reason on a server without it', async () => {
    mountSignedIn(<AdminPolicies />, { user: ADMIN });
    const minimum = await screen.findByRole('combobox', { name: 'Deleted items are kept at least' });
    expect(minimum).toBeDisabled();
    expect(screen.getByText(/This server does not offer a minimum yet/)).toBeInTheDocument();
    // backup.server_retention_days reads as a minimum.
    expect(screen.getByRole('combobox', { name: 'Keep users\' backups at least' })).toHaveTextContent('No minimum (default)');
  });
});

describe('Server settings → Instance backup', () => {
  // The instance backup schedule is set here with the administrator's password; destination and key stay read-only.
  it('saves the schedule with the administrator\'s password and shows the time in their zone too', { timeout: 20_000 }, async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/instance-backup') return { data: instanceStatus({ enabled: true, missing: [], destination: '/backups', key_fingerprint: 'k1' }) };
      throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(api.put).mockImplementation(async (path: string, body: unknown) => {
      if (path === '/admin/instance-backup/settings') { const { time_utc, keep } = body as { time_utc: string; keep: number }; return { data: instanceStatus({ enabled: true, missing: [], destination: '/backups', key_fingerprint: 'k1', time_utc, keep, schedule_source: 'admin' }) }; }
      throw new Error(`unexpected PUT ${path}`);
    });
    mountSignedIn(<AdminInstanceBackup />, { user: ADMIN });
    expect(await screen.findByText('03:30 UTC')).toBeInTheDocument();
    // The browser's zone in tests is UTC: the local reading is the same clock time with its zone's name.
    expect(screen.getAllByText(/3:30.*(UTC|GMT|Universal).*for you/).length).toBeGreaterThan(0);
    // Destination and key cannot be edited: they are text, not inputs.
    expect(screen.queryByRole('textbox', { name: /Destination|Key/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change schedule…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the schedule?' });
    fireEvent.change(within(dialog).getByLabelText('Time (UTC)'), { target: { value: '22:15' } });
    fireEvent.change(within(dialog).getByLabelText('Backups kept'), { target: { value: '7' } });
    const save = within(dialog).getByRole('button', { name: 'Save schedule' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/instance-backup/settings', { time_utc: '22:15', keep: 7, current_password: 'admin-pw' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('22:15 UTC')).toBeInTheDocument();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Schedule saved' }));
  });

  // The status polls every three seconds while a backup runs. A changed answer
  // must leave the administrator's unsaved fields alone; Save sends what they typed.
  it('a status answer that arrives while the schedule is being edited leaves the typed values alone', { timeout: 20_000 }, async () => {
    let status = instanceStatus({ enabled: true, missing: [], destination: '/backups', key_fingerprint: 'k1', running: true });
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/instance-backup') return { data: status };
      throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(api.put).mockImplementation(async (path: string, body: unknown) => {
      if (path === '/admin/instance-backup/settings') { const { time_utc, keep } = body as { time_utc: string; keep: number }; return { data: instanceStatus({ ...status, time_utc, keep, schedule_source: 'admin' }) }; }
      throw new Error(`unexpected PUT ${path}`);
    });
    const client = testClient();
    mountSignedIn(<AdminInstanceBackup />, { user: ADMIN, client });
    fireEvent.click(await screen.findByRole('button', { name: 'Change schedule…' }, { timeout: 5000 }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the schedule?' });
    fireEvent.change(within(dialog).getByLabelText('Time (UTC)'), { target: { value: '22:15' } });
    fireEvent.change(within(dialog).getByLabelText('Backups kept'), { target: { value: '7' } });
    // The run finishes and the server reports another schedule (set by a second administrator meanwhile).
    status = instanceStatus({ ...status, running: false, time_utc: '04:00', keep: 21, schedule_source: 'admin' });
    await act(async () => { await client.refetchQueries({ queryKey: instanceBackupQueryKey }); });
    await waitFor(() => expect(screen.getByText('04:00 UTC')).toBeInTheDocument());
    expect(within(dialog).getByLabelText('Time (UTC)')).toHaveValue('22:15');
    expect(within(dialog).getByLabelText('Backups kept')).toHaveValue(7);
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/instance-backup/settings', { time_utc: '22:15', keep: 7, current_password: 'admin-pw' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Opened again, the fields start from what the server holds now.
    fireEvent.click(screen.getByRole('button', { name: 'Change schedule…' }));
    const again = await screen.findByRole('dialog', { name: 'Change the schedule?' });
    expect(within(again).getByLabelText('Time (UTC)')).toHaveValue('22:15');
    expect(within(again).getByLabelText('Backups kept')).toHaveValue(7);
  });

  it('a refused password empties the field and keeps the dialog open for another try', { timeout: 20_000 }, async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/instance-backup') return { data: instanceStatus({ enabled: true, missing: [], destination: '/backups', key_fingerprint: 'k1' }) };
      throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(api.put).mockResolvedValueOnce({ error: 'The password is not correct.', status: 403, code: 'ADMIN_PASSWORD_INCORRECT' });
    mountSignedIn(<AdminInstanceBackup />, { user: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: 'Change schedule…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the schedule?' });
    const password = within(dialog).getByLabelText('Your password');
    fireEvent.change(password, { target: { value: 'wrong-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not save the schedule', description: 'The password is not correct.' })));
    expect(screen.getByRole('dialog', { name: 'Change the schedule?' })).toBeInTheDocument();
    await waitFor(() => expect((password as HTMLInputElement).value).toBe(''));
    expect(within(dialog).getByRole('button', { name: 'Save schedule' })).toBeDisabled();
  });

  it('refuses an impossible number of kept backups before asking for the password', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/instance-backup') return { data: instanceStatus({ enabled: true, missing: [], destination: '/backups', key_fingerprint: 'k1' }) };
      throw new Error(`unexpected GET ${path}`);
    });
    mountSignedIn(<AdminInstanceBackup />, { user: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: 'Change schedule…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the schedule?' });
    fireEvent.change(within(dialog).getByLabelText('Backups kept'), { target: { value: '0' } });
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/between 1 and 1000/);
    expect(within(dialog).getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('says destination and key are not configured and where to set them', async () => {
    mountSignedIn(<AdminInstanceBackup />, { user: ADMIN });
    expect(await screen.findAllByText('Not configured')).toHaveLength(2);
    expect(screen.getByText(/set INSTANCE_BACKUP_DIR to a mount outside the uploads folder, then restart/)).toBeInTheDocument();
    expect(screen.getByText(/set INSTANCE_BACKUP_KEY or INSTANCE_BACKUP_KEY_FILE \(at least 32 random bytes\), then restart/)).toBeInTheDocument();
  });

  it('shows the server\'s restore command and says why a run was refused', { timeout: 20_000 }, async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/instance-backup') return { data: instanceStatus({ enabled: true, missing: [], destination: '/backups', key_fingerprint: 'k1', restore_command: 'node /app/api/dist/scripts/instance-restore.js --file <backup.uhib> --key-file <key>' }) };
      throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(api.post).mockResolvedValue({ error: 'Conflict', status: 409, code: 'INSTANCE_BACKUP_RUNNING' } as never);
    mountSignedIn(<AdminInstanceBackup />, { user: ADMIN });
    expect(await screen.findByText('node /app/api/dist/scripts/instance-restore.js --file <backup.uhib> --key-file <key>')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not start the backup', description: 'A backup is already running; it shows on the page when it finishes.' })), { timeout: 5000 });
  });

  it('says what is missing while off and starts a run while on', async () => {
    const { unmount } = mountSignedIn(<AdminInstanceBackup />, { user: ADMIN });
    expect(await screen.findByText(/Set INSTANCE_BACKUP_DIR and INSTANCE_BACKUP_KEY or INSTANCE_BACKUP_KEY_FILE/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled();
    unmount();

    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/instance-backup') return { data: instanceStatus({ enabled: true, missing: [], destination: '/backups', key_fingerprint: 'k1', next_run_at: '2026-06-16T03:30:00.000Z', kept: { count: 3, bytes: 3_000_000 },
        last_run: { id: 'run-1', trigger: 'schedule', actor_email: null, status: 'succeeded', file_name: 'unihub-instance-20260615T0330Z-0.28.0.uhib', size_bytes: 1_000_000, app_version: '0.28.0', error: null, started_at: '2026-06-15T03:30:00.000Z', finished_at: '2026-06-15T03:31:00.000Z' } }) };
      throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(api.post).mockResolvedValue({ data: { run: { id: 'run-2', trigger: 'manual', actor_email: 'admin@example.com', status: 'running', file_name: null, size_bytes: null, app_version: '0.28.0', error: null, started_at: '2026-06-15T09:30:00.000Z', finished_at: null } } });
    mountSignedIn(<AdminInstanceBackup />, { user: ADMIN });
    const run = await screen.findByRole('button', { name: 'Back up now' });
    expect(run).toBeEnabled();
    expect(screen.getByText('/backups')).toBeInTheDocument();
    expect(screen.getByText(/3 backups, 2.9 MB/)).toBeInTheDocument();
    fireEvent.click(run);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/instance-backup/run'));
  });
});

describe('Admin → Users → a person', () => {
  // The server knows no such person (404 USER_NOT_FOUND, 400 INVALID_USER_ID): back to the list, with a word.
  it('a person the server no longer knows sends the administrator back to the list', { timeout: 20_000 }, async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/users') return { data: { users: USERS } };
      if (path.startsWith('/admin/users/user-alex/')) return { error: 'User not found', status: 404, code: 'USER_NOT_FOUND' };
      if (path === '/policies/effective') return policiesAnswer();
      throw new Error(`unexpected GET ${path}`);
    });
    mountSignedIn(<Routes><Route path="/admin/users/:id" element={<AdminUserDetail />} /><Route path="/admin/users" element={<p>The list of users</p>} /></Routes>, { user: ADMIN, path: '/admin/users/user-alex' });
    expect(await screen.findByText('The list of users', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'This person no longer exists' }));
    cleanup();
    // A malformed id in the address is the same case.
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/users') return { data: { users: USERS } };
      if (path.startsWith('/admin/users/not-a-uuid/')) return { error: 'Invalid user id', status: 400, code: 'INVALID_USER_ID' };
      if (path === '/policies/effective') return policiesAnswer();
      throw new Error(`unexpected GET ${path}`);
    });
    mountSignedIn(<Routes><Route path="/admin/users/:id" element={<AdminUserDetail />} /><Route path="/admin/users" element={<p>The list of users</p>} /></Routes>, { user: ADMIN, path: '/admin/users/not-a-uuid' });
    expect(await screen.findByText('The list of users', {}, { timeout: 10_000 })).toBeInTheDocument();
  });

  // The admin path's calendar add proves the caller too: no longer an administrator (403 ADMIN_REQUIRED) leaves the admin screens with a word.
  it('adding a calendar for a person when the caller is no longer an administrator leaves the admin screen with a word', { timeout: 20_000 }, async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'Only an administrator can do this; nothing was changed.', status: 403, code: 'ADMIN_REQUIRED' } as never);
    const retrySession = vi.fn(async () => {});
    mountSignedIn(<Routes><Route path="/admin/users/:id" element={<AdminUserDetail />} /><Route path="/settings" element={<p>Settings home</p>} /></Routes>,
      { user: ADMIN, path: '/admin/users/user-alex', auth: { retrySession } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add calendar account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a calendar account' });
    fireEvent.change(within(dialog).getByLabelText('Address'), { target: { value: 'https://dav.example.org/' } });
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/users/user-alex/calendar-accounts', expect.objectContaining({ current_password: 'admin-pw' })));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "You're no longer an administrator." })));
    expect(await screen.findByText('Settings home', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(retrySession).toHaveBeenCalled();
  });

  it('a confirmation opened for one person closes when the page moves to another', { timeout: 20_000 }, async () => {
    let navigate!: NavigateFunction;
    function Page() { navigate = useNavigate(); return <AdminUserDetail />; }
    mountSignedIn(<Page />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    fireEvent.click((await screen.findAllByRole('button', { name: 'Delete all' }))[0]);
    expect(await screen.findByRole('dialog')).toHaveTextContent('Delete all contacts of Alex Example?');
    await act(async () => navigate('/admin/users/user-blair'));
    await screen.findByText(/Users · Blair Example/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a completion for one person leaves a dialog opened since for another untouched', { timeout: 20_000 }, async () => {
    let navigate!: NavigateFunction;
    function Page() { navigate = useNavigate(); return <AdminUserDetail />; }
    let answerAlex!: (value: unknown) => void;
    vi.mocked(api.post).mockImplementation((path: string) => path === '/admin/users/user-alex/mail-accounts' ? new Promise(resolve => { answerAlex = resolve; }) as never : Promise.resolve({ data: {} }) as never);
    mountSignedIn(<Page />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add mail account' }));
    const alexDialog = await screen.findByRole('dialog', { name: 'Add a mail account' });
    fireEvent.change(within(alexDialog).getByLabelText('Email address'), { target: { value: 'alex-new@mail.example.com' } });
    fireEvent.change(within(alexDialog).getByLabelText('Mail password'), { target: { value: 'mail-secret' } });
    fireEvent.change(within(alexDialog).getByLabelText('IMAP server'), { target: { value: 'imap.example.com' } });
    fireEvent.change(within(alexDialog).getByLabelText('SMTP server'), { target: { value: 'smtp.example.com' } });
    fireEvent.change(within(alexDialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(alexDialog).getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/users/user-alex/mail-accounts', expect.objectContaining({ email_address: 'alex-new@mail.example.com' })));
    // Alex's request is still running when the page moves to Blair and a form opens for them.
    await act(async () => navigate('/admin/users/user-blair'));
    await screen.findByText(/Users · Blair Example/);
    fireEvent.click(screen.getByRole('button', { name: 'Add mail account' }));
    const blairDialog = await screen.findByRole('dialog', { name: 'Add a mail account' });
    fireEvent.change(within(blairDialog).getByLabelText('Email address'), { target: { value: 'blair@mail.example.com' } });
    await act(async () => answerAlex({ data: { account: MAIL_ACCOUNT } }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail account added' })), { timeout: 5000 });
    expect(screen.getByRole('dialog', { name: 'Add a mail account' })).toBeInTheDocument();
    expect(within(blairDialog).getByLabelText('Email address')).toHaveValue('blair@mail.example.com');
  });

  it('sends the ports the administrator edited and leaves the rest of the account untouched', () => {
    const submitted = vi.fn();
    mountSignedIn(<AdminMailAccountDialog account={MAIL_ACCOUNT as never} open onClose={() => {}} pending={false} onSubmit={submitted} />);
    fireEvent.change(screen.getByLabelText('IMAP port'), { target: { value: '1993' } });
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({ imap_port: 1993 }), 'admin-pw');
    const change = submitted.mock.calls[0][0] as Record<string, unknown>;
    for (const key of ['smtp_port', 'imap_host', 'smtp_host', 'username', 'encrypted_password']) expect(change).not.toHaveProperty(key);
  });

  it('every confirmation and account dialog names the person it acts for', { timeout: 20_000 }, async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/users') return { data: { users: USERS } };
      if (path === '/admin/users/user-alex/accounts') return { data: { user_id: 'user-alex', mail_accounts: [], calendar_accounts: [] } };
      if (path === '/admin/users/user-alex/bin') return { data: { items: [], retention: '30' } };
      if (path === '/admin/users/user-alex/backups') return { data: { jobs: [{ id: 'bk-1', scope: 'full', status: 'ready', phase: 'done', progress: 100, cancel_requested: false, requested_sections: [], file_size: 1_000_000, file_sha256: 'x', content_type: 'application/vnd.unihub.backup', encryption_enabled: true, backup_uuid: 'u', recovery_password_available: false, recovery_password_revealed: true, server_unlock_available: true, keep_until: '2099-01-01T00:00:00.000Z', contents: null, error: null, created_at: '2026-06-01T10:00:00.000Z', updated_at: '2026-06-01T10:00:00.000Z', started_at: null, completed_at: '2026-06-01T10:05:00.000Z', downloaded_at: null }] } };
      if (path === '/policies/effective') return policiesAnswer();
      throw new Error(`unexpected GET ${path}`);
    });
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    // Nothing of theirs but a backup: the sections say so with their name.
    expect(await screen.findByText('Alex Example has no mail accounts.')).toBeInTheDocument();
    expect(screen.getByText('Alex Example has no calendar accounts.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this backup of Alex Example?' });
    expect(within(confirm).getByTestId('confirm-target')).toHaveTextContent('For Alex Example (alex@example.com)');
    // The administrator's path is not held by the minimum; the row shows no deadline, since the job's stored one may be stale.
    expect(within(confirm).getByText(/whatever the minimum your rule keeps it for/)).toBeInTheDocument();
    expect(screen.queryByText(/kept at least until/)).not.toBeInTheDocument();
    fireEvent.change(within(confirm).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete backup' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/users/user-alex/backups/bk-1', { current_password: 'admin-pw' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a calendar account' });
    expect(within(dialog).getByTestId('confirm-target')).toHaveTextContent('For Alex Example (alex@example.com)');
  });

  it('says when a person has nothing at all on this server', async () => {
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-blair', routePath: '/admin/users/:id' });
    expect(await screen.findByText(/Blair Example has no mail or calendar accounts, no backups on this server and nothing in their bin yet/)).toHaveAttribute('role', 'status');
    expect(screen.getByText('The bin of Blair Example is empty.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Empty bin' })).toBeDisabled();
  });

  it('shows the person\'s bin, a group as one row, and deletes one item for good with the administrator\'s password', { timeout: 20_000 }, async () => {
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    // The calendar and its event are one row, named by the calendar.
    expect(screen.getByText('Garden club')).toBeInTheDocument();
    expect(screen.queryByText('Seed swap')).not.toBeInTheDocument();
    expect(screen.getByText(/with 1 item/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Empty bin' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Grace Hopper for good' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Grace Hopper for good?' });
    expect(within(confirm).getByTestId('confirm-target')).toHaveTextContent('Alex Example (alex@example.com)');
    fireEvent.change(within(confirm).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/users/user-alex/bin/bin-1', { current_password: 'admin-pw' }));
  });

  // A group (a calendar with its events, a merge) is one row; deleting it for good must reach every member, not only the one that names it.
  it('deletes a grouped item for good member by member, with the password confirmed once', { timeout: 20_000 }, async () => {
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Garden club for good' }, { timeout: 10_000 }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Garden club for good?' });
    expect(confirm).toHaveTextContent('2 items of Alex Example are deleted for good');
    fireEvent.change(within(confirm).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '2 items deleted for good' })));
    // The calendar leads its group; its event follows, each through the one-item route with the same password.
    expect(vi.mocked(api.delete).mock.calls.map(call => call[0])).toEqual(['/admin/users/user-alex/bin/bin-3', '/admin/users/user-alex/bin/bin-2']);
    expect(vi.mocked(api.delete).mock.calls.every(call => (call[1] as { current_password: string }).current_password === 'admin-pw')).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete Garden club for good?' })).not.toBeInTheDocument());
  });

  it('a member refused after another was deleted: the notice counts both, shows the server\'s sentence, and the bin is read again', { timeout: 20_000 }, async () => {
    vi.mocked(api.delete).mockResolvedValueOnce({ data: { deleted: 1 } }).mockResolvedValueOnce({ status: 409, error: 'A restore of this person is running.', code: 'RESTORE_IN_PROGRESS' } as never);
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    const binReads = () => vi.mocked(api.get).mock.calls.filter(([path]) => path === '/admin/users/user-alex/bin').length;
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Garden club for good' }, { timeout: 10_000 }));
    const before = binReads();
    const confirm = await screen.findByRole('dialog', { name: 'Delete Garden club for good?' });
    fireEvent.change(within(confirm).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '1 of 2 items deleted for good', description: '1 item remains in the bin. A restore of this person is running.', variant: 'destructive',
    })));
    expect(api.delete).toHaveBeenCalledTimes(2);
    // The confirmation promised the whole group; what remains is read again and shown as the smaller group.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete Garden club for good?' })).not.toBeInTheDocument());
    await waitFor(() => expect(binReads()).toBeGreaterThan(before));
  });

  // The person's bin comes a page at a time (whole groups, up to 2,000 items); covered with network-mocked pages, an e2e with that many items would be too heavy.
  const INVALID = { status: 400, error: 'This link to older bin items is not valid. Load the bin again from the newest items.', code: 'BIN_INVALID' };
  const pagedBin = (refuse?: unknown) => {
    const gets = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (!path.startsWith('/admin/users/user-alex/bin')) return (gets as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest) as never;
      if (!path.includes('before=')) return { data: { items: [BIN_ITEMS[0]], retention: '30', next_cursor: 'cursor-1' } } as never;
      if (refuse) return refuse as never;
      return { data: { items: BIN_ITEMS.slice(1), retention: '30', next_cursor: null } } as never;
    });
  };
  const binReads = () => vi.mocked(api.get).mock.calls.filter(([path]) => path === '/admin/users/user-alex/bin').length;

  it('the bin shows its newest page with "Show older items", which appends the next page and goes on the last', { timeout: 20_000 }, async () => {
    pagedBin();
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByText('Garden club')).not.toBeInTheDocument();
    expect(screen.getByText('1 item shown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show older items' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/users/user-alex/bin?before=cursor-1', expect.anything()));
    expect(await screen.findByText('Garden club')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show older items' })).not.toBeInTheDocument();
    expect(screen.getByText('1 item', { exact: true })).toBeInTheDocument();
  });

  it('the bin reloads from the newest items when the server no longer accepts the cursor, with its sentence', { timeout: 20_000 }, async () => {
    pagedBin(INVALID);
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    const before = binReads();
    fireEvent.click(screen.getByRole('button', { name: 'Show older items' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not load older items', description: INVALID.error })));
    await waitFor(() => expect(binReads()).toBeGreaterThan(before));
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Show older items' })).toBeInTheDocument();
  });

  it('no longer an administrator in the middle of a group delete: the notice says what went, not "Nothing was changed"', { timeout: 20_000 }, async () => {
    vi.mocked(api.delete).mockResolvedValueOnce({ data: { deleted: 1 } }).mockResolvedValueOnce({ status: 403, error: 'Only an administrator may do this.', code: 'ADMIN_REQUIRED' } as never);
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Garden club for good' }, { timeout: 10_000 }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Garden club for good?' });
    fireEvent.change(within(confirm).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "You're no longer an administrator.", description: '1 of 2 items were deleted for good before; 1 item remains in the bin.',
    })));
    expect(state.toast).not.toHaveBeenCalledWith(expect.objectContaining({ description: 'Nothing was changed.' }));
  });

  it('a group delete whose session ends between two members sends no further member', { timeout: 20_000 }, async () => {
    let answer!: (value: unknown) => void;
    vi.mocked(api.delete).mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }) as never);
    const mounted = render(
      <AuthContext.Provider value={{ user: ADMIN, isOffline: false } as unknown as AuthContextType}>
        <SessionQueryProvider privateSession><MemoryRouter initialEntries={['/admin/users/user-alex']}><Routes><Route path="/admin/users/:id" element={<AdminUserDetail />} /></Routes></MemoryRouter></SessionQueryProvider>
      </AuthContext.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Garden club for good' }, { timeout: 10_000 }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Garden club for good?' });
    fireEvent.change(within(confirm).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/users/user-alex/bin/bin-3', { current_password: 'admin-pw' }));
    // The session ends (a sign-out, another account) while the first member's answer is on its way.
    mounted.unmount();
    state.toast.mockClear();
    await act(async () => answer({ data: { deleted: 1 } }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    // The second member is not sent under whatever session comes next; nothing is shown.
    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(state.toast).not.toHaveBeenCalled();
  });

  it('Show older items waits while the bin is read again after a delete, so the refresh is not lost', { timeout: 20_000 }, async () => {
    const gets = vi.mocked(api.get).getMockImplementation()!;
    let binReadsSeen = 0;
    let refetched!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (!path.startsWith('/admin/users/user-alex/bin')) return (gets as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest) as never;
      if (path.includes('before=')) return { data: { items: BIN_ITEMS.slice(1), retention: '30', next_cursor: null } } as never;
      binReadsSeen += 1;
      if (binReadsSeen === 1) return { data: { items: [BIN_ITEMS[0]], retention: '30', next_cursor: 'cursor-1' } } as never;
      // The read after the delete: held until the test lets it answer, without Grace (another newer item remains on the first page).
      return new Promise(resolve => { refetched = () => resolve({ data: { items: [{ ...BIN_ITEMS[0], id: 'bin-0', title: 'Ada Lovelace' }], retention: '30', next_cursor: 'cursor-1' } }); }) as never;
    });
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Grace Hopper for good' }, { timeout: 10_000 }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete Grace Hopper for good?' });
    fireEvent.change(within(confirm).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(binReadsSeen).toBe(2));
    // The confirmation is over (the delete succeeded); the bin is still being read again. The closing
    // dialog may still hide the page from assistive technology for a moment, hence `hidden`.
    const older = screen.getByRole('button', { name: 'Show older items', hidden: true });
    expect(older).toBeDisabled();
    fireEvent.click(older);
    await act(async () => refetched(undefined));
    await waitFor(() => expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument());
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('before='), expect.anything());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show older items', hidden: true })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Show older items', hidden: true }));
    expect(await screen.findByText('Garden club')).toBeInTheDocument();
  });

  it('a mail server that cannot be verified asks the administrator to trust it, then sends the fingerprints with their password again', { timeout: 20_000 }, async () => {
    const trust = { blocked: false, requiresConfirmation: true, requiresInsecureTls: true, warnings: ['The certificate is self-signed.'],
      assessments: { imap: { host: 'imap.example.com', port: 993, knownProvider: false, allowlisted: false, blocked: false }, smtp: { host: 'smtp.example.com', port: 587, knownProvider: false, allowlisted: false, blocked: false } },
      certificates: { imap: { fingerprint256: 'AA:BB', authorized: false, subject: { CN: 'imap.example.com' } }, smtp: { fingerprint256: 'CC:DD', authorized: false, subject: { CN: 'smtp.example.com' } } } };
    vi.mocked(api.post).mockResolvedValueOnce({ error: 'Review mail server authenticity before continuing.', status: 409, requiresHostTrustConfirmation: true, mailHostTrust: trust } as never)
      .mockResolvedValueOnce({ data: { account: MAIL_ACCOUNT } });
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    fireEvent.click(await screen.findByRole('button', { name: 'Add mail account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a mail account' });
    fireEvent.change(within(dialog).getByLabelText('Email address'), { target: { value: 'new@mail.example.com' } });
    fireEvent.change(within(dialog).getByLabelText('Mail password'), { target: { value: 'mail-secret' } });
    fireEvent.change(within(dialog).getByLabelText('IMAP server'), { target: { value: 'imap.example.com' } });
    fireEvent.change(within(dialog).getByLabelText('SMTP server'), { target: { value: 'smtp.example.com' } });
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add account' }));
    const ask = await screen.findByRole('dialog', { name: 'Trust this mail server?' });
    expect(within(ask).getByText(/AA:BB/)).toBeInTheDocument();
    expect(within(ask).getByText('The certificate is self-signed.')).toBeInTheDocument();
    expect(within(ask).getByTestId('confirm-target')).toHaveTextContent('Alex Example (alex@example.com)');
    // The password was dropped with the refused request: it is asked for again.
    fireEvent.change(within(ask).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(ask).getByRole('button', { name: 'Trust and save' }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/admin/users/user-alex/mail-accounts', expect.objectContaining({
      email_address: 'new@mail.example.com', accept_host_trust: true, trusted_imap_fingerprint256: 'AA:BB', trusted_smtp_fingerprint256: 'CC:DD', provider: 'custom', current_password: 'admin-pw',
    })));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Mail account added' })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('removes a mail account with its mail after the administrator\'s password, and adds one with the person\'s fields', { timeout: 20_000 }, async () => {
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-alex', routePath: '/admin/users/:id' });
    await screen.findByText('alex@mail.example.com');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Actions for alex@mail.example.com' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove with its mail' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove alex@mail.example.com with its mail?' });
    expect(within(confirm).getByRole('button', { name: 'Remove with its mail' })).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove with its mail' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/users/user-alex/mail-accounts/m1?purge=true', { current_password: 'admin-pw' }));

    fireEvent.click(screen.getByRole('button', { name: 'Add mail account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a mail account' });
    fireEvent.change(within(dialog).getByLabelText('Email address'), { target: { value: 'new@mail.example.com' } });
    fireEvent.change(within(dialog).getByLabelText('Mail password'), { target: { value: 'mail-secret' } });
    fireEvent.change(within(dialog).getByLabelText('IMAP server'), { target: { value: 'imap.example.com' } });
    fireEvent.change(within(dialog).getByLabelText('SMTP server'), { target: { value: 'smtp.example.com' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Sync/ }));
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add account' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/users/user-alex/mail-accounts', expect.objectContaining({
      email_address: 'new@mail.example.com', username: 'new@mail.example.com', encrypted_password: 'mail-secret', imap_host: 'imap.example.com', smtp_host: 'smtp.example.com', sync_mode: 'sync', provider: 'custom', current_password: 'admin-pw',
    })));
  });
});

describe('Users list', () => {
  it('a password-confirmed action answered after the session ended shows nothing of its target', { timeout: 20_000 }, async () => {
    let answer!: (value: unknown) => void;
    vi.mocked(api.post).mockImplementation(() => new Promise(resolve => { answer = resolve; }) as never);
    const mounted = render(
      <AuthContext.Provider value={{ user: ADMIN, isOffline: false } as unknown as AuthContextType}>
        <SessionQueryProvider privateSession><MemoryRouter><AdminUsers /></MemoryRouter></SessionQueryProvider>
      </AuthContext.Provider>,
    );
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Actions for alex@example.com' }, { timeout: 10_000 }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset 2FA' }));
    await screen.findByText('Reset 2FA for alex@example.com');
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset 2FA' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/users/user-alex/2fa/reset', { current_password: 'admin-pw' }));
    // The session ends (sign-out or another account) before the server answers.
    mounted.unmount();
    state.toast.mockClear();
    await act(async () => answer({ data: { message: 'reset' } }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(state.toast).not.toHaveBeenCalled();
  });
});
