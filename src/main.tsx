import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import "./index.css";
import { initServiceWorker } from "./utils/service-worker";
import { createPwaUpdateManager } from "./lib/pwa-update";

const updates = 'serviceWorker' in navigator ? createPwaUpdateManager({
  serviceWorker: navigator.serviceWorker,
  reload: () => window.location.reload(),
  onAvailable: () => {
    window.__unihubUpdateAvailable = true;
    window.dispatchEvent(new Event('unihub-update-available'));
  },
  onFailure: () => window.dispatchEvent(new Event('unihub-update-failed')),
}) : undefined;

// Register service worker
registerSW({
  immediate: true,
  onRegisteredSW(swUrl, registration) {
    console.log('[SW] Service Worker registered:', swUrl);
    // Initialize our service worker utilities
    if (registration) {
      updates?.setRegistration(registration);
      initServiceWorker();
    }
  },
  onNeedRefresh() {
    updates?.notifyAvailable();
  },
  // Workbox otherwise reloads every prompted tab, including tabs with unsaved edits.
  // Native activation/controller events above reload only the tab that gave consent.
  onNeedReload() {},
  onOfflineReady() {
    console.log('[SW] Application shell cached');
  },
});

window.addEventListener('unihub-apply-update', () => {
  if (updates) void updates.apply();
  else window.dispatchEvent(new Event('unihub-update-failed'));
});

createRoot(document.getElementById("root")!).render(<App />);
