import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPwaUpdateManager } from '@/lib/pwa-update';

class Worker extends EventTarget {
  state: ServiceWorkerState = 'installed';
  postMessage = vi.fn();
  transition(state: ServiceWorkerState) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
class WorkerContainer extends EventTarget {
  controller: ServiceWorker | null = null;
  getRegistration = vi.fn<() => Promise<ServiceWorkerRegistration | undefined>>();
  control(worker: Worker) { this.controller = worker as unknown as ServiceWorker; this.dispatchEvent(new Event('controllerchange')); }
}
const managers: ReturnType<typeof createPwaUpdateManager>[] = [];
function tab(waiting: Worker | null, controlled = true) {
  const serviceWorker = new WorkerContainer();
  if (controlled) serviceWorker.controller = new Worker() as unknown as ServiceWorker;
  const registration = { waiting: waiting as unknown as ServiceWorker | null } as ServiceWorkerRegistration;
  const reload = vi.fn();
  const onAvailable = vi.fn();
  const onFailure = vi.fn();
  const manager = createPwaUpdateManager({ serviceWorker, reload, onAvailable, onFailure });
  manager.setRegistration(registration);
  managers.push(manager);
  return { manager, serviceWorker, reload, onAvailable, onFailure, registration };
}
afterEach(() => { managers.splice(0).forEach(manager => manager.dispose()); vi.useRealTimers(); });

describe('service worker update lifecycle', () => {
  it('reloads only the consenting tab, including a tab opened before its first controller existed', async () => {
    const worker = new Worker();
    const first = tab(worker, false);
    const second = tab(worker);
    first.manager.notifyAvailable();
    second.manager.notifyAvailable();
    await first.manager.apply();
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' });
    expect(first.reload).not.toHaveBeenCalled();
    worker.transition('activating');
    worker.transition('activated');
    first.serviceWorker.control(worker);
    second.serviceWorker.control(worker);
    expect(first.reload).toHaveBeenCalledTimes(1);
    expect(second.reload).not.toHaveBeenCalled();
  });

  it('keeps all non-consenting tabs intact when another tab activates an update', () => {
    const worker = new Worker();
    const first = tab(worker);
    const second = tab(worker);
    first.manager.notifyAvailable();
    second.manager.notifyAvailable();
    worker.transition('activated');
    first.serviceWorker.control(worker);
    second.serviceWorker.control(worker);
    expect(first.reload).not.toHaveBeenCalled();
    expect(second.reload).not.toHaveBeenCalled();
  });

  it('refreshes the current tab on consent after the waiting worker was already activated elsewhere', async () => {
    const current = tab(null);
    current.manager.notifyAvailable();
    await current.manager.apply();
    expect(current.reload).toHaveBeenCalledTimes(1);
    expect(current.onFailure).not.toHaveBeenCalled();
  });

  it('uses native controller changes without relying on Workbox update/external flags', async () => {
    const worker = new Worker();
    const current = tab(worker, false);
    await current.manager.apply();
    current.serviceWorker.control(worker);
    worker.transition('activated');
    expect(current.reload).toHaveBeenCalledTimes(1);
  });

  it('times out safely and requires new consent before a delayed activation can reload', async () => {
    vi.useFakeTimers();
    const worker = new Worker();
    const current = tab(worker);
    await current.manager.apply();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(current.onFailure).toHaveBeenCalledTimes(1);
    worker.transition('activated');
    current.serviceWorker.control(worker);
    expect(current.reload).not.toHaveBeenCalled();
    Object.defineProperty(current.registration, 'waiting', { value: null });
    await current.manager.apply();
    expect(current.reload).toHaveBeenCalledTimes(1);
  });

  it('reports failed activation and permits retry instead of leaving the button stuck', async () => {
    const worker = new Worker();
    const current = tab(worker);
    worker.postMessage.mockImplementationOnce(() => { throw new Error('Worker unavailable'); });
    await current.manager.apply();
    expect(current.onFailure).toHaveBeenCalledTimes(1);
    await current.manager.apply();
    worker.transition('redundant');
    expect(current.onFailure).toHaveBeenCalledTimes(2);
    expect(current.reload).not.toHaveBeenCalled();
  });

  it('does not mistake an ordinary first installation for an update', () => {
    const current = tab(null, false);
    current.serviceWorker.control(new Worker());
    expect(current.onAvailable).not.toHaveBeenCalled();
    expect(current.reload).not.toHaveBeenCalled();
  });
});
