import { useId, useState } from 'react';
import { useAppLock, type AppLockArea, type RelockAfter } from '@/hooks/use-app-lock';
import { useModules } from '@/hooks/use-modules';
import { usePolicies } from '@/hooks/use-policies';
import { useToast } from '@/hooks/use-toast';
import type { DeviceSettingValues } from '../../../api/src/contracts/settings';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioRow } from '@/components/ui/radio';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { ADMIN_REASON } from '@/components/settings/setting-policy';
import { PinDialog } from '@/components/app-lock/PinDialog';
import { UnlockDialog } from '@/components/app-lock/UnlockDialog';
import { useTurnOnAppLock } from '@/components/app-lock/use-turn-on-app-lock';
import { areaLabel, LOCKABLE_MODULES, RELOCK_LABELS, RELOCK_ORDER, relockAllowed } from '@/components/app-lock/area-names';

// Settings → App lock (0.29, F5/F8). Everything here applies to this device:
// the server keeps the choice with the device record so it can enforce the
// administrator's requirement and hide notification text while the device is
// locked; the PIN or fingerprint itself never leaves the device. A choice
// below the administrator's requirement is checked and greyed with the
// server's reason. Turning the lock on asks for the method once; turning it
// off or weakening it asks for the unlock first.

type LockChoice = 'off' | 'app' | 'modules';
const choiceOf = (scope: readonly AppLockArea[]): LockChoice => scope.includes('app') ? 'app' : scope.length ? 'modules' : 'off';
/** True when `next` protects less than `current`: off, fewer modules, or the whole app narrowed to modules. */
function weakensScope(current: readonly AppLockArea[], next: readonly AppLockArea[]) {
  if (next.includes('app')) return false;
  if (current.includes('app')) return true;
  return current.some(area => !next.includes(area));
}

export const APP_LOCK_DOCS_URL = 'https://github.com/mrksrus/selfhost-unihub/blob/main/docs/APP_LOCK.md';

export default function AppLockSettings() {
  const lock = useAppLock();
  const { modules, isEnabled } = useModules();
  const { policies } = usePolicies();
  const { toast } = useToast();
  const { turnOn, dialog: setupDialog, busy: turningOn } = useTurnOnAppLock();
  const id = useId();
  const [choice, setChoice] = useState<LockChoice | null>(null);
  const [pinDialog, setPinDialog] = useState<'set' | 'change' | null>(null);
  const [confirming, setConfirming] = useState<Partial<DeviceSettingValues> | null>(null);
  const [saving, setSaving] = useState(false);

  const scopeSetting = lock.settings.app_lock_scope;
  const relockSetting = lock.settings.app_lock_relock_after;
  const deviceLockSetting = lock.settings.app_lock_on_device_lock;
  const scope = scopeSetting.value;
  const requiredScope = scopeSetting.floor ?? [];
  const maxBackground = relockSetting.floor ?? null;
  // The administrator's reasons come from the server with the rules, never from here.
  const requiredReason = requiredScope.length ? policies['app_lock.required'].reason ?? ADMIN_REASON : undefined;
  const maxReason = maxBackground ? policies['app_lock.max_background'].reason ?? ADMIN_REASON : undefined;
  const screenshotsReason = policies['app_lock.screenshots'].reason ?? ADMIN_REASON;
  const shownChoice = choice ?? choiceOf(scope);
  const busy = saving || turningOn;
  const native = lock.method.method !== 'pin';
  const lockable = LOCKABLE_MODULES.filter(moduleId => isEnabled(moduleId));

  const fail = (message: string | null) => { if (message) toast({ title: 'The app lock was not changed', description: message, variant: 'destructive' }); };

  /** Saves a change that does not weaken the lock; turning it on sets the method up first. */
  const save = async (patch: Partial<DeviceSettingValues>) => {
    const turningLockOn = !scope.length && !!patch.app_lock_scope?.length;
    if (turningLockOn) {
      const outcome = await turnOn(patch);
      if (!outcome.ok) fail(outcome.message);
      setChoice(null);
      return;
    }
    setSaving(true);
    try {
      await lock.saveSettings(patch);
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The settings were not saved.');
    } finally {
      setSaving(false);
      setChoice(null);
    }
  };
  /** A weakening change waits for the unlock; the dialog saves it once the person is confirmed. */
  const weaken = (patch: Partial<DeviceSettingValues>) => setConfirming(patch);
  const change = (patch: Partial<DeviceSettingValues>) => {
    const nextScope = patch.app_lock_scope ?? scope;
    const nextRelock = patch.app_lock_relock_after ?? relockSetting.value;
    const weakens = scope.length > 0 && (weakensScope(scope, nextScope) || !relockAllowed(nextRelock, relockSetting.value));
    if (weakens) weaken(patch); else void save(patch);
  };

  const chooseLock = (next: LockChoice) => {
    if (next === 'off') { if (scope.length) change({ app_lock_scope: [] }); return; }
    if (next === 'app') { change({ app_lock_scope: ['app'] }); return; }
    // Chosen modules: from the whole app, every enabled module; from off, nothing is locked until a module is ticked.
    setChoice('modules');
    if (scope.includes('app')) change({ app_lock_scope: lockable });
  };
  const toggleModule = (moduleId: AppLockArea, checked: boolean) => {
    const next = LOCKABLE_MODULES.filter(area => (area === moduleId ? checked : scope.includes(area)));
    change({ app_lock_scope: next });
  };

  const methodDescription = native
    ? lock.method.biometric === 'not_enrolled' ? 'No fingerprint or face is set up on this phone: its PIN is used.'
      : lock.method.biometric === 'available' ? 'Set up on this phone.' : 'The phone\'s screen lock is used.'
    : lock.method.pinUnavailable ?? (lock.method.appUpdateForBiometrics
      ? `Update the UniHub app to unlock with your fingerprint. Until then, use a UniHub PIN${lock.method.pinSet ? ', set for this device' : ''}.`
      : lock.method.pinSet ? 'Set for this browser.' : 'Not set yet. The PIN stays in this browser.');
  const needsScreenLock = !native && lock.capabilities.secureWindow && !lock.method.deviceSecure;

  return (
    <>
      <SettingsSection title="App lock" description="Applies to this device. UniHub asks for the lock before it shows what is locked; the choice is kept with this device on the server, which enforces what your administrator requires.">
        <SettingsRow label="Lock" stack lock={requiredReason}>
          <div role="radiogroup" aria-label="Lock" className="w-full">
            <RadioRow id={`${id}-off`} name={`${id}-lock`} label="Off" checked={shownChoice === 'off'} disabled={busy || requiredScope.length > 0} onChange={() => chooseLock('off')} />
            <RadioRow id={`${id}-app`} name={`${id}-lock`} label="Whole app" description="Everything, the dashboard and settings included." checked={shownChoice === 'app'} disabled={busy} onChange={() => chooseLock('app')} />
            <RadioRow id={`${id}-modules`} name={`${id}-lock`} label="Chosen modules" checked={shownChoice === 'modules'} disabled={busy || requiredScope.includes('app')} onChange={() => chooseLock('modules')} />
            {shownChoice === 'modules' && (
              <ul aria-label="Locked modules" className="mb-1 ml-9 space-y-1">
                {lockable.map(moduleId => {
                  const required = requiredScope.includes(moduleId);
                  return (
                    <li key={moduleId} className="flex items-start gap-3 py-1.5 touch:py-2">
                      <Checkbox id={`${id}-${moduleId}`} className="mt-0.5" checked={scope.includes(moduleId)} disabled={busy || required}
                        onCheckedChange={checked => toggleModule(moduleId, checked === true)} />
                      <label htmlFor={`${id}-${moduleId}`} className="min-w-0 text-sm">
                        {areaLabel(moduleId, modules)}
                        {moduleId === 'contacts' && <span className="block text-xs text-muted-foreground">Contacts synced to the phone stay in its Contacts app.</span>}
                        {required && <span className="block text-xs text-muted-foreground">Required</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </SettingsRow>

        <SettingsRow label="Unlock with" description={<>
          <span className="block">{native ? 'Fingerprint, face or the phone\'s PIN' : 'UniHub PIN'}</span>
          <span className="block">{methodDescription}</span>
          {needsScreenLock && <span className="block">Set a screen lock in Android settings, or use a UniHub PIN instead.</span>}
        </>}>
          {!native && (
            <Button variant="outline" disabled={busy || !!lock.method.pinUnavailable} onClick={() => setPinDialog(lock.method.pinSet ? 'change' : 'set')}>
              {lock.method.pinSet ? 'Change PIN' : 'Set PIN'}
            </Button>
          )}
        </SettingsRow>

        <SettingsRow label="Ask again" htmlFor={`${id}-relock`} lock={maxReason}>
          <Select value={relockSetting.value} disabled={busy || relockSetting.locked} onValueChange={value => change({ app_lock_relock_after: value as RelockAfter })}>
            <SelectTrigger id={`${id}-relock`} className="w-full sm:w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[...RELOCK_ORDER].map(value => (
                <SelectItem key={value} value={value} disabled={!relockAllowed(value, maxBackground)}>{RELOCK_LABELS[value]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow label="Also when the phone is locked" htmlFor={`${id}-device-lock`} lock={lock.capabilities.deviceLockReason ?? undefined}
          description="Lock as soon as the phone's screen locks, whatever the time above.">
          <Switch id={`${id}-device-lock`} checked={deviceLockSetting.value} disabled={busy || !lock.capabilities.deviceLockSignal || deviceLockSetting.locked}
            onCheckedChange={checked => change({ app_lock_on_device_lock: checked })} />
        </SettingsRow>

        {lock.screenshotsForbidden && (
          <SettingsRow label="Screenshots" description="Blocked in the UniHub app." lock={screenshotsReason} />
        )}

        <SettingsBlock>
          <p className="max-w-prose text-xs text-muted-foreground">
            What the app lock protects: it stops someone holding this unlocked device from opening UniHub. It does not protect the server, the data on its way, or this device's storage against someone who can copy it. A browser keeps the PIN itself and cannot block screenshots.{' '}
            <a href={APP_LOCK_DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Read more</a>
          </p>
        </SettingsBlock>
      </SettingsSection>

      {setupDialog}
      <PinDialog open={pinDialog !== null} mode={pinDialog ?? 'set'} onOpenChange={open => { if (!open) setPinDialog(null); }}
        onDone={() => toast({ title: pinDialog === 'change' ? 'PIN changed' : 'PIN set' })} />
      <UnlockDialog open={confirming !== null} action="confirm" title="Confirm it is you" description="Weakening the app lock asks for the unlock first."
        onOpenChange={open => { if (!open) { setConfirming(null); setChoice(null); } }}
        onSuccess={() => { if (confirming) void save(confirming); setConfirming(null); }} />
    </>
  );
}
