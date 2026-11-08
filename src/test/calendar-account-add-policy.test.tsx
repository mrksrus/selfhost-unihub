import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { useCalendarAccounts } from '@/hooks/use-calendar-accounts';
import { usePolicy } from '@/hooks/use-policies';
import { AddCalendarAccountDialog } from '@/components/calendar/CalendarAccountDialogs';
import { mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const ADD = 'Your administrator does not allow adding mail or calendar accounts.';

/** The add dialog, with the panel's add control as the rules see it (usePolicy, as CalendarPanel greys it). */
function Harness() {
  const data = useCalendarAccounts();
  const addPolicy = usePolicy('accounts.add');
  return <>
    <p data-testid="add-control">{addPolicy.lock ?? 'Add account allowed'}</p>
    <AddCalendarAccountDialog open onOpenChange={() => {}} data={data} />
  </>;
}

let policies = policiesAnswer();
beforeEach(() => {
  stubBrowserApis();
  policies = policiesAnswer();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/calendar/accounts') return { data: { accounts: [] } };
    if (path === '/calendar/calendars') return { data: { calendars: [] } };
    if (path === '/policies/effective') return policies;
    throw new Error(`unexpected GET ${path}`);
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// accounts.add set while the server was being found (403 POLICY_FORBIDS after discovery):
// the reason stays in the dialog with what was typed, and the rules are read again.
describe('adding a calendar account a rule refuses after discovery', () => {
  it('shows the reason in the dialog, keeps the typed values and reads the rules again', { timeout: 20_000 }, async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ status: 403, error: ADD, code: 'POLICY_FORBIDS', details: { policy: 'accounts.add', reason: ADD } } as never);
    mountSignedIn(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Add calendar account' });
    fireEvent.keyDown(within(dialog).getByLabelText('Type'), { key: 'Enter' });
    fireEvent.keyDown(await screen.findByRole('option', { name: 'CalDAV server' }), { key: 'Enter' });
    fireEvent.change(await within(dialog).findByLabelText('Email'), { target: { value: 'cal@example.org' } });
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'app-password' } });
    expect(await screen.findByTestId('add-control')).toHaveTextContent('Add account allowed');
    // The rule is set while the server is being found: the refusal comes after discovery.
    policies = policiesAnswer({ 'accounts.add': { value: 'forbidden', reason: ADD } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/calendar/accounts', expect.objectContaining({ provider: 'caldav', account_email: 'cal@example.org' })));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(ADD);
    expect(within(dialog).getByLabelText('Email')).toHaveValue('cal@example.org');
    expect(within(dialog).getByRole('button', { name: 'Connect' })).toBeEnabled();
    // The rules were read again: the add control now greys out with the reason.
    await waitFor(() => expect(screen.getByTestId('add-control')).toHaveTextContent(ADD));
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not add the calendar account', description: ADD }));
  });
});
