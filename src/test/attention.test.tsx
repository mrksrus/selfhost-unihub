import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAttentionItems } from '@/hooks/use-attention';
import { AttentionList } from '@/components/layout/AttentionList';
import { api } from '@/lib/api';
import type { ModulePreference } from '@/lib/modules';

vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'owner' }, isOffline: false }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const modules = (enabled: Partial<Record<ModulePreference['id'], boolean>>): ModulePreference[] =>
  (['mail', 'calendar', 'contacts', 'recordings'] as const).map(id => ({ id, label: id, visible: true, enabled: enabled[id] ?? true, background: true }));

function Tray() {
  return <AttentionList items={useAttentionItems()} />;
}

function mount(enabled: Partial<Record<ModulePreference['id'], boolean>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['modules'], modules(enabled));
  return render(<QueryClientProvider client={client}><MemoryRouter><Tray /></MemoryRouter></QueryClientProvider>);
}

const responses: Record<string, unknown> = {
  '/mail/accounts': { accounts: [
    { id: 'a1', email_address: 'owner@example.test', is_active: true, sync_mode: 'sync', sync_policy_confirmed: false },
    { id: 'a2', email_address: 'second@example.test', is_active: true, sync_mode: 'download' },
  ] },
  '/mail/writebacks': { operations: [
    { id: 'w1', email_id: 'e1', action: 'star', status: 'failed', state: 'needs_attention' },
    { id: 'w2', email_id: 'e2', action: 'read', status: 'pending', state: 'queued' },
  ] },
  '/mail/sync/status': { accounts: [{ account_id: 'a2', state: 'error', error: 'Login refused', phase: null, processed: 0, total: null, started_at: null, updated_at: null }] },
  '/calendar/accounts': { accounts: [{ id: 'c1', display_name: 'Work calendar', is_active: true, sync_status: 'error', sync_error: 'Server unreachable' }] },
};

describe('attention tray', () => {
  it('collects mail decisions, failed syncs and calendar errors with links to where they are resolved', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => ({ data: responses[path.split('?')[0]] }));
    mount();
    const changes = await screen.findByText('1 mail change needs your attention');
    expect(within(changes.closest('li')!).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/mail?review=attention');
    const decision = screen.getByText('1 mail account needs a decision').closest('li')!;
    expect(decision).toHaveTextContent('owner@example.test');
    expect(within(decision).getByRole('link', { name: 'Decide' })).toHaveAttribute('href', '/mail?review=decision');
    const failed = (await screen.findByText('Mail sync failed for second@example.test')).closest('li')!;
    expect(failed).toHaveTextContent('Login refused');
    expect(within(failed).getByRole('link', { name: 'Open sync details' })).toHaveAttribute('href', '/mail?review=sync');
    expect(await screen.findByText('Calendar sync failed for Work calendar')).toBeInTheDocument();
  });

  it('asks nothing of disabled modules and says when all is well', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => ({ data: responses[path.split('?')[0]] }));
    mount({ mail: false, calendar: false });
    expect(await screen.findByText('Nothing needs your attention.')).toBeInTheDocument();
    const paths = vi.mocked(api.get).mock.calls.map(([path]) => path);
    expect(paths.filter(path => path.startsWith('/mail') || path.startsWith('/calendar'))).toEqual([]);
  });
});
