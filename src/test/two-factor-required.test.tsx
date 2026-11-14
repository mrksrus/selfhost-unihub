import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { emitAppEvent } from '@/lib/app-events';
import { AppLockContext } from '@/hooks/use-app-lock';
import AppLayout from '@/components/layout/AppLayout';
import { TwoFactorReminder, useTwoFactorPrompt } from '@/components/organisation/TwoFactorRequired';
import { fakeAppLock } from './helpers/app-lock';
import { mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

// Two-factor authentication required by the administrator (0.30): a
// reminder during the person's 7 days, then the set-up in place of the app.
// The server says which (effective policies `two_factor`, 403
// TWO_FACTOR_REQUIRED); the page shows it.

const state = vi.hoisted(() => ({ toast: vi.fn(), signOut: vi.fn(async () => undefined), user: null as unknown }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: state.user, loading: false, serverUnavailable: false, retrySession: vi.fn(), signOut: state.signOut, setUser: (next: unknown) => { state.user = next; } }), useUserTimezone: () => 'UTC' }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, canNavigate: () => true, pages: [], modules: [] }), moduleForPath: () => undefined }));
vi.mock('@/hooks/use-background-notification-checks', () => ({ useBackgroundNotificationChecks: vi.fn() }));
vi.mock('@/hooks/use-calendar-notifications', () => ({ useCalendarNotifications: vi.fn() }));
vi.mock('@/hooks/use-mail-notifications', () => ({ useMailNotifications: vi.fn() }));
vi.mock('@/hooks/use-recording-uploads', () => ({ useRecordingUploadRunner: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const REASON = 'Your administrator requires two-factor authentication.';
const USER = { id: 'user-blair', email: 'blair@example.com', full_name: 'Blair Example', two_factor_enabled: false };
const days = (count: number) => new Date(Date.now() + count * 86_400_000).toISOString();
/** GET /policies/effective with the rule set and the person's grace. */
const rules = (twoFactor: { required: boolean; grace_ends_at: string | null } | null, revisions: { revision?: number; acknowledged?: number } = {}) => {
  const answer = policiesAnswer(twoFactor?.required ? { 'auth.two_factor': { value: 'required', reason: REASON } } : {}, revisions.revision ?? 1).data;
  return { data: { ...answer, acknowledged_revision: revisions.acknowledged ?? answer.revision, rules: twoFactor?.required ? [REASON] : [], two_factor: twoFactor } };
};
const answerWith = (effective: ReturnType<typeof rules>) => vi.mocked(api.get).mockImplementation(async (path: string) => path === '/policies/effective' ? effective : { data: {} });
const mountLayout = () => mountSignedIn(<AppLockContext.Provider value={fakeAppLock()}><AppLayout /></AppLockContext.Provider>, { user: USER });
const SETUP = { secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/UniHub%3Ablair%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=UniHub' };

beforeEach(() => {
  stubBrowserApis();
  sessionStorage.clear();
  state.user = { ...USER };
  vi.mocked(api.post).mockImplementation(async (path: string) => path === '/auth/2fa/setup/start' ? { data: SETUP }
    : path === '/auth/2fa/setup/confirm' ? { data: { recoveryCodes: ['aaaa-1111', 'bbbb-2222'] } } : { data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the reminder during the 7 days', () => {
  it('says until when, opens the set-up, and stays closed for the session once closed', { timeout: 20_000 }, async () => {
    answerWith(rules({ required: true, grace_ends_at: days(5) }));
    const view = mountSignedIn(<TwoFactorReminder />, { user: USER });
    const bar = await screen.findByRole('status', {}, { timeout: 10_000 });
    expect(bar).toHaveTextContent(REASON);
    expect(bar).toHaveTextContent(/Set it up by [\w ]+; after that you can only set it up or sign out\./);
    fireEvent.click(within(bar).getByRole('button', { name: 'Set up now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up two-factor authentication' });
    expect(api.post).toHaveBeenCalledWith('/auth/2fa/setup/start');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Close the reminder until the next start' }));
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
    // Another page of the same session does not bring it back.
    view.unmount();
    const before = vi.mocked(api.get).mock.calls.length;
    mountSignedIn(<TwoFactorReminder />, { user: USER });
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByText(REASON)).not.toBeInTheDocument();
  });

  it('does not show for a person who has two-factor authentication, or while the rule does not apply', { timeout: 20_000 }, async () => {
    answerWith(rules({ required: true, grace_ends_at: null }));
    state.user = { ...USER, two_factor_enabled: true };
    const view = mountSignedIn(<TwoFactorReminder />, { user: USER });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    view.unmount();
    state.user = { ...USER };
    answerWith(rules({ required: false, grace_ends_at: null }));
    const before = vi.mocked(api.get).mock.calls.length;
    mountSignedIn(<TwoFactorReminder />, { user: USER });
    await waitFor(() => expect(vi.mocked(api.get).mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('the set-up in place of the app, after the 7 days', () => {
  it('replaces the shell with the server\'s reason, and stays until the recovery codes are closed', { timeout: 30_000 }, async () => {
    answerWith(rules({ required: true, grace_ends_at: days(-3) }));
    mountLayout();
    expect(await screen.findByRole('heading', { name: 'Set up two-factor authentication to continue' }, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText(REASON)).toBeInTheDocument();
    expect(screen.getByText(/The time to set it up ended on [\w ]+\. Until it is on, you can only set it up or sign out\./)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Set up two-factor authentication' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set up two-factor authentication' });
    fireEvent.change(within(dialog).getByLabelText('Current password'), { target: { value: 'own-password' } });
    fireEvent.change(within(dialog).getByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/auth/2fa/setup/confirm', { secret: SETUP.secret, code: '123456', current_password: 'own-password' }));
    // The rule is met now, but the codes are shown only once: the prompt and its dialog stay until Done.
    const codes = await screen.findByRole('list', { name: 'Recovery codes' });
    expect(codes).toHaveTextContent('aaaa-1111');
    expect((state.user as { two_factor_enabled: boolean }).two_factor_enabled).toBe(true);
    expect(screen.getByRole('heading', { name: 'Set up two-factor authentication to continue', hidden: true })).toBeInTheDocument();
  });

  it('signs out from the prompt', { timeout: 20_000 }, async () => {
    answerWith(rules({ required: true, grace_ends_at: days(-1) }));
    mountLayout();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }, { timeout: 10_000 }));
    await waitFor(() => expect(state.signOut).toHaveBeenCalledOnce());
  });

  it('a request the server refuses with TWO_FACTOR_REQUIRED opens the prompt with its reason, whatever the page last read', { timeout: 20_000 }, async () => {
    // The page still believes the grace runs (a stale answer); the server knows better.
    answerWith(rules({ required: true, grace_ends_at: days(2) }));
    const Probe = () => useTwoFactorPrompt() ?? <p>the app</p>;
    mountSignedIn(<Probe />, { user: USER });
    expect(await screen.findByText('the app')).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    act(() => emitAppEvent('unihub:two-factor-required', { grace_ended_at: days(-1), reason: 'Two-factor authentication is required for the Finance group.' }));
    expect(await screen.findByRole('heading', { name: 'Set up two-factor authentication to continue' })).toBeInTheDocument();
    expect(screen.getByText('Two-factor authentication is required for the Finance group.')).toBeInTheDocument();
    expect(screen.queryByText('the app')).not.toBeInTheDocument();
  });

  it('the data rules notice opens first, over the prompt', { timeout: 20_000 }, async () => {
    answerWith(rules({ required: true, grace_ends_at: days(-1) }, { revision: 4, acknowledged: 3 }));
    mountLayout();
    const notice = await screen.findByRole('dialog', { name: 'Your administrator changed the data rules' }, { timeout: 10_000 });
    expect(within(notice).getByRole('list', { name: 'Rules in force' })).toHaveTextContent(REASON);
    expect(screen.getByRole('heading', { name: 'Set up two-factor authentication to continue', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { hidden: true })).not.toBeInTheDocument();
  });
});
