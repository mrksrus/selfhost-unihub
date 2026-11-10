import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { AppLockContext, type AppLockArea, type AppLockValue, type DeviceSettings, type RelockAfter } from '@/hooks/use-app-lock';
import { DEFAULT_DEVICE_SETTINGS, defaultsResolved } from '@/lib/settings-defaults';
import AppLockSettings from '@/components/settings/AppLockSettings';
import { fakeAppLock } from './helpers/app-lock';
import { mountSignedIn, policiesAnswer, stubBrowserApis } from './helpers/data-safety';

const state = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock('@/hooks/use-modules', () => ({ useModules: () => ({ isPending: false, isEnabled: () => true, canAccess: () => true, pages: [],
  modules: [{ id: 'mail', label: 'Mail' }, { id: 'calendar', label: 'Calendar and ToDo' }, { id: 'contacts', label: 'Contacts' }, { id: 'recordings', label: 'Recordings and Music' }] }) }));
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } }));

const REQUIRED_REASON = 'Your administrator requires the app lock for Mail.';
const MAX_REASON = 'Your administrator allows at most 5 minutes in the background before UniHub locks again.';

/** This device's settings as the server resolves them, with a floor where the policies set one. */
function settingsWith({ scope = [], relock = '60', scopeFloor, relockFloor }: { scope?: AppLockArea[]; relock?: RelockAfter; scopeFloor?: AppLockArea[]; relockFloor?: RelockAfter } = {}): DeviceSettings {
  const settings = defaultsResolved({ ...DEFAULT_DEVICE_SETTINGS, app_lock_scope: scope, app_lock_relock_after: relock });
  if (scopeFloor) settings.app_lock_scope = { ...settings.app_lock_scope, source: 'policy', floor: scopeFloor };
  if (relockFloor) settings.app_lock_relock_after = { ...settings.app_lock_relock_after, source: 'policy', floor: relockFloor };
  return settings;
}

function mount(overrides: Partial<AppLockValue>) {
  const lock = fakeAppLock({ status: overrides.scope?.length ? 'unlocked' : 'off', settingsLoaded: true, ...overrides });
  mountSignedIn(<AppLockContext.Provider value={lock}><AppLockSettings /></AppLockContext.Provider>);
  return lock;
}
const typePin = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

beforeEach(() => {
  stubBrowserApis();
  vi.mocked(api.get).mockResolvedValue(policiesAnswer());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Settings → App lock', () => {
  it('turning the lock on from the web sets a PIN first, then saves the whole-app scope', { timeout: 20_000 }, async () => {
    const setPin = vi.fn(async () => ({ ok: true as const }));
    const saveSettings = vi.fn(async () => settingsWith({ scope: ['app'] }));
    mount({ settings: settingsWith(), setPin, saveSettings });
    expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked();
    expect(screen.getByText('Applies to this device', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Whole app/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Set a UniHub PIN' });
    expect(saveSettings).not.toHaveBeenCalled();
    typePin(within(dialog).getByLabelText('New PIN'), '246810');
    typePin(within(dialog).getByLabelText('New PIN again'), '246811');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set PIN' }));
    expect(await within(dialog).findByText('The two PINs are not the same.')).toBeInTheDocument();
    typePin(within(dialog).getByLabelText('New PIN again'), '246810');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set PIN' }));
    await waitFor(() => expect(setPin).toHaveBeenCalledWith('246810', undefined));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ app_lock_scope: ['app'] }));
  });

  it('greys the choices under the administrator\'s requirement with the server\'s reason, never hiding them', { timeout: 20_000 }, async () => {
    vi.mocked(api.get).mockResolvedValue(policiesAnswer({
      'app_lock.required': { value: ['mail'], reason: REQUIRED_REASON },
      'app_lock.max_background': { value: '300', reason: MAX_REASON },
    }));
    mount({ settings: settingsWith({ scope: ['mail'], relock: '60', scopeFloor: ['mail'], relockFloor: '300' }), method: { ...fakeAppLock().method, pinSet: true } });
    expect(await screen.findByText(REQUIRED_REASON)).toBeInTheDocument();
    expect(screen.getByText(MAX_REASON)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Off' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Chosen modules' })).toBeChecked();
    const list = screen.getByRole('list', { name: 'Locked modules' });
    const mail = within(list).getByRole('checkbox', { name: /^Mail/ });
    expect(mail).toBeChecked();
    expect(mail).toBeDisabled();
    expect(within(list).getByRole('checkbox', { name: /^Contacts/ })).toBeEnabled();
    expect(within(list).getByText('Contacts synced to the phone stay in its Contacts app.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: 'Ask again' }));
    expect(await screen.findByRole('option', { name: 'After 15 minutes in the background' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: 'After 5 minutes in the background' })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: 'Every time UniHub opens' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('a weakening change asks for the unlock first and saves only once confirmed', { timeout: 20_000 }, async () => {
    const confirm = vi.fn(async (pin?: string) => (pin === '135790' ? { ok: true as const } : { ok: false as const, reason: 'wrong' as const, pin: { failures: 1, waitUntil: null, attemptsLeft: null } }));
    const saveSettings = vi.fn(async () => settingsWith({ scope: ['mail'] }));
    mount({ settings: settingsWith({ scope: ['mail', 'contacts'] }), method: { ...fakeAppLock().method, pinSet: true }, confirm, saveSettings });
    const contacts = within(screen.getByRole('list', { name: 'Locked modules' })).getByRole('checkbox', { name: /^Contacts/ });
    fireEvent.click(contacts);
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    expect(saveSettings).not.toHaveBeenCalled();
    typePin(within(dialog).getByLabelText('PIN'), '111111');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText('That is not the PIN.')).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
    typePin(within(dialog).getByLabelText('PIN'), '135790');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalledWith({ app_lock_scope: ['mail'] }));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('closing the unlock keeps the lock as it was, and a longer time asks too', { timeout: 20_000 }, async () => {
    const saveSettings = vi.fn(async () => settingsWith());
    mount({ settings: settingsWith({ scope: ['app'], relock: '60' }), method: { ...fakeAppLock().method, pinSet: true }, saveSettings });
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm it is you' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirm it is you' })).not.toBeInTheDocument());
    expect(saveSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: /Whole app/ })).toBeChecked();
    fireEvent.click(screen.getByRole('combobox', { name: 'Ask again' }));
    fireEvent.click(await screen.findByRole('option', { name: 'After 15 minutes in the background' }));
    expect(await screen.findByRole('dialog', { name: 'Confirm it is you' })).toBeInTheDocument();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('changing the PIN asks for the current one and sends both', async () => {
    const setPin = vi.fn(async () => ({ ok: true as const }));
    mount({ settings: settingsWith({ scope: ['app'] }), method: { ...fakeAppLock().method, pinSet: true }, setPin });
    expect(screen.getByText('Set for this browser.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change PIN' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the UniHub PIN' });
    typePin(within(dialog).getByLabelText('Current PIN'), '135790');
    typePin(within(dialog).getByLabelText('New PIN'), '24681012');
    typePin(within(dialog).getByLabelText('New PIN again'), '24681012');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change PIN' }));
    await waitFor(() => expect(setPin).toHaveBeenCalledWith('24681012', '135790'));
    await waitFor(() => expect(state.toast).toHaveBeenCalledWith({ title: 'PIN changed' }));
  });

  it('in the Android app the method row follows the phone, and the device-lock switch works there only', () => {
    mount({ settings: settingsWith({ scope: ['app'] }),
      method: { method: 'biometric', biometric: 'available', deviceSecure: true, pinSet: false, pinUnavailable: null, appUpdateForBiometrics: false },
      capabilities: { deviceLockSignal: true, deviceLockReason: null, secureWindow: true } });
    expect(screen.getByText('Fingerprint, face or the phone\'s PIN')).toBeInTheDocument();
    expect(screen.getByText('Set up on this phone.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /PIN/ })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Also when the phone is locked' })).toBeEnabled();
    cleanup();

    mount({ settings: settingsWith({ scope: ['app'] }),
      method: { method: 'device_credential', biometric: 'not_enrolled', deviceSecure: true, pinSet: false, pinUnavailable: null, appUpdateForBiometrics: false },
      capabilities: { deviceLockSignal: true, deviceLockReason: null, secureWindow: true }, screenshotsForbidden: true });
    expect(screen.getByText('No fingerprint or face is set up on this phone: its PIN is used.')).toBeInTheDocument();
    expect(screen.getByText('Screenshots')).toBeInTheDocument();
    cleanup();

    const reason = 'Your browser cannot tell when the device locks; UniHub locks after the time above.';
    mount({ settings: settingsWith(), capabilities: { deviceLockSignal: false, deviceLockReason: reason, secureWindow: false } });
    expect(screen.getByText('UniHub PIN')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Also when the phone is locked' })).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText('Screenshots')).not.toBeInTheDocument();
  });
});
