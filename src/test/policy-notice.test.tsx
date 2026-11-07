import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { api } from '@/lib/api';
import { PolicyNoticeDialog } from '@/components/policies/PolicyNoticeDialog';
import { RulesOnThisServer } from '@/components/settings/AccountSettings';
import Auth from '@/pages/Auth';
import { mountSignedIn, policiesAnswer, stubBrowserApis, testClient } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn(), signupMode: { mode: 'open' as const, dataRules: [] as string[] }, auth: { user: null as unknown, isOffline: false } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/auth-api', () => ({ fetchPublicSignupMode: vi.fn(async () => state.signupMode) }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ ...state.auth, loading: false, signIn: vi.fn(), signUp: vi.fn(), verifyTwoFactorLogin: vi.fn() }) }));

const RULES = ['Your administrator does not allow deleting items from the bin for good.', 'Your administrator keeps each of your backups at least 90 days.'];
const rules = (revision: number, acknowledged: number, list = RULES) => ({ data: { ...policiesAnswer().data, revision, acknowledged_revision: acknowledged, rules: list } });

beforeEach(() => { stubBrowserApis(); state.auth = { user: { id: 'user-ada', email: 'ada@example.com', role: 'user' }, isOffline: false }; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// D38: the notice of the data rules. The server keeps the revision each
// person confirmed; the dialog opens while theirs is behind, lists the rules
// in force, and OK records the revision shown, so it opens once per change.
describe('the data rules notice', () => {
  it('opens once for an unacknowledged revision, lists the rules, and OK records the revision', async () => {
    vi.mocked(api.get).mockResolvedValue(rules(3, 2));
    vi.mocked(api.post).mockResolvedValue({ data: { acknowledged_revision: 3 } });
    const client = testClient();
    mountSignedIn(<PolicyNoticeDialog />, { client });
    const dialog = await screen.findByRole('dialog', { name: 'Your administrator changed the data rules' });
    const list = within(dialog).getByRole('list', { name: 'Rules in force' });
    expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual(RULES);
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/policies/acknowledge', { revision: 3 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The same revision stays confirmed: another mount in this session opens nothing.
    cleanup();
    mountSignedIn(<PolicyNoticeDialog />, { client });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('stays closed while the revision is confirmed, and reads as the server\'s rules for a person who never confirmed any', async () => {
    vi.mocked(api.get).mockResolvedValue(rules(3, 3));
    const { unmount } = mountSignedIn(<PolicyNoticeDialog />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/policies/effective', expect.anything()));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();
    // An administrator created the account: nothing changed for them, the rules are new to them.
    vi.mocked(api.get).mockResolvedValue(rules(3, 0));
    mountSignedIn(<PolicyNoticeDialog />);
    expect(await screen.findByRole('dialog', { name: 'Rules on this server' })).toBeInTheDocument();
  });

  it('closed without OK, it records nothing and does not come back in this session', async () => {
    vi.mocked(api.get).mockResolvedValue(rules(3, 2));
    mountSignedIn(<PolicyNoticeDialog />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a revision without any rule left still says so and can be confirmed', async () => {
    vi.mocked(api.get).mockResolvedValue(rules(4, 3, []));
    vi.mocked(api.post).mockResolvedValue({ data: { acknowledged_revision: 4 } });
    mountSignedIn(<PolicyNoticeDialog />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('No rule limits what you can do on this server right now.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/policies/acknowledge', { revision: 4 }));
  });
});

describe('Settings → Profile, Rules on this server', () => {
  it('lists the rules in force, or says that none limits the person', async () => {
    vi.mocked(api.get).mockResolvedValue(rules(3, 3));
    const { unmount } = mountSignedIn(<RulesOnThisServer />);
    const section = (await screen.findByRole('heading', { name: 'Rules on this server' })).closest('section')!;
    await waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(2));
    expect(within(section).getByText(RULES[1])).toBeInTheDocument();
    unmount();
    vi.mocked(api.get).mockResolvedValue(rules(0, 0, []));
    mountSignedIn(<RulesOnThisServer />);
    expect(await screen.findByText('No rule limits what you can do on this server right now.')).toBeInTheDocument();
  });

  it('needs a connection', async () => {
    state.auth = { ...state.auth, isOffline: true };
    mountSignedIn(<RulesOnThisServer />);
    expect(await screen.findByText('The rules need a connection.')).toBeInTheDocument();
  });
});

describe('the sign-up form', () => {
  // Radix tabs switch on the pointer going down, not on click.
  const openSignUp = () => { const tab = screen.getByRole('tab', { name: 'Create account' }); fireEvent.mouseDown(tab, { button: 0 }); fireEvent.focus(tab); fireEvent.click(tab); };
  it('lists the rules that limit a new person, and nothing when there are none', async () => {
    state.auth = { user: null, isOffline: false };
    state.signupMode = { mode: 'open', dataRules: RULES };
    const { unmount } = render(<MemoryRouter><Auth /></MemoryRouter>);
    openSignUp();
    const section = (await screen.findByRole('heading', { name: 'Rules on this server' })).closest('section')!;
    expect(within(section).getAllByRole('listitem').map(item => item.textContent)).toEqual(RULES);
    unmount();
    state.signupMode = { mode: 'open', dataRules: [] };
    render(<MemoryRouter><Auth /></MemoryRouter>);
    openSignUp();
    await screen.findByRole('button', { name: 'Create account' });
    expect(screen.queryByRole('heading', { name: 'Rules on this server' })).not.toBeInTheDocument();
  });
});
