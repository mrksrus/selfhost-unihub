import type { ChatIceServer } from '../contracts/chat';

import crypto from 'node:crypto';
import { readSecret } from '../config';

// The relay for calls (TURN): the addresses devices are told (TURN_URLS,
// comma separated) and credentials made per call from the secret the relay
// shares (TURN_SECRET or TURN_SECRET_FILE), the standard way for a shared
// secret: the user name is the expiry time and the call's id, the password
// the base64 HMAC-SHA1 of the user name under the secret. Made when asked,
// never stored or logged. Without addresses or a secret: no servers.

const LIFETIME_SECONDS = 12 * 60 * 60;

function relay(): { urls: string[]; secret: string } | null {
  const urls = (process.env.TURN_URLS ?? '').split(',').map(url => url.trim()).filter(Boolean);
  let secret: string | undefined;
  try { secret = readSecret('TURN_SECRET'); } catch { secret = undefined; }
  return urls.length && secret ? { urls, secret } : null;
}

/** Whether the relay is configured, for the Server page. */
function relayConfigured() { return !!relay(); }

/** The connection servers for a call, good for twelve hours from `now`. */
function iceServers(callId: string, now = Date.now()): ChatIceServer[] {
  const configured = relay();
  if (!configured) return [];
  const username = `${Math.floor(now / 1000) + LIFETIME_SECONDS}:${callId}`;
  return [{ urls: configured.urls, username, credential: crypto.createHmac('sha1', configured.secret).update(username).digest('base64') }];
}

export { iceServers, relayConfigured };
