import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App.tsx";
import "./index.css";
import { initServiceWorker } from "./utils/service-worker";

// Register service worker
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(swUrl, registration) {
    console.log('[SW] Service Worker registered:', swUrl);
    // Initialize our service worker utilities
    if (registration) {
      initServiceWorker();
    }
  },
  onNeedRefresh() {
    window.__unihubUpdateAvailable = true;
    window.dispatchEvent(new Event('unihub-update-available'));
  },
  onOfflineReady() {
    console.log('[SW] Application shell cached');
  },
});

window.addEventListener('unihub-apply-update', () => {
  void updateSW(true).catch(() => window.dispatchEvent(new Event('unihub-update-failed')));
});

createRoot(document.getElementById("root")!).render(<App />);
