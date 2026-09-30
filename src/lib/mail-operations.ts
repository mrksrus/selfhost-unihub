import { api, type ApiResponse } from '@/lib/api';

export interface MailAcceptance {
  sync_pending?: boolean;
  operation_ids?: string[];
  accepted_revision?: string | number;
  message?: string;
}

export class UnknownMailAcceptance extends Error {
  constructor(readonly key: string) {
    super('UniHub has not confirmed whether this change was saved. The same request will be checked again; do not repeat the action with a new key.');
  }
}

export type MailCommand = { method: 'PUT' | 'POST'; path: string; body: object; key: string };
export const newMailCommand = (method: MailCommand['method'], path: string, body: object): MailCommand =>
  ({ method, path, body, key: crypto.randomUUID() });

function ambiguous(response: ApiResponse<unknown>) {
  return response.status === 408 || response.status === 429 || response.status === 502 || response.status === 503 ||
    response.status === 504 || (response.status !== undefined && response.status >= 500) ||
    (response.status === undefined && /timed out|network|could not reach|failed to fetch|did not respond|invalid json|not with json|offline mode is read-only|no network connection/i.test(response.error || ''));
}

async function lookup(key: string): Promise<MailAcceptance | null> {
  const result = await api.get<{ found?: boolean; response?: MailAcceptance | null; operations?: unknown[] }>(`/mail/operations?key=${encodeURIComponent(key)}`);
  if (result.error || !result.data?.found) return null;
  return result.data.response ?? { sync_pending: true };
}

// On a lost acknowledgement, look up the durable receipt before replaying the
// exact original request/key. Never create a second MOVE key to recover HTTP.
export async function acceptMailCommand(command: MailCommand): Promise<MailAcceptance> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let result: ApiResponse<MailAcceptance>;
    try {
      result = command.method === 'PUT'
        ? await api.put<MailAcceptance>(command.path, command.body, { headers: { 'Idempotency-Key': command.key } })
        : await api.post<MailAcceptance>(command.path, command.body, { headers: { 'Idempotency-Key': command.key } });
    } catch {
      result = { error: 'Network request did not respond.' };
    }
    if (!result.error && result.data) return result.data;
    if (!result.error) result = { error: 'Invalid mail acceptance response' };
    if (!ambiguous(result)) throw new Error(result.error);
    try {
      const accepted = await lookup(command.key);
      if (accepted) return accepted;
    } catch { /* Lookup failure is not proof of rejection. */ }
  }
  throw new UnknownMailAcceptance(command.key);
}
