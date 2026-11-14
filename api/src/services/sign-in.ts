import type { RouteRequest, SqlExecutor } from '../types';
import type { DeviceClaim } from './devices';

import { db } from '../state';
import { generateToken, getClientIP, getSessionExpiry } from '../auth';
import { bindDevice } from './devices';
import { createSession } from './sessions';
import { withTransaction } from './transactions';

// The address (through the trusted-proxy rules) and the browser of a new sign-in.
function sessionOrigin(req: RouteRequest) {
  let ipAddress: string | null = null;
  try { ipAddress = getClientIP(req as Parameters<typeof getClientIP>[0]) || null; } catch { /* unknown */ }
  const agent = req.headers?.['user-agent'];
  return { ipAddress, userAgent: typeof agent === 'string' ? agent : null };
}

// A new session on the device the sign-in names (F5): the device and the
// session commit together, in the caller's transaction or in one of their own.
// Sign-in, sign-up and a used setup link (routes/auth.ts, routes/invites.ts).
async function openSession(userId: string, device: DeviceClaim, req: RouteRequest, connection: SqlExecutor = db) {
  const token = generateToken(userId);
  const expiresAt = getSessionExpiry();
  const origin = sessionOrigin(req);
  const open = async (cx: SqlExecutor) => {
    const deviceId = await bindDevice(userId, device, origin.userAgent, cx);
    await createSession({ userId, token, expiresAt, deviceId, ...origin }, cx);
  };
  if (connection === db) await withTransaction(open); else await open(connection);
  return token;
}

export { openSession, sessionOrigin };
