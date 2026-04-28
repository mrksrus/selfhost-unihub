import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import {
  MAIL_PERIODIC_SYNC_TAG,
  NOTIFICATION_CHECK_INTERVAL_MS,
  initServiceWorker,
  registerPeriodicSync,
  requestNotificationPermission,
  showNotification,
} from '@/utils/service-worker';

const MAIL_NOTIFICATION_STORAGE_PREFIX = 'unihub:mail-notifications:';
const MAX_TRACKED_EMAIL_IDS = 200;
const MAIL_REFETCH_INTERVAL_MS = NOTIFICATION_CHECK_INTERVAL_MS;
const NEW_EMAIL_GRACE_MS = 5 * 60 * 1000;
const NOTIFICATION_FETCH_LIMIT = 50;
const EXCLUDED_NOTIFICATION_FOLDERS = new Set(['sent', 'trash', 'archive']);

interface NotificationEmail {
  id: string;
  subject: string | null;
  from_address: string;
  from_name: string | null;
  folder: string;
  received_at: string;
}

interface MailNotificationState {
  knownIds: string[];
  lastCheckedAt: number;
}

function getMailNotificationStorageKey(userId: string) {
  return `${MAIL_NOTIFICATION_STORAGE_PREFIX}${userId}`;
}

function loadMailNotificationState(storageKey: string): MailNotificationState | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MailNotificationState>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.knownIds)) {
      return null;
    }
    return {
      knownIds: parsed.knownIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_TRACKED_EMAIL_IDS),
      lastCheckedAt: Number.isFinite(parsed.lastCheckedAt) ? Number(parsed.lastCheckedAt) : Date.now(),
    };
  } catch {
    return null;
  }
}

function saveMailNotificationState(storageKey: string, state: MailNotificationState) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({
      knownIds: state.knownIds.slice(0, MAX_TRACKED_EMAIL_IDS),
      lastCheckedAt: state.lastCheckedAt,
    }));
  } catch {
    // Ignore storage failures; notifications can still work for the current session.
  }
}

function getSenderLabel(email: NotificationEmail) {
  return (email.from_name || email.from_address || 'Unknown sender').trim();
}

export const useMailNotifications = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const notificationStateRef = useRef<MailNotificationState | null>(null);

  useEffect(() => {
    if (!user?.id) {
      notificationStateRef.current = null;
      return;
    }

    notificationStateRef.current = loadMailNotificationState(getMailNotificationStorageKey(user.id));

    const setupNotifications = async () => {
      await initServiceWorker();
      await requestNotificationPermission();
      await registerPeriodicSync(MAIL_PERIODIC_SYNC_TAG, MAIL_REFETCH_INTERVAL_MS);
    };

    void setupNotifications();
  }, [user?.id]);

  const { data: latestEmails = [], refetch } = useQuery({
    queryKey: ['mail-notification-feed', user?.id],
    queryFn: async () => {
      const response = await api.get<{ emails: NotificationEmail[] }>(
        `/mail/emails?limit=${NOTIFICATION_FETCH_LIMIT}&offset=0`
      );
      if (response.error) throw new Error(response.error);
      return response.data?.emails || [];
    },
    enabled: !!user,
    refetchInterval: MAIL_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: true,
    staleTime: 15000,
  });

  useEffect(() => {
    if (!user?.id) return;

    const refreshNotifications = () => {
      void refetch();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshNotifications();
      }
    };

    window.addEventListener('sw-check-emails', refreshNotifications);
    window.addEventListener('focus', refreshNotifications);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('sw-check-emails', refreshNotifications);
      window.removeEventListener('focus', refreshNotifications);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refetch, user?.id]);

  useEffect(() => {
    if (!user?.id) return;

    const storageKey = getMailNotificationStorageKey(user.id);
    const relevantEmails = latestEmails.filter((email) => !EXCLUDED_NOTIFICATION_FOLDERS.has(email.folder));
    const now = Date.now();

    if (!notificationStateRef.current) {
      const initialState = {
        knownIds: relevantEmails.map((email) => email.id).slice(0, MAX_TRACKED_EMAIL_IDS),
        lastCheckedAt: now,
      };
      notificationStateRef.current = initialState;
      saveMailNotificationState(storageKey, initialState);
      return;
    }

    const currentState = notificationStateRef.current;
    const knownIds = new Set(currentState.knownIds);
    const freshnessThreshold = Math.max(0, currentState.lastCheckedAt - NEW_EMAIL_GRACE_MS);
    const newEmails = relevantEmails.filter((email) => {
      if (knownIds.has(email.id)) return false;
      const receivedAtMs = Date.parse(email.received_at);
      return Number.isFinite(receivedAtMs) && receivedAtMs >= freshnessThreshold;
    });

    const nextState: MailNotificationState = {
      knownIds: Array.from(new Set([
        ...relevantEmails.map((email) => email.id),
        ...currentState.knownIds,
      ])).slice(0, MAX_TRACKED_EMAIL_IDS),
      lastCheckedAt: now,
    };
    notificationStateRef.current = nextState;
    saveMailNotificationState(storageKey, nextState);

    if (newEmails.length === 0) return;

    queryClient.invalidateQueries({ queryKey: ['emails'] });
    queryClient.invalidateQueries({ queryKey: ['mail-unread-counts'] });
    queryClient.invalidateQueries({ queryKey: ['mail-accounts-count'] });
    queryClient.invalidateQueries({ queryKey: ['stats'] });

    const isViewingMail = document.visibilityState === 'visible' && window.location.pathname.startsWith('/mail');
    if (isViewingMail) return;

    const firstEmail = newEmails[0];
    const title = newEmails.length === 1 ? 'New Email' : 'New Emails';
    const body = newEmails.length === 1
      ? `${getSenderLabel(firstEmail)}: ${firstEmail.subject || '(No subject)'}`
      : `${newEmails.length} new emails received`;

    void showNotification(title, {
      body,
      tag: 'mail-new-email',
      renotify: true,
      requireInteraction: false,
      data: {
        url: '/mail',
        emailIds: newEmails.map((email) => email.id),
      },
    });
  }, [latestEmails, queryClient, user?.id]);
};
