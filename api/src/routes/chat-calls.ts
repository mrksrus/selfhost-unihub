import type { RouteRequest } from '../types';
import type {
  ChatCallAnswerResponse, ChatCallResponse, ChatCallSignalPostedResponse, ChatCallSignalsResponse, ChatCallStartResponse, ChatCurrentCallResponse, ChatIceServersResponse,
} from '../contracts/chat';

import { getAuthTokenFromRequest } from '../auth';
import { defineRoutes } from '../http/route';
import { joinedOnly } from '../services/chat-devices';
import { answerCall, callAlive, callIceServers, currentCall, endCall, fetchSignals, postSignal, startCall } from '../services/chat-calls';

type Request = RouteRequest & { url: string; params: Record<string, string> };

// Voice calls (services/chat-calls.ts, contracts/chat.ts). Part of Chat: no
// restore section, the module gate and the app lock area are `chat`, and a
// device that has not joined Chat is refused every route.
const token = (req: Request) => getAuthTokenFromRequest(req);
const id = (req: Request) => req.params.id.toLowerCase();

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
  'GET /api/chat/calls/:id/ice': { auth: 'user', module: 'chat', handler: async (req: Request, userId: string) => {
    return await callIceServers(userId, token(req), id(req)) satisfies ChatIceServersResponse;
  } },
}));
