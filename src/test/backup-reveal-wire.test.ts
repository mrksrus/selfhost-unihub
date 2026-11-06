import { afterEach, expect, it, vi } from 'vitest';
import { RevealAlreadyShown, RevealUncertain, revealRecoveryPasswordOnce } from '@/lib/backup-api';
import { ApiError } from '@/lib/api-error';

// The reveal's outcome through the real ApiClient (src/lib/api.ts), classified by
// the answer's shape: only the API's own JSON refusal before showing the password
// is a refusal. Everything the client cannot read as that, including a proxy's
// HTML page with a 200, is uncertain: the server may have shown the password.
afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown, format: 'json' | 'html' | 'bad-json') =>
  new Response(format === 'json' ? JSON.stringify(body) : (body as string), { status, headers: { 'content-type': format === 'html' ? 'text/html' : 'application/json' } });

it.each([
  [200, { recovery_password: 'synthetic-success' }, 'json', 'answered'],
  [400, { error: 'Invalid backup job id' }, 'json', 'refused'],
  [404, { error: 'Backup or recovery password not found' }, 'json', 'refused'],
  [409, { error: 'Backup is not ready' }, 'json', 'refused'],
  [410, { error: 'Recovery password has already been revealed' }, 'json', 'shown'],
  [408, { error: 'Timed out' }, 'json', 'uncertain'],
  [500, { error: 'Failed to reveal recovery password' }, 'json', 'uncertain'],
  [502, '<html>proxy failed</html>', 'html', 'uncertain'],
  [403, '<html>proxy failed</html>', 'html', 'uncertain'],
  [200, '<html>proxy page</html>', 'html', 'uncertain'],
  [200, 'invalid JSON', 'bad-json', 'uncertain'],
  [200, {}, 'json', 'uncertain'],
] as const)('HTTP %s %j as %s is %s', async (status, body, format, outcome) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(status, body, format)));
  const reveal = revealRecoveryPasswordOnce('synthetic-job');
  if (outcome === 'answered') await expect(reveal).resolves.toBe('synthetic-success');
  else await expect(reveal).rejects.toBeInstanceOf(outcome === 'refused' ? ApiError : outcome === 'shown' ? RevealAlreadyShown : RevealUncertain);
});

it('a connection that drops is uncertain, not a refusal', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(revealRecoveryPasswordOnce('synthetic-job')).rejects.toBeInstanceOf(RevealUncertain);
});
