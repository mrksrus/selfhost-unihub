import { clearOfflineData } from '@/lib/offline';
import { skipToken, useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { api } from '@/lib/api';

import { defaultPages, knownPages, moduleForPath, pageForPath, type ModuleId, type ModulePreference, type PageId, type PagePreference } from '@/lib/modules';
export type { ModuleId, ModulePreference, PageId, PagePreference } from '@/lib/modules';
export { moduleForPath } from '@/lib/modules';
// Filled together with ['modules'] from the same answer.
export const PAGES_QUERY_KEY = ['module-pages'] as const;
type ModulesResponse = { modules: ModulePreference[]; pages?: PagePreference[] };
function storePages(client: QueryClient, data: ModulesResponse) {
  client.setQueryData(PAGES_QUERY_KEY, data.pages ? knownPages(data.pages) : defaultPages(data.modules));
}
export function useModules() {
  const { user } = useAuth();
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['modules'], enabled: !!user, retry: false,
    queryFn: async ({ signal }) => {
      const response = await api.get<ModulesResponse>('/modules', { signal });
      if (response.error || !response.data?.modules) throw new Error(response.error || 'Module preferences unavailable.');
      storePages(client, response.data);
      return response.data.modules;
    },
  });
  const modules = query.data || [];
  const stored = useQuery<PagePreference[]>({ queryKey: PAGES_QUERY_KEY, queryFn: skipToken }).data;
  const pages = stored ?? defaultPages(modules);
  const isEnabled = (id: ModuleId) => modules.some(module => module.id === id && module.enabled);
  const isVisible = (id: ModuleId) => modules.some(module => module.id === id && module.visible);
  const canAccess = (path: string) => { const id = moduleForPath(path); return !id || isEnabled(id); };
  // Shown in navigation: the page is not hidden and its module is enabled.
  const canNavigate = (path: string) => {
    const pageId = pageForPath(path);
    if (!pageId) return canAccess(path);
    const page = pages.find(entry => entry.id === pageId);
    return !!page?.visible && (!page.module || isEnabled(page.module));
  };
  return { ...query, modules, pages, isEnabled, isVisible, canNavigate, canAccess };
}
async function saveModules(body: Record<string, unknown>, failure: string) {
  const response = await api.put<ModulesResponse>('/modules', body);
  if (response.error || !response.data?.modules) throw new Error(response.error || failure);
  return response.data;
}
export function useUpdateModule() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, patch }: { id: ModuleId; patch: Partial<Pick<ModulePreference, 'visible' | 'enabled' | 'background'>> }) =>
    saveModules({ modules: { [id]: patch } }, 'Module preferences were not saved.'),
  onSuccess: async (data, variables) => { client.setQueryData(['modules'], data.modules); storePages(client, data); await client.invalidateQueries(); if (variables.patch.enabled === false) await clearOfflineData(); } });
}
export function useUpdatePage() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ id, visible }: { id: PageId; visible: boolean }) =>
    saveModules({ pages: { [id]: { visible } } }, 'Page was not saved.'),
  onSuccess: data => { client.setQueryData(['modules'], data.modules); storePages(client, data); } });
}
export function useReorderPages() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (order: PageId[]) => saveModules({ page_order: order }, 'Page order was not saved.'),
    onMutate: order => {
      // Move rows at once; the server's answer replaces this.
      const previous = client.getQueryData<PagePreference[]>(PAGES_QUERY_KEY);
      if (previous) client.setQueryData(PAGES_QUERY_KEY, order.map(id => previous.find(page => page.id === id)).filter(Boolean));
      return { previous };
    },
    onError: (_error, _order, context) => { if (context?.previous) client.setQueryData(PAGES_QUERY_KEY, context.previous); },
    onSuccess: data => { client.setQueryData(['modules'], data.modules); storePages(client, data); } });
}
