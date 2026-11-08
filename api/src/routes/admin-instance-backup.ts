import type { ServerResponse } from 'node:http';
import type { RouteRequest } from '../types';
import type { InstanceBackupRunResponse, InstanceBackupStatus } from '../contracts/instance-backup';
import { defineRoutes } from '../http/route';
import { clientError } from '../http/errors';
import { getInstanceBackupStatus, startInstanceBackup, updateInstanceBackupSchedule } from '../services/instance-backup';
import { confirmPassword } from '../security/reauthentication';
import { isWorkerOwner } from '../services/worker-owner';
import { recordAuditAfter } from '../services/audit';
import { log } from '../log';

// The instance backup's admin page (contracts/instance-backup.ts): its state,
// "Back up now" and the schedule (D35). The destination and the key are
// read-only here; the files are on the destination mount and are never
// downloaded through the API.
export = defineRoutes({
  'GET /api/admin/instance-backup': { auth: 'admin', permission: 'server.settings', module: null, handler: async () => {
    const status: InstanceBackupStatus = await getInstanceBackupStatus();
    return { ...status };
  } },

  'POST /api/admin/instance-backup/run': { auth: 'admin', permission: 'server.settings', module: null, restoreSection: null, body: { limit: 1024 },
    handler: async (req: RouteRequest, userId: string) => {
      // The worker owner runs the backup; another process (a handover) does not start one.
      if (!isWorkerOwner()) return { error: 'The server is starting its background work; try again in a minute.', code: 'INSTANCE_BACKUP_NOT_READY', status: 503 };
      try {
        const { run, done } = await startInstanceBackup({ trigger: 'manual', actorId: userId });
        done.catch(error => log.error('INSTANCE BACKUP', 'Run ended unexpectedly', error, { run: run.id }));
        await recordAuditAfter({ action: 'admin.instance_backup_started', actorId: userId, req, details: { run: run.id } });
        const response: InstanceBackupRunResponse = { run };
        return { ...response, status: 202 };
      } catch (error) {
        return clientError(error, 'Could not start the instance backup');
      }
    } },

  'PUT /api/admin/instance-backup/settings': { auth: 'admin', permission: 'server.settings', module: null, restoreSection: null, body: { limit: 2048 },
    handler: async (req: RouteRequest, userId: string, body: unknown, res: ServerResponse) => {
      const refused = await confirmPassword(userId, (body as { current_password?: unknown } | null)?.current_password, res);
      if (refused) return refused;
      return { ...await updateInstanceBackupSchedule(userId, body, { req }) };
    } },
});
