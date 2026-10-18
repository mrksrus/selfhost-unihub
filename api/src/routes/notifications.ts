import type { ServerResponse } from 'node:http';
import type { ApiError, RouteRequest, RouteResponse } from '../types';
import type { RoutePolicy, UserRouteSpec } from '../http/route';

import { getAuthTokenFromRequest } from '../auth';
import { clientError } from '../http/errors';
import { defineRoutes } from '../http/route';
import * as notifications from '../services/notifications';
import * as androidPush from '../services/android-push';

interface NotificationBody { subscription?: unknown; endpoint?: string; keys?: unknown; replaces?: unknown; device?: unknown; ids?: unknown }
type NotificationHandler = (req: RouteRequest, userId: string, body: NotificationBody, res: ServerResponse) => unknown | Promise<unknown>;

// Subscriptions are device state, not recoverable data: no module, no restore section.
const route = (handler: NotificationHandler, policy: RoutePolicy = {}): UserRouteSpec => ({
  auth: 'user', module: null, ...policy,
  handler: async (req, userId, body, res) => {
    try { return (await handler(req, userId, (body || {}) as NotificationBody, res)) as RouteResponse | undefined; }
    catch (error) {
      const response = clientError(error, 'Could not update notifications. Please try again.');
      if (response.status === 500) console.error('[NOTIFICATIONS] Request failed:', (error as ApiError).code || (error as ApiError).name);
      return response;
    }
  },
});
const write: RoutePolicy = { restoreSection: null };
export = defineRoutes({
  'GET /api/notifications/config': route(async () => ({ publicKey: (await notifications.getVapidKeys()).publicKey })),
  'GET /api/notifications/status': route((req, userId) => notifications.deviceStatus(userId, new URL(req.url!, 'http://localhost').searchParams.get('endpoint'))),
  'POST /api/notifications/subscription': route((req, userId, body) => notifications.subscribe(userId, getAuthTokenFromRequest(req), body.subscription), write),
  'POST /api/notifications/unsubscribe': route((req, userId, body) => notifications.unsubscribe(userId, body.endpoint), write),
  'DELETE /api/notifications/subscription': route((req, userId, body) => notifications.unsubscribe(userId, body.endpoint), write),
  'POST /api/notifications/test': route(async (req, userId, body) => {
    const result = await notifications.enqueueTestNotification(userId, body.endpoint);
    // Durable queue acknowledgement; normal job loop also handles restarts and retries.
    void notifications.processNotificationJobs().catch((error: ApiError) => console.error('[NOTIFICATIONS] Test delivery deferred:', (error as ApiError).code || (error as ApiError).name));
    return result;
  }, write),
  // The Android app (android-push.ts). Status, test and unsubscribe above take
  // the endpoint the registration returns.
  'POST /api/notifications/android/devices': route((req, userId, body) => androidPush.registerDevice(userId, getAuthTokenFromRequest(req), body), write),
  'POST /api/notifications/android/ack': route((req, userId, body) => androidPush.acknowledge(userId, getAuthTokenFromRequest(req), body), write),
  // The app's live connection: the handler writes and owns the response.
  'GET /api/notifications/android/stream': route((req, userId, body, res) =>
    androidPush.attachStream(req, res, userId, getAuthTokenFromRequest(req), new URL(req.url!, 'http://localhost').searchParams.get('device')),
  { response: 'stream', body: { kind: 'none' } }),
});
