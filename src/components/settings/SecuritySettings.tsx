import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState } from '@/components/ui/page-states';
import { TotpQrCode } from '@/components/settings/TotpQrCode';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';

type TwoFactorStatus = { enabled: boolean; recoveryCodesRemaining: number; secretReadable?: boolean };
type TwoFactorSetup = { secret: string; otpauth_uri: string };

const message = (error: unknown) => error instanceof Error ? error.message : 'Unknown error';
const emptyPasswordForm = { current_password: '', new_password: '', confirm_password: '' };

function Field({ id, label, ...props }: { id: string; label: string } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
    </div>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 font-mono text-sm">
      {codes.map(code => <li key={code}>{code}</li>)}
    </ul>
  );
}

function PasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { signOut } = useAuth();
  const { toast } = useToast();
  const [form, setForm] = useState(emptyPasswordForm);
  const [busy, setBusy] = useState(false);
  const close = (next: boolean) => { onOpenChange(next); if (!next) setForm(emptyPasswordForm); };

  const submit = async () => {
    if (form.new_password !== form.confirm_password) { toast({ title: 'The new passwords do not match', variant: 'destructive' }); return; }
    if (form.new_password.length < 12) { toast({ title: 'Use at least 12 characters for the new password', variant: 'destructive' }); return; }
    setBusy(true);
    try {
      const response = await api.put('/auth/password', { current_password: form.current_password, new_password: form.new_password });
      if (response.error) { toast({ title: 'Could not change the password', description: response.error, variant: 'destructive' }); return; }
      toast({ title: 'Password changed', description: 'All devices were signed out. Sign in again with your new password.' });
      close(false);
      await signOut();
    } catch (error) {
      toast({ title: 'Could not change the password', description: message(error), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Every device, including this one, is signed out afterwards.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <Field id="current-password" label="Current password" type="password" autoComplete="current-password"
            value={form.current_password} onChange={event => setForm(prev => ({ ...prev, current_password: event.target.value }))} />
          <Field id="new-password" label="New password" type="password" autoComplete="new-password"
            value={form.new_password} onChange={event => setForm(prev => ({ ...prev, new_password: event.target.value }))} />
          <Field id="confirm-password" label="New password again" type="password" autoComplete="new-password"
            value={form.confirm_password} onChange={event => setForm(prev => ({ ...prev, confirm_password: event.target.value }))} />
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={() => close(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 aria-hidden="true" className="animate-spin" />}Change password</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function SecuritySettings() {
  const { user, setUser } = useAuth();
  const { toast } = useToast();
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [disableForm, setDisableForm] = useState({ current_password: '', code: '' });
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['auth', '2fa-status'],
    queryFn: async () => {
      const response = await api.get<TwoFactorStatus>('/auth/2fa/status');
      if (response.error) throw new Error(response.error);
      return response.data || { enabled: false, recoveryCodesRemaining: 0 };
    },
    enabled: !!user,
  });
  const status = statusQuery.data;

  const run = async <T,>(failure: string, request: () => Promise<{ data?: T; error?: string }>, done: (data: T | undefined) => Promise<void> | void) => {
    setBusy(true);
    try {
      const response = await request();
      if (response.error) { toast({ title: failure, description: response.error, variant: 'destructive' }); return; }
      await done(response.data);
    } catch (error) {
      toast({ title: failure, description: message(error), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const startSetup = () => {
    setNewCodes(null); setCode(''); setSetupPassword('');
    void run<TwoFactorSetup>('Could not start two-factor authentication setup', () => api.post<TwoFactorSetup>('/auth/2fa/setup/start'), data => {
      setSetup(data || null);
      setSetupOpen(true);
    });
  };

  const confirmSetup = () => {
    if (!setup) return;
    void run<{ recoveryCodes: string[] }>('Could not turn on two-factor authentication',
      () => api.post('/auth/2fa/setup/confirm', { secret: setup.secret, code, current_password: setupPassword }), async data => {
        setSetupPassword('');
        setNewCodes(data?.recoveryCodes || []);
        setUser(user ? { ...user, two_factor_enabled: true } : user);
        await statusQuery.refetch();
        toast({ title: 'Two-factor authentication is on' });
      });
  };

  const disable = () => void run<unknown>('Could not turn off two-factor authentication', () => api.post('/auth/2fa/disable', disableForm), async () => {
    setDisableOpen(false);
    setDisableForm({ current_password: '', code: '' });
    setNewCodes(null);
    setUser(user ? { ...user, two_factor_enabled: false } : user);
    await statusQuery.refetch();
    toast({ title: 'Two-factor authentication is off' });
  });

  const regenerate = () => void run<{ recoveryCodes: string[] }>('Could not create new recovery codes',
    () => api.post('/auth/2fa/recovery-codes/regenerate', { code }), async data => {
      setNewCodes(data?.recoveryCodes || []);
      setRecoveryOpen(false);
      setCode('');
      await statusQuery.refetch();
      toast({ title: 'New recovery codes created' });
    });

  const closeSetup = () => { setSetupOpen(false); setSetup(null); setCode(''); setSetupPassword(''); };

  return (
    <>
      <SettingsSection title="Sign-in">
        <SettingsRow label="Password" description="Changing it signs out every device.">
          <Button variant="outline" onClick={() => setPasswordOpen(true)}>Change password</Button>
        </SettingsRow>
        <SettingsRow label="Two-factor authentication"
          description={statusQuery.isLoading ? 'Checking…'
            : status?.enabled ? `On. ${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? '' : 's'} left.`
            : 'Ask for a code from an authenticator app when signing in.'}>
          {status?.enabled ? (
            <>
              {/* New codes need a readable authenticator key; without one the server refuses. */}
              {status.secretReadable !== false && <Button variant="outline" onClick={() => setRecoveryOpen(true)}>New recovery codes</Button>}
              <Button variant="outline" onClick={() => setDisableOpen(true)}>Turn off</Button>
            </>
          ) : statusQuery.isLoading || statusQuery.error ? null : (
            <Button variant="outline" onClick={startSetup} disabled={busy}>{busy && <Loader2 aria-hidden="true" className="animate-spin" />}Set up</Button>
          )}
        </SettingsRow>
        {status?.enabled && status.secretReadable === false && (
          <SettingsBlock>
            <p role="alert" className="text-sm text-destructive">
              Authenticator codes cannot be checked because the server encryption key changed. Turn two-factor authentication off with a recovery code and set it up again.
            </p>
          </SettingsBlock>
        )}
        {statusQuery.error && (
          <SettingsBlock>
            <ErrorState title="Could not check two-factor authentication" error={statusQuery.error} onRetry={() => void statusQuery.refetch()} retrying={statusQuery.isFetching} />
          </SettingsBlock>
        )}
        {newCodes && newCodes.length > 0 && !setupOpen && (
          <SettingsBlock>
            <p className="mb-1 text-sm font-medium">Your new recovery codes</p>
            <p className="mb-3 text-sm text-muted-foreground">Keep them somewhere safe. Each one signs you in once if you lose your authenticator app.</p>
            <RecoveryCodes codes={newCodes} />
          </SettingsBlock>
        )}
      </SettingsSection>

      <PasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />

      <Dialog open={recoveryOpen} onOpenChange={open => { setRecoveryOpen(open); if (!open) setCode(''); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New recovery codes</DialogTitle>
            <DialogDescription>Enter a code from your authenticator app. Unused old recovery codes stop working.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); regenerate(); }}>
            <Field id="recovery-verify-code" label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} />
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="ghost" onClick={() => setRecoveryOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={busy || !code.trim()}>{busy && <Loader2 aria-hidden="true" className="animate-spin" />}Create new codes</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={disableOpen} onOpenChange={open => { setDisableOpen(open); if (!open) setDisableForm({ current_password: '', code: '' }); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Turn off two-factor authentication</DialogTitle></DialogHeader>
          <form className="space-y-4" onSubmit={event => { event.preventDefault(); disable(); }}>
            <Field id="disable-2fa-password" label="Current password" type="password" autoComplete="current-password"
              value={disableForm.current_password} onChange={event => setDisableForm(prev => ({ ...prev, current_password: event.target.value }))} />
            <Field id="disable-2fa-code" label="Authenticator or recovery code" autoComplete="one-time-code"
              value={disableForm.code} onChange={event => setDisableForm(prev => ({ ...prev, code: event.target.value }))} />
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="ghost" onClick={() => setDisableOpen(false)}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={busy}>{busy && <Loader2 aria-hidden="true" className="animate-spin" />}Turn off</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={setupOpen} onOpenChange={open => { if (!open) closeSetup(); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader><DialogTitle>Set up two-factor authentication</DialogTitle></DialogHeader>
          {!newCodes ? (
            <form className="space-y-4" onSubmit={event => { event.preventDefault(); confirmSetup(); }}>
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
              <Field id="confirm-2fa-password" label="Current password" type="password" autoComplete="current-password" value={setupPassword} onChange={event => setSetupPassword(event.target.value)} />
              <Field id="confirm-2fa-code" label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} />
              <DialogFooter className="gap-2 sm:gap-0">
                <Button type="button" variant="ghost" onClick={closeSetup}>Cancel</Button>
                <Button type="submit" disabled={busy || !code.trim() || !setupPassword}>{busy && <Loader2 aria-hidden="true" className="animate-spin" />}Turn on</Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Two-factor authentication is on and your other devices were signed out. Save these recovery codes now; they are not shown again.
              </p>
              <RecoveryCodes codes={newCodes} />
              <DialogFooter><Button onClick={closeSetup}>Done</Button></DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
