// B-21 (0.25.1): a cold start (the app swiped away and opened again) begins in
// UniHub's own light or dark theme. Android draws the splash screen before the
// app runs, in the phone's theme, so UniHub in Dark on a phone in light mode
// started with a light flash (and Light on a dark phone with a black one). From
// Android 13 the app chooses the splash theme of its next starts. The page's own
// start screens are covered by tests/display/start.e2e.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PACKAGE, adb, openApp, serial, sleep } from '../support/android.mjs';

const SDK = process.env.ANDROID_HOME ?? `${process.env.HOME}/Android/Sdk`;

/** The brightness (0 to 255) of a point of the screen, from a raw screenshot. */
function brightnessAt(xFraction, yFraction) {
  const raw = execFileSync(`${SDK}/platform-tools/adb`, ['-s', serial, 'exec-out', 'screencap'], { maxBuffer: 64 * 1024 * 1024 });
  const width = raw.readUInt32LE(0), height = raw.readUInt32LE(4);
  // Android 9+ writes a 16-byte header (width, height, format, colour space), then RGBA.
  const header = raw.length - width * height * 4;
  const at = header + (Math.floor(height * yFraction) * width + Math.floor(width * xFraction)) * 4;
  return 0.2126 * raw[at] + 0.7152 * raw[at + 1] + 0.0722 * raw[at + 2];
}

test('[B-21] a cold start of UniHub in Dark on a light phone starts dark, without a light flash', { timeout: 600_000 }, async t => {
  const sdk = Number(adb('shell', 'getprop', 'ro.build.version.sdk').trim());
  if (sdk < 33) { t.skip('the splash theme can be chosen from Android 13'); return; }
  const night = adb('shell', 'cmd', 'uimode', 'night').trim();
  adb('shell', 'cmd', 'uimode', 'night', 'no');
  try {
    // UniHub's default theme is Dark; the page reports it to the app, which keeps it for the next starts.
    const { device, page } = await openApp();
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true, 'UniHub is in Dark');
    await sleep(2000);
    await device.close();
    adb('shell', 'am', 'force-stop', PACKAGE);
    await sleep(1500);
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
    const samples = [];
    for (let i = 0; i < 12; i++) samples.push(Math.round(brightnessAt(0.5, 0.2)));
    console.log(`brightness at the top of the screen during the start: ${samples.join(' ')}`);
    assert.deepEqual(samples.filter(value => value > 128), [], 'no light frame while UniHub (Dark) starts');
  } finally {
    adb('shell', 'cmd', 'uimode', 'night', /yes/.test(night) ? 'yes' : 'no');
  }
});
