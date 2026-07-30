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

  it('builds validated native download URLs without fetching the file into memory', () => {
    expect(api.getDownloadUrl('/backup/jobs/job-id/download')).toBe('/api/backup/jobs/job-id/download');
    expect(() => api.getDownloadUrl('https://evil.example.com/steal')).toThrow(
      'Absolute API URLs are not allowed.'
    );
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

  it('explains proxy upload rejections instead of reporting only a JSON error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      statusText: 'Request Entity Too Large',
      headers: {
        get: () => 'text/html',
      },
      text: async () => '<html><body>413 Request Entity Too Large</body></html>',
    }) as unknown as typeof fetch);

    const response = await api.post('/mail/send', { attachments: [] });

    expect(response.status).toBe(413);
    expect(response.error).toContain('request is too large');
    expect(response.error).not.toContain('not JSON');
  });
});
