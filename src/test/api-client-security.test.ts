import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { AppLockRequired, unwrap } from '@/lib/api-error';
import { onAppEvent } from '@/lib/app-events';

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
    expect(response.error).toContain('attachment');
    expect(response.error).not.toContain('not JSON');
  });

  it('reports the server-side size limit of an oversized write instead of an attachment hint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      statusText: 'Payload Too Large',
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Request body too large (max 262144 bytes)' }),
    }) as unknown as typeof fetch);

    const response = await api.put('/recordings/r1', { category: 'music', metadata: { chords: 'C G Am F' } });

    expect(response.status).toBe(413);
    expect(response.error).toBe('Request body too large (max 262144 bytes)');
  });

  it('mentions attachments only when a proxy refuses a compose request', async () => {
    const proxyRefusal = () => vi.fn().mockResolvedValue({
      ok: false,
      status: 413,
      statusText: 'Request Entity Too Large',
      headers: { get: () => 'text/html' },
      text: async () => '<html><body>413 Request Entity Too Large</body></html>',
    }) as unknown as typeof fetch;

    vi.stubGlobal('fetch', proxyRefusal());
    const contact = await api.post('/contacts', { first_name: 'Alice', notes: 'long' });
    expect(contact.status).toBe(413);
    expect(contact.error).toContain('too large');
    expect(contact.error).not.toContain('attachment');

    vi.stubGlobal('fetch', proxyRefusal());
    const draft = await api.put('/mail/drafts/d1', { attachments: [] });
    expect(draft.error).toContain('attachment');
  });
  // A lock-wait timeout answers 503 CHANGE_IN_PROGRESS with its own sentence: the person reads that, not a generic server error.
  it('shows the server\'s own words for a 503 that carries them, with its code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 503, statusText: 'Service Unavailable',
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Another change is in progress. Try again in a moment.', code: 'CHANGE_IN_PROGRESS' }),
    }) as unknown as typeof fetch);
    api.setCsrfToken('csrf-token-value');
    const response = await api.put('/mail/accounts/m1/calendar', { enabled: false });
    expect(response).toMatchObject({ status: 503, code: 'CHANGE_IN_PROGRESS', error: 'Another change is in progress. Try again in a moment.' });
  });

  it('forwards AbortSignal and preserves cancellation as a rejected request', async () => {
    const controller = new AbortController();
    const cancelled = new DOMException('Cancelled', 'AbortError');
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      throw cancelled;
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.get('/contacts', { signal: controller.signal })).rejects.toBe(cancelled);
  });


  it('a request refused for a missing app lock tells the lock provider and throws AppLockRequired, with known values only', async () => {
    const refusal = { error: 'Your administrator requires the app lock for Mail.', code: 'APP_LOCK_REQUIRED',
      details: { required: ['mail', 'chat'], max_background: '300', reason: 'Your administrator requires the app lock for Mail.' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', headers: { get: () => 'application/json' }, json: async () => refusal }) as unknown as typeof fetch);
    const heard: unknown[] = [];
    const stop = onAppEvent('unihub:app-lock-required', details => heard.push(details));
    const response = await api.get('/mail/accounts');
    stop();
    const expected = { required: ['mail'], max_background: '300', reason: 'Your administrator requires the app lock for Mail.' };
    expect(heard).toEqual([expected]);
    let thrown: unknown;
    try { unwrap(response); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AppLockRequired);
    expect(thrown).toMatchObject({ status: 403, code: 'APP_LOCK_REQUIRED', requirement: expected });
  });

  it('another 403 is no app lock prompt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', headers: { get: () => 'application/json' }, json: async () => ({ error: 'Mail is turned off.', code: 'MODULE_DISABLED' }) }) as unknown as typeof fetch);
    const heard: unknown[] = [];
    const stop = onAppEvent('unihub:app-lock-required', details => heard.push(details));
    const response = await api.get('/mail/accounts');
    stop();
    expect(heard).toEqual([]);
    expect(() => unwrap(response)).toThrow('Mail is turned off.');
  });
});
