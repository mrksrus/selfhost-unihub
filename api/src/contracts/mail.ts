// Request and response shapes of the 0.24 mail routes (F11). The frontend
// imports these as types only.

/** PUT /api/mail/accounts/:id/signature. Empty text clears the signature. */
export interface SignatureRequest { html: string; text: string }
export interface SignatureResponse { id: string; signature_html: string | null; signature_text: string | null }

export interface MailTemplate {
  id: string;
  name: string;
  subject: string;
  /** Rich version; null for a plain-text template. */
  body_html: string | null;
  body_text: string;
  updated_at: string;
}
/** POST /api/mail/templates and PUT /api/mail/templates/:id. */
export interface MailTemplateRequest { name: string; subject?: string; body_html?: string | null; body_text?: string }
export interface MailTemplatesResponse { templates: MailTemplate[] }
export interface MailTemplateResponse { template: MailTemplate }

/** A draft's scheduled send (POST/DELETE /api/mail/drafts/:id/schedule; list rows carry scheduled_send_at and scheduled_send_status). */
export interface ScheduledSend {
  email_id: string;
  send_at: string;
  /** scheduled, being sent, sent (the draft could not be removed), failed (not sent) or unknown (may have been sent: check Sent). */
  status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'unknown';
  last_error: string | null;
}
/** POST /api/mail/drafts/:id/schedule */
export interface ScheduleRequest { send_at: string }
export interface ScheduleResponse { schedule: ScheduledSend }
/** POST /api/mail/emails/:id/snooze */
export interface SnoozeRequest { until: string }
export interface SnoozeResponse { id: string; snoozed_until: string | null }
