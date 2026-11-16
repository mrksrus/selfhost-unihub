import type { RouteRequest } from '../types';
import type { DirectoryEntryResponse, DirectoryResponse } from '../contracts/directory';
import { defineRoutes } from '../http/route';
import { personFromParam } from '../services/admin-path';
import { listDirectory, updateDirectoryEntry } from '../services/directory';

// The company directory (contracts/directory.ts). Reading it is the Contacts
// module's; a person's own fields sit under Settings › Profile, open with
// Contacts off. Directory rows are organisation data, in no personal backup.
type Request = RouteRequest & { url: string; params: Record<string, string> };

export = defineRoutes({
  'GET /api/directory': { auth: 'user', module: 'contacts', handler: async () => {
    const entries = (await listDirectory()).map(({ created_at: _created, updated_at: _updated, ...entry }) => entry);
    return { entries } satisfies DirectoryResponse;
  } },
  'PUT /api/directory/me': { auth: 'user', module: null, restoreSection: null, body: { limit: 4096 }, handler: async (_req: Request, userId: string, body: unknown) => {
    return { entry: await updateDirectoryEntry(userId, body) } satisfies DirectoryEntryResponse;
  } },
  // An administrator's correction, recorded in the activity log.
  'PUT /api/admin/users/:id/directory': { auth: 'admin', permission: 'users.manage', module: null, restoreSection: null, body: { limit: 4096 }, handler: async (req: Request, adminId: string, body: unknown) => {
    return { entry: await updateDirectoryEntry(await personFromParam(req.params.id), body, { adminId, req }) } satisfies DirectoryEntryResponse;
  } },
});
