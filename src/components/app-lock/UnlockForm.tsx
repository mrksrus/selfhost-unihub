import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Fingerprint, Loader2 } from 'lucide-react';
import { useAppLock, type AppLockPinState } from '@/hooks/use-app-lock';
import { Button } from '@/components/ui/button';
import { PinField } from '@/components/app-lock/PinField';
import { useCountdown } from '@/components/app-lock/use-countdown';
import { unlockMessage } from '@/components/app-lock/unlock-message';
import { cn } from '@/lib/utils';

interface UnlockFormProps {
  /** `unlock` opens this tab; `confirm` only checks the person (before a weakening change). */
  action: 'unlock' | 'confirm';
  /** On the button; "Unlock" or "Confirm". */
  label?: string;
  /** In the Android app: start the phone's prompt by itself once the form shows; the button retries. */
  autoStart?: boolean;
  autoFocus?: boolean;
  onSuccess: () => void;
  className?: string;
}

/**
 * The person proves it is them: with the UniHub PIN (a field and a button), or
 * in the Android app with the phone's own prompt (a button that opens it). The
 * answer's errors, the tries left and the wait between tries are announced in
 * one live region under the control. Used by the lock screen and by every
 * dialog that asks for the unlock.
 */
export function UnlockForm({ action, label = action === 'confirm' ? 'Confirm' : 'Unlock', autoStart = true, autoFocus = true, onSuccess, className }: UnlockFormProps) {
  const lock = useAppLock();
  const id = useId();
  const native = lock.method.method !== 'pin';
  const [pinMode, setPinMode] = useState(!native);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // The PIN's counts: the provider's, then the latest answer's.
  const [pinState, setPinState] = useState<AppLockPinState>(lock.pin);
  useEffect(() => setPinState(lock.pin), [lock.pin]);
  const seconds = useCountdown(pinState.waitUntil);
  const field = useRef<HTMLInputElement>(null);

  const run = async (typed?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await (action === 'confirm' ? lock.confirm(typed) : lock.unlock(typed));
      if (result.ok) { setPin(''); onSuccess(); return; }
      if (result.reason === 'pin-needed') { setPinMode(true); return; }
      if ('pin' in result) setPinState(result.pin);
      setMessage(unlockMessage(result));
      if (result.reason === 'wrong' || result.reason === 'invalid') { setPin(''); field.current?.focus(); }
    } finally {
      setBusy(false);
    }
  };

  // The phone's prompt opens once by itself; after a cancel or a failure the button opens it again.
  const started = useRef(false);
  useEffect(() => {
    if (!native || pinMode || !autoStart || started.current) return;
    started.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, pinMode, autoStart]);

  const waiting = seconds !== null;
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy && !waiting) void run(pin); };
  const status = (
    <div role="status" aria-live="polite" className="min-h-5 space-y-1 text-sm">
      {message && <p className="text-destructive">{message}</p>}
      {waiting && <p className="text-muted-foreground">Try again in {seconds} s.</p>}
      {pinState.attemptsLeft !== null && (
        <p className="text-warning">{pinState.attemptsLeft === 1 ? '1 try left' : `${pinState.attemptsLeft} tries left`} before this device is signed out.</p>
      )}
    </div>
  );

  if (!pinMode) {
    return (
      <div className={cn('space-y-3', className)}>
        <Button type="button" className="w-full" onClick={() => void run()} disabled={busy}>
          {busy ? <Loader2 aria-hidden="true" className="motion-safe:animate-spin" /> : <Fingerprint aria-hidden="true" />}{label}
        </Button>
        {status}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={cn('space-y-3', className)} noValidate>
      <PinField ref={field} id={`${id}-pin`} label="PIN" value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, ''))}
        autoFocus={autoFocus} disabled={busy || waiting} aria-invalid={!!message || undefined} aria-describedby={`${id}-status`} />
      <div id={`${id}-status`}>{status}</div>
      <Button type="submit" className="w-full" disabled={busy || waiting || pin.length < 6}>
        {busy && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}{label}
      </Button>
    </form>
  );
}
