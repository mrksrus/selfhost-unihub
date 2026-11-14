import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { confirmTwoFactorSetup, type TwoFactorSetup } from '@/lib/auth-api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TotpQrCode } from '@/components/settings/TotpQrCode';

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 font-mono text-sm">
      {codes.map(code => <li key={code}>{code}</li>)}
    </ul>
  );
}

/**
 * Turning two-factor authentication on: the key to scan, then the password
 * and a first code, then the recovery codes, shown once. Open while `setup`
 * is the answer of startTwoFactorSetup. One set-up for Settings › Security
 * and for the prompt of a person whose administrator requires it.
 */
export function TwoFactorSetupDialog({ setup, onClose, onEnabled }: { setup: TwoFactorSetup | null; onClose: () => void; onEnabled?: (recoveryCodes: string[]) => void | Promise<void> }) {
  const { user, setUser } = useAuth();
  const { toast } = useToast();
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!setup) { setCode(''); setPassword(''); setCodes(null); } }, [setup]);

  const confirm = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      const recoveryCodes = await confirmTwoFactorSetup({ secret: setup.secret, code, current_password: password });
      setPassword('');
      setCodes(recoveryCodes);
      setUser(user ? { ...user, two_factor_enabled: true } : user);
      await onEnabled?.(recoveryCodes);
      toast({ title: 'Two-factor authentication is on' });
    } catch (error) {
      toast({ title: 'Could not turn on two-factor authentication', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!setup} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Set up two-factor authentication</DialogTitle></DialogHeader>
        {!codes ? (
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); void confirm(); }}>
            <p className="text-sm text-muted-foreground">
              Scan the code with your authenticator app, or open it in the app on this device, or type the key. Then enter your password and the 6-digit code the app shows.
            </p>
            {setup?.otpauth_uri && (
              <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
                <TotpQrCode uri={setup.otpauth_uri} />
                <div className="w-full min-w-0 space-y-3">
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Setup key</p>
                    <p className="break-all rounded-md bg-muted px-3 py-2 font-mono text-sm">{setup.secret}</p>
                  </div>
                  <Button variant="outline" asChild className="w-full sm:w-auto"><a href={setup.otpauth_uri}>Open in authenticator app</a></Button>
                </div>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="confirm-2fa-password">Current password</Label>
              <Input id="confirm-2fa-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-2fa-code">Authenticator code</Label>
              <Input id="confirm-2fa-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={busy || !code.trim() || !password}>{busy && <Loader2 aria-hidden="true" className="animate-spin" />}Turn on</Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Two-factor authentication is on and your other devices were signed out. Save these recovery codes now; they are not shown again.
            </p>
            <RecoveryCodes codes={codes} />
            <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
