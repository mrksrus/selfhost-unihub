import { useEffect } from 'react';
import { useAuth } from '@/contexts/useAuth';
import { syncPushSubscription } from '@/utils/service-worker';

export const useBackgroundNotificationChecks = () => {
  const { user } = useAuth();
  useEffect(() => {
    if (!user?.id) return;
    const controller = new AbortController();
    const sync = () => { void syncPushSubscription(user.id, controller.signal).catch(() => { /* Retry when connectivity returns. */ }); };
    sync();
    window.addEventListener('online', sync);
    return () => { controller.abort(); window.removeEventListener('online', sync); };
  }, [user?.id]);
};
