import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import InviteAccept from '@/pages/InviteAccept';
import { mountSignedIn } from './helpers/data-safety';

// /invite#<token> (0.30): the public page a setup link opens. It shows who
// the link is for and the rules that will apply to them, sets the password
// and signs in; a dead link is one screen with what to do next.

const state = vi.hoisted(() => ({ acceptInvite: vi.fn(), user: null as unknown }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: state.user, acceptInvite: state.acceptInvite }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const TOKEN = 'synthetic-setup-token-0123456789';
const CHECK = {
  email: 'casey@example.com', full_name: 'Casey Example', expires_at: '2026-06-22T09:30:00.000Z', rules_revision: 4,
  data_rules: ['Your administrator requires two-factor authentication.', 'Passwords need at least 14 characters, as your administrator set.'],
};
const mount = (hash = `#${TOKEN}`) => {
  window.history.replaceState(null, '', `/invite${hash}`);
  return mountSignedIn(<InviteAccept />, { path: '/invite', routePath: '*', auth: { user: null, session: null } });
};
const fill = (password: string, again = password) => {
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Password again'), { target: { value: again } });
};

beforeEach(() => {
  state.user = null;
  state.acceptInvite.mockResolvedValue({ error: null });
  vi.mocked(api.post).mockResolvedValue({ data: CHECK });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the setup link page', () => {
  it('shows who the link is for and their rules, takes the token out of the address, and sends no referrer', { timeout: 20_000 }, async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Set up your UniHub account' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/auth/invite/check', { token: TOKEN });
    expect(screen.getByText('casey@example.com')).toBeInTheDocument();
    const rules = screen.getByRole('list', { name: 'Rules in force' });
    expect(rules).toHaveTextContent('Your administrator requires two-factor authentication.');
    expect(rules).toHaveTextContent('Passwords need at least 14 characters');
    expect(screen.getByLabelText('Name')).toHaveValue('Casey Example');
    // The token is in no address bar, history entry or referrer once the page has it.
    expect(window.location.hash).toBe('');
    expect(document.head.querySelector('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  });

  it('sets the password with the name and the revision of the rules shown, then opens the app', { timeout: 20_000 }, async () => {
    mount();
    await screen.findByRole('heading', { name: 'Set up your UniHub account' }, { timeout: 10_000 });
    const submit = screen.getByRole('button', { name: 'Set password and sign in' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Casey E. Example' } });
    fill('a-long-synthetic-password', 'a-different-password');
    fireEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('The two passwords do not match.');
    expect(state.acceptInvite).not.toHaveBeenCalled();
    fill('a-long-synthetic-password');
    fireEvent.click(submit);
    await waitFor(() => expect(state.acceptInvite).toHaveBeenCalledExactlyOnceWith(TOKEN, 'a-long-synthetic-password', 'Casey E. Example', 4));
  });

  it('a password the server refuses keeps the form with the server\'s sentence', { timeout: 20_000 }, async () => {
    state.acceptInvite.mockResolvedValue({ error: new ApiError({ error: 'Passwords need at least 14 characters, as your administrator set.', status: 400, code: 'PASSWORD_TOO_SHORT' }) });
    mount();
    await screen.findByRole('heading', { name: 'Set up your UniHub account' }, { timeout: 10_000 });
    fill('twelve-chars');
    fireEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords need at least 14 characters');
    expect(screen.getByLabelText('Password')).toHaveValue('twelve-chars');
  });

  it('a link that is used, replaced or expired, at the check or at the save, is one screen that says what to do', { timeout: 20_000 }, async () => {
    vi.mocked(api.post).mockResolvedValue({ error: 'This setup link does not work.', status: 404, code: 'INVITE_INVALID' });
    mount();
    expect(await screen.findByRole('heading', { name: 'This setup link does not work' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText(/Ask your administrator for a new link/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/auth');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    cleanup();

    // Valid when opened, used by someone else before the password was sent.
    vi.mocked(api.post).mockResolvedValue({ data: CHECK });
    state.acceptInvite.mockResolvedValue({ error: new ApiError({ error: 'This setup link does not work.', status: 404, code: 'INVITE_INVALID' }) });
    mount();
    await screen.findByRole('heading', { name: 'Set up your UniHub account' }, { timeout: 10_000 });
    fill('a-long-synthetic-password');
    fireEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }));
    expect(await screen.findByRole('heading', { name: 'This setup link does not work' })).toBeInTheDocument();
  });

  it('an address without a token asks nothing of the server', { timeout: 20_000 }, async () => {
    mount('');
    expect(await screen.findByRole('heading', { name: 'This setup link does not work' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
