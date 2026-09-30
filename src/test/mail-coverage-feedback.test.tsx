import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { MailSyncControl } from '@/components/mail/MailSyncControl';
import type { MailSyncJob } from '@/hooks/use-mail-sync-jobs';
import type { MailAccount } from '@/lib/mail-api';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

const base: MailSyncJob = { account_id: 'a1', state: 'running', phase: 'history', processed: 8, total: null,
  started_at: null, updated_at: null, error: null };
const accounts: MailAccount[] = [{ id: 'a1', email_address: 'owner@example.test', display_name: 'Owner', provider: 'custom', is_active: true, last_synced_at: null }];
const view = (job: MailSyncJob, list: MailAccount[] = accounts) => {
  render(<QueryClientProvider client={new QueryClient()}>
    <MailSyncControl accounts={list} viewAccountIds={['a1']} jobs={[job]} jobsError={false} operations={[]} operationsError={false}
      syncing={new Set()} cancelling={new Set()} onSync={vi.fn()} onCancel={vi.fn()} panel="default" onPanelChange={vi.fn()} touch={false} />
  </QueryClientProvider>);
  return within(screen.getByRole('region', { name: 'Accounts' }));
};

describe('coverage-aware sync feedback in the sync panel', () => {
  it('distinguishes recent coverage from pending history and bodies with unknown total', () => {
    const panel = view({ ...base, coverage: { recent: { current: true }, history: { complete: false }, bodies: { complete: false } } });
    expect(panel.getByText('Syncing · history · 8 processed')).toBeInTheDocument();
    expect(panel.getByText(/Inbox current/)).toBeInTheDocument();
    expect(panel.getByText(/Older mail not fully covered/)).toBeInTheDocument();
    expect(panel.getByText(/Bodies still downloading/)).toBeInTheDocument();
    expect(panel.queryByText(/Up to date/)).not.toBeInTheDocument();
  });
  it('never infers complete history from an idle job or a covered UID window', () => {
    const panel = view({ ...base, state: 'idle', coverage: { recent: { /* window metadata is not freshness */ }, history: { complete: false } } });
    expect(panel.getByText('Not synced yet')).toBeInTheDocument();
    expect(panel.getByText(/Older mail not fully covered/)).toBeInTheDocument();
    expect(panel.queryByText(/Inbox current/)).not.toBeInTheDocument();
    expect(panel.queryByText(/Up to date/)).not.toBeInTheDocument();
    expect(panel.getByRole('button', { name: 'Sync owner@example.test now' })).toBeEnabled();
  });
  it('reports up to date only when recent and history coverage are both complete', () => {
    const panel = view({ ...base, state: 'idle', updated_at: new Date(Date.now() - 120000).toISOString(),
      coverage: { recent: { current: true }, history: { complete: true }, bodies: { complete: true } } });
    expect(panel.getByText('Up to date · 2 minutes ago')).toBeInTheDocument();
  });
  it('explains sync coverage in the panel, collapsed, only when an account syncs with the server', () => {
    const panel = view({ ...base, state: 'idle' }, [{ ...accounts[0], sync_mode: 'sync' as const }]);
    const toggle = panel.getByRole('button', { name: 'About sync coverage' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel.queryByText(/Recent mail and older history have separate coverage/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(panel.getByText(/recent mail and older history have separate coverage/)).toBeInTheDocument();
    expect(panel.getByText(/Missing server messages stay as local copies/)).toBeInTheDocument();
  });
  it('has no sync coverage note for download-only accounts', () => {
    const panel = view({ ...base, state: 'idle' }, [{ ...accounts[0], sync_mode: 'download' as const }]);
    expect(panel.queryByRole('button', { name: 'About sync coverage' })).not.toBeInTheDocument();
  });
  it('shows paused provider state and requested cancellation without claiming completion', () => {
    const panel = view({ ...base, state: 'paused', phase: 'auth', error: 'Credentials needed' });
    expect(panel.getByText('Waiting · Credentials needed')).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: /Cancel sync/ })).not.toBeInTheDocument();
  });
});
