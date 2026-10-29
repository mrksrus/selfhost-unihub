// B-24 (0.25.1): the app update the page downloads installs without the Files
// app. Opened from the download manager's own "complete" notification,
// Android's installer counted the download manager as the source and refused
// it ("isn't allowed to install unknown apps from this source"). Now UniHub
// opens the installer itself: at once while it is on screen, and from its own
// notification after a download that finished in the background. Android
// asks once to allow UniHub as a source, then offers the update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE, adb, answerSlowDialogs, deviceScreenshot, openApp, screenNodes, sleep, tapNative } from '../support/android.mjs';

const evidence = process.env.UNIHUB_E2E_EVIDENCE ?? `${process.env.TMPDIR ?? '/tmp'}`;
const run = Date.now().toString(36);
const downloads = [];

const topActivity = () => adb('shell', 'dumpsys', 'activity', 'activities').split('\n').find(line => line.includes('topResumedActivity')) ?? '';

/** What the page's Update action does in the app (downloadFromServer in src/lib/platform.ts). */
async function startUpdate(page, name) {
  downloads.push(name);
  await page.evaluate(file => window.UniHubAndroid.postMessage(JSON.stringify({ type: 'download', url: new URL('/downloads/unihub.apk', location.href).href, name: file })), name);
}

/** Waits for Android's installer in front and returns the texts it shows. */
async function installerShown(shot) {
  let top = '';
  for (let attempt = 0; attempt < 60 && !/packageinstaller/i.test(top); attempt++) {
    await sleep(1000);
    top = topActivity();
  }
  assert.match(top, /packageinstaller/i, 'Android\'s installer is in front');
  let texts = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    await answerSlowDialogs();
    texts = screenNodes().filter(node => node.text).map(node => node.text);
    if (texts.some(text => /unknown apps|update this app|install this app/i.test(text))) break;
    await sleep(1000);
  }
  deviceScreenshot(`${evidence}/${shot}.png`);
  console.log(`installer: ${texts.join(' | ')}`);
  return texts;
}

test('[B-24] the downloaded app update opens Android\'s installer with UniHub as its source', { timeout: 900_000 }, async () => {
  adb('shell', 'pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
  adb('logcat', '-c');
  const { device, page } = await openApp();
  try {
    // Finished while the app is in the background: UniHub's notification leads to the installer.
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(2000);
    await startUpdate(page, `unihub-update-${run}-a.apk`);
    let posted = false;
    for (let attempt = 0; attempt < 90 && !posted; attempt++) {
      await sleep(2000);
      posted = adb('shell', 'dumpsys', 'notification', '--noredact').includes('UniHub update downloaded');
    }
    assert.ok(posted, 'UniHub announces the downloaded update');
    adb('shell', 'cmd', 'statusbar', 'expand-notifications');
    await sleep(1500);
    await tapNative(/^UniHub update downloaded$/);
    let texts = await installerShown('android-app-update-from-notification');
    assert.ok(!texts.includes('Download Manager'), 'the download manager is not the source');
    assert.ok(texts.some(text => /unknown apps from this source/.test(text)) && texts.includes('UniHub'), 'Android asks to allow UniHub as the source');
    await tapNative(/^Cancel$/);
    for (let attempt = 0; attempt < 20 && !topActivity().includes(PACKAGE); attempt++) await sleep(1000);
    assert.ok(topActivity().includes(PACKAGE), 'cancelled, the app is back and does not open the installer again');
    await sleep(3000);
    assert.ok(topActivity().includes(PACKAGE));

    // Finished while the app is in front: the installer opens by itself. Once
    // UniHub is allowed as a source, the update is offered.
    await startUpdate(page, `unihub-update-${run}-b.apk`);
    texts = await installerShown('android-app-update-in-front');
    assert.ok(texts.includes('UniHub') && !texts.includes('Download Manager'));
    await tapNative(/^Settings$/);
    await tapNative(/Allow from this source/);
    // Android returns to the installer by itself on newer versions.
    await sleep(3000);
    if (!/packageinstaller/i.test(topActivity())) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    texts = await installerShown('android-app-update-offered');
    assert.ok(texts.some(text => /update this app/i.test(text)), 'the update is offered');
    assert.equal(adb('logcat', '-d').split('\n').find(line => line.includes('needs to declare permission android.permission.REQUEST_INSTALL_PACKAGES')), undefined);
    await tapNative(/^Cancel$/);
  } finally {
    adb('shell', 'cmd', 'statusbar', 'collapse');
    if (!topActivity().includes(PACKAGE)) adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    for (const name of downloads) adb('shell', 'rm', '-f', `/sdcard/Download/${name}`);
    await device.close();
  }
});
