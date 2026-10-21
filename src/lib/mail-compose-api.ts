import { api } from '@/lib/api';
import { unwrap } from '@/lib/api-error';
import type { Email } from '@/lib/mail-api';

/** A file to upload; client_id names it so a draft save can answer which attachment it became. */
export type AttachmentPayload = Array<{ filename: string; contentType: string; size: number; dataBase64: string; client_id?: string }>;

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

/** What a reply answers: the server puts that message's id in In-Reply-To and References. */
export type ReplyThreading = { in_reply_to_email_id?: string };

export async function sendMessage(message: OutgoingMessage & ReplyThreading & { attachments?: AttachmentPayload }, sendKey: string) {
  return unwrap(await api.post('/mail/send', message, keyed(sendKey)));
}

/** Sends a stored draft; the server removes it once sent. */
export async function sendDraft(draftId: string, sendKey: string, threading: ReplyThreading = {}) {
  unwrap(await api.post(`/mail/drafts/${draftId}/send`, threading.in_reply_to_email_id ? threading : undefined, keyed(sendKey)));
}

type SavedDraft = { draft: Email; uploaded?: Array<{ client_id: string; id: string }> };

/**
 * Creates the draft, or updates it when draftId names one. Returns the stored
 * draft and, for each uploaded file that had a client_id, the attachment it became.
 */
export async function saveDraft(draftId: string | null, draft: DraftInput) {
  const saved = unwrap(draftId
    ? await api.put<SavedDraft>(`/mail/drafts/${draftId}`, draft)
    : await api.post<SavedDraft>('/mail/drafts', draft));
  if (!saved?.draft) throw new Error('Failed to save draft');
  return { draft: saved.draft, uploaded: saved.uploaded ?? [] };
}

export async function deleteDraft(draftId: string) {
  unwrap(await api.delete(`/mail/drafts/${draftId}`));
}
