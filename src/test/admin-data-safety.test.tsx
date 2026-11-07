import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { api } from '@/lib/api';
import AdminPolicies from '@/pages/AdminPolicies';
import AdminInstanceBackup from '@/pages/AdminInstanceBackup';
import AdminUserDetail from '@/pages/AdminUserDetail';
import AdminUsers from '@/pages/AdminUsers';
import { SessionQueryProvider } from '@/components/SessionQueryProvider';
import { AuthContext, type AuthContextType } from '@/contexts/auth-context';
import { AdminMailAccountDialog } from '@/components/admin/AdminAccountDialogs';
import type { AdminPoliciesResponse } from '@/lib/admin-api';
import type { InstanceBackupStatus } from '@/lib/instance-backup-api';
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
  enabled: false, missing: ['destination', 'key'], destination: null, key_fingerprint: null, time_utc: '03:30', keep: 14, next_run_at: null, last_run: null, last_success: null,
  kept: { count: 0, bytes: 0 }, running: false, runs: [], restore_command: 'node /app/api/dist/scripts/instance-restore.js --file <backup.uhib> --key-file <key>', ...fields,
});
const USERS = [{ id: 'user-admin', email: 'admin@example.com', full_name: 'Avery Admin', role: 'admin', is_active: true, created_at: '2026-01-01T00:00:00.000Z' },
  { id: 'user-alex', email: 'alex@example.com', full_name: 'Alex Example', role: 'user', is_active: true, two_factor_enabled: true, created_at: '2026-01-02T00:00:00.000Z' },
  { id: 'user-blair', email: 'blair@example.com', full_name: 'Blair Example', role: 'user', is_active: true, created_at: '2026-01-03T00:00:00.000Z' }];
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
    if (path === '/admin/users/user-blair/accounts') return { data: { user_id: 'user-blair', mail_accounts: [], calendar_accounts: [] } };
    if (path === '/admin/users/user-blair/backups') return { data: { jobs: [] } };
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

describe('Server settings → Policies: the bin\'s minimum (D34)', () => {
  it('greys the minimum out until the bin rule forbids deleting, then saves it with the bin rule', { timeout: 20_000 }, async () => {
    const withMinimum = (values: Record<string, unknown> = {}) => {
      const answer = adminPolicies();
      (answer.policies as Record<string, unknown>)['bin.min_retention'] = { value: 'forever', source: 'default', default: 'forever', values: ['30', '90', 'forever'], effect: 'The automatic purge waits at least this long.' };
      for (const [key, value] of Object.entries(values)) answer.policies[key as keyof typeof answer.policies] = { ...answer.policies[key as keyof typeof answer.policies], value, source: 'policy' } as never;
      return answer;
    };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/policies') return { data: withMinimum() };
      if (path === '/policies/effective') return policiesAnswer();
      throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(api.put).mockImplementation(async (path: string, body: unknown) => path === '/admin/policies' ? { data: withMinimum((body as { values: Record<string, unknown> }).values) } : { data: {} });
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
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/policies', { values: { 'bin.delete': 'forbidden', 'bin.min_retention': '90' }, current_password: 'admin-pw' }));
  });

  it('shows the minimum greyed out with the reason on a server without it', async () => {
    mountSignedIn(<AdminPolicies />, { user: ADMIN });
    const minimum = await screen.findByRole('combobox', { name: 'Deleted items are kept at least' });
    expect(minimum).toBeDisabled();
    expect(screen.getByText(/This server does not offer a minimum yet/)).toBeInTheDocument();
    // D36 reads as a minimum.
    expect(screen.getByRole('combobox', { name: 'Keep users\' backups at least' })).toHaveTextContent('No minimum (default)');
  });
});

describe('Server settings → Instance backup', () => {
  // D35: the schedule is set here with the administrator's password; destination and key stay read-only.
  it('saves the schedule with the administrator\'s password and shows the time in their zone too', { timeout: 20_000 }, async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/admin/instance-backup') return { data: instanceStatus({ enabled: true, missing: [], destination: '/backups', key_fingerprint: 'k1' }) };
      throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(api.put).mockImplementation(async (path: string, body: unknown) => {
      if (path === '/admin/instance-backup/schedule') { const { time_utc, keep } = body as { time_utc: string; keep: number }; return { data: instanceStatus({ enabled: true, missing: [], destination: '/backups', key_fingerprint: 'k1', time_utc, keep }) }; }
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
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/instance-backup/schedule', { time_utc: '22:15', keep: 7, current_password: 'admin-pw' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('22:15 UTC')).toBeInTheDocument();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Schedule saved' }));
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
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/between 1 and 365/);
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
    expect(within(confirm).getByText(/before the time your rule keeps it/)).toBeInTheDocument();
    fireEvent.change(within(confirm).getByLabelText('Your password'), { target: { value: 'admin-pw' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete backup' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/admin/users/user-alex/backups/bk-1', { current_password: 'admin-pw' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a calendar account' });
    expect(within(dialog).getByTestId('confirm-target')).toHaveTextContent('For Alex Example (alex@example.com)');
  });

  it('says when a person has nothing at all on this server', async () => {
    mountSignedIn(<AdminUserDetail />, { user: ADMIN, path: '/admin/users/user-blair', routePath: '/admin/users/:id' });
    expect(await screen.findByText(/Blair Example has no mail or calendar accounts and no backups on this server yet/)).toHaveAttribute('role', 'status');
  });

  it('removes a mail account with its mail after the administrator\'s password, and adds one with the person\'s fields', async () => {
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
      email_address: 'new@mail.example.com', username: 'new@mail.example.com', encrypted_password: 'mail-secret', imap_host: 'imap.example.com', smtp_host: 'smtp.example.com', sync_mode: 'sync', current_password: 'admin-pw',
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
