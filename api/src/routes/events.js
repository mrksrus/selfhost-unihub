const { verifyToken, getAuthTokenFromRequest } = require('../auth');
const { MODULE_CATALOG } = require('../services/module-catalog');
const { getUserModules } = require('../services/module-settings');
const { serverEvents } = require('../services/server-events');

// Modules whose events this user may receive. A disabled module's events are
// filtered per stream, the same way its routes are refused at the boundary.
async function enabledModules(userId) {
  const modules = await getUserModules(userId);
  return new Set(MODULE_CATALOG.map(module => module.id)
    .filter(moduleId => modules.find(module => module.id === moduleId)?.enabled === true));
}

module.exports = {
  // Reached only through request-handler.js, which has already authenticated
  // the session and applied the origin rules. The route takes over the
  // response; request-handler.js leaves a __handled result alone.
  'GET /api/events': async (req, userId, body, res) => {
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
