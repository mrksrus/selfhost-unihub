import type { RouteRequest, ApiError } from '../types';

import { defineRoutes } from '../http/route';
import { getOrderedUserModules, getUserPages, setUserModules } from '../services/module-settings';
import { applyModuleChange } from '../services/module-lifecycle';

export = defineRoutes({
  'GET /api/modules': { auth: 'user', module: null, handler: async (_req: RouteRequest, userId: string) => {
    return { modules: await getOrderedUserModules(userId), pages: await getUserPages(userId) };
  } },
  'PUT /api/modules': { auth: 'user', module: null, restoreSection: 'settings', handler: async (_req: RouteRequest, userId: string, body: unknown) => {
    try {
      const previous = await getOrderedUserModules(userId);
      const modules = await setUserModules(userId, body);
      await applyModuleChange(userId, previous, modules);
      return { modules, pages: await getUserPages(userId) };
    }
    catch (error) { if ((error as ApiError).status === 400) return { error: (error as ApiError).message, status: 400 }; throw error; }
  } },
});
