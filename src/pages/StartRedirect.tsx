import { useModules } from '@/hooks/use-modules';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

const startPagePaths: Record<string, string> = {
  mail: '/mail',
  calendar: '/calendar',
  todo: '/todo',
  contacts: '/contacts',
  recordings: '/recordings',
  notes: '/notes',
  dashboard: '/dashboard',
};

const StartRedirect = () => {
  const modules = useModules();
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'preferences'],
    queryFn: async () => {
      const response = await api.get<{ preferences: { default_start_page: string } }>('/settings/preferences');
      if (response.error) throw new Error(response.error);
      return response.data?.preferences;
    },
    retry: false,
  });

  if (isLoading || modules.isPending) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const desired = startPagePaths[data?.default_start_page || 'mail'] || '/mail';
  const target = modules.canNavigate(desired) ? desired : Object.values(startPagePaths).find(path => modules.canNavigate(path)) || '/settings';
  return <Navigate to={target} replace />;
};

export default StartRedirect;
