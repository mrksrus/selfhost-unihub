import { useAppLock } from '@/hooks/use-app-lock';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { UnlockForm } from '@/components/app-lock/UnlockForm';

interface UnlockDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `unlock` opens this tab (a locked placeholder's Unlock); `confirm` only checks the person before a weakening change. */
  action?: 'unlock' | 'confirm';
  title?: string;
  description?: string;
  onSuccess: () => void;
}

/**
 * The unlock asked for in place: from a locked placeholder (the dashboard, the
 * email peek, the search) or before a change that weakens the lock. Closing it
 * without the PIN or the phone's prompt changes nothing.
 */
export function UnlockDialog({ open, onOpenChange, action = 'unlock', title, description, onSuccess }: UnlockDialogProps) {
  const lock = useAppLock();
  const native = lock.method.method !== 'pin';
  const heading = title ?? (action === 'confirm' ? 'Confirm it is you' : 'Unlock UniHub');
  const text = description ?? (native ? 'Use your fingerprint, face or the phone\'s PIN.' : 'Enter your UniHub PIN.');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{text}</DialogDescription>
        </DialogHeader>
        {open && <UnlockForm action={action} onSuccess={() => { onSuccess(); onOpenChange(false); }} />}
      </DialogContent>
    </Dialog>
  );
}
