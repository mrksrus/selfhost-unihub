import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { androidApp, canInstallAndroidApp } from '@/lib/platform';

// Install prompt preferences, stored per browser.
export const NEXT_AT_KEY = 'unihub:pwa-install-next-at';
export const DECLINED_KEY = 'unihub:pwa-install-declined';
export const INSTALLED_AT_KEY = 'unihub:pwa-installed-at';
export const INSTALL_REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

function read(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function write(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* Without storage the prompt may show again. */ }
}

// Shown at most once a day until the user installs (or downloads the Android
// app) or answers No.
export function installPromptAllowed(now = Date.now()) {
  if (read(DECLINED_KEY) === 'true' || read(INSTALLED_AT_KEY)) return false;
  const nextAt = Number(read(NEXT_AT_KEY) || '0');
  return !Number.isFinite(nextAt) || now >= nextAt;
}
export function remindLater(now = Date.now()) {
  write(NEXT_AT_KEY, String(now + INSTALL_REMIND_AFTER_MS));
}
export function markInstalled(now = Date.now()) {
  write(INSTALLED_AT_KEY, String(now));
}

export function isStandaloneDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// ── Web app: the browser's own install dialog ─────────────────────
// The browser offers it once per page load, possibly before any component that
// shows it is mounted (the card remounts on account changes), so the offer is
// kept here for the whole tab.

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    markInstalled();
    deferred = null;
    notify();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether the browser offers to install the web app here. */
export function useWebInstallAvailable() {
  return useSyncExternalStore(subscribe, () => deferred !== null, () => false);
}

/** Opens the browser's install dialog. Cancelling it asks again in a day. */
export async function installWebApp() {
  const prompt = deferred;
  if (!prompt) return;
  deferred = null;
  notify();
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === 'dismissed') remindLater();
}

// ── Android app: the APK built into the server's image ───────────

export interface AndroidDownload {
  url: string;
  versionName: string;
  versionCode: number;
  size: number;
}

export interface ServerVersion {
  app: 'unihub';
  server: string;
  android: AndroidDownload | null;
}

export const serverVersionKey = ['server-version'] as const;

/** GET /api/version. Public and identical for every account. */
export function useServerVersion(enabled = true) {
  return useQuery({
    queryKey: serverVersionKey,
    enabled,
    queryFn: async ({ signal }) => {
      const response = await api.get<ServerVersion>('/version', { signal });
      if (response.error) throw new Error(response.error);
      if (!response.data) throw new Error('No version answer');
      return response.data;
    },
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}

/** The Android app this server offers for download on this device, if any. */
export function useAndroidDownload() {
  const offered = canInstallAndroidApp();
  const download = useServerVersion(offered).data?.android ?? null;
  return offered ? download : null;
}

/** In the Android app: the newer app this server carries, if any. */
export function useAndroidAppUpdate() {
  const app = androidApp();
  const download = useServerVersion(!!app).data?.android ?? null;
  return app && download && download.versionCode > app.versionCode ? download : null;
}

export function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
