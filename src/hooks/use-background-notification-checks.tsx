import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  BACKGROUND_NOTIFICATION_SYNC_TAG,
  CALENDAR_PERIODIC_SYNC_TAG,
  MAIL_PERIODIC_SYNC_TAG,
  NOTIFICATION_CHECK_INTERVAL_MS,
  initServiceWorker,
  registerBackgroundSync,
  registerPeriodicSync,
  requestBackgroundNotificationCheck,
  requestNotificationPermission,
} from '@/utils/service-worker';

export const useBackgroundNotificationChecks = () => {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;

    let cancelled = false;

    const setup = async () => {
      await initServiceWorker();
      await requestNotificationPermission();
      await registerPeriodicSync(BACKGROUND_NOTIFICATION_SYNC_TAG, NOTIFICATION_CHECK_INTERVAL_MS);
      await registerPeriodicSync(MAIL_PERIODIC_SYNC_TAG, NOTIFICATION_CHECK_INTERVAL_MS);
      await registerPeriodicSync(CALENDAR_PERIODIC_SYNC_TAG, NOTIFICATION_CHECK_INTERVAL_MS);
      await registerBackgroundSync(BACKGROUND_NOTIFICATION_SYNC_TAG);

      if (!cancelled) {
        await requestBackgroundNotificationCheck('app-start');
      }
    };

    const requestCheck = (reason: string) => {
      void requestBackgroundNotificationCheck(reason);
    };

    void setup();

    const intervalId = window.setInterval(() => {
      requestCheck('client-interval');
    }, NOTIFICATION_CHECK_INTERVAL_MS);

    const handleFocus = () => requestCheck('focus');
    const handleOnline = () => requestCheck('online');
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestCheck('visible');
      }
    };

    window.addEventListener('focus', handleFocus);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user?.id]);
};
