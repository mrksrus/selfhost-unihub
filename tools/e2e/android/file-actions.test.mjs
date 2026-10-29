// 25-07 / 25-08 / 25-01 (0.25.0): in the app, a mailed PDF and photo open in
// another app, are shared and saved to Downloads through Android's own sheets,
// fetched with a download ticket (F9) rather than the session; signing out
// deletes the copies handed to other apps, as does accepting another server
// from a connect link; and the composer's message stays above the on-screen
// keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PACKAGE, adb, answerSlowDialogs, deviceScreenshot, navigate, openApp, sleep, tapNative } from '../support/android.mjs';
import { sendMail } from '../tests/support/mail.ts';

const fixture = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const evidence = process.env.UNIHUB_E2E_EVIDENCE ?? `${process.env.TMPDIR ?? '/tmp'}`;
const run = Date.now().toString(36);
const pdfName = `report-${run}.pdf`, jpgName = `photo-${run}.jpg`;

/** The type the app last handed Android's sheet for this action (debug builds log it). */
async function chooserType(action) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const line = adb('logcat', '-d', '-s', 'UniHubFiles:I').split('\n').reverse().find(entry => entry.includes(`chooser ${action} `));
    if (line) return line.trim().split(' ').pop();
    await sleep(1000);
  }
  return null;
}

let chooserShots = 0;

/** Waits for Android's chooser (or the one app it chose) over the app, and closes it. */
async function closeChooser() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const top = adb('shell', 'dumpsys', 'activity', 'activities').split('\n').find(line => line.includes('topResumedActivity')) ?? '';
    // Between two activities nothing is resumed; wait for the next one.
    if (top.includes('ActivityRecord') && !top.includes(PACKAGE)) {
      // Android's chooser, or the only app for the type, which it starts at once (a PDF viewer).
      console.log(`over the app: ${top.trim()}`);
      await sleep(2500);
      deviceScreenshot(`${evidence}/android-file-chooser-${chooserShots++}.png`);
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      return top;
    }
    await sleep(1000);
  }
  throw new Error('no chooser appeared over the app');
}

const cacheCopies = () => adb('shell', 'run-as', PACKAGE, 'sh', '-c', '"ls cache/shared 2>/dev/null | wc -l"').trim();

async function copiesGone() {
  let left = cacheCopies();
  for (let attempt = 0; attempt < 20 && left !== '0'; attempt++) { await sleep(1000); left = cacheCopies(); }
  return left === '0';
}

/** An "Open in app" link to a server, accepted in the app's question. */
async function connectLink(server) {
  // adb joins the arguments into one shell line on the device: quote the link.
  adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'unihub://connect?server=${server}'`, PACKAGE);
  await tapNative(/^connect$/i);
}

test('[25-07 25-08 25-01] open with, share and save a mailed PDF and photo; sign-out and another server clear the copies; the message stays above the keyboard', { timeout: 1_200_000 }, async () => {
  const subject = `Files for other apps ${run}`;
  await sendMail({ from: 'Sam Sender <sam@example.org>', to: ['admin@mail.test'], subject, text: 'Two files attached.', attachments: [
    { filename: pdfName, content: readFileSync(fixture('synthetic-report.pdf')), contentType: 'application/pdf' },
    { filename: jpgName, content: readFileSync(fixture('synthetic-photo.jpg')), contentType: 'image/jpeg' },
  ] });
  adb('logcat', '-c');
  const { device, page } = await openApp();
  try {
    await navigate(page, '/mail');
    // New mail comes through the provider; ask for a sync until it is listed.
    const row = page.getByText(subject).first();
    for (let attempt = 0; attempt < 20 && !(await row.isVisible()); attempt++) {
      await page.evaluate(async () => {
        const { csrfToken } = await (await fetch('/api/auth/me')).json();
        await fetch('/api/mail/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: '{}' });
      });
      await sleep(5000);
    }
    await row.click();
    await page.getByRole('button', { name: new RegExp(`^${pdfName.replace('.', '\\.')}`) }).filter({ visible: true }).first().click();
    const viewer = page.getByRole('dialog', { name: pdfName });
    await viewer.waitFor();
    assert.equal(await viewer.getByRole('button', { name: 'Download', exact: true }).count(), 0, 'the app offers its own actions instead');

    // Open with and Share: Android's sheet, told the file's type.
    await viewer.getByRole('button', { name: 'Open with…' }).click();
    await closeChooser();
    assert.equal(await chooserType('open'), 'application/pdf');
    await answerSlowDialogs();
    await viewer.getByRole('button', { name: 'Share' }).click();
    await closeChooser();
    assert.equal(await chooserType('share'), 'application/pdf');
    assert.ok(Number(cacheCopies()) >= 2, 'the copies for other apps are in the app\'s cache');

    // Save the photo to Downloads: the same bytes as mailed.
    await answerSlowDialogs();
    await viewer.getByRole('button', { name: 'Next attachment' }).click();
    const photoViewer = page.getByRole('dialog', { name: jpgName });
    await photoViewer.waitFor();
    await photoViewer.getByRole('button', { name: 'Share' }).click();
    await closeChooser();
    assert.equal(await chooserType('share'), 'image/jpeg');
    await answerSlowDialogs();
    await photoViewer.getByRole('button', { name: 'Save to Downloads' }).click();
    let saved = null;
    for (let attempt = 0; attempt < 30 && !saved; attempt++) {
      saved = adb('shell', 'ls', '/sdcard/Download/').split('\n').map(line => line.trim()).find(name => name === jpgName) ?? null;
      if (!saved) await sleep(1000);
    }
    assert.equal(saved, jpgName, 'saved under its own name');
    const bytes = execBytes(`/sdcard/Download/${jpgName}`);
    assert.ok(bytes.equals(readFileSync(fixture('synthetic-photo.jpg'))), 'the saved photo has the mailed bytes');
    await page.keyboard.press('Escape');
    // Leave the open message (it covers the list and Compose on a phone).
    await page.getByRole('button', { name: /^Back to / }).filter({ visible: true }).first().click();
    const compose = page.getByRole('button', { name: 'Compose' }).filter({ visible: true }).first();

    // The composer: with the keyboard shown, the page ends at the keyboard and the message stays in view.
    await compose.click();
    const body = page.getByRole('textbox', { name: 'Message' }).filter({ visible: true }).first();
    await body.waitFor();
    // The emulator has a hardware keyboard; show the on-screen one as a phone does.
    adb('shell', 'settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
    const before = await page.evaluate(() => window.innerHeight);
    const box = await body.boundingBox();
    // A real touch, so Android shows its keyboard: page pixels to screen pixels, from the WebView's place on screen.
    const ratio = await page.evaluate(() => window.devicePixelRatio);
    const web = webViewBounds();
    adb('shell', 'input', 'tap', `${Math.round(web.left + (box.x + box.width / 2) * ratio)}`, `${Math.round(web.top + (box.y + 12) * ratio)}`);
    let keyboard = false;
    for (let attempt = 0; attempt < 20 && !keyboard; attempt++) {
      keyboard = /mInputShown=true|isInputViewShown=true/.test(adb('shell', 'dumpsys', 'input_method'));
      if (!keyboard) await sleep(1000);
    }
    assert.ok(keyboard, 'the on-screen keyboard is shown');
    await body.pressSequentially('Line one');
    await sleep(1500);
    deviceScreenshot(`${evidence}/android-compose-keyboard.png`);
    const view = await page.evaluate(() => {
      const caret = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
      return { inner: window.innerHeight, visual: window.visualViewport?.height ?? window.innerHeight, caretBottom: caret?.bottom ?? 0 };
    });
    assert.ok(view.inner < before - 100, `the WebView shrank for the keyboard (${before} -> ${view.inner})`);
    assert.ok(Math.abs(view.visual - view.inner) < 2, `nothing of the page lies under the keyboard (visual ${view.visual}, layout ${view.inner})`);
    assert.ok(view.caretBottom > 0 && view.caretBottom <= view.inner, `the line being typed is above the keyboard (${view.caretBottom} <= ${view.inner})`);
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');

    // Signing out removes the copies handed to other apps.
    const home = new URL(page.url()).origin;
    await page.evaluate(async () => {
      const { csrfToken } = await (await fetch('/api/auth/me')).json();
      await fetch('/api/auth/signout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: '{}' });
      window.location.assign('/auth');
    }).catch(() => {});
    assert.ok(await copiesGone(), 'no copy for other apps is left after signing out');

    // So does accepting another server from a connect link, where no sign-in
    // page need follow (that server's login may still be valid).
    adb('shell', 'run-as', PACKAGE, 'sh', '-c', '"mkdir -p cache/shared/e2e-left && echo copy > cache/shared/e2e-left/left.txt"');
    assert.equal(cacheCopies(), '1');
    await connectLink('https://other-server.example.invalid');
    assert.ok(await copiesGone(), 'no copy for other apps is left after switching to another server');
    // Back to the stack's server for the next test.
    await connectLink(home);
  } finally {
    await device.close();
  }
});

/** Where the app's WebView is on screen, in screen pixels. */
function webViewBounds() {
  adb('shell', 'uiautomator', 'dump', '/data/local/tmp/unihub-ui.xml');
  const xml = adb('shell', 'cat', '/data/local/tmp/unihub-ui.xml');
  const node = [...xml.matchAll(/<node [^>]*>/g)].map(match => match[0]).find(tag => tag.includes('class="android.webkit.WebView"'));
  const box = node && /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
  if (!box) throw new Error('the WebView is not on screen');
  return { left: +box[1], top: +box[2], right: +box[3], bottom: +box[4] };
}

function execBytes(path) {
  return Buffer.from(adb('exec-out', 'base64', path).replace(/\s+/g, ''), 'base64');
}
