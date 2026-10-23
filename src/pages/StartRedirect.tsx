import { useModules } from '@/hooks/use-modules';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import { LoadingState } from '@/components/ui/page-states';

import { navigationPages } from '@/lib/navigation';

const startPagePaths: Record<string, string> = {
  mail: '/mail',
  calendar: '/calendar',
  todo: '/todo',
  contacts: '/contacts',
  recordings: '/recordings',
  music: '/music',
  dashboard: '/dashboard',
};

const StartRedirect = () => {
  const modules = useModules();
  const { data: startPage, isLoading } = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('default_start_page'), retry: false });


  if (isLoading || modules.isPending) {
    return <LoadingState className="min-h-full" label="Opening UniHub…" />;
  }

  const desired = startPagePaths[startPage || 'mail'] || '/mail';
  // A hidden start page still opens; only a disabled module falls back to navigation.
  const target = modules.canAccess(desired) ? desired : navigationPages(modules.pages, modules.canNavigate)[0]?.href || '/dashboard';
  return <Navigate to={target} replace />;
};

export default StartRedirect;
