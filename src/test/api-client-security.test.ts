import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';

describe('api client security', () => {
  beforeEach(() => {
    api.setCsrfToken(null);
    vi.restoreAllMocks();
  });

  it('rejects absolute URLs to avoid credential leakage', async () => {
    const response = await api.get('https://evil.example.com/steal');
    expect(response.error).toBe('Absolute API URLs are not allowed.');
  });

  it('sends cookie credentials and CSRF header without Authorization bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'application/json',
      },
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    api.setCsrfToken('csrf-token-value');
    await api.post('/contacts', { first_name: 'Alice' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.credentials).toBe('include');
    expect(requestInit.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'csrf-token-value',
    });
    expect((requestInit.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
