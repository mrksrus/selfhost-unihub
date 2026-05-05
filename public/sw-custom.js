// Custom service worker code for UniHub PWA.
// This file is loaded by the VitePWA-generated service worker.

const NOTIFICATION_STATE_CACHE = 'unihub-notification-state-v1';
const NOTIFICATION_STATE_URL = '/__unihub_notification_state__.json';
const BACKGROUND_NOTIFICATION_SYNC_TAG = 'unihub-notification-check';
const MAIL_PERIODIC_SYNC_TAG = 'check-emails-periodic';
const CALENDAR_PERIODIC_SYNC_TAG = 'check-calendar-periodic';
const NOTIFICATION_SYNC_TAGS = new Set([
  BACKGROUND_NOTIFICATION_SYNC_TAG,
  MAIL_PERIODIC_SYNC_TAG,
  CALENDAR_PERIODIC_SYNC_TAG,
  'check-emails',
  'check-calendar',
]);

const MAIL_NOTIFICATION_FETCH_LIMIT = 50;
const MAIL_BACKGROUND_SYNC_MIN_AGE_MS = 10 * 60 * 1000;
const MAX_TRACKED_EMAIL_IDS = 200;
const MAX_TRACKED_CALENDAR_EVENT_IDS = 500;
const MAX_STORED_REMINDERS = 1000;
const MAIL_NEW_GRACE_MS = 5 * 60 * 1000;
const CALENDAR_NEW_GRACE_MS = 5 * 60 * 1000;
const CALENDAR_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const CALENDAR_REMINDER_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const REMINDER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NOTIFICATIONS_PER_CHECK = 10;
const EXCLUDED_NOTIFICATION_FOLDERS = new Set(['sent', 'trash', 'archive']);

let notificationCheckPromise = null;

self.addEventListener('sync', (event) => {
  if (!NOTIFICATION_SYNC_TAGS.has(event.tag)) return;
  console.log('[SW] Background sync triggered:', event.tag);
  event.waitUntil(handleBackgroundNotificationEvent(event.tag));
});

self.addEventListener('periodicsync', (event) => {
  if (!NOTIFICATION_SYNC_TAGS.has(event.tag)) return;
  console.log('[SW] Periodic sync triggered:', event.tag);
  event.waitUntil(handleBackgroundNotificationEvent(event.tag));
});

self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data);

  if (event.data?.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    event.waitUntil(showNotification(title, options));
  } else if (event.data?.type === 'REGISTER_SYNC') {
    event.waitUntil(registerOneShotSync(event.data.tag));
  } else if (event.data?.type === 'RUN_NOTIFICATION_CHECKS') {
    event.waitUntil(runNotificationChecks(event.data.reason || 'message', {
      suppressNotifications: event.data.suppressNotifications !== false,
    }));
  } else if (event.data?.type === 'RESET_NOTIFICATION_STATE') {
    event.waitUntil(resetNotificationState());
  }
});

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.notification.tag);
  event.notification.close();

  const tag = event.notification.tag || '';
  const fallbackUrl = tag.includes('calendar')
    ? '/calendar'
    : '/mail';
  const requestedUrl = event.notification.data?.url || fallbackUrl;
  const targetUrl = new URL(requestedUrl, self.location.origin).toString();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          if ('navigate' in client && client.url !== targetUrl) {
            await client.navigate(targetUrl);
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

async function handleBackgroundNotificationEvent(reason) {
  const clients = await getWindowClients();
  const hasVisibleWindow = hasVisibleClient(clients);
  if (hasVisibleWindow) {
    clients.forEach((client) => {
      client.postMessage({ type: 'CHECK_EMAILS' });
      client.postMessage({ type: 'CHECK_CALENDAR' });
    });
  }

  return runNotificationChecks(reason, {
    suppressNotifications: hasVisibleWindow,
  });
}

async function registerOneShotSync(tag) {
  if (!tag || !('sync' in self.registration)) return false;
  try {
    await self.registration.sync.register(tag);
    return true;
  } catch (error) {
    console.error('[SW] Failed to register sync:', error);
    return false;
  }
}

async function runNotificationChecks(reason, options = {}) {
  if (notificationCheckPromise) {
    return notificationCheckPromise;
  }

  notificationCheckPromise = runNotificationChecksOnce(reason, options)
    .catch((error) => {
      console.error('[SW] Notification check failed:', error);
    })
    .finally(() => {
      notificationCheckPromise = null;
    });

  return notificationCheckPromise;
}

async function runNotificationChecksOnce(reason, options) {
  const authContext = await getCurrentAuthContext();
  if (!authContext?.userId) {
    await resetNotificationState();
    return;
  }

  const suppressNotifications = !!options.suppressNotifications;
  const state = await loadNotificationState(authContext.userId);
  const now = Date.now();
  state.lastRunAt = now;
  state.lastRunReason = reason;

  const results = await Promise.allSettled([
    checkMailNotifications(state, now, suppressNotifications),
    checkCalendarNotifications(state, now, suppressNotifications),
  ]);

  results.forEach((result) => {
    if (result.status === 'rejected') {
      console.error('[SW] Notification check task failed:', result.reason);
    }
  });

  await saveNotificationState(state);
}

async function getCurrentAuthContext() {
  try {
    const data = await fetchJson('/api/auth/me?background=1', {
      'X-Background-Sync': '1',
    });
    return {
      userId: data?.user?.id || null,
    };
  } catch (error) {
    console.log('[SW] Auth check failed for background notifications:', error.message || error);
    return null;
  }
}

async function checkMailNotifications(state, now, suppressNotifications) {
  await triggerBackgroundMailSync();

  const data = await fetchJson(`/api/mail/emails?limit=${MAIL_NOTIFICATION_FETCH_LIMIT}&offset=0&include_count=false`);
  const emails = Array.isArray(data?.emails) ? data.emails : [];
  const relevantEmails = emails.filter((email) => !EXCLUDED_NOTIFICATION_FOLDERS.has(email.folder));

  if (!state.lastMailCheckedAt) {
    state.knownEmailIds = relevantEmails.map((email) => email.id).slice(0, MAX_TRACKED_EMAIL_IDS);
    state.lastMailCheckedAt = now;
    return;
  }

  const knownIds = new Set(Array.isArray(state.knownEmailIds) ? state.knownEmailIds : []);
  const freshnessThreshold = Math.max(0, state.lastMailCheckedAt - MAIL_NEW_GRACE_MS);
  const newEmails = relevantEmails.filter((email) => {
    if (!email?.id || knownIds.has(email.id)) return false;
    const receivedAtMs = Date.parse(email.received_at);
    return Number.isFinite(receivedAtMs) && receivedAtMs >= freshnessThreshold;
  });

  state.knownEmailIds = unique([
    ...relevantEmails.map((email) => email.id).filter(Boolean),
    ...(state.knownEmailIds || []),
  ]).slice(0, MAX_TRACKED_EMAIL_IDS);
  state.lastMailCheckedAt = now;

  if (suppressNotifications || newEmails.length === 0) return;
  if (await hasVisibleClientForPath('/mail')) return;

  const firstEmail = newEmails[0];
  const title = newEmails.length === 1 ? 'New Email' : 'New Emails';
  const body = newEmails.length === 1
    ? `${getSenderLabel(firstEmail)}: ${firstEmail.subject || '(No subject)'}`
    : `${newEmails.length} new emails received`;

  await showNotification(title, {
    body,
    tag: 'mail-new-email',
    renotify: true,
    requireInteraction: false,
    data: {
      url: '/mail',
      emailIds: newEmails.map((email) => email.id),
    },
  });
}

async function triggerBackgroundMailSync() {
  try {
    const response = await fetch('/api/mail/sync/background', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Background-Sync': '1',
      },
      body: JSON.stringify({
        min_age_ms: MAIL_BACKGROUND_SYNC_MIN_AGE_MS,
      }),
    });

    if (!response.ok) {
      console.log('[SW] Background mail sync trigger failed:', response.status);
    }
  } catch (error) {
    console.log('[SW] Background mail sync trigger failed:', error.message || error);
  }
}

async function checkCalendarNotifications(state, now, suppressNotifications) {
  state.deliveredReminderKeys = pruneReminderStore(state.deliveredReminderKeys || {}, now);

  const query = new URLSearchParams({
    include_todos: 'true',
    include_done: 'false',
    visible_only: 'true',
    range_start: new Date(now - CALENDAR_REMINDER_LOOKBACK_MS).toISOString(),
    range_end: new Date(now + CALENDAR_LOOKAHEAD_MS).toISOString(),
  });
  const data = await fetchJson(`/api/calendar/events?${query.toString()}`);
  const events = Array.isArray(data?.events) ? data.events : [];

  await checkCalendarReminders(state, events, now, suppressNotifications);
  await checkNewCalendarEvents(state, events, now, suppressNotifications);
}

async function checkCalendarReminders(state, events, now, suppressNotifications) {
  const deliveredReminderKeys = state.deliveredReminderKeys || {};
  let shownCount = 0;

  for (const event of events) {
    if (!event || event.todo_status === 'done' || event.todo_status === 'cancelled') continue;

    const eventStartMs = Date.parse(event.start_time);
    if (!Number.isFinite(eventStartMs)) continue;

    const reminderMinutesList = getReminderMinutes(event);
    for (const reminderMinutes of reminderMinutesList) {
      if (shownCount >= MAX_NOTIFICATIONS_PER_CHECK) return;

      const reminderKey = getReminderKey(event, reminderMinutes);
      if (deliveredReminderKeys[reminderKey]) continue;

      const reminderTimeMs = eventStartMs - reminderMinutes * 60 * 1000;
      const isDue = reminderTimeMs <= now && now - reminderTimeMs <= CALENDAR_REMINDER_LOOKBACK_MS;
      if (!isDue) continue;

      if (suppressNotifications) {
        deliveredReminderKeys[reminderKey] = now;
        continue;
      }

      const shown = await showNotification(event.title || 'Calendar Reminder', {
        body: getReminderLeadText(reminderMinutes),
        tag: `calendar-${event.id}`,
        renotify: true,
        requireInteraction: false,
        data: {
          url: getCalendarNotificationPath(event),
          eventId: event.id,
          reminderMinutes,
        },
      });

      if (shown) {
        deliveredReminderKeys[reminderKey] = now;
        shownCount += 1;
      }
    }
  }
}

async function checkNewCalendarEvents(state, events, now, suppressNotifications) {
  const relevantEvents = events.filter((event) => (
    event?.id &&
    !event.is_todo_only &&
    event.todo_status !== 'done' &&
    event.todo_status !== 'cancelled'
  ));

  if (!state.lastCalendarCheckedAt) {
    state.knownCalendarEventIds = relevantEvents.map((event) => event.id).slice(0, MAX_TRACKED_CALENDAR_EVENT_IDS);
    state.lastCalendarCheckedAt = now;
    return;
  }

  const knownIds = new Set(Array.isArray(state.knownCalendarEventIds) ? state.knownCalendarEventIds : []);
  const freshnessThreshold = Math.max(0, state.lastCalendarCheckedAt - CALENDAR_NEW_GRACE_MS);
  const newEvents = relevantEvents.filter((event) => {
    if (knownIds.has(event.id)) return false;
    const createdAtMs = Date.parse(event.created_at);
    return Number.isFinite(createdAtMs) && createdAtMs >= freshnessThreshold;
  });

  state.knownCalendarEventIds = unique([
    ...relevantEvents.map((event) => event.id),
    ...(state.knownCalendarEventIds || []),
  ]).slice(0, MAX_TRACKED_CALENDAR_EVENT_IDS);
  state.lastCalendarCheckedAt = now;

  if (suppressNotifications || newEvents.length === 0) return;
  if (await hasVisibleClientForPath('/calendar')) return;

  const firstEvent = newEvents[0];
  const title = newEvents.length === 1 ? 'New Calendar Event' : 'New Calendar Events';
  const body = newEvents.length === 1
    ? [firstEvent.title, getCalendarEventStartText(firstEvent)].filter(Boolean).join(' - ')
    : `${newEvents.length} new calendar events added`;

  await showNotification(title, {
    body,
    tag: 'calendar-new-events',
    renotify: true,
    requireInteraction: false,
    data: {
      url: '/calendar',
      eventIds: newEvents.map((event) => event.id),
    },
  });
}

async function fetchJson(endpoint, headers = {}) {
  const response = await fetch(endpoint, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Server returned non-JSON response');
  }

  return response.json();
}

function createDefaultState(userId) {
  return {
    version: 1,
    userId,
    knownEmailIds: [],
    knownCalendarEventIds: [],
    deliveredReminderKeys: {},
    lastMailCheckedAt: 0,
    lastCalendarCheckedAt: 0,
    lastRunAt: 0,
    lastRunReason: null,
  };
}

async function loadNotificationState(userId) {
  try {
    const cache = await caches.open(NOTIFICATION_STATE_CACHE);
    const response = await cache.match(NOTIFICATION_STATE_URL);
    if (!response) return createDefaultState(userId);

    const state = await response.json();
    if (!state || state.userId !== userId) {
      return createDefaultState(userId);
    }

    return {
      ...createDefaultState(userId),
      ...state,
      knownEmailIds: Array.isArray(state.knownEmailIds) ? state.knownEmailIds.slice(0, MAX_TRACKED_EMAIL_IDS) : [],
      knownCalendarEventIds: Array.isArray(state.knownCalendarEventIds)
        ? state.knownCalendarEventIds.slice(0, MAX_TRACKED_CALENDAR_EVENT_IDS)
        : [],
      deliveredReminderKeys: state.deliveredReminderKeys && typeof state.deliveredReminderKeys === 'object'
        ? state.deliveredReminderKeys
        : {},
    };
  } catch (error) {
    console.error('[SW] Failed to load notification state:', error);
    return createDefaultState(userId);
  }
}

async function saveNotificationState(state) {
  try {
    state.knownEmailIds = unique(state.knownEmailIds || []).slice(0, MAX_TRACKED_EMAIL_IDS);
    state.knownCalendarEventIds = unique(state.knownCalendarEventIds || []).slice(0, MAX_TRACKED_CALENDAR_EVENT_IDS);
    state.deliveredReminderKeys = pruneReminderStore(state.deliveredReminderKeys || {}, Date.now());

    const cache = await caches.open(NOTIFICATION_STATE_CACHE);
    await cache.put(NOTIFICATION_STATE_URL, new Response(JSON.stringify(state), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    }));
  } catch (error) {
    console.error('[SW] Failed to save notification state:', error);
  }
}

async function resetNotificationState() {
  try {
    await caches.delete(NOTIFICATION_STATE_CACHE);
  } catch (error) {
    console.error('[SW] Failed to reset notification state:', error);
  }
}

async function showNotification(title, options = {}) {
  try {
    if (!self.registration?.showNotification) return false;
    await self.registration.showNotification(title, {
      ...options,
      icon: options.icon || '/icons/icon-512x512.png',
      badge: options.badge || '/favicon.ico',
      tag: options.tag || 'unihub-notification',
      requireInteraction: options.requireInteraction ?? false,
      silent: options.silent ?? false,
      data: options.data || {},
    });
    return true;
  } catch (error) {
    console.error('[SW] Failed to show notification:', error);
    return false;
  }
}

async function getWindowClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

function hasVisibleClient(clients) {
  return clients.some((client) => {
    const visibilityState = client.visibilityState || (client.focused ? 'visible' : 'hidden');
    return visibilityState === 'visible';
  });
}

async function hasVisibleClientForPath(pathPrefix) {
  const clients = await getWindowClients();
  return clients.some((client) => {
    try {
      const url = new URL(client.url);
      const visibilityState = client.visibilityState || (client.focused ? 'visible' : 'hidden');
      return url.origin === self.location.origin &&
        url.pathname.startsWith(pathPrefix) &&
        visibilityState === 'visible';
    } catch {
      return false;
    }
  });
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function pruneReminderStore(store, now) {
  return Object.fromEntries(
    Object.entries(store)
      .filter(([, timestamp]) => Number.isFinite(timestamp) && timestamp >= now - REMINDER_RETENTION_MS)
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_STORED_REMINDERS)
  );
}

function getSenderLabel(email) {
  return (email.from_name || email.from_address || 'Unknown sender').trim();
}

function getReminderMinutes(event) {
  const source = Array.isArray(event.reminders) && event.reminders.length > 0
    ? event.reminders
    : (typeof event.reminder_minutes === 'number' ? [event.reminder_minutes] : []);

  return unique(
    source
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0)
  ).sort((a, b) => b - a);
}

function getReminderKey(event, reminderMinutes) {
  return `${event.id}:${event.start_time}:${reminderMinutes}`;
}

function getReminderLeadText(reminderMinutes) {
  if (reminderMinutes <= 0) return 'Event is starting now';
  if (reminderMinutes % 1440 === 0) {
    const days = reminderMinutes / 1440;
    return `Event starts in ${days} day${days === 1 ? '' : 's'}`;
  }
  if (reminderMinutes % 60 === 0) {
    const hours = reminderMinutes / 60;
    return `Event starts in ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `Event starts in ${reminderMinutes} minute${reminderMinutes === 1 ? '' : 's'}`;
}

function getCalendarNotificationPath(event) {
  return event.is_todo_only ? '/todo' : '/calendar';
}

function getCalendarEventStartText(event) {
  const start = new Date(event.start_time);
  if (!Number.isFinite(start.getTime())) return '';
  const options = event.all_day
    ? { dateStyle: 'medium' }
    : { dateStyle: 'medium', timeStyle: 'short' };
  return `Starts ${start.toLocaleString(undefined, options)}`;
}
