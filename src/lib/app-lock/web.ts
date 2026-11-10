// The page's own app lock (the web, the installed web app, and Android apps
// before bridge level 3): the UniHub PIN (pin.ts) and this tab's time in the
// background. lib/platform.ts chooses it; nothing else imports it.
//
// Each tab keeps its own timer: it notes when it went to the background and,
// on its return, how long it was away. Whether that is long enough to lock is
// the provider's decision (timeline.ts), the same rule for every tab.
import type { DeviceLock, DeviceLockConfig } from '@/lib/platform';
import { pinSupport } from '@/lib/app-lock/pin';

/**
 * On the root element while the tab is in the background with a lock on: the
 * screens blur the page, so the frame a browser shows on return and the
 * Android task switcher's picture show nothing readable (best effort).
 */
export const HIDDEN_CLASS = 'app-lock-hidden';

/** Page visibility, the same in a browser and in the app's WebView. */
export function subscribeVisibility(listener: (event: 'hidden' | 'visible') => void) {
  const onVisibility = () => listener(document.visibilityState === 'hidden' ? 'hidden' : 'visible');
  const onHide = () => listener('hidden');
  const onShow = (event: PageTransitionEvent) => { if (event.persisted) listener('visible'); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('pageshow', onShow);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('pageshow', onShow);
  };
}

export function createWebDeviceLock(): DeviceLock {
  const listeners = new Set<(event: 'hidden' | 'visible') => void>();
  let config: DeviceLockConfig | null = null;
  let hiddenAt: number | null = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? Date.now() : null;
  let lastHiddenForMs: number | null = null;
  let fresh = true;

  // Installed once for the page; the provider's listeners run after the
  // times are noted.
  if (typeof document !== 'undefined') subscribeVisibility(event => {
    if (event === 'hidden') {
      if (hiddenAt === null) hiddenAt = Date.now();
      if (config?.scope.length) document.documentElement.classList.add(HIDDEN_CLASS);
    } else if (hiddenAt !== null) {
      lastHiddenForMs = Date.now() - hiddenAt;
      hiddenAt = null;
    }
    listeners.forEach(listener => listener(event));
  });

  return {
    async method() { return { method: 'pin', biometric: 'none', deviceSecure: false }; },
    async authenticate() { return 'pin'; },
    async configure(next) {
      config = next;
      if (!next?.scope.length) document.documentElement.classList.remove(HIDDEN_CLASS);
    },
    async state() {
      const state = {
        due: null,
        hiddenForMs: hiddenAt !== null ? Date.now() - hiddenAt : lastHiddenForMs,
        deviceLockedSinceHidden: false,
        freshProcess: fresh,
        authenticatedAt: null,
      };
      fresh = false;
      return state;
    },
    async release() { document.documentElement.classList.remove(HIDDEN_CLASS); },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    capabilities: { secureWindow: false, hideRecents: false, deviceLockSignal: false },
  };
}

/** Why the PIN cannot be used here, or null. */
export const webPinUnavailable = () => pinSupport().reason;
