import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import DeleteDataSettings from '@/components/settings/DeleteDataSettings';
import { MailAccountModeSettings } from '@/components/mail/MailAccountModeSettings';
import { MailCalendarSettings } from '@/components/mail/MailCalendarSettings';
import type { MailAccount } from '@/lib/mail-api';
import { mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, modules: [], pages: [] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const REASON = 'Your administrator does not allow deleting data.';
const ACCOUNT_REASON = 'Your administrator does not allow deleting your UniHub account.';

beforeEach(() => { stubBrowserApis(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// F13, "the server decides, the client shows": a forbidden action stays on
// the page, greyed out with the server's reason, and the page never hides it.
describe('policy greying', () => {
  it('greys a forbidden control out with the reason, never hides it, and only once the rules are known', async () => {
    let answer!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/policies/effective') return new Promise(resolve => { answer = resolve; }) as never;
      throw new Error(`unexpected GET ${path}`);
    });
    mountSignedIn(<DeleteDataSettings />);
    const deleteAll = screen.getAllByRole('button', { name: 'Delete all' });
    const deleteAccount = screen.getByRole('button', { name: 'Delete account' });
    // Until the rules arrive, nothing is greyed: the server refuses a forbidden request anyway.
    expect(deleteAll[0]).toBeEnabled();
    expect(deleteAccount).toBeEnabled();
    answer(policiesAnswer({ 'data.clear': { value: 'forbidden', reason: REASON }, 'account.delete': { value: 'forbidden', reason: ACCOUNT_REASON } }));
    await waitFor(() => expect(deleteAccount).toBeDisabled());
    for (const button of screen.getAllByRole('button', { name: 'Delete all' })) expect(button).toBeDisabled();
    expect(screen.getAllByText(REASON).length).toBe(deleteAll.length);
    expect(screen.getByText(ACCOUNT_REASON)).toBeInTheDocument();
    // The rows stay: a greyed control is still a visible one.
    expect(screen.getByText('Contacts')).toBeInTheDocument();
  });

  // D41: deleting one's own account asks for the password again and sends it with the request.
  it('deleting your own account asks for your password and sends it', async () => {
    vi.mocked(api.get).mockResolvedValue(policiesAnswer());
    vi.mocked(api.delete).mockResolvedValue({ data: { deleted: true } });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mountSignedIn(<DeleteDataSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete your account?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete account' });
    expect(confirm).toBeDisabled();
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Your password'), { target: { value: 'my-own-password' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/settings/account', { current_password: 'my-own-password' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/auth'));
    vi.unstubAllGlobals();
  });

  it('keeps an allowed control usable when the rules fail to load', async () => {
    vi.mocked(api.get).mockResolvedValue({ error: 'Not reachable', status: 503 });
    mountSignedIn(<DeleteDataSettings />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/policies/effective', expect.anything()));
    expect(screen.getByRole('button', { name: 'Delete account' })).toBeEnabled();
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
  });

  it('greys a forbidden mail mode out with its reason and a forbidden provider deletion', async () => {
    const SYNC_REASON = 'Your administrator does not allow Sync mode for mail accounts.';
    const DELETE_REASON = 'Your administrator does not allow deleting mail at the provider.';
    vi.mocked(api.get).mockResolvedValue(policiesAnswer({
      'mail.mode.sync': { value: 'forbidden', reason: SYNC_REASON },
      'mail.provider_delete': { value: 'forbidden', reason: DELETE_REASON },
    }));
    const onModeChange = vi.fn();
    mountSignedIn(<MailAccountModeSettings mode="download" syncWindow={null} trashWindow={30} deleteOnServer={false} isNew
      onModeChange={onModeChange} onSyncWindowChange={() => {}} onTrashWindowChange={() => {}} onDeleteChange={() => {}} />);
    const sync = screen.getByRole('radio', { name: /^Sync/ });
    await waitFor(() => expect(sync).toBeDisabled());
    expect(screen.getByText(SYNC_REASON)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Download/ })).toBeEnabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByText(DELETE_REASON)).toBeInTheDocument();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('the linked calendar of a mail account follows accounts.remove and accounts.add', { timeout: 20_000 }, async () => {
    const REMOVE = 'Your administrator does not allow removing accounts.';
    const ADD = 'Your administrator does not allow adding accounts.';
    const account = { id: 'mail-a', email_address: 'a@example.com', provider: 'custom', is_active: true } as MailAccount;
    let link = { enabled: true, account: { id: 'cal-a', provider: 'caldav', is_active: true, sync_status: 'ok', last_synced_at: null, provider_config: {} }, calendars: [], event_count: 3, provider: null };
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/policies/effective') return policiesAnswer({ 'accounts.remove': { value: 'forbidden', reason: REMOVE }, 'accounts.add': { value: 'forbidden', reason: ADD } });
      if (path === '/mail/accounts/mail-a/calendar') return { data: { calendar: link } };
      throw new Error(`unexpected GET ${path}`);
    });
    // Turning the calendar off removes a calendar account.
    const on = mountSignedIn(<MailCalendarSettings account={account} />);
    const toggle = await screen.findByRole('switch', { name: 'Calendar' });
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(toggle).toBeChecked();
    expect(screen.getByText(REMOVE)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    on.unmount();
    // Turning it on adds one.
    link = { ...link, enabled: false, account: null as never, event_count: 0 };
    mountSignedIn(<MailCalendarSettings account={account} />);
    const connect = await screen.findByRole('button', { name: 'Connect calendar' });
    await waitFor(() => expect(connect).toBeDisabled());
    expect(screen.getByRole('switch', { name: 'Calendar' })).toBeDisabled();
    expect(screen.getByText(ADD)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a preset for new accounts selects the mode and locks the choice; an existing account keeps its mode', async () => {
    const PRESET = 'New mail accounts use Sync mode, as your administrator set.';
    vi.mocked(api.get).mockResolvedValue(policiesAnswer({ 'mail.mode.new_accounts': { value: 'sync', allowed: true, reason: PRESET } }));
    const onModeChange = vi.fn();
    const { unmount } = mountSignedIn(<MailAccountModeSettings mode="download" syncWindow={null} trashWindow={30} deleteOnServer={false} isNew
      onModeChange={onModeChange} onSyncWindowChange={() => {}} onTrashWindowChange={() => {}} onDeleteChange={() => {}} />);
    await waitFor(() => expect(onModeChange).toHaveBeenCalledWith('sync'));
    expect(screen.getByRole('radio', { name: /^Download/ })).toBeDisabled();
    expect(screen.getAllByText(PRESET).length).toBeGreaterThan(0);
    unmount();

    onModeChange.mockClear();
    mountSignedIn(<MailAccountModeSettings mode="download" syncWindow={null} trashWindow={30} deleteOnServer={false}
      onModeChange={onModeChange} onSyncWindowChange={() => {}} onTrashWindowChange={() => {}} onDeleteChange={() => {}} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/policies/effective', expect.anything()));
    expect(screen.getByRole('radio', { name: /^Sync/ })).toBeEnabled();
    expect(onModeChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: /^Sync/ }));
    expect(onModeChange).toHaveBeenCalledWith('sync');
  });
});
