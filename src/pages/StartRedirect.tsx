import { useModules } from '@/hooks/use-modules';
import { Navigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import { StartingScreen } from '@/components/ui/page-states';

import { navigationPages } from '@/lib/navigation';
import { usePolicies } from '@/hooks/use-policies';
import { pageForPath } from '@/lib/modules';
import { pageLock } from '@/lib/policies-api';

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
  const { policies } = usePolicies();
  const { data: startPage, isLoading } = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('default_start_page'), retry: false });


  if (isLoading || modules.isPending) {
    return <StartingScreen />;
  }

  const desired = startPagePaths[startPage || 'mail'] || '/mail';
  // A hidden start page still opens; a disabled module, or a page an administrator's rule takes away (Music), falls back to navigation.
  const page = pageForPath(desired);
  const target = modules.canAccess(desired) && !(page && pageLock(policies, page, null)) ? desired : navigationPages(modules.pages, modules.canNavigate)[0]?.href || '/dashboard';
  // The start screen stays while the start page's code loads (a transition keeps this page meanwhile).
  return <><StartingScreen /><Navigate to={target} replace /></>;
};

export default StartRedirect;
