import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAppLock, type AppLockArea } from '@/hooks/use-app-lock';
import { useModules } from '@/hooks/use-modules';
import { useAuth } from '@/contexts/useAuth';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { UniHubMark } from '@/components/app-lock/UniHubMark';
import { UnlockForm } from '@/components/app-lock/UnlockForm';
import { areaLabel } from '@/components/app-lock/area-names';
import { cn } from '@/lib/utils';

interface LockScreenProps {
  /** `app` for the whole app, or the locked module whose page this is. */
  area: AppLockArea;
  /** `page`: in place of the whole shell. `inline`: inside a page's body, under its own header. */
  variant: 'page' | 'inline';
  /** In place of "<Area> is locked", for a section that only reaches locked modules ("Unlock to continue"). */
  title?: string;
  description?: string;
}

/**
 * The lock screen: the mark, one sentence, the unlock. Nothing private is in
 * the DOM behind it. The whole-app lock takes the place of the shell (the
 * navigation included); a module lock sits inside the module's page, so the
 * rest of UniHub stays usable. "Forgot PIN? Sign out" is the way out on the
 * web: it removes this device's offline copy and PIN and keeps unsent
 * recordings.
 */
export function LockScreen({ area, variant, title, description }: LockScreenProps) {
  const lock = useAppLock();
  const { user } = useAuth();
  const { modules } = useModules();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const label = areaLabel(area, modules);
  const heading = title ?? `${label} is locked`;
  const pinMethod = lock.method.method === 'pin';
  const Heading = variant === 'page' ? 'h1' : 'h2';
  const account = user?.full_name || user?.email;

  const signOut = async () => {
    setSigningOut(true);
    try { await lock.signOut(); } finally { setSigningOut(false); setConfirmSignOut(false); }
  };

  const body = (
    <div className={cn('flex w-full max-w-xs flex-col items-center gap-6 text-center', variant === 'page' ? 'm-auto py-8' : 'mx-auto py-10')}>
      <UniHubMark />
      <div className="space-y-1">
        <Heading className="text-xl font-semibold tracking-tight">{heading}</Heading>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
        {account && <p className="truncate text-sm text-muted-foreground">{account}</p>}
      </div>
      {lock.pinLost ? (
        <p role="status" className="text-sm text-muted-foreground">The PIN kept in this browser is gone. Sign out, then sign in again to set a new one.</p>
      ) : (
        <UnlockForm action="unlock" onSuccess={() => undefined} className="w-full text-left" />
      )}
      {lock.method.appUpdateForBiometrics && (
        <p className="text-sm text-muted-foreground">Update the UniHub app to unlock with your fingerprint.</p>
      )}
      <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setConfirmSignOut(true)}>
        {pinMethod ? 'Forgot PIN? Sign out' : 'Sign out'}
      </Button>
      <AlertDialog open={confirmSignOut} onOpenChange={open => { if (!signingOut) setConfirmSignOut(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of this device?</AlertDialogTitle>
            <AlertDialogDescription>
              {pinMethod
                ? 'This removes the offline copy of your data and the UniHub PIN from this device. Recordings not uploaded yet stay here. Sign in again with your password to set a new PIN.'
                : 'This removes the offline copy of your data from this device. Recordings not uploaded yet stay here. Sign in again with your password to continue.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signingOut}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={event => { event.preventDefault(); void signOut(); }} disabled={signingOut}>
              {signingOut && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  if (variant === 'inline') return <div aria-label={heading} role="region">{body}</div>;
  // The column scrolls when a phone keyboard shortens the viewport, so the PIN field and Unlock stay reachable above it.
  return (
    <main aria-label={heading} className="flex h-dvh flex-col overflow-y-auto bg-background px-6 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] pt-[max(1.5rem,env(safe-area-inset-top,0px))]">
      {body}
    </main>
  );
}
