import type { ServerResponse } from 'node:http';
import type { RouteRequest, RouteResponse } from '../types';
import type { AdminClearModule, AdminDeleteResponse, AdminUserBackupsResponse } from '../contracts/admin-accounts';
import type { BinDeleteResponse, BinListResponse } from '../contracts/bin';
import { defineRoutes } from '../http/route';
import { clientError, notFound } from '../http/errors';
import { confirmPasswordHash } from '../security/reauthentication';
import { getAuthTokenFromRequest } from '../auth';
import { asCaller } from '../services/caller-proof';
import type { AuditDetails, AuditEntry } from '../services/audit';
import { recordAudit, recordAuditIntent, settleAudit } from '../services/audit';
import { assertPerson, assertPersonModule, personAccounts, personFromParam } from '../services/admin-path';
import { createMailAccount, updateMailAccount } from '../services/mail-account-changes';
import { disconnectAccount, disconnectAndPurgeAccount } from '../services/mail-account-lifecycle';
import { createCalendarAccount, deleteCalendarAccount, updateCalendarAccount } from '../services/calendar-account-changes';
import { deleteDataExportJob, listDataExportJobs } from '../services/export-jobs';
import { deleteBinItem, emptyBin, listBin } from '../services/bin';
import { assertBackupDeletableNow } from '../services/backup-policy';
import { clearModuleData, isClearTarget } from '../services/data-clear';

// The administrator's path for one person (F13, accounts.admin_manage;
// contracts/admin-accounts.ts): what a policy forbids the person, an
// administrator with users.manage does for them after entering their own
// password, and the activity log records it with the person as target. Each
// route calls the service of the person's own route with the person's id
// and the administrator as actor (services/admin-path.ts checks the
// person's module switch and restore lock). Reading needs users.read.
// Every change has its entry before it answers: in the transaction of the
// change where the service has one (calendar account removal, the bin, the
// clears, mail account removal, a backup), else written first and settled
// after (audited).
type Request = RouteRequest & { url: string; params: Record<string, string> };
type Body = Record<string, unknown> & { current_password?: unknown };
type Handler = (req: Request, adminId: string, body: Body, res: ServerResponse) => Promise<RouteResponse>;

// The administrator's password stands for the person's confirmations; it
// never reaches the service with the rest of the body.
const withoutPassword = ({ current_password: _password, ...rest }: Body = {}) => rest;

// `:id` as the person's stored id (admin-path.ts personFromParam), so the
// services, the person's lock and the rows written all use one spelling.
async function asStored(req: Request): Promise<Request> {
  return Object.assign(req, { params: { ...req.params, id: await personFromParam(req.params.id) } });
}

function read(handler: (req: Request, adminId: string) => Promise<RouteResponse>) {
  return { auth: 'admin' as const, permission: 'users.read' as const, module: null, handler: async (req: Request, adminId: string) => {
    try { return await handler(await asStored(req), adminId); } catch (error) { return answer(error); }
  } };
}

function change(handler: Handler, limit = 4096) {
  return { auth: 'admin' as const, permission: 'users.manage' as const, module: null, restoreSection: null, body: { limit },
    handler: async (req: Request, adminId: string, body: Body, res: ServerResponse) => {
      try {
        const confirmed = await confirmPasswordHash(adminId, body?.current_password, res);
        if ('refused' in confirmed) return confirmed.refused;
        // The change may wait (the person's lock, rows); its final step asks
        // again that the administrator is one, signed in, with this password.
        return await asCaller({ userId: adminId, token: getAuthTokenFromRequest(req), admin: true, passwordHash: confirmed.passwordHash },
          async () => handler(await asStored(req), adminId, body ?? {}, res));
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

// The entry first; the change runs only once it is stored. A success
// settles it as done. An error answer settles it as unknown with the answer,
// as the service may have written part of the change before it refused; an
// error without a status leaves it pending.
async function audited(entry: AuditEntry, change: () => Promise<RouteResponse>, outcome: (result: RouteResponse) => AuditDetails = () => ({})) {
  const id = await recordAuditIntent(entry);
  const answered = (status: unknown, code: unknown) => settleAudit(id, 'unknown', { status: typeof status === 'number' ? status : null, code: typeof code === 'string' ? code : null });
  let result: RouteResponse;
  try {
    result = await change();
  } catch (error) {
    const { status, code } = error as { status?: number; code?: string };
    if (status && status < 500) await answered(status, code);
    throw error;
  }
  if (failed(result)) await answered(result.status, result.code); else await settleAudit(id, 'done', outcome(result));
  return result;
}
const deleted = (count: number, extra: RouteResponse = {}): RouteResponse => ({ ...extra, deleted: count } satisfies AdminDeleteResponse & RouteResponse);

export = defineRoutes({
  'GET /api/admin/users/:id/accounts': read(async req => ({ ...await personAccounts(req.params.id) })),

  'POST /api/admin/users/:id/mail-accounts': change(async (req, adminId, body) => {
    const userId = req.params.id;
    await assertPersonModule(userId, 'mail');
    // A server given by its addresses unless the dialog names a provider.
    return audited({ action: 'admin.mail_account_added', actorId: adminId, targetUserId: userId, req, details: { mail_account: null } },
      async () => await createMailAccount(userId, { provider: 'custom', ...withoutPassword(body) }, { adminId }) as RouteResponse,
      result => ({ mail_account: (result as { account?: { id?: string } }).account?.id ?? null }));
  }, 50000),

  'PUT /api/admin/users/:id/mail-accounts/:accountId': change(async (req, adminId, body) => {
    const userId = req.params.id, accountId = req.params.accountId;
    await assertPersonModule(userId, 'mail');
    const values = withoutPassword(body);
    return audited({ action: 'admin.mail_account_changed', actorId: adminId, targetUserId: userId, req,
      details: { mail_account: accountId, fields: Object.keys(values).filter(key => key !== 'encrypted_password').sort().join(',') || null, password: 'encrypted_password' in values } },
    async () => await updateMailAccount(userId, accountId, values, { adminId }) as RouteResponse);
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
    return audited({ action: 'admin.calendar_account_added', actorId: adminId, targetUserId: userId, req, details: { calendar_account: null } },
      async () => await createCalendarAccount(userId, withoutPassword(body), { adminId }) as RouteResponse,
      result => ({ calendar_account: (result as { account?: { id?: string } }).account?.id ?? null }));
  }, 50000),

  'PUT /api/admin/users/:id/calendar-accounts/:accountId': change(async (req, adminId, body) => {
    const userId = req.params.id, accountId = req.params.accountId;
    await assertPersonModule(userId, 'calendar');
    const values = withoutPassword(body);
    return audited({ action: 'admin.calendar_account_changed', actorId: adminId, targetUserId: userId, req,
      details: { calendar_account: accountId, fields: Object.keys(values).filter(key => key !== 'password').sort().join(',') || null, password: 'password' in values } },
    async () => await updateCalendarAccount(userId, accountId, values) as RouteResponse);
  }, 50000),

  'DELETE /api/admin/users/:id/calendar-accounts/:accountId': change(async (req, adminId) => {
    const userId = req.params.id, accountId = req.params.accountId;
    await assertPersonModule(userId, 'calendar');
    const result = await deleteCalendarAccount(userId, accountId, {
      actor: { adminId },
      record: cx => recordAudit({ action: 'admin.calendar_account_removed', actorId: adminId, targetUserId: userId, req, details: { calendar_account: accountId } }, cx),
    }) as RouteResponse;
    if (failed(result)) return result;
    return deleted(1, result);
  }),

  'GET /api/admin/users/:id/backups': read(async req => {
    await assertPerson(req.params.id);
    // The person's own GET /api/backup/jobs answer (export-jobs.ts serializeJob).
    const jobs = await listDataExportJobs(req.params.id) as unknown as AdminUserBackupsResponse['jobs'];
    return { jobs };
  }),

  // Also earlier than backup.server_retention_days would let the person.
  'DELETE /api/admin/users/:id/backups/:jobId': change(async (req, adminId) => {
    const userId = req.params.id, jobId = req.params.jobId;
    await assertPerson(userId);
    const result = await deleteDataExportJob(userId, jobId, {
      authorize: cx => assertBackupDeletableNow(cx, userId, jobId, { adminId }),
      record: cx => recordAudit({ action: 'admin.backup_deleted', actorId: adminId, targetUserId: userId, req, details: { backup_job: jobId } }, cx),
    }) as RouteResponse;
    if (failed(result)) return result;
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
    const module = typeof values.module === 'string' ? values.module : null;
    // An entry for each batch, with the batch's deletion.
    const result: BinDeleteResponse = await emptyBin(userId, values, {
      adminId,
      record: (cx, rows) => recordAudit({ action: 'admin.bin_emptied', actorId: adminId, targetUserId: userId, req, details: { deleted: rows.length, module } }, cx),
    });
    return { ...result };
  }),

  'DELETE /api/admin/users/:id/bin/:itemId': change(async (req, adminId) => {
    const userId = req.params.id, itemId = req.params.itemId;
    await assertPerson(userId);
    const result: BinDeleteResponse = await deleteBinItem(userId, itemId, {
      adminId,
      record: cx => recordAudit({ action: 'admin.bin_item_deleted', actorId: adminId, targetUserId: userId, req, details: { bin_item: itemId } }, cx),
    });
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
