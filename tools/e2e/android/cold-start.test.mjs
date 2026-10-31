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

/** Where a point of the screen is in a raw screenshot: its byte offset. */
function offsetOf(xFraction, yFraction) {
  const raw = execFileSync(`${SDK}/platform-tools/adb`, ['-s', serial, 'exec-out', 'screencap'], { maxBuffer: 64 * 1024 * 1024 });
  const width = raw.readUInt32LE(0), height = raw.readUInt32LE(4);
  // Android 9+ writes a 16-byte header (width, height, format, colour space), then RGBA.
  const header = raw.length - width * height * 4;
  return header + (Math.floor(height * yFraction) * width + Math.floor(width * xFraction)) * 4;
}

// The window in front of every other: the launcher, UniHub's splash screen
// ("Splash Screen io.github.mrksrus.unihub") or UniHub's own window. The
// focused window would not do: the splash screen never has the focus.
const FRONT = 'dumpsys window displays | grep mTopFullscreenOpaqueWindowState';

/**
 * Samples the screen on the phone (pulling whole screenshots takes seconds on
 * a slow emulator) until `count` samples had UniHub in front, for at most
 * `seconds`: per sample the brightness (0 to 255) of the pixel at offset,
 * whether UniHub was in front just before and after the screenshot, and
 * whether that was its splash screen.
 */
function sampleOnPhone(offset, count, seconds) {
  const script = `front=$(${FRONT}); kept=0; end=$(($(cut -d. -f1 /proc/uptime) + ${seconds}));
    while [ $kept -lt ${count} ] && [ $(cut -d. -f1 /proc/uptime) -lt $end ]; do
      pixel=$(screencap | head -c ${offset + 3} | tail -c 3 | xxd -p); before=$front; front=$(${FRONT})
      inFront=$(echo "$before" | grep -c ${PACKAGE})$(echo "$front" | grep -c ${PACKAGE}); [ $inFront = 11 ] && kept=$((kept + 1))
      echo "sample $pixel $inFront $(echo "$front" | grep -c 'Splash Screen')"
    done`;
  return [...adb('shell', script).matchAll(/^sample ([0-9a-f]{6}) (\d\d) (\d)/gm)].map(([, pixel, inFront, splash]) => {
    const [r, g, b] = pixel.match(/../g).map(hex => parseInt(hex, 16));
    return { value: Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b), inFront: inFront === '11', splash: splash === '1' };
  });
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
    const offset = offsetOf(0.5, 0.2);
    await sleep(1500);
    // Without -W, which would return only after the splash screen.
    adb('shell', 'am', 'start', '-n', `${PACKAGE}/.MainActivity`);
    // The first screenshots can come before UniHub is in front and show the
    // (light) launcher: those are skipped, not counted as UniHub's frames. The
    // first eight samples with UniHub in front cover its splash screen and the
    // page's start (a screenshot takes 1 to 2.5 s while a slow emulator starts the app).
    const all = sampleOnPhone(offset, 8, 60);
    const kept = all.filter(s => s.inFront);
    const samples = kept.map(s => s.value);
    const skipped = all.filter(s => !s.inFront).map(s => s.value);
    console.log(`brightness at the top of the screen during the start: ${samples.join(' ')} (${kept.filter(s => s.splash).length} of the splash screen; UniHub not in front, skipped: ${skipped.join(' ') || 'none'})`);
    assert.equal(samples.length, 8, `eight samples with UniHub in front within 60 s; skipped: ${skipped.join(' ')}`);
    assert.deepEqual(samples.filter(value => value > 128), [], 'no light frame while UniHub (Dark) starts');
  } finally {
    adb('shell', 'cmd', 'uimode', 'night', /yes/.test(night) ? 'yes' : 'no');
  }
});
