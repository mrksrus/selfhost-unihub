// UniHub as the phone's email app: an email link (SENDTO or VIEW mailto:)
// opens the composer with its to, cc, bcc, subject and body, and sends
// nothing by itself (Mailto.kt, MainActivity). The link waits through
// connecting to the server and signing in, and behind the app lock until it
// is unlocked. Which app Android opens for a link is the person's choice; the
// test names UniHub.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKAGE, adb, enrollFingerprint, openApp, resetAppLock, screenNodes, setDevicePin, signOutApp, sleep, tapNative, touch, touchFinger, waitForUnlockPrompt,
} from '../support/android.mjs';

const run = Date.now().toString(36).slice(-5);
const base = process.env.UNIHUB_E2E_URL ?? `http://127.0.0.1:${8087 + Number(process.env.UNIHUB_E2E_INSTANCE ?? '1')}`;
const greenmail = `http://127.0.0.1:${8184 + Number(process.env.UNIHUB_E2E_INSTANCE ?? '1')}`;

function mail(label) {
  const fields = { to: [`ada.${run}@example.org`, `ben.${run}@example.org`], cc: `cy.${run}@example.org`, bcc: `di.${run}@example.org`,
    subject: `${label} ${run} & more`, body: `First line ${run}\nSecond line` };
  const link = `mailto:${fields.to.join(',')}?cc=${encodeURIComponent(fields.cc)}&bcc=${encodeURIComponent(fields.bcc)}` +
    `&subject=${encodeURIComponent(fields.subject)}&body=${encodeURIComponent(fields.body)}`;
  return { ...fields, link };
}

function openLink(action, link) {
  adb('shell', `am start -a android.intent.action.${action} -d '${link}' ${PACKAGE}`);
}

/** The page once it shows the composer filled from the link; a new page load may replace the WebView's page target. */
async function composerShows(device, expected) {
  let last;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const page = await (await device.webView({ pkg: PACKAGE }, { timeout: 60_000 })).page();
      const dialog = page.getByRole('dialog').filter({ has: page.getByLabel('Subject') });
      await dialog.waitFor({ timeout: 10_000 });
      assert.equal(await dialog.locator('input').and(dialog.getByLabel('Subject')).first().inputValue(), expected.subject);
      for (const [field, addresses] of [['To', expected.to], ['Cc', [expected.cc]], ['Bcc', [expected.bcc]]]) {
        const list = dialog.getByRole('list', { name: `${field} recipients` });
        for (const address of addresses) assert.equal(await list.getByText(address).count(), 1, `${address} in ${field}`);
      }
      assert.match(await dialog.innerText(), new RegExp(`First line ${run}\\s+Second line`));
      return page;
    } catch (error) {
      last = error;
      await sleep(2000);
    }
  }
  throw new Error(`the composer did not show the link: ${last?.message}`);
}

/** Nothing reached the recipients: the composer only opened. */
async function nothingSent(expected) {
  await sleep(5000);
  for (const address of [...expected.to, expected.cc, expected.bcc]) {
    const response = await fetch(`${greenmail}/api/user/${encodeURIComponent(address)}/messages`);
    const messages = response.ok ? await response.json() : [];
    assert.equal(messages.filter(message => message.subject === expected.subject).length, 0, `nothing sent to ${address}`);
  }
}

before(resetAppLock);
after(resetAppLock);

test('an email link opens the composer with to, cc, bcc, subject and body and sends nothing', { timeout: 600_000 }, async () => {
  const { device } = await openApp();
  try {
    const expected = mail('Signed in');
    openLink('SENDTO', expected.link);
    await composerShows(device, expected);
    await nothingSent(expected);
  } finally {
    await device.close();
  }
});

test('a link to an app that is not connected yet waits through connecting and signing in', { timeout: 900_000 }, async () => {
  await signOutApp();
  adb('shell', 'am', 'force-stop', PACKAGE);
  adb('shell', `run-as ${PACKAGE} rm -f shared_prefs/server.xml`);
  // The next test needs the app connected, also when this one fails before connecting (as tools/e2e/android.sh connects it).
  const reconnect = () => {
    if (adb('shell', `run-as ${PACKAGE} ls shared_prefs`).includes('server.xml')) return;
    adb('shell', 'am', 'force-stop', PACKAGE);
    const xml = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name="origin">${base}</string></map>`;
    adb('shell', `echo ${Buffer.from(xml).toString('base64')} | base64 -d > /data/local/tmp/unihub-server.xml`);
    adb('shell', `run-as ${PACKAGE} cp /data/local/tmp/unihub-server.xml shared_prefs/server.xml`);
  };
  const expected = mail('Connected');
  openLink('VIEW', expected.link);
  let input;
  for (let attempt = 0; attempt < 60 && !input; attempt++) {
    await sleep(1000);
    input = screenNodes().find(node => node.id.endsWith(':id/server_input'));
  }
  assert.ok(input, 'the connect screen asks for the server');
  adb('shell', 'input', 'tap', `${input.x}`, `${input.y}`);
  adb('shell', 'input', 'text', base);
  try {
    await tapNative(/^Connect$/i);
    // Signs in on the page the app shows now, without starting the app again.
    const { device } = await openApp({ restart: false });
    try {
      await composerShows(device, expected);
    } finally {
      await device.close();
    }
  } finally {
    reconnect();
  }
});

test('a link while the app is locked opens the composer behind the lock, shown once unlocked', { timeout: 900_000 }, async () => {
  setDevicePin();
  await enrollFingerprint();
  const { device, page } = await openApp();
  try {
    // Settings → App lock → Whole app, every time UniHub opens (app-lock.test.mjs has the screens).
    await page.goto(new URL('/settings?section=app-lock', page.url()).href);
    const whole = page.getByRole('radio', { name: 'Whole app' });
    await whole.waitFor({ state: 'attached' });
    if (!await whole.isChecked()) {
      const row = page.getByRole('radiogroup', { name: 'Lock' }).getByText('Whole app', { exact: true });
      await row.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await touch(page, row);
      await waitForUnlockPrompt();
      await touchFinger(1);
      for (let i = 0; i < 30 && !await whole.isChecked(); i++) await sleep(1000);
    }
    await page.getByLabel('Ask again').selectOption({ label: 'Every time UniHub opens' }, { timeout: 5000 }).catch(async () => {
      await touch(page, page.getByRole('combobox', { name: 'Ask again' }));
      await touch(page, page.getByRole('option', { name: 'Every time UniHub opens' }));
    });

    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(2000);
    const expected = mail('Locked');
    openLink('SENDTO', expected.link);
    let locked = false;
    for (let attempt = 0; attempt < 30 && !locked; attempt++) {
      await sleep(2000);
      const current = await (await device.webView({ pkg: PACKAGE })).page();
      locked = await current.getByText('UniHub is locked', { exact: true }).isVisible().catch(() => false) &&
        await current.getByLabel('Subject').count() === 0;
    }
    assert.ok(locked, 'the lock screen shows first, nothing of the message behind it');
    await waitForUnlockPrompt();
    await touchFinger(1);
    await composerShows(device, expected);
  } finally {
    await device.close();
  }
});
