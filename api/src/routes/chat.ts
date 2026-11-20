import type { RouteRequest } from '../types';
import type {
  ChatArchiveResponse, ChatArchiveStoredResponse, ChatConversationResponse, ChatConversationsResponse, ChatGroupJoinedResponse, ChatGroupResponse,
  ChatMarksResponse, ChatMessageDeletedResponse, ChatMessageResponse, ChatMessagesResponse,
} from '../contracts/chat';

import { getAuthTokenFromRequest } from '../auth';
import { defineRoutes } from '../http/route';
import {
  confirmJoined, createGroup, deleteMessage, fetchMessages, listArchive, listConversations, moveMarks, postMessage, startConversation, storeArchive,
} from '../services/chat';

type Request = RouteRequest & { url: string; params: Record<string, string> };

// Conversations, groups, messages, marks and the personal archive
// (services/chat.ts, contracts/chat.ts). Chat is in no personal backup, so no
// restore section gates these routes; the module gate and the app lock area
// are `chat`. Every conversation route answers 404 to anyone not in it.
const query = (req: Request) => new URL(req.url, 'http://localhost').searchParams;
const token = (req: Request) => getAuthTokenFromRequest(req);
// Ids are stored in lower case.
const id = (req: Request) => req.params.id.toLowerCase();

export = defineRoutes({
  'GET /api/chat/conversations': { auth: 'user', module: 'chat', handler: async (_req: Request, userId: string) => {
    return { conversations: await listConversations(userId) } satisfies ChatConversationsResponse;
  } },
  'POST /api/chat/conversations': { auth: 'user', module: 'chat', restoreSection: null, handler: async (_req: Request, userId: string, body: unknown) => {
    return await startConversation(userId, body) satisfies ChatConversationResponse;
  } },
  'POST /api/chat/conversations/:id/groups': { auth: 'user', module: 'chat', restoreSection: null, body: { limit: 640 * 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return await createGroup(userId, token(req), id(req), body) satisfies ChatGroupResponse;
  } },
  'POST /api/chat/groups/:id/joined': { auth: 'user', module: 'chat', restoreSection: null, body: { kind: 'none' }, handler: async (req: Request, userId: string) => {
    return await confirmJoined(userId, token(req), id(req)) satisfies ChatGroupJoinedResponse;
  } },
  'POST /api/chat/conversations/:id/messages': { auth: 'user', module: 'chat', restoreSection: null, body: { limit: 4 * 1024 * 1024 }, handler: async (req: Request, userId: string, body: unknown) => {
    return { message: await postMessage(userId, token(req), id(req), body) } satisfies ChatMessageResponse;
  } },
  'GET /api/chat/conversations/:id/messages': { auth: 'user', module: 'chat', handler: async (req: Request, userId: string) => {
    return { ...await fetchMessages(userId, token(req), id(req), query(req)) } satisfies ChatMessagesResponse;
  } },
  // Final: no bin. Refused while the administrator forbids deleting for good.
  'DELETE /api/chat/messages/:id': { auth: 'user', module: 'chat', restoreSection: null, destructive: ['bin.delete'], handler: async (req: Request, userId: string) => {
    return await deleteMessage(userId, token(req), id(req)) satisfies ChatMessageDeletedResponse;
  } },
  'PUT /api/chat/conversations/:id/marks': { auth: 'user', module: 'chat', restoreSection: null, handler: async (req: Request, userId: string, body: unknown) => {
    return { ...await moveMarks(userId, id(req), body) } satisfies ChatMarksResponse;
  } },
  'POST /api/chat/archive': { auth: 'user', module: 'chat', restoreSection: null, body: { limit: 13 * 1024 * 1024 }, handler: async (_req: Request, userId: string, body: unknown) => {
    return await storeArchive(userId, body) satisfies ChatArchiveStoredResponse;
  } },
  'GET /api/chat/archive': { auth: 'user', module: 'chat', handler: async (req: Request, userId: string) => {
    return await listArchive(userId, query(req)) satisfies ChatArchiveResponse;
  } },
});
