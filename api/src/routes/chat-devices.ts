import type { ServerResponse } from 'node:http';
import type { RouteRequest } from '../types';
import type { ChatAccountResponse, ChatDeviceResponse, ChatDevicesResponse, ChatKeyPackageClaimResponse } from '../contracts/chat';

import { getAuthTokenFromRequest } from '../auth';
import { defineRoutes } from '../http/route';
import { confirmPassword, OWN_CODES } from '../security/reauthentication';
import {
  addKeyPackages, claimKeyPackages, conversationDevices, createAccount, describeChatDevice, enrolDevice, getAccount, parseAccount, replaceKeyBackup, startNewKey,
} from '../services/chat-devices';

type Request = RouteRequest & { url: string; params: Record<string, string> };

// The person's chat account, their chat devices and key packages, and the
// devices of a conversation's people (services/chat-devices.ts, contracts/chat.ts).
// Chat is in no personal backup, so no restore section gates these routes;
// the module gate and the app lock area are `chat`.
const KEY_PACKAGES_BODY = { limit: 160 * 1024 };
// The account password, asked before the key backup changes; the body is checked first.
const confirmed = (userId: string, body: unknown, res: ServerResponse) =>
  confirmPassword(userId, (body as { current_password?: unknown } | null)?.current_password, res, OWN_CODES);

export = defineRoutes({
  'GET /api/chat/account': { auth: 'user', module: 'chat', handler: async (_req: Request, userId: string) => {
    return { account: await getAccount(userId) } satisfies ChatAccountResponse;
  } },
  'POST /api/chat/account': { auth: 'user', module: 'chat', restoreSection: null, body: { limit: 4096 }, handler: async (_req: Request, userId: string, body: unknown) => {
    return { account: await createAccount(userId, parseAccount(body)) } satisfies ChatAccountResponse;
  } },
  'PUT /api/chat/account/key-backup': { auth: 'user', module: 'chat', restoreSection: null, body: { limit: 4096 }, handler: async (_req: Request, userId: string, body: unknown, res: ServerResponse) => {
    const input = parseAccount(body);
    const refused = await confirmed(userId, body, res);
    if (refused) return refused;
    return { account: await replaceKeyBackup(userId, input) } satisfies ChatAccountResponse;
  } },
  // Drops the person's archive copies, which only the forgotten key could open.
  'POST /api/chat/account/new-key': { auth: 'user', module: 'chat', restoreSection: null, body: { limit: 4096 }, handler: async (_req: Request, userId: string, body: unknown, res: ServerResponse) => {
    const input = parseAccount(body);
    const refused = await confirmed(userId, body, res);
    if (refused) return refused;
    return { account: await startNewKey(userId, input) } satisfies ChatAccountResponse;
  } },
  'POST /api/chat/devices': { auth: 'user', module: 'chat', restoreSection: null, body: KEY_PACKAGES_BODY, handler: async (req: Request, userId: string, body: unknown) => {
    return { ...await enrolDevice(userId, getAuthTokenFromRequest(req), body) } satisfies ChatDeviceResponse;
  } },
  'GET /api/chat/devices/current': { auth: 'user', module: 'chat', handler: async (req: Request, userId: string) => {
    return { ...await describeChatDevice(userId, getAuthTokenFromRequest(req)) } satisfies ChatDeviceResponse;
  } },
  'POST /api/chat/devices/current/key-packages': { auth: 'user', module: 'chat', restoreSection: null, body: KEY_PACKAGES_BODY, handler: async (req: Request, userId: string, body: unknown) => {
    return { ...await addKeyPackages(userId, getAuthTokenFromRequest(req), body) } satisfies ChatDeviceResponse;
  } },
  'GET /api/chat/conversations/:id/devices': { auth: 'user', module: 'chat', handler: async (req: Request, userId: string) => {
    return { devices: await conversationDevices(userId, req.params.id) } satisfies ChatDevicesResponse;
  } },
  'POST /api/chat/conversations/:id/key-packages': { auth: 'user', module: 'chat', restoreSection: null, body: { kind: 'none' }, handler: async (req: Request, userId: string) => {
    return { key_packages: await claimKeyPackages(userId, getAuthTokenFromRequest(req), req.params.id) } satisfies ChatKeyPackageClaimResponse;
  } },
});
