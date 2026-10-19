import fs from 'node:fs';
import path from 'node:path';
import packageJson = require('../../package.json');

// The handshake between this server and the Android app (android/). The app
// shows the server's own pages, so most changes need nothing here; this is for
// what the app does natively.
//
// - PROTOCOL changes only when an older app can no longer work with this
//   server at all. Additions are listed in FEATURES instead, and the app looks
//   for a feature rather than comparing versions.
// - MIN_APP is the oldest app version this server still serves. Raise it only
//   once no supported app needs what is being removed ("expand, then contract").
const PROTOCOL = 1;
const MIN_APP = '0.21.0';
// android-notifications (0.22.1): POST /api/notifications/android/devices,
// GET /api/notifications/android/stream and POST /api/notifications/android/ack.
const FEATURES: string[] = ['android-notifications'];

// Written by android/scripts/build-apk.sh next to the APK in the image.
const DOWNLOADS_DIR = process.env.UNIHUB_DOWNLOADS_DIR || '/app/downloads';
export const ANDROID_APK_URL = '/downloads/unihub.apk';

export interface AndroidDownload {
  url: string;
  versionName: string;
  versionCode: number;
  size: number;
  sha256: string;
}

function readAndroidDownload(dir: string): AndroidDownload | null {
  try {
    if (!fs.statSync(path.join(dir, 'unihub.apk')).isFile()) return null;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'unihub-android.json'), 'utf8'));
    // Code 0 or an empty name would offer the download to no one and hide every update.
    const valid = typeof meta?.versionName === 'string' && meta.versionName !== '' && Number.isSafeInteger(meta.versionCode) && meta.versionCode > 0
      && Number.isSafeInteger(meta.size) && meta.size > 0 && /^[0-9a-f]{64}$/.test(meta.sha256);
    if (!valid) return null;
    return { url: ANDROID_APK_URL, versionName: meta.versionName, versionCode: meta.versionCode, size: meta.size, sha256: meta.sha256 };
  } catch {
    return null;
  }
}

// The image's files never change while it runs, so they are read once.
const cache = new Map<string, AndroidDownload | null>();

/** GET /api/version: public, so the app can recognize a UniHub server before signing in. */
export function versionInfo(dir = DOWNLOADS_DIR) {
  if (!cache.has(dir)) cache.set(dir, readAndroidDownload(dir));
  return {
    app: 'unihub',
    server: packageJson.version,
    protocol: PROTOCOL,
    minApp: MIN_APP,
    features: FEATURES,
    android: cache.get(dir) ?? null,
  };
}
