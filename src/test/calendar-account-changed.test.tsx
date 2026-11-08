import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useCalendarAccounts } from '@/hooks/use-calendar-accounts';
import type { CalendarAccount } from '@/lib/calendar-api';
import { mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const CHANGED = 'This account changed in the meantime. Try again.';
const ACCOUNT = { id: 'acct-1', provider: 'caldav', account_email: 'a@example.com', display_name: 'Work', is_active: true, sync_status: 'ok', last_synced_at: null, mail_account_id: null } as unknown as CalendarAccount;

/** The calendar accounts' changes, as the panel calls them. */
function Harness() {
  const data = useCalendarAccounts();
  return <>
    <p>{data.accounts.length} accounts</p>
    <button type="button" onClick={() => data.setAccountActive.mutate({ id: 'acct-1', active: false })}>Pause sync</button>
    <button type="button" onClick={() => data.deleteAccount.mutate('acct-1')}>Remove account</button>
  </>;
}

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/calendar/accounts') return { data: { accounts: [ACCOUNT] } };
    if (path === '/calendar/calendars') return { data: { calendars: [] } };
    if (path === '/policies/effective') return policiesAnswer();
    throw new Error(`unexpected GET ${path}`);
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// 409 ACCOUNT_CHANGED on PUT or DELETE /api/calendar/accounts/:id: nothing was
// written; the person reads the server's sentence and the accounts are read again.
describe('a calendar account changed meanwhile', () => {
  const reads = () => vi.mocked(api.get).mock.calls.filter(([path]) => path === '/calendar/accounts').length;

  it('a refused pause shows the server\'s sentence and reads the accounts again', { timeout: 20_000 }, async () => {
    vi.mocked(api.put).mockResolvedValueOnce({ status: 409, error: CHANGED, code: 'ACCOUNT_CHANGED' } as never);
    mountSignedIn(<Harness />);
    await screen.findByText('1 accounts');
    const before = reads();
    fireEvent.click(screen.getByRole('button', { name: 'Pause sync' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/calendar/accounts/acct-1', { is_active: false }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not change sync', description: CHANGED })));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it('a refused removal shows the server\'s sentence and reads the accounts again', { timeout: 20_000 }, async () => {
    vi.mocked(api.delete).mockResolvedValueOnce({ status: 409, error: CHANGED, code: 'ACCOUNT_CHANGED' } as never);
    mountSignedIn(<Harness />);
    await screen.findByText('1 accounts');
    const before = reads();
    fireEvent.click(screen.getByRole('button', { name: 'Remove account' }));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not remove the account', description: CHANGED })));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(screen.getByText('1 accounts')).toBeInTheDocument();
  });
});
