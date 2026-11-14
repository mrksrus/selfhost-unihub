import type { ServerResponse } from 'node:http';
import type { RouteRequest } from '../types';
import type { InviteCheckResponse } from '../contracts/organisation';

import { consumeAuthAttempt, generateCsrfToken, getClientIP, hashPassword, setAuthCookie, setCsrfCookie } from '../auth';
import { defineRoutes } from '../http/route';
import { acceptInvite, assertPasswordLength, checkInvite, inviteeOf } from '../services/invites';
import { deviceClaim } from '../services/devices';
import { openSession } from '../services/sign-in';
import { listPeople } from '../services/user-lifecycle';
import { permissionsOf } from '../security/permissions';

// Setup links (services/invites.ts): public, as sign-up is, whatever the
// sign-up mode. The token travels in the body, never in the address.
type Request = RouteRequest & { url: string; params: Record<string, string> };
type Input = { token?: unknown; password?: unknown; full_name?: unknown; device?: unknown; rules_revision?: unknown } | null;

async function overBudget(res: ServerResponse, scope: Parameters<typeof consumeAuthAttempt>[0], identity: string) {
  const retryAfter = await consumeAuthAttempt(scope, identity);
  if (!retryAfter) return null;
  res.setHeader('Retry-After', String(retryAfter));
  return { error: `Too many attempts. Try again in ${retryAfter} seconds.`, status: 429 };
}

export = defineRoutes({
  'POST /api/auth/invite/check': { auth: 'public', module: null, csrf: 'none', body: { limit: 1024 }, handler: async (req: Request, _userId: string | null, body: Input, res: ServerResponse) => {
    const limited = await overBudget(res, 'ip', getClientIP(req as Parameters<typeof getClientIP>[0]));
    if (limited) return limited;
    return { ...await checkInvite(body) } satisfies InviteCheckResponse;
  } },
  // Sets the password and signs in, as sign-up does; the page listed the
  // rules of `rules_revision`, which the account starts with confirmed.
  'POST /api/auth/invite/accept': { auth: 'public', module: null, csrf: 'none', body: { limit: 4096 }, handler: async (req: Request, _userId: string | null, body: Input, res: ServerResponse) => {
    const ip = getClientIP(req as Parameters<typeof getClientIP>[0]);
    const limited = await overBudget(res, 'ip', ip) ?? await overBudget(res, 'signup', ip);
    if (limited) return limited;
    const password = body?.password;
    if (typeof password !== 'string' || !password.length || password.length > 1024) return { error: 'Password is required', status: 400 };
    if (body?.full_name != null && (typeof body.full_name !== 'string' || body.full_name.length > 255)) return { error: 'A name has at most 255 characters.', status: 400 };
    const fullName = typeof body?.full_name === 'string' && body.full_name.trim() ? body.full_name.trim() : null;
    // Early answers before the slow hash; the transaction checks both again.
    await assertPasswordLength(await inviteeOf(body?.token), password);
    const passwordHash = await hashPassword(password);
    const device = deviceClaim(body?.device);
    const { userId, session: token } = await acceptInvite({ token: body?.token, password, passwordHash, fullName, rulesRevision: body?.rules_revision },
      (cx, id) => openSession(id, device, req, cx), req);
    const csrfToken = generateCsrfToken();
    setAuthCookie(res, token);
    setCsrfCookie(res, csrfToken);
    const [person] = await listPeople(userId);
    return { csrfToken, user: { id: person.id, email: person.email, full_name: person.full_name, role: person.role, timezone: null, two_factor_enabled: false, permissions: permissionsOf(person.role), manages_groups: person.groups.some(group => group.role === 'manager') } };
  } },
});
