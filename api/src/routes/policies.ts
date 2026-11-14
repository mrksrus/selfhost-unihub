import type { ServerResponse } from 'node:http';
import type { RouteRequest } from '../types';
import type { AdminPoliciesResponse, EffectivePoliciesResponse } from '../contracts/policies';
import { defineRoutes } from '../http/route';
import { confirmPasswordHash } from '../security/reauthentication';
import { getAuthTokenFromRequest } from '../auth';
import { asCaller } from '../services/caller-proof';
import { acknowledgePolicies, getAdminPolicies, getEffectivePolicies, updateAdminPolicies } from '../services/settings';

// The data-safety policies (F13 on F1, contracts/policies.ts): what applies to
// the signed-in person, their confirmation of the rules (the rules notice), and the
// administrator's page. The services decide; these routes only carry it, and
// a refusal they throw is answered by the request boundary.
export = defineRoutes({
  'GET /api/policies/effective': { auth: 'user', module: null, appLock: 'exempt', handler: async (_req: RouteRequest, userId: string) => {
    const effective: EffectivePoliciesResponse = await getEffectivePolicies(userId);
    return { ...effective };
  } },

  // Installation data, outside any person's recovery sections.
  'POST /api/policies/acknowledge': { auth: 'user', module: null, appLock: 'exempt', restoreSection: null, body: { limit: 1024 }, handler: async (_req: RouteRequest, userId: string, body: unknown) => {
    return { ...await acknowledgePolicies(userId, body) };
  } },

  'GET /api/admin/policies': { auth: 'admin', permission: 'server.settings', module: null, handler: async () => {
    const policies: AdminPoliciesResponse = await getAdminPolicies();
    return { ...policies };
  } },

  'PUT /api/admin/policies': { auth: 'admin', permission: 'server.settings', module: null, restoreSection: null, body: { limit: 8192 },
    handler: async (req: RouteRequest, userId: string, body: unknown, res: ServerResponse) => {
      const confirmed = await confirmPasswordHash(userId, (body as { current_password?: unknown } | null)?.current_password, res);
      if ('refused' in confirmed) return confirmed.refused;
      return { ...await asCaller({ userId, token: getAuthTokenFromRequest(req), permission: 'server.settings', passwordHash: confirmed.passwordHash },
        () => updateAdminPolicies(userId, body, { req })) };
    } },
});
