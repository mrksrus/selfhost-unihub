import type { RouteRequest, ApiError } from '../types';
import type { MailTemplateResponse, MailTemplatesResponse, ScheduleResponse, SignatureResponse, SnoozeResponse } from '../contracts/mail';
import { clientError } from '../http/errors';
import { log } from '../log';
import { defineRoutes } from '../http/route';
import { saveSignature, SIGNATURE_HTML_LIMIT, SIGNATURE_TEXT_LIMIT } from '../services/mail-signature';
import { createTemplate, deleteTemplate, listTemplates, updateTemplate, TEMPLATE_HTML_LIMIT, TEMPLATE_TEXT_LIMIT } from '../services/mail-templates';
import { cancelSchedule, scheduleDraft } from '../services/mail-scheduled-send';
import { snoozeEmail, unsnoozeEmail } from '../services/mail-snooze';

// The mail essentials of 0.24: signatures, templates, scheduled send and
// snooze. Declared with their specs; the older mail route files are
// still wrapped by legacy-spec.ts.
type Request = RouteRequest & { params: Record<string, string> };

function failed(error: unknown, fallback: string) {
  if (!(error as ApiError).status) log.error('mail', fallback, error);
  return clientError(error, fallback);
}

export = defineRoutes({
  'PUT /api/mail/accounts/:id/signature': { auth: 'user', module: 'mail', restoreSection: 'mail',
    body: { limit: SIGNATURE_HTML_LIMIT + SIGNATURE_TEXT_LIMIT + 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
      try {
        return await saveSignature(userId, req.params.id, body) satisfies SignatureResponse;
      } catch (error) { return failed(error, 'Failed to save the signature'); }
    } },

  'GET /api/mail/templates': { auth: 'user', module: 'mail', handler: async (req: Request, userId: string) => {
    try {
      return { templates: await listTemplates(userId) } satisfies MailTemplatesResponse;
    } catch (error) { return failed(error, 'Failed to load templates'); }
  } },
  'POST /api/mail/templates': { auth: 'user', module: 'mail', restoreSection: 'mail',
    body: { limit: TEMPLATE_HTML_LIMIT + TEMPLATE_TEXT_LIMIT + 4096 }, handler: async (req: Request, userId: string, body: unknown) => {
      try {
        return { template: await createTemplate(userId, body) } satisfies MailTemplateResponse;
      } catch (error) { return failed(error, 'Failed to save the template'); }
    } },
  'PUT /api/mail/templates/:id': { auth: 'user', module: 'mail', restoreSection: 'mail',
    body: { limit: TEMPLATE_HTML_LIMIT + TEMPLATE_TEXT_LIMIT + 4096 }, handler: async (req: Request, userId: string, body: unknown) => {
      try {
        return { template: await updateTemplate(userId, req.params.id, body) } satisfies MailTemplateResponse;
      } catch (error) { return failed(error, 'Failed to save the template'); }
    } },
  'DELETE /api/mail/templates/:id': { auth: 'user', module: 'mail', restoreSection: 'mail', handler: async (req: Request, userId: string) => {
    try {
      await deleteTemplate(userId, req.params.id);
      return { deleted: true };
    } catch (error) { return failed(error, 'Failed to delete the template'); }
  } },

  'POST /api/mail/drafts/:id/schedule': { auth: 'user', module: 'mail', restoreSection: 'mail', body: { limit: 1024 },
    handler: async (req: Request, userId: string, body: unknown) => {
      try {
        return { schedule: await scheduleDraft(userId, req.params.id, body) } satisfies ScheduleResponse;
      } catch (error) { return failed(error, 'Failed to schedule the message'); }
    } },
  'DELETE /api/mail/drafts/:id/schedule': { auth: 'user', module: 'mail', restoreSection: 'mail', handler: async (req: Request, userId: string) => {
    try {
      return await cancelSchedule(userId, req.params.id);
    } catch (error) { return failed(error, 'Failed to cancel the scheduled send'); }
  } },

  'POST /api/mail/emails/:id/snooze': { auth: 'user', module: 'mail', restoreSection: 'mail', body: { limit: 1024 },
    handler: async (req: Request, userId: string, body: unknown) => {
      try {
        return await snoozeEmail(userId, req.params.id, body) satisfies SnoozeResponse;
      } catch (error) { return failed(error, 'Failed to snooze the message'); }
    } },
  'DELETE /api/mail/emails/:id/snooze': { auth: 'user', module: 'mail', restoreSection: 'mail', handler: async (req: Request, userId: string) => {
    try {
      return await unsnoozeEmail(userId, req.params.id) satisfies SnoozeResponse;
    } catch (error) { return failed(error, 'Failed to bring the message back'); }
  } },
});
