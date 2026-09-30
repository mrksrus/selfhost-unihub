import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { acceptMailCommand, newMailCommand, UnknownMailAcceptance } from '@/lib/mail-operations';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());

describe('mail HTTP acceptance recovery (not provider confirmation)', () => {
  it('treats a found receipt without a response body as accepted but never provider-confirmed', async () => {
    const command = newMailCommand('PUT', '/mail/emails/m1/read', { is_read: true });
    vi.mocked(api.put).mockResolvedValue({ status: 504, error: 'Gateway timeout' });
    vi.mocked(api.get).mockResolvedValue({ data: { found: true, response: null, operations: [{ state: 'reconciling' }] } });
    expect(await acceptMailCommand(command)).toEqual({ sync_pending: true });
    expect(api.put).toHaveBeenCalledTimes(1);
  });
  it('uses the owner-scoped receipt instead of repeating an acknowledged MOVE', async () => {
    const command = newMailCommand('POST', '/mail/emails/bulk-move', { email_ids: ['m1'], folder: 'archive' });
    vi.mocked(api.post).mockResolvedValue({ error: 'The server was reached, but it did not respond before the request timed out.' });
    vi.mocked(api.get).mockResolvedValue({ data: { found: true, response: { operation_ids: ['op1'], sync_pending: true }, operations: [] } });
    const accepted = await acceptMailCommand(command);
    expect(accepted).toMatchObject({ operation_ids: ['op1'], sync_pending: true });
    expect(api.get).toHaveBeenCalledExactlyOnceWith(`/mail/operations?key=${command.key}`);
    expect(api.post).toHaveBeenCalledExactlyOnceWith(command.path, command.body, { headers: { 'Idempotency-Key': command.key } });
  });
  it('retries precisely the same key and body if lookup has no receipt', async () => {
    const command = newMailCommand('POST', '/mail/emails/bulk-delete', { email_ids: ['m1'] });
    vi.mocked(api.post).mockResolvedValueOnce({ status: 504, error: 'Gateway timeout' }).mockResolvedValueOnce({ data: { operation_ids: ['op2'], sync_pending: true } });
    vi.mocked(api.get).mockResolvedValue({ data: { found: false, response: null, operations: [] } });
    expect(await acceptMailCommand(command)).toMatchObject({ operation_ids: ['op2'] });
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
  });
  it('does not invent a new key or misreport an unresolved acceptance as rejection', async () => {
    const command = newMailCommand('PUT', '/mail/emails/m1/star', { is_starred: true });
    vi.mocked(api.put).mockResolvedValue({ status: 503, error: 'API unavailable' });
    vi.mocked(api.get).mockResolvedValue({ error: 'Status unavailable' });
    await expect(acceptMailCommand(command)).rejects.toBeInstanceOf(UnknownMailAcceptance);
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(new Set(vi.mocked(api.put).mock.calls.map(([, , options]) => (options?.headers as Record<string, string>)['Idempotency-Key']))).toEqual(new Set([command.key]));
  });
});
