import { useModules } from '@/hooks/use-modules';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { invalidateMailQueries } from '@/lib/mail-api';

// The server emits committed mail arrivals. Refresh open views without a second polling feed or notification owner.
export const useMailNotifications = () => {
  const { user } = useAuth();
  const { modules } = useModules();
  const active = modules.some(module => module.id === 'mail' && module.enabled && module.background);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!user?.id || !active) return;
    const refresh = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (data?.userId === user.id && data.kind === 'mail') void invalidateMailQueries(queryClient);
    };
    window.addEventListener('unihub-notification-data', refresh);
    return () => window.removeEventListener('unihub-notification-data', refresh);
  }, [queryClient, user?.id, active]);
};
