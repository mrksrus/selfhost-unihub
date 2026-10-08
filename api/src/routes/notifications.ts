import type { IncomingMessage } from 'node:http';
import type { ApiError } from '../types';
interface NotificationBody { subscription?: unknown; endpoint?: string }
type NotificationHandler = (req: IncomingMessage, userId: string, body: NotificationBody) => unknown | Promise<unknown>;

import imported1 = require('../auth');
const { getAuthTokenFromRequest } = imported1;
import notifications = require('../services/notifications');

const authenticated = (handler: NotificationHandler) => async (req: IncomingMessage, userId: string | null, body?: NotificationBody | null) => {
  if (!userId) return { error: 'Unauthorized', status: 401 };
  try { return await handler(req, userId, body || {}); }
  catch (error) {
    if ((error as ApiError).status === 401) return { error: (error as ApiError).message, status: 401 };
    if (/Invalid|Unsupported|Maximum|belongs to another|Enable notifications/.test((error as ApiError).message)) return { error: (error as ApiError).message, status: 400 };
    console.error('[NOTIFICATIONS] Request failed:', (error as ApiError).code || (error as ApiError).name);
    return { error: 'Could not update notifications. Please try again.', status: 500 };
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
};
