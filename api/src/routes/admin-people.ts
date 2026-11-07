import type { ServerResponse } from 'node:http';
import type { RouteRequest, RouteResponse } from '../types';
import type { AdminClearModule, AdminDeleteResponse, AdminUserBackupsResponse } from '../contracts/admin-accounts';
import type { BinDeleteResponse, BinListResponse } from '../contracts/bin';
import { defineRoutes } from '../http/route';
import { clientError, notFound } from '../http/errors';
import { confirmPassword } from '../security/reauthentication';
import { recordAuditAfter } from '../services/audit';
import { adminMailAccountChange, assertPerson, assertPersonModule, personAccounts } from '../services/admin-path';
import { createMailAccount, updateMailAccount } from '../services/mail-account-changes';
import { disconnectAccount, disconnectAndPurgeAccount } from '../services/mail-account-lifecycle';
import { createCalendarAccount, deleteCalendarAccount, updateCalendarAccount } from '../services/calendar-account-changes';
import { deleteDataExportJob, listDataExportJobs } from '../services/export-jobs';
import { deleteBinItem, emptyBin, listBin } from '../services/bin';
import { clearModuleData, isClearTarget } from '../services/data-clear';

// The administrator's path for one person (F13, accounts.admin_manage;
// contracts/admin-accounts.ts): what a policy forbids the person, an
// administrator with users.manage does for them after entering their own
// password, and the activity log records it with the person as target. Each
// route calls the service of the person's own route with the person's id
// and the administrator as actor (services/admin-path.ts checks the
// person's module switch and restore lock). Reading needs users.read.
type Request = RouteRequest & { url: string; params: Record<string, string> };
type Body = Record<string, unknown> & { current_password?: unknown };
type Handler = (req: Request, adminId: string, body: Body, res: ServerResponse) => Promise<RouteResponse>;

// The administrator's password stands for the person's confirmations; it
// never reaches the service with the rest of the body.
const withoutPassword = ({ current_password: _password, ...rest }: Body = {}) => rest;

function read(handler: (req: Request, adminId: string) => Promise<RouteResponse>) {
  return { auth: 'admin' as const, permission: 'users.read' as const, module: null, handler: async (req: Request, adminId: string) => {
    try { return await handler(req, adminId); } catch (error) { return answer(error); }
  } };
}

function change(handler: Handler, limit = 4096) {
  return { auth: 'admin' as const, permission: 'users.manage' as const, module: null, restoreSection: null, body: { limit },
    handler: async (req: Request, adminId: string, body: Body, res: ServerResponse) => {
      try {
        const refused = await confirmPassword(adminId, body?.current_password, res);
        if (refused) return refused;
        return await handler(req, adminId, body ?? {}, res);
      } catch (error) { return answer(error); }
    } };
}

// A refusal answers with its status and code; anything else is the
// boundary's 500 with the request id.
function answer(error: unknown): RouteResponse {
  if ((error as { status?: number }).status) return clientError(error, 'The change failed');
  throw error;
}

const failed = (result: RouteResponse) => typeof result.error === 'string' || (typeof result.status === 'number' && result.status >= 400);
const deleted = (count: number, extra: RouteResponse = {}): RouteResponse => ({ ...extra, deleted: count } satisfies AdminDeleteResponse & RouteResponse);

export = defineRoutes({
  'GET /api/admin/users/:id/accounts': read(async req => ({ ...await personAccounts(req.params.id) })),

  'POST /api/admin/users/:id/mail-accounts': change(async (req, adminId, body) => {
    const userId = req.params.id;
    await assertPersonModule(userId, 'mail');
    const result = await createMailAccount(userId, withoutPassword(body), { adminId }) as RouteResponse;
    const account = (result as { account?: { id?: string } }).account;
    if (!failed(result) && account?.id) await recordAuditAfter({ action: 'admin.mail_account_added', actorId: adminId, targetUserId: userId, req, details: { mail_account: account.id } });
    return result;
  }, 50000),

  'PUT /api/admin/users/:id/mail-accounts/:accountId': change(async (req, adminId, body) => {
    const userId = req.params.id, accountId = req.params.accountId;
    await assertPersonModule(userId, 'mail');
    const values = withoutPassword(body);
    const result = await updateMailAccount(userId, accountId, await adminMailAccountChange(userId, accountId, values), { adminId }) as RouteResponse;
    if (!failed(result)) {
      await recordAuditAfter({ action: 'admin.mail_account_changed', actorId: adminId, targetUserId: userId, req,
        details: { mail_account: accountId, fields: Object.keys(values).filter(key => key !== 'encrypted_password').sort().join(',') || null, password: 'encrypted_password' in values } });
    }
    return result;
  }, 50000),

  // Without purge: disconnected, UniHub keeps its copy of the mail. With
  // purge=true: disconnected and that copy deleted (the provider keeps its
  // mail), refused as the person's purge is while a provider change has an
  // unresolved outcome.
  'DELETE /api/admin/users/:id/mail-accounts/:accountId': change(async (req, adminId) => {
    const userId = req.params.id, accountId = req.params.accountId;
    await assertPersonModule(userId, 'mail');
    const purge = new URL(req.url, 'http://localhost').searchParams.get('purge') === 'true';
    const result = purge
      ? await disconnectAndPurgeAccount(userId, accountId, null, { req, adminId })
      : await disconnectAccount(userId, accountId, { req, adminId });
    return deleted(1, result as RouteResponse);
  }),

  'POST /api/admin/users/:id/calendar-accounts': change(async (req, adminId, body) => {
    const userId = req.params.id;
    await assertPersonModule(userId, 'calendar');
    const result = await createCalendarAccount(userId, withoutPassword(body)) as RouteResponse;
    const account = (result as { account?: { id?: string } }).account;
    if (!failed(result) && account?.id) await recordAuditAfter({ action: 'admin.calendar_account_added', actorId: adminId, targetUserId: userId, req, details: { calendar_account: account.id } });
    return result;
  }, 50000),

  'PUT /api/admin/users/:id/calendar-accounts/:accountId': change(async (req, adminId, body) => {
    const userId = req.params.id, accountId = req.params.accountId;
    await assertPersonModule(userId, 'calendar');
    const values = withoutPassword(body);
    const result = await updateCalendarAccount(userId, accountId, values) as RouteResponse;
    if (!failed(result)) {
      await recordAuditAfter({ action: 'admin.calendar_account_changed', actorId: adminId, targetUserId: userId, req,
        details: { calendar_account: accountId, fields: Object.keys(values).filter(key => key !== 'password').sort().join(',') || null, password: 'password' in values } });
    }
    return result;
  }, 50000),

  'DELETE /api/admin/users/:id/calendar-accounts/:accountId': change(async (req, adminId) => {
    const userId = req.params.id, accountId = req.params.accountId;
    await assertPersonModule(userId, 'calendar');
    const result = await deleteCalendarAccount(userId, accountId) as RouteResponse;
    if (failed(result)) return result;
    await recordAuditAfter({ action: 'admin.calendar_account_removed', actorId: adminId, targetUserId: userId, req, details: { calendar_account: accountId } });
    return deleted(1, result);
  }),

  'GET /api/admin/users/:id/backups': read(async req => {
    await assertPerson(req.params.id);
    // The person's own GET /api/backup/jobs answer (export-jobs.ts serializeJob).
    const jobs = await listDataExportJobs(req.params.id) as unknown as AdminUserBackupsResponse['jobs'];
    return { jobs };
  }),

  // Also earlier than backup.server_retention_days would let the person (D36).
  'DELETE /api/admin/users/:id/backups/:jobId': change(async (req, adminId) => {
    const userId = req.params.id, jobId = req.params.jobId;
    await assertPerson(userId);
    const result = await deleteDataExportJob(userId, jobId) as RouteResponse;
    if (failed(result)) return result;
    await recordAuditAfter({ action: 'admin.backup_deleted', actorId: adminId, targetUserId: userId, req, details: { backup_job: jobId } });
    return deleted(1, result);
  }),

  'GET /api/admin/users/:id/bin': read(async req => {
    await assertPerson(req.params.id);
    const url = new URL(req.url, 'http://localhost');
    const response: BinListResponse = await listBin(req.params.id, url.searchParams.get('module') ?? undefined);
    return { ...response };
  }),

  // The bin checks the person's module switches and restore locks per module.
  'POST /api/admin/users/:id/bin/empty': change(async (req, adminId, body) => {
    const userId = req.params.id;
    await assertPerson(userId);
    const values = withoutPassword(body);
    const result: BinDeleteResponse = await emptyBin(userId, values);
    await recordAuditAfter({ action: 'admin.bin_emptied', actorId: adminId, targetUserId: userId, req,
      details: { deleted: result.deleted, module: typeof values.module === 'string' ? values.module : null } });
    return { ...result };
  }),

  'DELETE /api/admin/users/:id/bin/:itemId': change(async (req, adminId) => {
    const userId = req.params.id, itemId = req.params.itemId;
    await assertPerson(userId);
    const result: BinDeleteResponse = await deleteBinItem(userId, itemId);
    await recordAuditAfter({ action: 'admin.bin_item_deleted', actorId: adminId, targetUserId: userId, req, details: { bin_item: itemId } });
    return { ...result };
  }),

  // Settings → Delete data for the person; the entry is in the transaction of the deletion.
  'POST /api/admin/users/:id/clear/:module': change(async (req, adminId) => {
    const userId = req.params.id, target: unknown = req.params.module;
    if (!isClearTarget(target)) throw notFound('CLEAR_MODULE_UNKNOWN', 'Unknown data to delete');
    await assertPerson(userId);
    return { ...await clearModuleData(userId, target satisfies AdminClearModule, { adminId, req }) };
  }),
});
