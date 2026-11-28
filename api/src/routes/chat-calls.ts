import type { ServerResponse } from 'node:http';
import type { RouteResponse } from '../types';
import type { UpgradeRequest, WebSocketConnection } from '../http/websocket';
import type {
  ChatCallAnswerResponse, ChatCallResponse, ChatCallSignalPostedResponse, ChatCallSignalsResponse, ChatCallStartResponse, ChatCurrentCallResponse, ChatIceServersResponse,
} from '../contracts/chat';

import { getAuthTokenFromRequest, verifyToken } from '../auth';
import { defineRoutes } from '../http/route';
import { acceptWebSocket } from '../http/websocket';
import { callMedia } from '../services/call-media';
import { joinedOnly } from '../services/chat-devices';
import { answerCall, callAlive, callIceServers, currentCall, endCall, fetchSignals, mediaEnd, postSignal, startCall } from '../services/chat-calls';

type Request = UpgradeRequest & { url: string; params: Record<string, string> };

// Voice calls (services/chat-calls.ts, contracts/chat.ts). Part of Chat: no
// restore section, the module gate and the app lock area are `chat`, and a
// device that has not joined Chat is refused every route.
const token = (req: Request) => getAuthTokenFromRequest(req);
const id = (req: Request) => req.params.id.toLowerCase();

// The handshake after every check passed. A request that reached this far
// without its Upgrade came through a proxy that does not pass WebSockets.
function upgrade(req: Request, res: ServerResponse, use: (ws: WebSocketConnection) => void): RouteResponse | undefined {
  if (!req.upgrade) return { status: 426, error: 'This address takes a WebSocket. The reverse proxy in front of UniHub may not pass WebSockets.', code: 'CHAT_CALL_MEDIA_UPGRADE' };
  const ws = acceptWebSocket(req, res);
  if (!ws) return { status: 400, error: 'Invalid WebSocket handshake', code: 'CHAT_CALL_MEDIA_INVALID' };
  use(ws);
  return undefined;
}

export = defineRoutes(joinedOnly({
  'POST /api/chat/calls': { auth: 'user', module: 'chat', restoreSection: null, body: { limit: 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return await startCall(userId, token(req), body) satisfies ChatCallStartResponse;
  } },
  'GET /api/chat/calls/current': { auth: 'user', module: 'chat', handler: async (req: Request, userId: string) => {
    return await currentCall(userId, token(req)) satisfies ChatCurrentCallResponse;
  } },
  'POST /api/chat/calls/:id/answer': { auth: 'user', module: 'chat', restoreSection: null, body: { kind: 'none' }, handler: async (req: Request, userId: string) => {
    return await answerCall(userId, token(req), id(req)) satisfies ChatCallAnswerResponse;
  } },
  'POST /api/chat/calls/:id/end': { auth: 'user', module: 'chat', restoreSection: null, body: { limit: 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return await endCall(userId, token(req), id(req), body) satisfies ChatCallResponse;
  } },
  'POST /api/chat/calls/:id/signals': { auth: 'user', module: 'chat', restoreSection: null, body: { limit: 64 * 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return await postSignal(userId, token(req), id(req), body) satisfies ChatCallSignalPostedResponse;
  } },
  'GET /api/chat/calls/:id/signals': { auth: 'user', module: 'chat', handler: async (req: Request, userId: string) => {
    return await fetchSignals(userId, token(req), id(req), new URL(req.url, 'http://localhost').searchParams.get('after')) satisfies ChatCallSignalsResponse;
  } },
  'POST /api/chat/calls/:id/alive': { auth: 'user', module: 'chat', restoreSection: null, body: { kind: 'none' }, handler: async (req: Request, userId: string) => {
    return await callAlive(userId, token(req), id(req)) satisfies ChatCallResponse;
  } },
  'GET /api/chat/calls/:id/media': { auth: 'user', module: 'chat', response: 'upgrade', body: { kind: 'none' }, handler: async (req: Request, userId: string, _body: unknown, res: ServerResponse) => {
    const callId = id(req);
    const { device, sender } = await mediaEnd(userId, token(req), callId);
    if (!callMedia.admits(callId, device)) return { status: 503, error: 'UniHub is carrying too many calls right now.', code: 'CHAT_CALL_MEDIA_BUSY' };
    return upgrade(req, res, ws => callMedia.attach({ callId, device, userId, sender, token: token(req), ws,
      // As the event stream: the session's own lookup, then the call's (a group call's membership and number now).
      check: async () => String(await verifyToken(req)) === userId
        && await mediaEnd(userId, token(req), callId).then(now => now.device === device && now.sender === sender, error => { if (error?.status) return false; throw error; }) }));
  } },
  'GET /api/chat/calls/check': { auth: 'user', module: 'chat', response: 'upgrade', body: { kind: 'none' }, handler: async (req: Request, _userId: string, _body: unknown, res: ServerResponse) => {
    return upgrade(req, res, ws => ws.close(1000));
  } },
  'GET /api/chat/calls/:id/ice': { auth: 'user', module: 'chat', handler: async (req: Request, userId: string) => {
    return await callIceServers(userId, token(req), id(req)) satisfies ChatIceServersResponse;
  } },
// The Server page's check of WebSockets carries nothing of Chat.
}, ['GET /api/chat/calls/check']));
