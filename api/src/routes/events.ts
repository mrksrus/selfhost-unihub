import type { ServerResponse } from 'node:http';
import type { AuthRequest } from '../types';
import imported1 = require('../auth');
const { verifyToken, getAuthTokenFromRequest } = imported1;
import imported2 = require('../services/module-catalog');
const { MODULE_CATALOG } = imported2;
import imported3 = require('../services/module-settings');
const { getUserModules } = imported3;
import imported4 = require('../services/server-events');
const { serverEvents } = imported4;

// Modules whose events this user may receive. A disabled module's events are
// filtered per stream, the same way its routes are refused at the boundary.
async function enabledModules(userId: string) {
  const modules = await getUserModules(userId);
  return new Set(MODULE_CATALOG.map(module => module.id)
    .filter(moduleId => modules.find(module => module.id === moduleId)?.enabled === true));
}

export = {
  // Reached only through request-handler.js, which has already authenticated
  // the session and applied the origin rules. The route takes over the
  // response; request-handler.js leaves a __handled result alone.
  'GET /api/events': async (req: AuthRequest, userId: string | null, body: unknown, res: ServerResponse) => {
    if (!userId) return { error: 'Unauthorized', status: 401 };
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
    return { __handled: true };
  },
};
