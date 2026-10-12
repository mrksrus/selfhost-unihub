import { useSyncExternalStore } from 'react';
import { emitAppEvent, onAppEvent } from '@/lib/app-events';

declare global { interface Window { __unihubUpdateAvailable?: boolean } }

// One state for the whole tab: the attention tray, the rail dot and the More
// page all show the same update. main.tsx sets __unihubUpdateAvailable when the
// update arrives before React renders.
interface UpdateState { available: boolean; updating: boolean; failed: boolean }

let state: UpdateState = { available: false, updating: false, failed: false };
const listeners = new Set<() => void>();
let started = false;

function set(next: Partial<UpdateState>) {
  state = { ...state, ...next };
  listeners.forEach(listener => listener());
}

function getSnapshot() {
  if (!started) {
    started = true;
    if (window.__unihubUpdateAvailable) state = { ...state, available: true };
    onAppEvent('unihub:update-available', () => set({ available: true }));
    onAppEvent('unihub:update-failed', () => set({ updating: false, failed: true }));
  }
  return state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test hook: forget the update state of a previous test. */
export function resetAppUpdateState() {
  state = { available: !!window.__unihubUpdateAvailable, updating: false, failed: false };
  listeners.forEach(listener => listener());
}

/**
 * A new UniHub version waits for this tab. Refreshing is the user's choice,
 * so unsaved edits and running uploads are never lost to an automatic reload.
 */
export function useAppUpdate() {
  const current = useSyncExternalStore(subscribe, getSnapshot);

  return {
    ...current,
    apply: () => {
      set({ updating: true, failed: false });
      emitAppEvent('unihub:apply-update');
    },
    /** Hide it for now; it returns when the next update is announced. */
    dismiss: () => set({ available: false, failed: false }),
  };
}
