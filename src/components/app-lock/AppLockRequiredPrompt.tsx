import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { useAppLock, type AppLockArea } from '@/hooks/use-app-lock';
import { useModules } from '@/hooks/use-modules';
import { Button } from '@/components/ui/button';
import { UniHubMark } from '@/components/app-lock/UniHubMark';
import { useTurnOnAppLock } from '@/components/app-lock/use-turn-on-app-lock';
import { areaLabel, describeRequirement, scopeMeeting, shorterRelock } from '@/components/app-lock/area-names';
import { cn } from '@/lib/utils';

interface AppLockRequiredPromptProps {
  /** `app` in place of the whole shell, or the locked module whose page this is. */
  area: AppLockArea;
  variant: 'page' | 'inline';
}

/**
 * Nothing can unlock this device yet, and something is locked: the
 * administrator requires the app lock the device does not have, or the lock
 * was on here and its PIN is gone after a new sign-in. The administrator's
 * reason is the server's, in its words; the requirement is told in one
 * sentence. "Turn on the app lock" runs the same set-up as Settings → App
 * lock. The data rules notice (D38) opens over this prompt first.
 */
export function AppLockRequiredPrompt({ area, variant }: AppLockRequiredPromptProps) {
  const lock = useAppLock();
  const { modules } = useModules();
  const { turnOn, dialog, busy } = useTurnOnAppLock();
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const requirement = lock.requirement && !lock.requirement.meets ? lock.requirement : null;
  const Heading = variant === 'page' ? 'h1' : 'h2';
  const native = lock.method.method !== 'pin';

  const start = async () => {
    setError(null);
    const scope = scopeMeeting(lock.settings.app_lock_scope.value, requirement?.required ?? []);
    const outcome = await turnOn({
      app_lock_scope: scope.length ? scope : ['app'],
      app_lock_relock_after: shorterRelock(lock.settings.app_lock_relock_after.value, requirement?.max_background),
    });
    if (!outcome.ok && outcome.message) setError(outcome.message);
  };
  const signOut = async () => {
    setSigningOut(true);
    try { await lock.signOut(); } finally { setSigningOut(false); }
  };

  const title = requirement ? 'Your administrator requires the app lock' : 'Set up the app lock again';
  const text = requirement
    ? requirement.reason ?? `The app lock is required for ${areaLabel(area, modules)}.`
    : 'The app lock is on for this device, but nothing can unlock it here yet. Set it up again to continue.';
  const detail = requirement ? describeRequirement(requirement, modules) : '';
  const method = native
    ? (lock.method.deviceSecure ? 'You unlock with your fingerprint, face or the phone\'s PIN.' : 'Set a screen lock in Android settings, or use a UniHub PIN.')
    : lock.method.appUpdateForBiometrics ? 'Update the UniHub app to unlock with your fingerprint. Until then, use a UniHub PIN.' : 'You unlock with a UniHub PIN kept in this browser.';

  const body = (
    <div className={cn('flex w-full max-w-sm flex-col items-center gap-6 text-center', variant === 'page' ? 'm-auto py-8' : 'mx-auto py-10')}>
      {variant === 'page' ? <UniHubMark /> : <Lock aria-hidden="true" className="h-8 w-8 text-accent" />}
      <div className="space-y-2">
        <Heading className="text-xl font-semibold tracking-tight">{title}</Heading>
        <p className="text-sm text-muted-foreground">{text}</p>
        {detail && <p className="text-sm">{detail}</p>}
        <p className="text-sm text-muted-foreground">{lock.method.pinUnavailable ?? method}</p>
      </div>
      <div className="flex w-full flex-col gap-2">
        <Button onClick={() => void start()} disabled={busy || !!lock.method.pinUnavailable} className="w-full">
          {busy && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Turn on the app lock
        </Button>
        <Button variant="outline" onClick={() => void signOut()} disabled={signingOut} className="w-full">
          {signingOut && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Sign out
        </Button>
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-destructive">{error}</p>
      {dialog}
    </div>
  );

  if (variant === 'inline') return <div role="region" aria-label={title}>{body}</div>;
  return (
    <main aria-label={title} className="flex h-dvh flex-col overflow-y-auto bg-background px-6 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] pt-[max(1.5rem,env(safe-area-inset-top,0px))]">
      {body}
    </main>
  );
}
