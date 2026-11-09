import { useEffect, useId, useState, type ReactNode } from 'react';
import { Loader2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Whose data an action concerns: "For Alex Example (alex@example.com)". */
export function TargetLine({ target }: { target: string }) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="confirm-target">
      <UserRound aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span><span className="text-muted-foreground">For </span><span className="break-words font-medium">{target}</span></span>
    </p>
  );
}

/**
 * Confirms an action with the person's own password: an administrator acting
 * on another account or on a server-wide rule, or someone deleting their own
 * account. The field is emptied as the request is sent: the typed
 * password lives in no state beyond the request itself, and a refusal leaves
 * the dialog open for another try. `target` names the person the action is done for, so an
 * administrator always sees whose data a password unlocks. The activity log
 * records the action.
 */
export function PasswordConfirmDialog({ open, onClose, title, description, target, children, actionLabel, destructive = false, pending, confirmDisabled = false, onConfirm }: {
  open: boolean; onClose: () => void; title: string; description: ReactNode; actionLabel: string;
  /** The person the action concerns, shown as its own line ("For Alex Example (alex@example.com)"). */
  target?: string;
  /** More to read or choose before the password, for example the fields of a schedule. */
  children?: ReactNode;
  destructive?: boolean; pending: boolean;
  /** The fields above the password are not yet complete. */
  confirmDisabled?: boolean;
  onConfirm: (currentPassword: string) => void;
}) {
  const [password, setPassword] = useState('');
  const id = useId();
  useEffect(() => { if (!open) setPassword(''); }, [open]);
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !pending) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {target && <TargetLine target={target} />}
        <form className="space-y-4 pt-2" onSubmit={event => { event.preventDefault(); if (!password || confirmDisabled) return; onConfirm(password); setPassword(''); }}>
          {children}
          <div className="space-y-2">
            <Label htmlFor={id}>Your password</Label>
            <Input id={id} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending || !password || confirmDisabled}>
              {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
              {actionLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
