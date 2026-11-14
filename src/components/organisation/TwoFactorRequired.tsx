import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, ShieldAlert, X } from 'lucide-react';
import { useAuth } from '@/contexts/useAuth';
import { usePolicies } from '@/hooks/use-policies';
import { useToast } from '@/hooks/use-toast';
import { onAppEvent } from '@/lib/app-events';
import { startTwoFactorSetup, twoFactorStatusQueryKey, type TwoFactorSetup } from '@/lib/auth-api';
import { policiesQueryKey } from '@/lib/policies-api';
import { UniHubMark } from '@/components/app-lock/UniHubMark';
import { formatDay } from '@/components/admin/person-words';
import { TwoFactorSetupDialog } from '@/components/settings/TwoFactorSetupDialog';
import { Button } from '@/components/ui/button';

// Two-factor authentication required by the administrator (0.30). A person
// without it has 7 days from when the rule first applies to them: until then
// a reminder at every start, which can be closed for the session; after it
// the server answers only the set-up, sign-out and the phone's background
// work, and this prompt stands in place of the app. The server decides both
// (GET /api/policies/effective `two_factor`, 403 TWO_FACTOR_REQUIRED); the
// page only shows them.

const FALLBACK_REASON = 'Your administrator requires two-factor authentication for your account.';

/** What applies to the signed-in person: nothing, the reminder (with the day the grace ends, when known) or the prompt. */
export function useTwoFactorRequirement(): { state: 'none' | 'reminder' | 'required'; graceEndsAt: string | null; reason: string } {
  const { user } = useAuth();
  const { twoFactor, policies } = usePolicies();
  // The server refused a request: the grace is over, whatever this page last read.
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => onAppEvent('unihub:two-factor-required', details => setRefused(details.reason ?? FALLBACK_REASON)), []);
  const reason = refused ?? policies['auth.two_factor'].reason ?? FALLBACK_REASON;
  if (!user || user.two_factor_enabled) return { state: 'none', graceEndsAt: null, reason };
  if (refused) return { state: 'required', graceEndsAt: twoFactor?.grace_ends_at ?? null, reason };
  if (!twoFactor?.required) return { state: 'none', graceEndsAt: null, reason };
  const ends = twoFactor.grace_ends_at;
  return { state: ends && Date.parse(ends) <= Date.now() ? 'required' : 'reminder', graceEndsAt: ends, reason };
}

/** Starts the set-up and holds its dialog. `onOpenChange` tells the caller while the dialog is open, recovery codes included. */
function useSetup(onOpenChange?: (open: boolean) => void) {
  const { toast } = useToast();
  const client = useQueryClient();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    try { setSetup(await startTwoFactorSetup()); onOpenChange?.(true); }
    catch (error) { toast({ title: 'Could not start two-factor authentication setup', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' }); }
    finally { setStarting(false); }
  };
  // The rule is met: the person's rules and their Security page are read again once the recovery codes are closed.
  const close = () => { setSetup(null); onOpenChange?.(false); void client.invalidateQueries({ queryKey: policiesQueryKey }); void client.invalidateQueries({ queryKey: twoFactorStatusQueryKey }); };
  return { start, starting, dialog: <TwoFactorSetupDialog setup={setup} onClose={close} /> };
}

const closedKey = (userId: string) => `unihub:two-factor-reminder-closed:${userId}`;

/** During the grace: a bar above the page, at every start, closed for this session with its ×. */
export function TwoFactorReminder() {
  const { user } = useAuth();
  const { state, graceEndsAt } = useTwoFactorRequirement();
  const { start, starting, dialog } = useSetup();
  const [closed, setClosed] = useState(() => { try { return !!user && sessionStorage.getItem(closedKey(user.id)) === '1'; } catch { return false; } });
  // The dialog stays mounted while the recovery codes show, although the set-up already ended the reminder.
  if (state !== 'reminder' || closed) return <>{dialog}</>;
  const close = () => { setClosed(true); try { if (user) sessionStorage.setItem(closedKey(user.id), '1'); } catch { /* closed for this page only */ } };
  return (
    <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted px-4 py-2 text-sm">
      <ShieldAlert aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 basis-56">
        Your administrator requires two-factor authentication.
        <span className="text-muted-foreground"> {graceEndsAt ? `Set it up by ${formatDay(graceEndsAt)}; after that you can only set it up or sign out.` : 'Set it up soon; later you can only set it up or sign out.'}</span>
      </span>
      <div className="flex items-center gap-1 touch:gap-3">
        <Button size="sm" variant="outline" type="button" onClick={() => void start()} disabled={starting}>{starting && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Set up now</Button>
        <Button size="icon-sm" variant="ghost" type="button" aria-label="Close the reminder until the next start" onClick={close}><X aria-hidden="true" /></Button>
      </div>
      {dialog}
    </div>
  );
}

/**
 * After the grace: in place of the app, as the required app lock's prompt
 * is. "Set up two-factor authentication" runs the same set-up as Settings ›
 * Security; signing out is the other way on. The data rules notice opens
 * over it first.
 */
export function TwoFactorRequiredPrompt({ reason, graceEndsAt, onSetupOpenChange }: { reason: string; graceEndsAt: string | null; onSetupOpenChange?: (open: boolean) => void }) {
  const { signOut } = useAuth();
  const { start, starting, dialog } = useSetup(onSetupOpenChange);
  const [signingOut, setSigningOut] = useState(false);
  const leave = async () => { setSigningOut(true); try { await signOut(); } finally { setSigningOut(false); } };
  // The reason under it is the server's sentence, which names the administrator's rule.
  const title = 'Set up two-factor authentication to continue';
  return (
    <main aria-label={title} className="flex h-dvh flex-col overflow-y-auto bg-background px-6 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] pt-[max(1.5rem,env(safe-area-inset-top,0px))]">
      <div className="m-auto flex w-full max-w-sm flex-col items-center gap-6 py-8 text-center">
        <UniHubMark />
        <div className="space-y-2">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{reason}</p>
          <p className="text-sm">{graceEndsAt ? `The time to set it up ended on ${formatDay(graceEndsAt)}. ` : ''}Until it is on, you can only set it up or sign out.</p>
          <p className="text-sm text-muted-foreground">You need an authenticator app on your phone. It shows a new 6-digit code for each sign-in.</p>
        </div>
        <div className="flex w-full flex-col gap-2">
          <Button onClick={() => void start()} disabled={starting} className="w-full">
            {starting && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Set up two-factor authentication
          </Button>
          <Button variant="outline" onClick={() => void leave()} disabled={signingOut} className="w-full">
            {signingOut && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}Sign out
          </Button>
        </div>
        {dialog}
      </div>
    </main>
  );
}

/**
 * The prompt for the app's layout, or null while nothing is required. It
 * stays until its set-up dialog is closed: the rule is met as soon as the
 * code is confirmed, but the recovery codes are still on the screen then.
 */
export function useTwoFactorPrompt() {
  const { state, reason, graceEndsAt } = useTwoFactorRequirement();
  const [settingUp, setSettingUp] = useState(false);
  return state === 'required' || settingUp ? <TwoFactorRequiredPrompt reason={reason} graceEndsAt={graceEndsAt} onSetupOpenChange={setSettingUp} /> : null;
}
