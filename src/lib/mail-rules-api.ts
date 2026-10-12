import { api } from '@/lib/api';

export interface MailSenderRule {
  id: string;
  mail_account_id: string | null;
  match_type: 'domain' | 'email';
  match_value: string;
  target_folder: string;
  priority: number;
  is_active: number | boolean;
  account_email?: string | null;
}

interface Candidate { email_count: number; last_received_at: string | null; has_rule: number; matching_rule?: MailSenderRule | null }
export interface DomainCandidate extends Candidate { domain: string }
export interface SenderCandidate extends Candidate { sender_email: string; sender_name: string | null }

export interface RuleInput {
  match_type: 'domain' | 'email';
  match_value: string;
  target_folder: string;
  mail_account_id: string | null;
  priority: number;
  is_active: boolean;
}

export interface SortResult { scanned: number; matched: number; applied: number; queued?: number; skipped?: number; complete?: boolean; next_cursor?: string | null }

export const senderCandidatesQueryKey = ['mail-sender-candidates'] as const;

async function send<T>(request: Promise<{ data?: T; error?: string }>) {
  const response = await request;
  if (response.error) throw new Error(response.error);
  return response.data;
}

export const mailRulesApi = {
  candidates: async (signal?: AbortSignal) => (await send(api.get<{ domains: DomainCandidate[]; senders: SenderCandidate[] }>(
    '/settings/mail-sender-candidates?domain_limit=20&sender_limit=20', { signal }))) ?? { domains: [], senders: [] },
  save: (id: string | undefined, rule: RuleInput) => send(id ? api.put(`/mail/sender-rules/${id}`, rule) : api.post('/mail/sender-rules', rule)),
  remove: (id: string) => send(api.delete(`/mail/sender-rules/${id}`)),
  // Moves matching inbox mail in batches; a cursor continues an incomplete pass.
  sortInbox: (cursor: string | null) => send(api.post<SortResult>('/mail/sender-rules/backfill', { mode: 'apply', limit: 5000, cursor: cursor || undefined })),
};
