import type { ServerResponse } from 'node:http';
import type { AuthRequest } from '../types';
import { verifyToken, getAuthTokenFromRequest } from '../auth';
import { MODULE_CATALOG } from '../services/module-catalog';
import { getUserModules } from '../services/module-settings';
import { serverEvents } from '../services/server-events';
import { defineRoutes } from '../http/route';

// Modules whose events this user may receive. A disabled module's events are
// filtered per stream, the same way its routes are refused at the boundary.
async function enabledModules(userId: string) {
  const modules = await getUserModules(userId);
  return new Set(MODULE_CATALOG.map(module => module.id)
    .filter(moduleId => modules.find(module => module.id === moduleId)?.enabled === true));
}

export = defineRoutes({
  // Reached only through request-handler.ts, which has already authenticated
  // the session and applied the origin rules. A streaming route: once attached,
  // the handler owns the response and returns nothing; a refusal before that
  // is an ordinary JSON error.
  'GET /api/events': { auth: 'user', module: null, response: 'stream', body: { kind: 'none' }, handler: async (req: AuthRequest, userId: string, body: unknown, res: ServerResponse) => {
    const modules = await enabledModules(userId);
    const attached = serverEvents.attach({
      userId,
      req,
      res,
      token: getAuthTokenFromRequest(req),
      modules,
      // Every heartbeat re-checks the session with the same lookup as any API
      // request, so a revoked, expired or deactivated session stops receiving
      // events even when no sign-out path closed it explicitly.
      revalidate: async stream => {
        const current = await verifyToken(req);
        if (!current || String(current) !== String(stream.userId)) return false;
        stream.modules = await enabledModules(current);
        return true;
      },
    });
    if (!attached.ok) {
      if (attached.status === 429 || attached.status === 503) res.setHeader('Retry-After', '60');
      return { error: attached.error, status: attached.status };
    }
    return undefined;
  } },
});
