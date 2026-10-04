// Service worker side of recording uploads. Built on its own into
// recording-uploads-sw.js (see vite.config.ts) and loaded with importScripts
// next to public/sw-custom.js.
//
// The page uploads while it is visible. When it is hidden it hands the queue
// over: with Background Sync the browser wakes this worker when there is a
// connection, even after the app is closed. Without it (Safari, Firefox) the
// page wakes the worker directly, which keeps running for a short while. If
// the upload cannot finish, a notification tells the user that the recording
// is still only on this device.
import {
  processRecordingQueue,
  listStoredRecordings,
  listQueuedUserIds,
  withRecordingUploadLock,
  RECORDING_UPLOADS_NOTICE_TAG,
  RECORDING_UPLOADS_SYNC_TAG,
  type QueueRunResult,
} from '@/lib/recording-queue';
import type { UploadRequest } from '@/lib/recording-upload';

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface SyncEvent extends ExtendableEvent {
  tag: string;
  lastChance: boolean;
}
interface ExtendableMessageEvent extends ExtendableEvent {
  data: unknown;
}
type SyncRegistration = ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } };
interface WorkerScope {
  registration: ServiceWorkerRegistration;
  // From public/sw-custom.js: runs task with whether userId is the bound account.
  unihubWithBoundUser?: (userId: string, task: (bound: boolean) => Promise<void>) => Promise<unknown>;
  addEventListener(type: 'sync', listener: (event: SyncEvent) => void): void;
  addEventListener(type: 'message', listener: (event: ExtendableMessageEvent) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const REQUEST_TIMEOUT_MS = 60_000;
// Chrome stops a sync event after a few minutes. Stopping earlier keeps the
// last chunk and the notification inside that window.
const SYNC_BUDGET_MS = 150_000;
// Without Background Sync the worker only lives a little after the page hides.
const HANDOVER_BUDGET_MS = 20_000;

async function request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
      // The worker cannot read the CSRF cookie. The server accepts this
      // custom header instead, for recording uploads only.
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Background-Sync': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, body: data && typeof data === 'object' ? data as Record<string, unknown> : null };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timeout);
  }
}
const uploadRequest: UploadRequest = request;

// The account signed in here right now. Recordings of another account wait
// until that account signs in again.
async function signedInUser(): Promise<string | null | 'offline'> {
  const response = await request('GET', '/auth/me?background=1');
  if (response.status === 0 || response.status >= 500) return 'offline';
  const user = response.body?.user as { id?: unknown } | undefined;
  return response.status === 200 && typeof user?.id === 'string' ? user.id : null;
}

async function notify(tag: string, title: string, body: string, userId: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  await scope.registration.showNotification(title, {
    body,
    tag,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    data: { url: '/recordings', userId, recordingUpload: true },
  }).catch(() => {});
}

async function closeNotifications(tags: string[]) {
  const notifications = await scope.registration.getNotifications().catch(() => [] as Notification[]);
  notifications.filter(notification => tags.includes(notification.tag)).forEach(notification => notification.close());
}

// Server reminders about a stalled upload use the same tag per recording.
const uploadTag = (id: string) => `recording-upload:${id}`;

async function reportResult(userId: string, result: QueueRunResult, finalAttempt: boolean) {
  await closeNotifications(result.uploaded.map(recording => uploadTag(recording.id)));
  for (const job of result.failed) {
    // The account may have signed out or switched since the upload began.
    // Without the bound account rechecked the notice leaves out the title.
    const show = async (bound: boolean) => notify(uploadTag(job.id), 'Recording could not be uploaded', bound
      ? `"${job.details.title}" was refused by the server: ${job.error}. It is still saved on this device.`
      : 'A recording was refused by the server. It is still saved on this device.', userId);
    await (scope.unihubWithBoundUser ? scope.unihubWithBoundUser(userId, show) : show(false)).catch(() => {});
  }
  const pending = (await listStoredRecordings(userId)).filter(job => job.state === 'queued');
  if (!pending.length) {
    await closeNotifications([RECORDING_UPLOADS_NOTICE_TAG]);
    return pending;
  }
  if (result.stoppedBy === 'signed-out') {
    await notify(RECORDING_UPLOADS_NOTICE_TAG, 'Sign in to finish uploading',
      `${pending.length === 1 ? 'A recording is' : `${pending.length} recordings are`} saved on this device only. Open UniHub and sign in to upload.`, userId);
  } else if (finalAttempt) {
    await notify(RECORDING_UPLOADS_NOTICE_TAG, 'Recording not uploaded yet',
      `${pending.length === 1 ? 'A recording is' : `${pending.length} recordings are`} saved on this device only. Open UniHub to finish the upload.`, userId);
  }
  return pending;
}

type QueueRun =
  | { kind: 'busy' }
  | { kind: 'offline' }
  | { kind: 'signed-out' }
  | { kind: 'ran'; userId: string; result: QueueRunResult };

async function runQueue(budgetMs: number): Promise<QueueRun> {
  const signal = AbortSignal.timeout(budgetMs);
  return withRecordingUploadLock<QueueRun>(signal, async () => {
    const userId = await signedInUser();
    if (userId === 'offline') return { kind: 'offline' };
    if (userId === null) return { kind: 'signed-out' };
    return { kind: 'ran', userId, result: await processRecordingQueue({ userId, request: uploadRequest, signal }) };
  }).catch(error => {
    // The page held the lock for the whole budget: it is still uploading.
    if (signal.aborted) return { kind: 'busy' } as const;
    throw error;
  });
}

// Without an answer from the server the account is unknown, so every account
// with queued recordings on this device is told.
async function notifyWaitingAccounts(title: string, body: string) {
  for (const userId of await listQueuedUserIds()) await notify(RECORDING_UPLOADS_NOTICE_TAG, title, body, userId);
}

const notUploadedYet = () => notifyWaitingAccounts('Recording not uploaded yet',
  'A recording is saved on this device only. Open UniHub to finish the upload.');
const signInToUpload = () => notifyWaitingAccounts('Sign in to finish uploading',
  'A recording is saved on this device only. Open UniHub and sign in to upload it.');

async function onSync(event: SyncEvent) {
  const run = await runQueue(SYNC_BUDGET_MS);
  if (run.kind === 'busy') return;
  if (run.kind === 'signed-out') return signInToUpload();
  if (run.kind === 'offline') {
    if (event.lastChance) await notUploadedYet();
    throw new Error('Recording upload will be retried');
  }
  const pending = await reportResult(run.userId, run.result, event.lastChance);
  if (!pending.length || run.result.stoppedBy === 'signed-out' || event.lastChance) return;
  // More to do. Ask for another sync when progress was made; failing the
  // event makes the browser retry with backoff and finally set lastChance.
  if (run.result.progressed) {
    try {
      await (scope.registration as SyncRegistration).sync?.register(RECORDING_UPLOADS_SYNC_TAG);
      return;
    } catch {
      // Some browsers only allow registration from a page.
    }
  }
  throw new Error('Recording upload will be retried');
}

async function onHandover() {
  const run = await runQueue(HANDOVER_BUDGET_MS);
  if (run.kind === 'busy') return;
  if (run.kind === 'signed-out') return signInToUpload();
  if (run.kind === 'offline') return notUploadedYet();
  await reportResult(run.userId, run.result, true);
}

scope.addEventListener('sync', event => {
  if (event.tag !== RECORDING_UPLOADS_SYNC_TAG) return;
  event.waitUntil(onSync(event));
});

scope.addEventListener('message', event => {
  const data = event.data as { type?: unknown } | null;
  if (data?.type !== 'RECORDING_UPLOADS_HANDOVER') return;
  event.waitUntil(onHandover().catch(() => {}));
});
