import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import AdminPolicies from '@/pages/AdminPolicies';
import { ChatRetentionLine } from '@/components/chat/ChatRetentionLine';
import type { AdminPoliciesResponse, RetentionPreview } from '@/lib/admin-api';
import { DEFAULT_POLICY_VALUES, POLICY_KEYS } from '@/lib/policies-api';
import { ADMIN, SERVER_OWNER, mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

// "Delete chat messages after" on Server › Policies: what the page alone
// knows. The typed word and the count gate the save, a count belongs to the
// value it was asked for, Undo sets back the value the page had loaded, and
// only the owner is offered to end the wait. The server's rules (the 24
// hours, the password, the owner) are proven in its own tests.

const state = vi.hoisted(() => ({ toast: vi.fn(), user: null as unknown }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: state.user, isOffline: false }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, modules: [], pages: [] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const DAYS = [null, 30, 90, 180, 365];
const policies = (retention: number | null): AdminPoliciesResponse => ({ revision: 3, policies: Object.fromEntries(POLICY_KEYS.map(key => [key, {
  value: key === 'chat.retention_days' ? retention : DEFAULT_POLICY_VALUES[key], source: 'default', default: DEFAULT_POLICY_VALUES[key],
  values: key === 'chat.retention_days' ? DAYS : [DEFAULT_POLICY_VALUES[key]], effect: null,
}])) as AdminPoliciesResponse['policies'] });
const NONE: RetentionPreview = { messages: 0, files: 0, conversations: 0, waiting: 0, waiting_from: null };
const WAITING: RetentionPreview = { ...NONE, waiting: 3, waiting_from: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString() };

/** The server's answers; a count stays open until the test answers it. */
let pending: RetentionPreview;
let stored: number | null;
let counts: Record<string, (answer: RetentionPreview) => void>;

const mount = (user = SERVER_OWNER) => { state.user = user; return mountSignedIn(<AdminPolicies />, { user, path: '/admin/policies', routePath: '/admin/policies' }); };
const choose = async (option: string) => {
  fireEvent.click(await screen.findByRole('combobox', { name: /^Delete chat messages after/ }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
};
const openSave = async () => {
  fireEvent.click(within(await screen.findByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Save changes…' }));
  return screen.findByRole('dialog', { name: 'Save the changed rules?' });
};
const type = (dialog: HTMLElement, label: string | RegExp, value: string) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });

beforeEach(() => {
  stubBrowserApis();
  pending = NONE;
  stored = null;
  counts = {};
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === '/admin/policies') return { data: policies(stored) };
    if (path === '/admin/groups') return { data: { groups: [] } };
    if (path === '/policies/effective') return policiesAnswer();
    if (path === '/admin/chat/retention-preview') return { data: pending };
    const days = /^\/admin\/chat\/retention-preview\?days=(\d+)$/.exec(path)?.[1];
    if (days) return { data: await new Promise<RetentionPreview>(resolve => { counts[days] = resolve; }) };
    throw new Error(`unexpected GET ${path}`);
  });
  vi.mocked(api.put).mockImplementation(async (_path: string, body?: unknown) => ({ data: policies((body as { values: Record<string, number | null> }).values['chat.retention_days']) }));
  vi.mocked(api.post).mockResolvedValue({ data: { acknowledged_revision: 3 } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Server › Policies: a shorter chat retention', () => {
  it('is saved only with the server\'s count, the typed word and the password; Undo then sets back the value the page had loaded', { timeout: 40_000 }, async () => {
    mount();
    await choose('30 days');
    const dialog = await openSave();
    expect(within(dialog).getByText('Counting what this deletes…')).toBeTruthy();
    // The word comes first in the dialog and has the focus.
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText(/^Type DELETE to confirm/)));
    const save = within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    type(dialog, /^Type DELETE/, 'delete');
    type(dialog, 'Your password', 'admin-own-password');
    expect(save.disabled).toBe(true);

    counts['30']({ ...NONE, messages: 12, files: 1, conversations: 2 });
    expect(await within(dialog).findByText('12 messages and 1 file in 2 chats are older than 30 days and will be deleted.')).toBeTruthy();
    expect(save.disabled).toBe(false);
    type(dialog, /^Type DELETE/, 'delet');
    expect(save.disabled).toBe(true);
    type(dialog, /^Type DELETE/, 'DELETE');
    fireEvent.click(save);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/policies', { values: { 'chat.retention_days': 30 }, current_password: 'admin-own-password' }));

    // The wait has not started on the server yet; the page knows what it saved and what was there before.
    const waits = await screen.findByTestId('retention-pending');
    expect(waits.textContent).toMatch(/^From about .+, messages older than 30 days are deleted\. Nothing is deleted before then\./);
    fireEvent.click(within(waits).getByRole('button', { name: 'Undo' }));
    const undo = await screen.findByRole('dialog', { name: 'Undo the shorter time?' });
    type(undo, 'Your password', 'admin-own-password');
    fireEvent.click(within(undo).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.put).toHaveBeenLastCalledWith('/admin/policies', { values: { 'chat.retention_days': null }, current_password: 'admin-own-password' }));
    await waitFor(() => expect(screen.queryByTestId('retention-pending')).toBeNull());
  });

  it('a count that arrives late for an earlier choice is not shown for the next one', { timeout: 40_000 }, async () => {
    mount();
    await choose('30 days');
    fireEvent.click(within(await openSave()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await choose('90 days');
    const dialog = await openSave();
    await waitFor(() => expect(counts['90']).toBeTruthy());
    counts['30']({ ...NONE, messages: 500, files: 40, conversations: 9 });
    type(dialog, /^Type DELETE/, 'DELETE');
    type(dialog, 'Your password', 'admin-own-password');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(within(dialog).getByText('Counting what this deletes…')).toBeTruthy();
    expect(within(dialog).queryByText(/500 messages/)).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    counts['90']({ ...NONE, messages: 3, files: 0, conversations: 1 });
    expect(await within(dialog).findByText('3 messages and 0 files in 1 chat are older than 90 days and will be deleted.')).toBeTruthy();
  });

  it('a longer time is saved like every rule, without the word', { timeout: 20_000 }, async () => {
    stored = 30;
    mount();
    await choose('90 days');
    const dialog = await openSave();
    expect(within(dialog).queryByTestId('retention-warning')).toBeNull();
    type(dialog, 'Your password', 'admin-own-password');
    expect((within(dialog).getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('chats that wait are named with their date; only the owner is offered to end the wait', { timeout: 20_000 }, async () => {
    pending = WAITING;
    mount(ADMIN);
    const waits = await screen.findByTestId('retention-pending');
    expect(waits.textContent).toMatch(/^From .+, old messages are deleted in 3 chats\./);
    expect(within(waits).queryByRole('button')).toBeNull();
    cleanup();
    mount(SERVER_OWNER);
    expect(await within(await screen.findByTestId('retention-pending')).findByRole('button', { name: 'Apply now…' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

describe('the retention line of a chat', () => {
  const line = (retention_days: 30 | null, retention_from: string | null) => render(<ChatRetentionLine conversation={{ retention_days, retention_from }} />).container.textContent;
  it('names the date during the 24 hours, then only the time, and nothing while messages are kept', () => {
    expect(line(30, new Date(Date.now() + 60 * 60 * 1000).toISOString())).toMatch(/^From .+, messages older than 30 days are deleted here$/);
    expect(line(30, new Date(Date.now() - 60 * 60 * 1000).toISOString())).toBe('Messages older than 30 days are deleted here');
    expect(line(null, null)).toBe('');
  });
});
