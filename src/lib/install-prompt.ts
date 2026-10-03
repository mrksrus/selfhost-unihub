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

// Shown at most once a day until the user installs or answers No.
export function installPromptAllowed(now = Date.now()) {
  if (read(DECLINED_KEY) === 'true' || read(INSTALLED_AT_KEY)) return false;
  const nextAt = Number(read(NEXT_AT_KEY) || '0');
  return !Number.isFinite(nextAt) || now >= nextAt;
}
export function remindLater(now = Date.now()) {
  write(NEXT_AT_KEY, String(now + INSTALL_REMIND_AFTER_MS));
}
