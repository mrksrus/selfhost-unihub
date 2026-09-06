const { getAuthTokenFromRequest } = require('../auth');
const notifications = require('../services/notifications');

const authenticated = handler => async (req, userId, body) => {
  if (!userId) return { error: 'Unauthorized', status: 401 };
  try { return await handler(req, userId, body || {}); }
  catch (error) {
    if (error.status === 401) return { error: error.message, status: 401 };
    if (/Invalid|Unsupported|Maximum|belongs to another|Enable notifications/.test(error.message)) return { error: error.message, status: 400 };
    console.error('[NOTIFICATIONS] Request failed:', error.code || error.name);
    return { error: 'Could not update notifications. Please try again.', status: 500 };
  }
};
module.exports = {
  'GET /api/notifications/config': authenticated(async () => ({ publicKey: (await notifications.getVapidKeys()).publicKey })),
  'GET /api/notifications/status': authenticated(async (req, userId) => ({ subscribed: await notifications.subscriptionStatus(userId, new URL(req.url, 'http://localhost').searchParams.get('endpoint')) })),
  'POST /api/notifications/subscription': authenticated((req, userId, body) => notifications.subscribe(userId, getAuthTokenFromRequest(req), body.subscription)),
  'POST /api/notifications/unsubscribe': authenticated((req, userId, body) => notifications.unsubscribe(userId, body.endpoint)),
  'DELETE /api/notifications/subscription': authenticated((req, userId, body) => notifications.unsubscribe(userId, body.endpoint)),
  'POST /api/notifications/test': authenticated(async (req, userId, body) => {
    const result = await notifications.enqueueTestNotification(userId, body.endpoint);
    // Durable queue acknowledgement; normal job loop also handles restarts and retries.
    void notifications.processNotificationJobs().catch(error => console.error('[NOTIFICATIONS] Test delivery deferred:', error.code || error.name));
    return result;
  }),
};
