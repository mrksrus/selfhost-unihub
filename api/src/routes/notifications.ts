import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiError } from '../types';

import { getAuthTokenFromRequest } from '../auth';
import { clientError } from '../http/errors';
import * as notifications from '../services/notifications';
import * as androidPush from '../services/android-push';

interface NotificationBody { subscription?: unknown; endpoint?: string; keys?: unknown; replaces?: unknown; device?: unknown; ids?: unknown }
type NotificationHandler = (req: IncomingMessage, userId: string, body: NotificationBody, res: ServerResponse) => unknown | Promise<unknown>;

const authenticated = (handler: NotificationHandler) => async (req: IncomingMessage, userId: string | null, body: NotificationBody | null | undefined, res: ServerResponse) => {
  if (!userId) return { error: 'Unauthorized', status: 401 };
  try { return await handler(req, userId, body || {}, res); }
  catch (error) {
    const response = clientError(error, 'Could not update notifications. Please try again.');
    if (response.status === 500) console.error('[NOTIFICATIONS] Request failed:', (error as ApiError).code || (error as ApiError).name);
    return response;
  }
};
export = {
  'GET /api/notifications/config': authenticated(async () => ({ publicKey: (await notifications.getVapidKeys()).publicKey })),
  'GET /api/notifications/status': authenticated((req, userId) => notifications.deviceStatus(userId, new URL(req.url!, 'http://localhost').searchParams.get('endpoint'))),
  'POST /api/notifications/subscription': authenticated((req, userId, body) => notifications.subscribe(userId, getAuthTokenFromRequest(req), body.subscription)),
  'POST /api/notifications/unsubscribe': authenticated((req, userId, body) => notifications.unsubscribe(userId, body.endpoint)),
  'DELETE /api/notifications/subscription': authenticated((req, userId, body) => notifications.unsubscribe(userId, body.endpoint)),
  'POST /api/notifications/test': authenticated(async (req, userId, body) => {
    const result = await notifications.enqueueTestNotification(userId, body.endpoint);
    // Durable queue acknowledgement; normal job loop also handles restarts and retries.
    void notifications.processNotificationJobs().catch((error: ApiError) => console.error('[NOTIFICATIONS] Test delivery deferred:', (error as ApiError).code || (error as ApiError).name));
    return result;
  }),
  // The Android app (android-push.ts). Status, test and unsubscribe above take
  // the endpoint the registration returns.
  'POST /api/notifications/android/devices': authenticated((req, userId, body) => androidPush.registerDevice(userId, getAuthTokenFromRequest(req), body)),
  'POST /api/notifications/android/ack': authenticated((req, userId, body) => androidPush.acknowledge(userId, getAuthTokenFromRequest(req), body)),
  // Takes over the response like GET /api/events (request-handler.ts leaves a __handled result alone).
  'GET /api/notifications/android/stream': authenticated((req, userId, body, res) =>
    androidPush.attachStream(req, res, userId, getAuthTokenFromRequest(req), new URL(req.url!, 'http://localhost').searchParams.get('device'))),
};
