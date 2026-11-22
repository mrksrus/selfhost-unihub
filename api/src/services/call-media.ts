import type { WebSocketConnection } from '../http/websocket';

import { hashToken } from './server-events';
import { log } from '../log';

// A call's sound through UniHub (contracts/chat.ts, GET /api/chat/calls/:id/media):
// the media sockets of each call, keyed by chat device, in this process only
// (like the event stream's bus). A message from one end goes to every other
// end unchanged; nothing of it is read or logged.

interface End {
  callId: string;
  device: string;
  userId: string;
  tokenHash: string | null;
  ws: WebSocketConnection;
  /** Whether the session and the call still admit this end; false closes it, a throw keeps it. */
  check: () => Promise<boolean>;
  checking: boolean;
  tokens: number;
  refilledAt: number;
  slowSince: number | null;
}

// Mutable for the tests.
const config = {
  tickMs: 25 * 1000,
  idleMs: 60 * 1000,
  slowBytes: 8 * 1024,
  slowMs: 15 * 1000,
  rate: 60,
  burst: 120,
  maxSockets: 200,
};

const calls = new Map<string, Map<string, End>>();
let timer: NodeJS.Timeout | null = null;
let closing = false;
let refusedAt = 0;
const ends = () => [...calls.values()].flatMap(room => [...room.values()]);

/** Whether an end of this call may open a socket now; a reconnect of an attached device always may. */
function admits(callId: string, device: string) {
  if (closing) return false;
  if (calls.get(callId)?.has(device) || ends().length < config.maxSockets) return true;
  if (Date.now() - refusedAt > 60 * 1000) { refusedAt = Date.now(); log.warn('CALLS', 'Media sockets at capacity'); }
  return false;
}

function forward(from: End, data: Buffer) {
  const now = Date.now();
  from.tokens = Math.min(config.burst, from.tokens + (now - from.refilledAt) * config.rate / 1000);
  from.refilledAt = now;
  if (from.tokens < 1) return;
  from.tokens--;
  for (const to of calls.get(from.callId)?.values() ?? []) {
    if (to === from) continue;
    // Old sound is worth nothing: a receiver that does not keep up loses frames, never memory.
    if (to.ws.buffered > config.slowBytes) to.slowSince ??= now;
    else { to.slowSince = null; to.ws.send(data); }
  }
}

async function revalidate(end: End) {
  if (end.checking || end.ws.closed) return;
  end.checking = true;
  try {
    if (!await end.check()) end.ws.close(1008);
  } catch {
    // A transient database error keeps the socket; the next tick checks again.
  } finally {
    end.checking = false;
  }
}

/** Pings every end, closes the idle and the slow, and checks every session and call again. */
async function tick() {
  const now = Date.now();
  await Promise.all(ends().map(end => {
    if (now - end.ws.heardAt > config.idleMs || (end.slowSince !== null && now - end.slowSince >= config.slowMs)) return end.ws.close(4001);
    if (end.ws.buffered <= config.slowBytes) end.slowSince = null;
    end.ws.ping();
    return revalidate(end);
  }));
}

function attach({ callId, device, userId, token, ws, check }: { callId: string; device: string; userId: string; token: string | null; ws: WebSocketConnection; check: End['check'] }) {
  const room = calls.get(callId) ?? new Map<string, End>();
  calls.set(callId, room);
  const end: End = { callId, device, userId, tokenHash: hashToken(token), ws, check, checking: false, tokens: config.burst, refilledAt: Date.now(), slowSince: null };
  const previous = room.get(device);
  room.set(device, end);
  previous?.ws.close(4000);
  ws.onMessage = data => forward(end, data);
  ws.onClose = () => {
    if (room.get(device) !== end) return;
    room.delete(device);
    if (!room.size && calls.get(callId) === room) calls.delete(callId);
    if (!calls.size && timer) { clearInterval(timer); timer = null; }
  };
  timer ??= setInterval(() => { void tick(); }, config.tickMs);
  timer.unref();
  // The call may have ended while the socket was admitted.
  void revalidate(end);
}

function closeWhere(match: (end: End) => boolean, code: number) {
  let closed = 0;
  for (const end of ends()) if (match(end)) { end.ws.close(code); closed++; }
  return closed;
}

const callMedia = {
  config,
  admits,
  attach,
  tick,
  /** The call ended. */
  closeCall: (callId: string) => closeWhere(end => end.callId === callId, 1000),
  closeUser: (userId: unknown, exceptToken: string | null = null) => {
    const except = hashToken(exceptToken);
    return closeWhere(end => end.userId === String(userId) && !(except && end.tokenHash === except), 1008);
  },
  closeTokenHash: (hash: string | null) => hash ? closeWhere(end => end.tokenHash === hash, 1008) : 0,
  closeAll: () => { closing = true; return closeWhere(() => true, 1001); },
  stats: () => ({ calls: calls.size, sockets: ends().length, buffered: Math.max(0, ...ends().map(end => end.ws.buffered)) }),
};

export { callMedia };
