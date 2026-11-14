import { useEffect, type ReactNode } from 'react';
import { ServerOff } from 'lucide-react';
import OfflineBanner from '@/components/offline/OfflineBanner';
import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/useAuth';
import { useAppLock } from '@/hooks/use-app-lock';
import { LockScreen } from '@/components/app-lock/LockScreen';
import { AppLockRequiredPrompt } from '@/components/app-lock/AppLockRequiredPrompt';
import { useBackgroundNotificationChecks } from '@/hooks/use-background-notification-checks';
import { useCalendarNotifications } from '@/hooks/use-calendar-notifications';
import { useMailNotifications } from '@/hooks/use-mail-notifications';
import { useRecordingUploadRunner } from '@/hooks/use-recording-uploads';
import NavRail from './NavRail';
import BottomNav from './BottomNav';
import GlobalCommandPalette from '@/components/GlobalCommandPalette';
import { MailPeek } from '@/components/mail/MailPeek';
import { PreferenceAccent } from '@/components/theme/PreferenceAccent';
import { PolicyNoticeDialog } from '@/components/policies/PolicyNoticeDialog';
import { TwoFactorReminder, useTwoFactorPrompt } from '@/components/organisation/TwoFactorRequired';
import { Button } from '@/components/ui/button';
import { EmptyState, StartingScreen } from '@/components/ui/page-states';

const SERVER_RETRY_MS = 10_000;

/** Shown instead of the sign-in page while the server gives no answer; retries on its own. */
function ServerUnavailable({ onRetry, retrying }: { onRetry: () => Promise<void>; retrying: boolean }) {
  // Wait for the pending check to settle before scheduling the next: a new
  // check aborts the previous one, so a slow server would never get to answer.
  useEffect(() => {
    if (retrying) return;
    const timer = window.setTimeout(() => { void onRetry(); }, SERVER_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [onRetry, retrying]);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <EmptyState icon={ServerOff} title="UniHub's server is not answering"
        description="It may be restarting or busy. This page keeps trying; your session is kept."
        action={<Button variant="outline" disabled={retrying} onClick={() => { void onRetry(); }}>{retrying ? 'Trying…' : 'Try again'}</Button>} />
    </div>
  );
}

/**
 * Two-factor authentication required and the person's grace over: the server
 * answers nothing but its set-up, so the prompt stands in place of the shell,
 * after the data rules notice, as the required app lock does.
 */
function TwoFactorGate({ children }: { children: ReactNode }) {
  const prompt = useTwoFactorPrompt();
  if (!prompt) return children;
  return (
    <div className="h-dvh overflow-hidden bg-background">
      <PreferenceAccent />
      {prompt}
      <PolicyNoticeDialog />
    </div>
  );
}

// Global navigation only: the rail on wide windows, the bottom bar on phones.
// Each page renders its own header and panel through PageShell.
const AppLayout = () => {
  const { user, loading, serverUnavailable, retrySession } = useAuth();
  const lock = useAppLock();
  // These stay mounted while the app is locked: an upload must not stop, and
  // notifications keep being checked (the lock hides their content elsewhere).
  useBackgroundNotificationChecks();
  useCalendarNotifications();
  useMailNotifications();
  useRecordingUploadRunner();

  if (!user && serverUnavailable) {
    return <ServerUnavailable onRetry={retrySession} retrying={loading} />;
  }

  if (loading) return <StartingScreen />;

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  // Until this device's lock state is known, no private view and no lock screen either.
  if (lock.status === 'checking') return <StartingScreen />;

  // The whole-app lock: nothing of the shell is in the DOM behind the lock
  // screen. The data rules notice opens over the set-up prompt first.
  if (lock.locked('app')) {
    return (
      <div className="h-dvh overflow-hidden bg-background">
        <PreferenceAccent />
        {lock.status === 'setup' ? <><AppLockRequiredPrompt area="app" variant="page" /><PolicyNoticeDialog /></> : <LockScreen area="app" variant="page" />}
      </div>
    );
  }

  return (
    <TwoFactorGate>
    <div className="flex h-dvh overflow-hidden bg-background">
      <PreferenceAccent />
      <div className="hidden md:block">
        <NavRail />
      </div>
      {/* Phones: clears the status bar once, above the offline banner and every page header. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top,0px)] md:pt-0">
        <OfflineBanner />
        <TwoFactorReminder />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
      <GlobalCommandPalette />
      <MailPeek />
      {/* The data rules' notice opens over whichever page the app starts on. */}
      <PolicyNoticeDialog />
      <BottomNav />
    </div>
    </TwoFactorGate>
  );
};

export default AppLayout;
