import { api } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import type {
  MailTemplate, MailTemplateRequest, MailTemplateResponse, MailTemplatesResponse, ScheduleResponse, ScheduledSend,
  SignatureRequest, SignatureResponse, SnoozeResponse,
} from '../../api/src/contracts/mail';
export type { MailTemplate, MailTemplateRequest, ScheduledSend } from '../../api/src/contracts/mail';

// Browser side of the 0.24 mail essentials: signatures, templates, scheduled
// send and snooze (api/src/routes/mail-essentials.ts).
export const mailTemplatesKey = ['mail-templates'] as const;

// A failed request is thrown as ApiError, so the composer can tell a
// scheduled send in progress (409 SCHEDULED_SEND_IN_PROGRESS) or a taken
// template name (409 TEMPLATE_NAME_TAKEN) from any other failure.
async function unwrap<T>(request: Promise<{ data?: T; error?: string; status?: number }>, fallback: string): Promise<T> {
  const response = await request;
  if (response.error) throw new ApiError(response);
  if (response.data === undefined) throw new Error(fallback);
  return response.data;
}

export const saveMailSignature = (accountId: string, signature: SignatureRequest) =>
  unwrap(api.put<SignatureResponse>(`/mail/accounts/${encodeURIComponent(accountId)}/signature`, signature), 'Could not save the signature');

export const fetchMailTemplates = async (): Promise<MailTemplate[]> =>
  (await unwrap(api.get<MailTemplatesResponse>('/mail/templates'), 'Could not load templates')).templates;
export const createMailTemplate = async (template: MailTemplateRequest) =>
  (await unwrap(api.post<MailTemplateResponse>('/mail/templates', template), 'Could not save the template')).template;
export const updateMailTemplate = async (id: string, template: MailTemplateRequest) =>
  (await unwrap(api.put<MailTemplateResponse>(`/mail/templates/${encodeURIComponent(id)}`, template), 'Could not save the template')).template;
export const deleteMailTemplate = (id: string) =>
  unwrap(api.delete<{ deleted: boolean }>(`/mail/templates/${encodeURIComponent(id)}`), 'Could not delete the template');

/** Schedules a saved draft (or moves its time). Save the draft first: the stored draft is what gets sent. */
export const scheduleMailDraft = async (draftId: string, sendAt: Date): Promise<ScheduledSend> =>
  (await unwrap(api.post<ScheduleResponse>(`/mail/drafts/${encodeURIComponent(draftId)}/schedule`, { send_at: sendAt.toISOString() }), 'Could not schedule the message')).schedule;
export const cancelMailSchedule = (draftId: string) =>
  unwrap(api.delete<{ email_id: string; cancelled: boolean }>(`/mail/drafts/${encodeURIComponent(draftId)}/schedule`), 'Could not cancel the scheduled send');

export const snoozeMail = (emailId: string, until: Date) =>
  unwrap(api.post<SnoozeResponse>(`/mail/emails/${encodeURIComponent(emailId)}/snooze`, { until: until.toISOString() }), 'Could not snooze the message');
export const unsnoozeMail = (emailId: string) =>
  unwrap(api.delete<SnoozeResponse>(`/mail/emails/${encodeURIComponent(emailId)}/snooze`), 'Could not bring the message back');
