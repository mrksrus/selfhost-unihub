import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import AdminPolicies from '@/pages/AdminPolicies';
import AdminInstanceBackup from '@/pages/AdminInstanceBackup';
import AdminUserDetail from '@/pages/AdminUserDetail';
import type { AdminPoliciesResponse } from '@/lib/admin-api';
import type { InstanceBackupStatus } from '@/lib/instance-backup-api';
import { DEFAULT_POLICY_VALUES, POLICY_KEYS } from '@/lib/policies-api';
import { ADMIN, mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
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
  kept: { count: 0, bytes: 0 }, running: false, runs: [], ...fields,
});
const USERS = [{ id: 'user-admin', email: 'admin@example.com', full_name: 'Avery Admin', role: 'admin', is_active: true, created_at: '2026-01-01T00:00:00.000Z' },
  { id: 'user-alex', email: 'alex@example.com', full_name: 'Alex Example', role: 'user', is_active: true, created_at: '2026-01-02T00:00:00.000Z' }];
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
});

describe('Server settings → Instance backup', () => {
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
