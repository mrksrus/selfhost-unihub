import { useEffect, useId, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * Confirms an action on another account, or a server-wide rule, with the
 * administrator's own password; the dialog stays open with the password kept
 * when the server refuses it. The activity log records the action.
 */
export function PasswordConfirmDialog({ open, onClose, title, description, actionLabel, destructive = false, pending, onConfirm }: {
  open: boolean; onClose: () => void; title: string; description: string; actionLabel: string;
  destructive?: boolean; pending: boolean; onConfirm: (currentPassword: string) => void;
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
        <form className="space-y-4 pt-2" onSubmit={event => { event.preventDefault(); if (password) onConfirm(password); }}>
          <div className="space-y-2">
            <Label htmlFor={id}>Your password</Label>
            <Input id={id} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending || !password}>
              {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
              {actionLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
