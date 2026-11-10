import { useId, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { useAppLock } from '@/hooks/use-app-lock';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PinField } from '@/components/app-lock/PinField';
import { unlockMessage } from '@/components/app-lock/unlock-message';

const PIN = /^\d{6,12}$/;

interface PinDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `set` for the first PIN; `change` asks for the current one first. */
  mode: 'set' | 'change';
  /** Called once the PIN is saved. */
  onDone?: () => void;
}

/**
 * Sets or changes the UniHub PIN: 6 to 12 digits, typed twice. The PIN stays
 * in this browser (the server only learns that this device locks with one).
 */
export function PinDialog({ open, onOpenChange, mode, onDone }: PinDialogProps) {
  const lock = useAppLock();
  const id = useId();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const digits = (value: string) => value.replace(/\D/g, '');

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) { setCurrent(''); setPin(''); setAgain(''); setError(null); }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!PIN.test(pin)) { setError('A PIN has 6 to 12 digits.'); return; }
    if (pin !== again) { setError('The two PINs are not the same.'); return; }
    if (mode === 'change' && !PIN.test(current)) { setError('Enter your current PIN first.'); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await lock.setPin(pin, mode === 'change' ? current : undefined);
      if (result.ok) { onDone?.(); close(false); return; }
      if (result.reason === 'unsupported') { setError(lock.method.pinUnavailable ?? 'This browser cannot keep a UniHub PIN.'); return; }
      if (result.reason === 'invalid') { setError('A PIN has 6 to 12 digits.'); return; }
      if (result.reason === 'wrong') { setError('That is not your current PIN.'); setCurrent(''); return; }
      setError(unlockMessage(result) ?? 'The PIN was not saved. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{mode === 'change' ? 'Change the UniHub PIN' : 'Set a UniHub PIN'}</DialogTitle>
          <DialogDescription>6 to 12 digits. It stays in this browser; UniHub asks for it when it locks.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {mode === 'change' && (
            <PinField id={`${id}-current`} label="Current PIN" showLabel value={current} onChange={event => setCurrent(digits(event.target.value))} autoFocus disabled={busy} />
          )}
          <PinField id={`${id}-new`} label="New PIN" showLabel value={pin} onChange={event => setPin(digits(event.target.value))} autoFocus={mode === 'set'} disabled={busy} />
          <PinField id={`${id}-again`} label="New PIN again" showLabel value={again} onChange={event => setAgain(digits(event.target.value))} disabled={busy}
            aria-invalid={!!error || undefined} aria-describedby={`${id}-error`} />
          <p id={`${id}-error`} role="status" aria-live="polite" className="min-h-5 text-sm text-destructive">{error}</p>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={() => close(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || pin.length < 6 || again.length < 6 || (mode === 'change' && current.length < 6)}>
              {busy && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}{mode === 'change' ? 'Change PIN' : 'Set PIN'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
