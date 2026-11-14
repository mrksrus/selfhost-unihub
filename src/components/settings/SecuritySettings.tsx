import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { changePassword, disableTwoFactor, fetchTwoFactorStatus, regenerateRecoveryCodes, startTwoFactorSetup, twoFactorStatusQueryKey, type TwoFactorSetup } from '@/lib/auth-api';
import { usePolicy } from '@/hooks/use-policies';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState } from '@/components/ui/page-states';
import { RecoveryCodes, TwoFactorSetupDialog } from '@/components/settings/TwoFactorSetupDialog';
import { PolicyNote } from '@/components/ui/policy-note';
import { Devices } from '@/components/settings/Devices';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';


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

function PasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { signOut } = useAuth();
  const { toast } = useToast();
  const [form, setForm] = useState(emptyPasswordForm);
  const [busy, setBusy] = useState(false);
  // The shortest password the administrator's rule accepts for this person; the server checks it anyway.
  const minimum = usePolicy('auth.password_min_length');
  const close = (next: boolean) => { onOpenChange(next); if (!next) setForm(emptyPasswordForm); };

  const submit = async () => {
    if (form.new_password !== form.confirm_password) { toast({ title: 'The new passwords do not match', variant: 'destructive' }); return; }
    if (form.new_password.length < minimum.value) { toast({ title: `Use at least ${minimum.value} characters for the new password`, variant: 'destructive' }); return; }
    setBusy(true);
    try {
      await changePassword(form.current_password, form.new_password);
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
          <div>
            <Field id="new-password" label="New password" type="password" autoComplete="new-password" aria-describedby="new-password-hint"
              value={form.new_password} onChange={event => setForm(prev => ({ ...prev, new_password: event.target.value }))} />
            <div id="new-password-hint">
              {minimum.source === 'policy' && minimum.reason
                ? <PolicyNote reason={minimum.reason} />
                : <p className="mt-1 text-xs text-muted-foreground">At least {minimum.value} characters.</p>}
            </div>
          </div>
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
  const [disableOpen, setDisableOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [disableForm, setDisableForm] = useState({ current_password: '', code: '' });
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const statusQuery = useQuery({
    queryKey: twoFactorStatusQueryKey,
    queryFn: ({ signal }) => fetchTwoFactorStatus(signal),
    enabled: !!user,
  });
  const status = statusQuery.data;

  const run = async <T,>(failure: string, request: () => Promise<T>, done: (data: T) => Promise<void> | void) => {
    setBusy(true);
    try {
      await done(await request());
    } catch (error) {
      toast({ title: failure, description: message(error), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  // Required by the administrator: turning it off is refused by the server, and the button says why.
  const requirement = usePolicy('auth.two_factor');
  const required = requirement.value === 'required' ? requirement.reason ?? 'Your administrator requires two-factor authentication.' : undefined;

  const startSetup = () => {
    setNewCodes(null);
    void run<TwoFactorSetup | null>('Could not start two-factor authentication setup', startTwoFactorSetup, setSetup);
  };

  const disable = () => void run('Could not turn off two-factor authentication', () => disableTwoFactor(disableForm), async () => {
    setDisableOpen(false);
    setDisableForm({ current_password: '', code: '' });
    setNewCodes(null);
    setUser(user ? { ...user, two_factor_enabled: false } : user);
    await statusQuery.refetch();
    toast({ title: 'Two-factor authentication is off' });
  });

  const regenerate = () => void run('Could not create new recovery codes',
    () => regenerateRecoveryCodes(code), async recoveryCodes => {
      setNewCodes(recoveryCodes);
      setRecoveryOpen(false);
      setCode('');
      await statusQuery.refetch();
      toast({ title: 'New recovery codes created' });
    });


  return (
    <>
      <SettingsSection title="Sign-in">
        <SettingsRow label="Password" description="Changing it signs out every device.">
          <Button variant="outline" onClick={() => setPasswordOpen(true)}>Change password</Button>
        </SettingsRow>
        <SettingsRow label="Two-factor authentication" lock={required}
          description={statusQuery.isLoading ? 'Checking…'
            : status?.enabled ? `On. ${status.recoveryCodesRemaining} recovery code${status.recoveryCodesRemaining === 1 ? '' : 's'} left.`
            : 'Ask for a code from an authenticator app when signing in.'}>
          {status?.enabled ? (
            <>
              {/* New codes need a readable authenticator key; without one the server refuses. */}
              {status.secretReadable !== false && <Button variant="outline" onClick={() => setRecoveryOpen(true)}>New recovery codes</Button>}
              <Button variant="outline" onClick={() => setDisableOpen(true)} disabled={!!required}>Turn off</Button>
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
        {newCodes && newCodes.length > 0 && !setup && (
          <SettingsBlock>
            <p className="mb-1 text-sm font-medium">Your new recovery codes</p>
            <p className="mb-3 text-sm text-muted-foreground">Keep them somewhere safe. Each one signs you in once if you lose your authenticator app.</p>
            <RecoveryCodes codes={newCodes} />
          </SettingsBlock>
        )}
      </SettingsSection>

      <Devices />

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

      <TwoFactorSetupDialog setup={setup} onClose={() => setSetup(null)} onEnabled={async recoveryCodes => { setNewCodes(recoveryCodes); await statusQuery.refetch(); }} />
    </>
  );
}
