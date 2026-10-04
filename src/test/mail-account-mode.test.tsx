import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailAccountModeSettings } from '@/components/mail/MailAccountModeSettings';
import { MailAccountDialog } from '@/components/mail/MailAccountDialog';
import { MailSyncAttentionLine, MailSyncControl, type SyncPanelFocus } from '@/components/mail/MailSyncControl';
import { useMailAccountEditor } from '@/hooks/use-mail-account-editor';
import { api } from '@/lib/api';
import type { MailAccount, MailModeImpact } from '@/lib/mail-api';
import { setOfflineMode } from '@/lib/offline';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), getDownloadUrl: (path: string) => `/api${path}` } }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));

const syncAccount: MailAccount = {
  id: 'a1', email_address: 'Owner@Example.test', display_name: 'Owner', provider: 'custom', username: 'owner',
  imap_host: 'imap.example.test', imap_port: 993, smtp_host: 'smtp.example.test', smtp_port: 587,
  is_active: true, last_synced_at: null, sync_mode: 'sync', sync_window_days: null, trash_window_days: 30,
  sync_policy_confirmed: true, sync_policy_pending_removals: 0,
};
const downloadAccount: MailAccount = { ...syncAccount, id: 'a2', email_address: 'archive@example.test', sync_mode: 'download' };
const impact = (extra: Partial<MailModeImpact> = {}): MailModeImpact => ({
  mode: 'sync', local_only: 0, outside_window: 0, outside_trash_window: 0, gmail_duplicates: 0, local_duplicates: 0, total_removals: 0, notes: [], ...extra,
});

let client: QueryClient;
beforeAll(() => {
  // Radix Select needs these browser APIs, which jsdom lacks.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => {
  vi.clearAllMocks();
  setOfflineMode(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(api.get).mockResolvedValue({ data: impact() });
  vi.mocked(api.post).mockResolvedValue({ data: {} });
  vi.mocked(api.put).mockResolvedValue({ data: {} });
});

function EditorHarness({ account }: { account?: MailAccount }) {
  const editor = useMailAccountEditor();
  return <>
    {account && <button type="button" onClick={() => editor.startEdit(account)}>Edit account</button>}
    <MailAccountDialog editor={editor} trigger={<button type="button">Add account</button>} />
  </>;
}
const mountEditor = (account?: MailAccount) => {
  render(<QueryClientProvider client={client}><EditorHarness account={account} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: account ? 'Edit account' : 'Add account' }));
  return screen.getByRole('dialog');
};
const chooseWindow = (dialog: HTMLElement, label: string, option: string) => {
  fireEvent.keyDown(within(dialog).getByLabelText(label), { key: 'Enter' });
  fireEvent.keyDown(screen.getByRole('option', { name: option }), { key: 'Enter' });
};
const impactCalls = () => vi.mocked(api.get).mock.calls.map(([endpoint]) => endpoint).filter(endpoint => endpoint.includes('/mode-impact'));
const saveButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Save Changes' });

describe('mail account mode chooser', () => {
  it('explains both modes in plain language and shows the right options for each', () => {
    const props = { mode: 'download' as const, syncWindow: null, trashWindow: 30 as const, deleteOnServer: false,
      onModeChange: vi.fn(), onSyncWindowChange: vi.fn(), onTrashWindowChange: vi.fn(), onDeleteChange: vi.fn() };
    const view = render(<MailAccountModeSettings {...props} />);
    expect(screen.getByText('How should UniHub handle this account?')).toBeInTheDocument();
    const sync = screen.getByRole('radio', { name: /Sync — works like a mail client/ });
    const download = screen.getByRole('radio', { name: /Download — keep an archive/ });
    expect(sync).toHaveAccessibleDescription(/deleted or moved elsewhere is deleted or moved here too/);
    expect(download).toHaveAccessibleDescription(/never changes the server/);
    expect(download).toBeChecked();
    expect(screen.getByText('Server deletion options exist only in Download mode.')).toBeInTheDocument();
    expect(screen.getByText('Delete emails on server after download')).toBeInTheDocument();
    fireEvent.click(sync);
    expect(props.onModeChange).toHaveBeenCalledWith('sync');

    view.rerender(<MailAccountModeSettings {...props} mode="sync" />);
    expect(screen.queryByText('Delete emails on server after download')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Keep mail from the last')).toHaveTextContent('All mail');
    expect(screen.getByLabelText('Trash & spam: keep the last')).toHaveTextContent('1 month');
    expect(screen.getByText(/Older mail stays on the server and is removed from UniHub/)).toBeInTheDocument();

    view.rerender(<MailAccountModeSettings {...props} saveDownloadFirst />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/Save Download mode first/)).toBeInTheDocument();
  });

  it('explains the modes for a new account without asking for an impact', async () => {
    const dialog = mountEditor();
    expect(within(dialog).getByRole('radio', { name: /Sync — works like a mail client/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Download — keep an archive/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Sync/ }));
    expect(within(dialog).getByLabelText('Keep mail from the last')).toBeInTheDocument();
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(impactCalls()).toEqual([]);
    expect(within(dialog).queryByText('Before you save')).not.toBeInTheDocument();
  });
});

describe('pre-save impact for an existing account', () => {
  it('fetches the impact of a window change and requires the typed address before saving', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: impact({ outside_window: 1200, outside_trash_window: 34, total_removals: 1234, notes: ['Starred mail is kept.'] }) });
    const dialog = mountEditor(syncAccount);
    expect(saveButton(dialog)).toBeEnabled();
    chooseWindow(dialog, 'Keep mail from the last', '3 months');
    expect(saveButton(dialog)).toBeDisabled();
    expect(await within(dialog).findByTestId('mail-mode-impact-total')).toHaveTextContent('1,234 emails will be removed from UniHub. They stay on the server.');
    expect(impactCalls()).toEqual(['/mail/accounts/a1/mode-impact?mode=sync&sync_window_days=90&trash_window_days=30']);
    expect(within(dialog).getByText('older than the mail window')).toBeInTheDocument();
    expect(within(dialog).getByText('Starred mail is kept.')).toBeInTheDocument();

    const address = within(dialog).getByLabelText(/to confirm/);
    expect(saveButton(dialog)).toBeDisabled();
    fireEvent.change(address, { target: { value: 'someone@example.test' } });
    expect(saveButton(dialog)).toBeDisabled();
    fireEvent.change(address, { target: { value: ' owner@example.TEST ' } });
    expect(saveButton(dialog)).toBeEnabled();
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put).toHaveBeenCalledWith('/mail/accounts/a1', expect.objectContaining({
      sync_mode: 'sync', sync_window_days: 90, trash_window_days: 30, confirm_address: 'owner@example.TEST',
    }));
  });

  it('keeps the edits and asks for the address when the server requires confirmation', async () => {
    vi.mocked(api.put).mockResolvedValue({ status: 400, error: 'Type the account address to confirm.', requires_confirmation: true });
    const dialog = mountEditor(syncAccount);
    chooseWindow(dialog, 'Trash & spam: keep the last', '2 weeks');
    expect(await within(dialog).findByText('Nothing will be removed from UniHub.')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/to confirm/)).not.toBeInTheDocument();
    expect(saveButton(dialog)).toBeEnabled();
    fireEvent.click(saveButton(dialog));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Type the account address to confirm.');
    expect(within(dialog).getByLabelText('Trash & spam: keep the last')).toHaveTextContent('2 weeks');
    expect(saveButton(dialog)).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'owner@example.test' } });
    vi.mocked(api.put).mockResolvedValue({ data: {} });
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/mail/accounts/a1', expect.objectContaining({
      trash_window_days: 14, confirm_address: 'owner@example.test', sync_mode_confirmed: true,
    })));
  });

  it('shows a visible error when the impact cannot be checked and still lets the user confirm', async () => {
    vi.mocked(api.get).mockResolvedValue({ error: 'The API is temporarily unavailable (503).' });
    const dialog = mountEditor(syncAccount);
    chooseWindow(dialog, 'Keep mail from the last', '1 year');
    expect(await within(dialog).findByText(/Couldn’t check how many emails would be removed/)).toBeInTheDocument();
    expect(saveButton(dialog)).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'owner@example.test' } });
    expect(saveButton(dialog)).toBeEnabled();
  });

  it('switches Download to Sync with counts, a backup first and the typed address', async () => {
    vi.mocked(api.get).mockImplementation(async (endpoint: string) => endpoint.startsWith('/backup/jobs/')
      ? { data: { job: { id: 'job-1', status: 'running', progress: 40, encryption_enabled: false } } }
      : { data: impact({ local_only: 7, gmail_duplicates: 3, total_removals: 10 }) });
    vi.mocked(api.post).mockResolvedValue({ data: { job: { id: 'job-1', status: 'queued', progress: 0, encryption_enabled: false } } });
    const dialog = mountEditor(downloadAccount);
    fireEvent.click(within(dialog).getByRole('radio', { name: /Sync — works like a mail client/ }));
    expect(within(dialog).getByText(/Sync makes the server the source of truth/)).toBeInTheDocument();
    expect(await within(dialog).findByTestId('mail-mode-impact-total')).toHaveTextContent('10 emails will be removed from UniHub.');
    expect(impactCalls()).toEqual(['/mail/accounts/a2/mode-impact?mode=sync&sync_window_days=&trash_window_days=30']);
    expect(within(dialog).getByText('no longer on the server')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Download a backup first' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/accounts/a2/backup-export'));
    expect(await within(dialog).findByText(/Preparing backup…/)).toBeInTheDocument();

    expect(saveButton(dialog)).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/to confirm/), { target: { value: 'archive@example.test' } });
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/accounts/a2', expect.objectContaining({
      sync_mode: 'sync', confirm_address: 'archive@example.test', sync_mode_confirmed: true, delete_emails_on_server: false,
    })));
  });
});

describe('reconnecting a paused account', () => {
  it('reactivates an account a restore paused without disconnecting it', async () => {
    const dialog = mountEditor({ ...downloadAccount, is_active: false, disconnected_at: null });
    expect(within(dialog).getByText(/required to reconnect/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^Password/), { target: { value: 'app-password' } });
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/accounts/a2', expect.objectContaining({ encrypted_password: 'app-password', is_active: true })));
  });

  it('reconnects a paused account with its saved password when the field stays empty', async () => {
    const dialog = mountEditor({ ...downloadAccount, is_active: false, disconnected_at: null, has_saved_password: true });
    expect(within(dialog).getByText(/reconnect with the saved password/)).toBeInTheDocument();
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/accounts/a2', expect.objectContaining({ is_active: true, encrypted_password: undefined })));
  });

  it('needs a new password for a disconnected account even if one was saved before', async () => {
    const dialog = mountEditor({ ...downloadAccount, is_active: false, disconnected_at: '2026-10-04T09:00:00Z', has_saved_password: true });
    expect(within(dialog).getByText(/required to reconnect/)).toBeInTheDocument();
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.put).mock.calls[0][1]).not.toHaveProperty('is_active');
  });

  it('does not reactivate without a password', async () => {
    const dialog = mountEditor({ ...downloadAccount, is_active: false, disconnected_at: null });
    fireEvent.change(within(dialog).getByLabelText(/Display name/i), { target: { value: 'Archive' } });
    fireEvent.click(saveButton(dialog));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.put).mock.calls[0][1]).not.toHaveProperty('is_active');
  });
});

describe('sync policy upgrade gate', () => {
  const pending: MailAccount = { ...syncAccount, id: 'p1', email_address: 'old@example.test', sync_policy_confirmed: false, sync_policy_pending_removals: 5 };
  const nothingPending: MailAccount = { ...syncAccount, id: 'p2', email_address: 'empty@example.test', sync_policy_confirmed: false, sync_policy_pending_removals: 0 };
  const confirmed: MailAccount = { ...syncAccount, id: 'p3', email_address: 'done@example.test', sync_policy_pending_removals: 9 };
  const archive: MailAccount = { ...downloadAccount, id: 'p4', email_address: 'keep@example.test', sync_policy_confirmed: false, sync_policy_pending_removals: 4 };

  function PanelHarness({ accounts }: { accounts: MailAccount[] }) {
    const [panel, setPanel] = useState<SyncPanelFocus | null>(null);
    return <>
      <MailSyncAttentionLine operations={[]} accounts={accounts} onReview={setPanel} />
      <MailSyncControl accounts={accounts} viewAccountIds={accounts.map(account => account.id)} jobs={[]} jobsError={false}
        operations={[]} operationsError={false} syncing={new Set()} cancelling={new Set()} onSync={vi.fn()} onCancel={vi.fn()}
        panel={panel} onPanelChange={setPanel} touch={false} />
    </>;
  }
  const mountPanel = (accounts: MailAccount[]) =>
    render(<QueryClientProvider client={client}><PanelHarness accounts={accounts} /></QueryClientProvider>);

  it('appears for every unconfirmed Sync account (with or without removals), and confirm posts the typed address', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { confirmed: true, queued: true } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mountPanel([pending, nothingPending, confirmed, archive]);
    expect(screen.getByRole('status')).toHaveTextContent('2 accounts need a decision');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const panel = await screen.findByRole('dialog');
    const notices = within(panel).getAllByRole('group');
    expect(notices).toHaveLength(2);
    expect(notices[0]).toHaveTextContent('Turn on mail-client behavior for old@example.test: 5 emails that are no longer on the server will be removed from UniHub.');
    expect(notices[1]).toHaveTextContent('Turn on mail-client behavior for empty@example.test: nothing is removed now');
    expect(within(notices[0]).getByRole('button', { name: 'Back up first' })).toBeInTheDocument();
    await waitFor(() => expect(within(panel).getAllByText(/Turn on mail-client behavior for/)[0].closest('p')).toHaveFocus());

    fireEvent.click(within(notices[0]).getByRole('button', { name: 'Confirm…' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'Turn on mail-client behavior' });
    const submit = within(confirmDialog).getByRole('button', { name: 'Turn on and remove 5 emails' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(confirmDialog).getByLabelText(/to confirm/), { target: { value: 'other@example.test' } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(confirmDialog).getByLabelText(/to confirm/), { target: { value: 'OLD@example.test' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/accounts/p1/confirm-sync-policy', { confirm_address: 'OLD@example.test' }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mail-accounts'] }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Turn on mail-client behavior' })).not.toBeInTheDocument());
  });

  it('shows nothing when no account needs a decision', () => {
    mountPanel([confirmed, archive]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a failed confirmation inside the dialog', async () => {
    vi.mocked(api.post).mockResolvedValue({ status: 400, error: 'The address does not match this account.' });
    mountPanel([pending]);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm…' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'Turn on mail-client behavior' });
    fireEvent.change(within(confirmDialog).getByLabelText(/to confirm/), { target: { value: 'old@example.test' } });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /Turn on and remove/ }));
    expect(await within(confirmDialog).findByRole('alert')).toHaveTextContent('The address does not match this account.');
  });

  it('shows the notice in the account settings too', () => {
    const dialog = mountEditor(pending);
    expect(within(dialog).getByRole('group', { name: /Turn on mail-client behavior for old@example.test/ })).toBeInTheDocument();
  });
});

describe('provider sync warnings', () => {
  const gmail: MailAccount = { ...syncAccount, provider: 'gmail', sync_warnings: ['gmail_all_mail_hidden', 'future_warning_code'] };

  it('explains a hidden Gmail All Mail in the sync panel row and the account settings, ignoring unknown codes', async () => {
    render(<QueryClientProvider client={client}>
      <MailSyncControl accounts={[gmail]} viewAccountIds={['a1']} jobs={[]} jobsError={false} operations={[]} operationsError={false}
        syncing={new Set()} cancelling={new Set()} onSync={vi.fn()} onCancel={vi.fn()} panel="default" onPanelChange={vi.fn()} touch={false} />
    </QueryClientProvider>);
    const panel = await screen.findByRole('dialog');
    const rows = within(panel).getAllByText(/Gmail’s “All Mail” is hidden from IMAP/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('In Gmail: Settings → Labels → All Mail → Show in IMAP.');
    expect(within(panel).queryByText(/future_warning_code/)).not.toBeInTheDocument();
  });

  it('shows the warning in the account settings', () => {
    const dialog = mountEditor(gmail);
    expect(within(dialog).getByText(/can’t tell archived mail from deleted mail and keeps it/)).toBeInTheDocument();
  });
});

describe('calendar of a mail account', () => {
  const link = {
    enabled: true,
    account: {
      id: 'c1', user_id: 'owner', provider: 'caldav', account_email: 'owner@example.test', display_name: 'Owner', token_expires_at: null,
      provider_config: { server: { url: 'https://dav.example.test/dav/', source: 'well-known', label: 'dav.example.test' } },
      capabilities: {}, is_active: true, sync_status: 'error', sync_error: 'The calendar server rejected the login.', last_synced_at: null,
      mail_account_id: 'a1', created_at: '', updated_at: '',
    },
    calendars: [{ id: 'k1', name: 'Personal', color: '#2563eb', read_only: false, is_visible: true }],
    event_count: 12,
    provider: null,
  };
  const routeGet = (calendar: unknown = link) => vi.mocked(api.get).mockImplementation(async (endpoint: string) => {
    if (endpoint === '/modules') return { data: { modules: [{ id: 'calendar', enabled: true, visible: true }] } };
    if (endpoint === '/mail/accounts/a1/calendar') return { data: { calendar } };
    return { data: impact() };
  });

  it('shows the server, status and calendars and asks before turning the calendar off', async () => {
    routeGet();
    vi.mocked(api.put).mockResolvedValue({ data: { calendar: { ...link, enabled: false, account: null, calendars: [], event_count: 0 } } });
    const dialog = mountEditor(syncAccount);
    expect(await within(dialog).findByText('The calendar server rejected the login.')).toBeInTheDocument();
    expect(within(dialog).getByText(/dav\.example\.test \(found automatically\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Personal · 12 events/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('switch', { name: 'Calendar' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/12 synced events/)).toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalledWith('/mail/accounts/a1/calendar', expect.anything());
    fireEvent.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/accounts/a1/calendar', expect.objectContaining({ enabled: false })));
  });

  it('applies a typed server address and Enter does not save the mail account', async () => {
    routeGet();
    vi.mocked(api.put).mockResolvedValue({ data: { calendar: link } });
    const dialog = mountEditor(syncAccount);
    const input = await within(dialog).findByLabelText('Calendar server address (optional)');
    fireEvent.change(input, { target: { value: 'https://cal.example.test/dav/' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/mail/accounts/a1/calendar',
      expect.objectContaining({ enabled: true, caldav_url: 'https://cal.example.test/dav/' })));
    expect(api.put).not.toHaveBeenCalledWith('/mail/accounts/a1', expect.anything());
  });

  it('turns the calendar on for a new account by default', async () => {
    routeGet();
    vi.mocked(api.post).mockResolvedValue({ data: { syncInProgress: true, calendarSync: { attempted: true, success: true, calendars: 2, server: { url: 'https://dav.example.test/', source: 'dns', label: 'dav.example.test' } } } });
    const fill = (dialog: HTMLElement) => {
      fireEvent.change(within(dialog).getByLabelText('Email Address'), { target: { value: 'new@example.test' } });
      fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'new@example.test' } });
      fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'secret' } });
      fireEvent.change(within(dialog).getByLabelText('IMAP Server'), { target: { value: 'imap.example.test' } });
      fireEvent.change(within(dialog).getByLabelText('SMTP Server'), { target: { value: 'smtp.example.test' } });
    };
    const dialog = mountEditor();
    expect(await within(dialog).findByRole('checkbox', { name: /Sync the calendar too/ })).toBeChecked();
    fill(dialog);
    fireEvent.submit(within(dialog).getByLabelText('Password').closest('form')!);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/accounts', expect.objectContaining({ try_calendar_sync: true, caldav_url: '' })));
    expect(vi.mocked(api.post).mock.calls[0][1]).toHaveProperty('time_zone');
  });

  it('skips the calendar of a Gmail account unless a subscription address is pasted', async () => {
    routeGet();
    vi.mocked(api.post).mockResolvedValue({ data: { syncInProgress: true } });
    const dialog = mountEditor();
    fireEvent.keyDown(within(dialog).getByLabelText('Email Provider'), { key: 'Enter' });
    fireEvent.keyDown(await screen.findByRole('option', { name: 'Gmail' }), { key: 'Enter' });
    expect(await within(dialog).findByText(/secret iCal address/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Email Address'), { target: { value: 'new@example.test' } });
    fireEvent.change(within(dialog).getByLabelText('Username'), { target: { value: 'new@example.test' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.submit(within(dialog).getByLabelText('Password').closest('form')!);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/accounts', expect.objectContaining({ provider: 'gmail', try_calendar_sync: false })));
  });
});
