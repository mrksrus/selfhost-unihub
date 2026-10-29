import { useEffect } from 'react';
import { ServerOff } from 'lucide-react';
import OfflineBanner from '@/components/offline/OfflineBanner';
import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/useAuth';
import { useBackgroundNotificationChecks } from '@/hooks/use-background-notification-checks';
import { useCalendarNotifications } from '@/hooks/use-calendar-notifications';
import { useMailNotifications } from '@/hooks/use-mail-notifications';
import { useRecordingUploadRunner } from '@/hooks/use-recording-uploads';
import NavRail from './NavRail';
import BottomNav from './BottomNav';
import GlobalCommandPalette from '@/components/GlobalCommandPalette';
import { MailPeek } from '@/components/mail/MailPeek';
import { PreferenceAccent } from '@/components/theme/PreferenceAccent';
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

// Global navigation only: the rail on wide windows, the bottom bar on phones.
// Each page renders its own header and panel through PageShell.
const AppLayout = () => {
  const { user, loading, serverUnavailable, retrySession } = useAuth();
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

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <PreferenceAccent />
      <div className="hidden md:block">
        <NavRail />
      </div>
      {/* Phones: clears the status bar once, above the offline banner and every page header. */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top,0px)] md:pt-0">
        <OfflineBanner />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
      <GlobalCommandPalette />
      <MailPeek />
      <BottomNav />
    </div>
  );
};

export default AppLayout;
