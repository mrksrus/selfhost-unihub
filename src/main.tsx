import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import "./index.css";
import {
  BACKGROUND_NOTIFICATION_SYNC_TAG,
  NOTIFICATION_CHECK_INTERVAL_MS,
  initServiceWorker,
  registerPeriodicSync,
} from "./utils/service-worker";

// Register service worker
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(swUrl, registration) {
    console.log('[SW] Service Worker registered:', swUrl);
    // Initialize our service worker utilities
    if (registration) {
      initServiceWorker();
      registerPeriodicSync(BACKGROUND_NOTIFICATION_SYNC_TAG, NOTIFICATION_CHECK_INTERVAL_MS).catch(console.error);
    }
  },
  onNeedRefresh() {
    console.log('[SW] Update available');
  },
  onOfflineReady() {
    console.log('[SW] App ready to work offline');
  },
});

createRoot(document.getElementById("root")!).render(<App />);
