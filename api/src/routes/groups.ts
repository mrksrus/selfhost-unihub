import type { ServerResponse } from 'node:http';
import type { RouteRequest } from '../types';
import type { GroupResponse, GroupsAdminResponse, GroupCandidatesResponse, GroupSummary, MyGroupsResponse } from '../contracts/organisation';

import { getAuthTokenFromRequest } from '../auth';
import { defineRoutes } from '../http/route';
import { confirmPasswordHash } from '../security/reauthentication';
import { asCaller } from '../services/caller-proof';
import {
  addMembers, createGroup, deleteGroup, groupCandidates, groupDetail, listGroups, myGroups, removeMember, renameGroup, setManager,
} from '../services/groups';

// Groups of the organisation (0.30, F3): administrators with groups.manage
// create and delete them and name their managers; a group's managers add and
// remove its members and rename it; its members read it. Who may do what is
// the access service's answer (services/access.ts), asked in the service
// before any change and again under the change's locks. Organisation data:
// no restore section, no module.
type Request = RouteRequest & { url: string; params: Record<string, string> };

// The change as the caller (caller-proof.ts): under its locks it asks again
// that they are signed in with this session and, where given, this password.
const asPerson = <T>(req: Request, userId: string, work: () => Promise<T>, passwordHash: string | null = null) =>
  asCaller({ userId, token: getAuthTokenFromRequest(req), passwordHash }, work);

export = defineRoutes({
  'GET /api/admin/groups': { auth: 'admin', permission: 'users.read', module: null, handler: async () => {
    return { groups: await listGroups() } satisfies GroupsAdminResponse;
  } },
  'POST /api/admin/groups': { auth: 'admin', permission: 'groups.manage', module: null, restoreSection: null, body: { limit: 2048 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { group: await asCaller({ userId, token: getAuthTokenFromRequest(req), permission: 'groups.manage' }, () => createGroup(userId, body, req)) } satisfies { group: GroupSummary };
  } },
  // Admin path: a group, its memberships and its policies; no person's data.
  'DELETE /api/admin/groups/:id': { auth: 'admin', permission: 'groups.manage', module: null, restoreSection: null, body: { limit: 4096 }, handler: async (req: Request, userId: string, body: { current_password?: unknown } | null, res: ServerResponse) => {
    const confirmed = await confirmPasswordHash(userId, body?.current_password, res);
    if ('refused' in confirmed) return confirmed.refused;
    return { ...await asCaller({ userId, token: getAuthTokenFromRequest(req), permission: 'groups.manage', passwordHash: confirmed.passwordHash }, () => deleteGroup(userId, req.params.id, req)) };
  } },
  'PUT /api/admin/groups/:id/managers/:userId': { auth: 'admin', permission: 'groups.manage', module: null, restoreSection: null, body: { limit: 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { ...await asCaller({ userId, token: getAuthTokenFromRequest(req), permission: 'groups.manage' }, () => setManager(userId, req.params.id, req.params.userId, body, req)) } satisfies GroupResponse;
  } },

  'GET /api/groups': { auth: 'user', module: null, handler: async (_req: Request, userId: string) => {
    return { groups: await myGroups(userId) } satisfies MyGroupsResponse;
  } },
  'GET /api/groups/:id': { auth: 'user', module: null, handler: async (req: Request, userId: string) => {
    return { ...await groupDetail(userId, req.params.id) } satisfies GroupResponse;
  } },
  'PUT /api/groups/:id': { auth: 'user', module: null, restoreSection: null, body: { limit: 2048 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { group: await asPerson(req, userId, () => renameGroup(userId, req.params.id, body, req)) } satisfies { group: GroupSummary };
  } },
  'GET /api/groups/:id/candidates': { auth: 'user', module: null, handler: async (req: Request, userId: string) => {
    const query = new URL(req.url, 'http://localhost').searchParams.get('q') ?? '';
    return { people: await groupCandidates(userId, req.params.id, query) } satisfies GroupCandidatesResponse;
  } },
  'POST /api/groups/:id/members': { auth: 'user', module: null, restoreSection: null, body: { limit: 16384 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { ...await asPerson(req, userId, () => addMembers(userId, req.params.id, body, req)) } satisfies GroupResponse;
  } },
  // A membership; no data.
  'DELETE /api/groups/:id/members/:userId': { auth: 'user', module: null, restoreSection: null, handler: async (req: Request, userId: string) => {
    return { ...await asPerson(req, userId, () => removeMember(userId, req.params.id, req.params.userId, req)) };
  } },
});
