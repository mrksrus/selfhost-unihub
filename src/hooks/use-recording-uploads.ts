import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/useAuth';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import { recordingsQueryKeys } from '@/lib/recordings-api';
import type { UploadRequest } from '@/lib/recording-upload';
import {
  listStoredRecordings,
  processRecordingQueue,
  withRecordingUploadLock,
  RECORDING_UPLOADS_CHANNEL,
  RECORDING_UPLOADS_NOTICE_TAG,
  RECORDING_UPLOADS_SYNC_TAG,
  type RecordingQueueMessage,
  type StoredRecording,
} from '@/lib/recording-queue';

const QUEUED_EVENT = 'unihub:recording-queued';
const STOP_EVENT = 'unihub:recording-stop';
const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 5 * 60_000;

export const pageUploadRequest: UploadRequest = async (method, path, body) => {
  const response = method === 'GET'
    ? await api.get<Record<string, unknown>>(path)
    : method === 'DELETE'
      ? await api.delete<Record<string, unknown>>(path)
      : await api.post<Record<string, unknown>>(path, body);
  if (response.error) return { status: response.status ?? 0, body: response as Record<string, unknown> };
  return { status: 200, body: response.data ?? null };
};

// Starts an upload pass now, for a recording that was just queued.
export function kickRecordingUploads() {
  window.dispatchEvent(new Event(QUEUED_EVENT));
}

// Stops this page's upload pass after the current chunk, so a discard can
// take the upload lock. kickRecordingUploads() starts it again.
export function stopRecordingUploads() {
  window.dispatchEvent(new Event(STOP_EVENT));
}

// Notices that a recording is not uploaded yet are stale once it is.
export async function closeUploadNotices(tags: string[]) {
  if (!('serviceWorker' in navigator) || !tags.length) return;
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const notifications = await registration?.getNotifications().catch(() => []) ?? [];
  notifications.filter(notification => tags.includes(notification.tag)).forEach(notification => notification.close());
}

async function handOverToServiceWorker(userId: string) {
  const queued = await listStoredRecordings(userId).then(jobs => jobs.some(job => job.state === 'queued'), () => false);
  if (!queued || !('serviceWorker' in navigator)) return;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>(resolve => setTimeout(() => resolve(null), 3000)),
  ]);
  if (!registration) return;
  const sync = (registration as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync;
  try {
    if (sync) {
      await sync.register(RECORDING_UPLOADS_SYNC_TAG);
      return;
    }
  } catch {
    // Background Sync can be turned off in site settings.
  }
  registration.active?.postMessage({ type: 'RECORDING_UPLOADS_HANDOVER' });
}

// Mounted once in the app layout, so uploads go on while the user is on other
// pages. Uploads run in this page while it is visible. When it is hidden or
// closed, the service worker takes over (see src/sw/recording-uploads.ts).
export function useRecordingUploadRunner() {
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (!userId || typeof indexedDB === 'undefined') return undefined;
    let disposed = false;
    let running = false;
    let again = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = FIRST_RETRY_MS;

    const run = async () => {
      if (disposed || document.visibilityState !== 'visible') return;
      if (running) { again = true; return; }
      running = true;
      again = false;
      clearTimeout(retryTimer);
      const current = new AbortController();
      controller = current;
      try {
        const result = await withRecordingUploadLock(current.signal, () => processRecordingQueue({
          userId, request: pageUploadRequest, signal: current.signal,
        }));
        if (!result.stoppedBy && !disposed) {
          const left = await listStoredRecordings(userId).catch(() => []);
          if (!left.some(job => job.state === 'queued')) void closeUploadNotices([RECORDING_UPLOADS_NOTICE_TAG]);
        }
        if (result.stoppedBy === 'retry' && !disposed) {
          retryTimer = setTimeout(() => void run(), retryDelay);
          retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
        } else if (result.stoppedBy !== 'paused') {
          retryDelay = FIRST_RETRY_MS;
        }
      } catch {
        // The lock wait was cancelled because the page was hidden.
      } finally {
        running = false;
        if (controller === current) controller = null;
        if (again && !disposed) void run();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void run();
      } else {
        controller?.abort();
        void handOverToServiceWorker(userId);
      }
    };
    const onPageHide = () => {
      controller?.abort();
      void handOverToServiceWorker(userId);
    };
    const onOnline = () => { retryDelay = FIRST_RETRY_MS; void run(); };
    const onQueued = () => void run();
    const onStop = () => controller?.abort();
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(RECORDING_UPLOADS_CHANNEL);
    if (channel) channel.onmessage = (event: MessageEvent<RecordingQueueMessage>) => {
      if (event.data?.type !== 'uploaded' || event.data.userId !== userId) return;
      void closeUploadNotices([`recording-upload:${event.data.id}`]);
      void queryClient.invalidateQueries({ queryKey: recordingsQueryKeys.all });
      toast({ title: 'Recording uploaded', description: event.data.title });
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('online', onOnline);
    window.addEventListener(QUEUED_EVENT, onQueued);
    window.addEventListener(STOP_EVENT, onStop);
    void run();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      controller?.abort();
      channel?.close();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('online', onOnline);
      window.removeEventListener(QUEUED_EVENT, onQueued);
      window.removeEventListener(STOP_EVENT, onStop);
    };
  }, [queryClient, toast, userId]);
}

// Recordings of the signed-in account that are kept on this device, with the
// live upload progress from whichever tab or worker is uploading them.
export function useStoredRecordings() {
  const { user } = useAuth();
  const userId = user?.id;
  const [recordings, setRecordings] = useState<StoredRecording[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) { setRecordings([]); return; }
    try {
      setRecordings(await listStoredRecordings(userId));
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(RECORDING_UPLOADS_CHANNEL);
    channel.onmessage = (event: MessageEvent<RecordingQueueMessage>) => {
      if (event.data?.type === 'progress') {
        const { id, bytesUploaded } = event.data;
        setProgress(current => ({ ...current, [id]: bytesUploaded }));
      } else {
        void refresh();
      }
    };
    return () => channel.close();
  }, [refresh]);

  return { recordings, progress, available, refresh };
}
