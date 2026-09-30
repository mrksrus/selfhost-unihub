import { clearOfflineData } from '@/lib/offline';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';

import { moduleForPath, type ModuleId, type ModulePreference } from '@/lib/modules';
export type { ModuleId, ModulePreference } from '@/lib/modules';
export { moduleForPath } from '@/lib/modules';
export function useModules() {
  const { user } = useAuth();
  const query = useQuery({ queryKey: ['modules'], enabled: !!user, retry: false,
    queryFn: async ({ signal }) => {
      const response = await api.get<{ modules: ModulePreference[] }>('/modules', { signal });
      if (response.error || !response.data?.modules) throw new Error(response.error || 'Module preferences unavailable.');
      return response.data.modules;
    },
  });
  const modules = query.data || [];
  const isEnabled = (id: ModuleId) => modules.some(module => module.id === id && module.enabled);
  const isVisible = (id: ModuleId) => modules.some(module => module.id === id && module.visible);
  const canAccess = (path: string) => { const id = moduleForPath(path); return !id || isEnabled(id); };
  const canNavigate = (path: string) => { const id = moduleForPath(path); return !id || (isEnabled(id) && isVisible(id)); };
  return { ...query, modules, isEnabled, isVisible, canNavigate, canAccess };
}
export function useUpdateModule() {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ id, patch }: { id: ModuleId; patch: Partial<Pick<ModulePreference, 'visible' | 'enabled' | 'background'>> }) => {
    const response = await api.put<{ modules: ModulePreference[] }>('/modules', { modules: { [id]: patch } });
    if (response.error || !response.data?.modules) throw new Error(response.error || 'Module preferences were not saved.');
    return response.data.modules;
  }, onSuccess: async (modules, variables) => { client.setQueryData(['modules'], modules); await client.invalidateQueries(); if (variables.patch.enabled === false) await clearOfflineData(); } });
}
