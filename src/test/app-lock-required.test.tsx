import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { AppLockContext, type AppLockValue } from '@/hooks/use-app-lock';
import { DEFAULT_DEVICE_SETTINGS, defaultsResolved } from '@/lib/settings-defaults';
import { AppLockRequiredPrompt } from '@/components/app-lock/AppLockRequiredPrompt';
import AppLayout from '@/components/layout/AppLayout';
import { fakeAppLock } from './helpers/app-lock';
import { mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }), clearToasts: vi.fn() }));
vi.mock('@/contexts/useAuth', () => ({ useAuth: () => ({ user: { id: 'user-ada', email: 'ada@example.com', full_name: 'Ada Example' }, loading: false, serverUnavailable: false, retrySession: vi.fn(), signOut: vi.fn() }), useUserTimezone: () => 'UTC' }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, canNavigate: () => true, pages: [],
  modules: [{ id: 'mail', label: 'Mail' }, { id: 'calendar', label: 'Calendar and ToDo' }, { id: 'contacts', label: 'Contacts' }, { id: 'recordings', label: 'Recordings and Music' }] }), moduleForPath: () => undefined }));
vi.mock('@/hooks/use-background-notification-checks', () => ({ useBackgroundNotificationChecks: vi.fn() }));
vi.mock('@/hooks/use-calendar-notifications', () => ({ useCalendarNotifications: vi.fn() }));
vi.mock('@/hooks/use-mail-notifications', () => ({ useMailNotifications: vi.fn() }));
vi.mock('@/hooks/use-recording-uploads', () => ({ useRecordingUploadRunner: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const REASON = 'Your administrator requires the app lock for Mail and Contacts.';
const requirement = { required: ['mail', 'contacts'] as const, max_background: '300' as const, reason: REASON, meets: false };
const typePin = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.get).mockImplementation(async (path: string) => path === '/policies/effective' ? policiesAnswer() : { data: {} });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('the "required by your administrator" prompt', () => {
  it('tells the server\'s reason and what is required, then sets a PIN and saves a scope that meets it', { timeout: 20_000 }, async () => {
    const setPin = vi.fn(async () => ({ ok: true as const }));
    const saveSettings = vi.fn(async () => defaultsResolved({ ...DEFAULT_DEVICE_SETTINGS, app_lock_scope: ['mail', 'contacts'] as never }));
    const lock = fakeAppLock({ status: 'setup', scope: [], requirement: { ...requirement, required: [...requirement.required] }, setPin, saveSettings, settingsLoaded: true });
    mountSignedIn(<AppLockContext.Provider value={lock}><AppLockRequiredPrompt area="mail" variant="inline" /></AppLockContext.Provider>);
    expect(screen.getByRole('heading', { name: 'Your administrator requires the app lock' })).toBeInTheDocument();
    expect(screen.getByText(REASON)).toBeInTheDocument();
    expect(screen.getByText('Mail and Contacts; UniHub locks after 5 minutes in the background at most.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on the app lock' }));
    const dialog = await screen.findByRole('dialog', { name: 'Set a UniHub PIN' });
    typePin(within(dialog).getByLabelText('New PIN'), '987654');
    typePin(within(dialog).getByLabelText('New PIN again'), '987654');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set PIN' }));
    await waitFor(() => expect(setPin).toHaveBeenCalledWith('987654', undefined));
    // The device's own minute is within the 5 minutes allowed, so it stays.
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ app_lock_scope: ['mail', 'contacts'], app_lock_relock_after: '60' }));
  });

  it('in the Android app it confirms with the phone\'s prompt instead of a PIN, and shows a refused save', async () => {
    const confirm = vi.fn(async () => ({ ok: true as const }));
    const saveSettings = vi.fn(async () => { throw new Error('Your administrator allows at most 5 minutes in the background before UniHub locks again.'); });
    const lock = fakeAppLock({ status: 'setup', scope: [], requirement: { ...requirement, required: ['app'] }, confirm, saveSettings, settingsLoaded: true,
      method: { method: 'biometric', biometric: 'available', deviceSecure: true, pinSet: false, pinUnavailable: null, appUpdateForBiometrics: false } });
    mountSignedIn(<AppLockContext.Provider value={lock}><AppLockRequiredPrompt area="app" variant="page" /></AppLockContext.Provider>);
    expect(screen.getByText('The whole app; UniHub locks after 5 minutes in the background at most.')).toBeInTheDocument();
    expect(screen.getByText('You unlock with your fingerprint, face or the phone\'s PIN.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on the app lock' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ app_lock_scope: ['app'], app_lock_relock_after: '60' }));
    expect(await screen.findByText('Your administrator allows at most 5 minutes in the background before UniHub locks again.')).toBeInTheDocument();
  });

  it('an older app says to update for the fingerprint and offers the PIN meanwhile', () => {
    const lock = fakeAppLock({ status: 'setup', requirement: { ...requirement, required: ['mail'] },
      method: { ...fakeAppLock().method, appUpdateForBiometrics: true } });
    mountSignedIn(<AppLockContext.Provider value={lock}><AppLockRequiredPrompt area="mail" variant="inline" /></AppLockContext.Provider>);
    expect(screen.getByText('Update the UniHub app to unlock with your fingerprint. Until then, use a UniHub PIN.')).toBeInTheDocument();
  });

  it('the data rules notice opens first, over the prompt that replaces the shell', async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => path === '/policies/effective'
      ? { data: { ...policiesAnswer({ 'app_lock.required': { value: ['app'], reason: REASON } }, 4).data, acknowledged_revision: 3, rules: [REASON] } }
      : { data: {} });
    vi.mocked(api.post).mockResolvedValue({ data: { acknowledged_revision: 4 } });
    const lock: AppLockValue = fakeAppLock({ status: 'setup', scope: ['app'], requirement: { ...requirement, required: ['app'], reason: REASON } });
    mountSignedIn(<AppLockContext.Provider value={lock}><AppLayout /></AppLockContext.Provider>);
    const notice = await screen.findByRole('dialog', { name: 'Your administrator changed the data rules' });
    expect(within(notice).getByRole('list', { name: 'Rules in force' })).toHaveTextContent(REASON);
    // The prompt is behind it (the modal notice hides it from assistive technology meanwhile); nothing of the shell is.
    expect(screen.getByRole('heading', { name: 'Your administrator requires the app lock', hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main', hidden: true })).not.toBeInTheDocument();
    fireEvent.click(within(notice).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/policies/acknowledge', { revision: 4 }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Your administrator changed the data rules' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Turn on the app lock' })).toBeEnabled();
  });
});
