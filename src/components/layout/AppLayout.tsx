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
import { LoadingState } from '@/components/ui/page-states';

// Global navigation only: the rail on wide windows, the bottom bar on phones.
// Each page renders its own header and panel through PageShell.
const AppLayout = () => {
  const { user, loading } = useAuth();
  useBackgroundNotificationChecks();
  useCalendarNotifications();
  useMailNotifications();
  useRecordingUploadRunner();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <LoadingState label="Loading UniHub…" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
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
      <BottomNav />
    </div>
  );
};

export default AppLayout;
