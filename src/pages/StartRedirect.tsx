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
  dashboard: '/dashboard',
};

const StartRedirect = () => {
  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'preferences'],
    queryFn: async () => {
      const response = await api.get<{ preferences: { default_start_page: string } }>('/settings/preferences');
      if (response.error) throw new Error(response.error);
      return response.data?.preferences;
    },
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <Navigate to={startPagePaths[data?.default_start_page || 'mail'] || '/mail'} replace />;
};

export default StartRedirect;
