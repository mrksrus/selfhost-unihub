import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type { Email } from '@/lib/mail-api';

export type AttachmentPayload = Array<{ filename: string; contentType: string; size: number; dataBase64: string }>;

export interface OutgoingMessage {
  account_id: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  isHtml: boolean;
}

export interface DraftInput extends OutgoingMessage {
  /** Attachments of the stored draft that stay; the others are removed. */
  existing_attachment_ids?: string[];
  attachments?: AttachmentPayload;
}

// sendKey is the Idempotency-Key of the composed message: a repeat after a
// lost response returns the first result instead of sending twice.
const keyed = (sendKey: string) => ({ headers: { 'Idempotency-Key': sendKey } });

export async function sendMessage(message: OutgoingMessage & { attachments?: AttachmentPayload }, sendKey: string) {
  return unwrap(await api.post('/mail/send', message, keyed(sendKey)));
}

/** Sends a stored draft; the server removes it once sent. */
export async function sendDraft(draftId: string, sendKey: string) {
  unwrap(await api.post(`/mail/drafts/${draftId}/send`, undefined, keyed(sendKey)));
}

/** Creates the draft, or updates it when draftId names one; returns the stored draft. */
export async function saveDraft(draftId: string | null, draft: DraftInput) {
  const saved = unwrap(draftId
    ? await api.put<{ draft: Email }>(`/mail/drafts/${draftId}`, draft)
    : await api.post<{ draft: Email }>('/mail/drafts', draft))?.draft;
  if (!saved) throw new Error('Failed to save draft');
  return saved;
}

export async function deleteDraft(draftId: string) {
  unwrap(await api.delete(`/mail/drafts/${draftId}`));
}
