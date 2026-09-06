interface UpdateOptions {
  serviceWorker: Pick<ServiceWorkerContainer, 'controller' | 'addEventListener' | 'removeEventListener' | 'getRegistration'>;
  reload: () => void;
  onAvailable: () => void;
  onFailure: () => void;
  timeoutMs?: number;
}

/** Activation is shared by all tabs; permission to reload belongs to this tab only. */
export function createPwaUpdateManager({ serviceWorker, reload, onAvailable, onFailure, timeoutMs = 20_000 }: UpdateOptions) {
  let registration: ServiceWorkerRegistration | undefined;
  let available = false;
  let requested = false;
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopWatchingWorker: (() => void) | undefined;
  let controller = serviceWorker.controller;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    stopWatchingWorker?.();
    stopWatchingWorker = undefined;
  };
  const notifyAvailable = () => {
    if (disposed) return;
    available = true;
    onAvailable();
  };
  const finish = (success: boolean) => {
    if (!requested || disposed) return;
    requested = false;
    generation += 1;
    cleanup();
    if (success) reload();
    else onFailure();
  };
  const controllerChanged = () => {
    const previous = controller;
    controller = serviceWorker.controller;
    if (requested) finish(true);
    else if (previous || available) notifyAvailable();
  };
  serviceWorker.addEventListener('controllerchange', controllerChanged);

  return {
    setRegistration(value: ServiceWorkerRegistration) { registration = value; },
    notifyAvailable,
    async apply() {
      if (requested || disposed) return;
      requested = true;
      const requestGeneration = ++generation;
      timer = setTimeout(() => finish(false), timeoutMs);
      try {
        const current = registration ?? await serviceWorker.getRegistration();
        if (disposed || requestGeneration !== generation) return;
        if (!current) throw new Error('Service worker registration is unavailable');
        const waiting = current.waiting;
        // Another tab may have already activated the update while this tab kept editing.
        if (!waiting) { finish(true); return; }
        const changed = () => {
          if (waiting.state === 'activated') finish(true);
          else if (waiting.state === 'redundant') finish(false);
        };
        waiting.addEventListener('statechange', changed);
        stopWatchingWorker = () => waiting.removeEventListener('statechange', changed);
        changed();
        if (requested) waiting.postMessage({ type: 'SKIP_WAITING' });
      } catch {
        if (requestGeneration === generation) finish(false);
      }
    },
    dispose() {
      disposed = true;
      generation += 1;
      cleanup();
      serviceWorker.removeEventListener('controllerchange', controllerChanged);
    },
  };
}
