import { useState, type ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailSyncAttentionLine, MailSyncControl, type SyncPanelFocus } from '@/components/mail/MailSyncControl';
import type { MailSyncJob } from '@/hooks/use-mail-sync-jobs';
import { api } from '@/lib/api';
import type { MailAccount, MailWriteback } from '@/lib/mail-api';
import type { ModulePreference } from '@/lib/modules';
import { setOfflineMode } from '@/lib/offline';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

const accounts: MailAccount[] = [
  { id: 'a1', email_address: 'owner@example.test', display_name: 'Owner', provider: 'custom', is_active: true, last_synced_at: null },
  { id: 'a2', email_address: 'second@example.test', display_name: 'Second', provider: 'custom', is_active: true, last_synced_at: null },
];
const job = (account_id: string, state: MailSyncJob['state'], extra: Partial<MailSyncJob> = {}): MailSyncJob => ({
  account_id, state, phase: null, processed: 0, total: null, started_at: null, updated_at: null, error: null, ...extra,
});
const op = (id: string, state: MailWriteback['state'], extra: Partial<MailWriteback> = {}): MailWriteback => ({
  id, email_id: `email-${id}`, action: 'star', status: state === 'needs_attention' ? 'conflict' : 'pending', state,
  error: 'private provider details', created_at: '2026-09-30T10:00:00Z', ...extra,
});
const waiting = (count: number) => Array.from({ length: count }, (_, index) => op(`w${index}`, 'queued'));
const mailModule = (background: boolean): ModulePreference[] =>
  [{ id: 'mail', label: 'Mail', visible: true, enabled: true, background, backgroundSupported: true }];

type Props = ComponentProps<typeof MailSyncControl>;
let client: QueryClient;
const onSync = vi.fn();
const onCancel = vi.fn();

function Harness(props: Partial<Props>) {
  const [panel, setPanel] = useState<SyncPanelFocus | null>(props.panel ?? null);
  const operations = props.operations ?? [];
  return <>
    <MailSyncAttentionLine operations={operations} onReview={() => setPanel('attention')} />
    <MailSyncControl accounts={accounts} viewAccountIds={['a1']} jobs={[]} jobsError={false} operationsError={false}
      syncing={new Set()} cancelling={new Set()} onSync={onSync} onCancel={onCancel} touch={false} {...props}
      operations={operations} panel={panel} onPanelChange={setPanel} />
  </>;
}
const mount = (props: Partial<Props> = {}) =>
  render(<QueryClientProvider client={client}><Harness {...props} /></QueryClientProvider>);
const syncButton = () => screen.getByRole('button', { name: /^(Sync mail|Syncing|Requesting mail sync)/ });

beforeEach(() => {
  vi.clearAllMocks();
  setOfflineMode(false);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(api.post).mockResolvedValue({ data: {} });
});

describe('toolbar sync control', () => {
  it('syncs the account in view with one click while everything is confirmed', () => {
    mount({ jobs: [job('a1', 'idle'), job('a2', 'running')] });
    expect(syncButton()).toHaveAccessibleName('Sync mail');
    expect(syncButton()).not.toHaveAttribute('aria-haspopup');
    expect(screen.queryByTestId('mail-sync-badge')).not.toBeInTheDocument();
    fireEvent.click(syncButton());
    expect(onSync).toHaveBeenCalledExactlyOnceWith('a1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('syncs every active account from a combined view and is disabled while a request is in flight', () => {
    const view = mount({ viewAccountIds: ['a1', 'a2'] });
    fireEvent.click(syncButton());
    expect(onSync.mock.calls).toEqual([['a1'], ['a2']]);
    view.unmount();
    mount({ syncing: new Set(['a1']) });
    expect(syncButton()).toHaveAccessibleName('Requesting mail sync');
    expect(syncButton()).toBeDisabled();
  });

  it('opens the panel instead of cancelling while syncing, focusing Cancel for the second step', async () => {
    mount({ jobs: [job('a1', 'running', { phase: 'INBOX', processed: 2, total: 10 })] });
    expect(syncButton()).toHaveAccessibleName('Syncing — open sync details');
    expect(syncButton()).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(syncButton());
    expect(onCancel).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Mail sync' });
    expect(within(dialog).getByText('Syncing · INBOX · 2 of 10')).toBeInTheDocument();
    const cancel = within(dialog).getByRole('button', { name: 'Cancel sync for owner@example.test' });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('a1');
  });

  it('lists every account with Cancel for queued or running jobs and Sync now otherwise', async () => {
    mount({ jobs: [job('a1', 'queued'), job('a2', 'error', { error: 'Login failed' })] });
    fireEvent.click(screen.getByRole('button', { name: 'Sync details' }));
    const list = within(await screen.findByRole('region', { name: 'Accounts' }));
    expect(list.getByText('Queued')).toBeInTheDocument();
    expect(list.getByText('Sync failed · Login failed')).toBeInTheDocument();
    expect(list.getByRole('button', { name: 'Cancel sync for owner@example.test' })).toBeEnabled();
    expect(list.queryByRole('button', { name: 'Cancel sync for second@example.test' })).not.toBeInTheDocument();
    fireEvent.click(list.getByRole('button', { name: 'Sync second@example.test now' }));
    expect(onSync).toHaveBeenCalledExactlyOnceWith('a2');
  });

  it('shows the number of changes waiting for the server, capped at 99+', () => {
    const view = mount({ operations: waiting(53) });
    expect(syncButton()).toHaveAccessibleName('Sync mail — 53 changes waiting — open sync details');
    expect(screen.getByTestId('mail-sync-badge')).toHaveTextContent('53');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mail-sync-warning')).not.toBeInTheDocument();
    view.unmount();
    mount({ operations: waiting(120) });
    expect(screen.getByTestId('mail-sync-badge')).toHaveTextContent('99+');
  });

  it('lists waiting operations in a collapsed line inside the panel', async () => {
    mount({ operations: [op('q', 'queued'), op('r', 'retry_wait', { due_at: new Date(Date.now() + 4 * 60000 + 5000).toISOString() })] });
    fireEvent.click(syncButton());
    const toggle = await screen.findByRole('button', { name: '2 changes waiting for the server' });
    expect(screen.queryByText(/Star change: server busy/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText('Star change: server busy; retry in 4 minutes.')).toBeInTheDocument();
    expect(screen.queryByText(/private provider details/)).not.toBeInTheDocument();
  });

  it('shows the attention line and warning dot only for changes that need a decision', async () => {
    const view = mount({ operations: [op('q', 'queued'), op('x', 'rejected', { status: 'failed' })] });
    expect(screen.queryByText(/need(s)? your attention/)).not.toBeInTheDocument();
    view.unmount();
    mount({ operations: [op('q', 'queued'), op('a', 'needs_attention', { can_cancel: true }), op('b', 'needs_attention')] });
    expect(syncButton()).toHaveAccessibleName('Sync mail — 1 change waiting, 2 changes need attention — open sync details');
    expect(screen.getByTestId('mail-sync-warning')).toBeInTheDocument();
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('2 changes need your attention');
    fireEvent.click(within(line).getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Mail sync' });
    const heading = within(dialog).getByRole('heading', { name: '2 changes need your attention' });
    await waitFor(() => expect(heading).toHaveFocus());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard star change' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/mail/writebacks/a/cancel'));
  });

  it('pauses and resumes background sync through the modules API', async () => {
    client.setQueryData(['modules'], mailModule(true));
    vi.mocked(api.put).mockResolvedValue({ data: { modules: mailModule(false) } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sync details' }));
    const toggle = await screen.findByRole('switch', { name: 'Background sync' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/modules', { modules: { mail: { background: false } } }));
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.getByText(/UniHub won’t sync on its own/)).toBeInTheDocument();
    expect(syncButton()).toHaveAccessibleName('Sync mail — background sync paused');
  });

  it('uses a bottom sheet on touch screens without a hover-only cancel icon', async () => {
    mount({ touch: true, jobs: [job('a1', 'running')] });
    fireEvent.click(syncButton());
    const sheet = await screen.findByRole('dialog', { name: 'Mail sync' });
    expect(within(sheet).getByRole('button', { name: 'Cancel sync for owner@example.test' })).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
