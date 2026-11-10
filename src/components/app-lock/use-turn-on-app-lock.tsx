import { useRef, useState, type ReactNode } from 'react';
import { useAppLock, type DeviceSettings } from '@/hooks/use-app-lock';
import type { DeviceSettingValues } from '../../../api/src/contracts/settings';
import { PinDialog } from '@/components/app-lock/PinDialog';
import { unlockMessage } from '@/components/app-lock/unlock-message';

export type TurnOnOutcome = { ok: true; settings: DeviceSettings } | { ok: false; message: string | null };
type Pending = { patch: Partial<DeviceSettingValues>; resolve: (outcome: TurnOnOutcome) => void };

/**
 * Turning the lock on needs a method first: on the web a UniHub PIN (set in a
 * dialog when there is none yet), in the Android app one confirmation with
 * the phone's prompt. Then the settings are saved. The dialog is rendered by
 * the caller (`dialog`), so the flow can start from a button anywhere.
 */
export function useTurnOnAppLock() {
  const lock = useAppLock();
  const pending = useRef<Pending | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (patch: Partial<DeviceSettingValues>): Promise<TurnOnOutcome> => {
    setBusy(true);
    try {
      return { ok: true, settings: await lock.saveSettings(patch) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The settings were not saved.' };
    } finally {
      setBusy(false);
    }
  };

  const turnOn = async (patch: Partial<DeviceSettingValues>): Promise<TurnOnOutcome> => {
    const method = lock.method;
    if (method.method === 'pin') {
      if (method.pinUnavailable) return { ok: false, message: method.pinUnavailable };
      if (method.pinSet) return save(patch);
      // The PIN dialog settles the promise: with the saved settings once a PIN is set, with nothing when it is closed.
      return new Promise<TurnOnOutcome>(resolve => { pending.current = { patch, resolve }; setPinOpen(true); });
    }
    setBusy(true);
    try {
      const confirmed = await lock.confirm();
      if (!confirmed.ok) return { ok: false, message: unlockMessage(confirmed) };
    } finally {
      setBusy(false);
    }
    return save(patch);
  };

  const settle = (outcome: Promise<TurnOnOutcome> | TurnOnOutcome) => {
    const current = pending.current;
    pending.current = null;
    if (current) void Promise.resolve(outcome).then(current.resolve);
  };

  const dialog: ReactNode = (
    <PinDialog open={pinOpen} mode="set"
      onOpenChange={open => { setPinOpen(open); if (!open) settle({ ok: false, message: null }); }}
      onDone={() => { if (pending.current) settle(save(pending.current.patch)); }} />
  );

  return { turnOn, dialog, busy };
}
