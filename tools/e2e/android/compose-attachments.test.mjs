// B-20 (0.24.2): files picked in Android's own document picker reach the phone
// composer. The composer's file input allows several files, so the picker
// answers through its selection mode (ClipData), which the shell must read.
// 0.25.0: on Android 16 (WebView 133) the apps up to 0.24.3 handed the page
// 0-byte files; the sent message must carry the picked files' exact bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deviceScreenshot, navigate, openApp, pickFromDownloads, pushToDownloads, sleep } from '../support/android.mjs';

const fixture = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const evidence = process.env.UNIHUB_E2E_EVIDENCE ?? `${process.env.TMPDIR ?? '/tmp'}`;
const greenmail = `http://127.0.0.1:${8184 + Number(process.env.UNIHUB_E2E_INSTANCE ?? '1')}`;

/** The raw message delivered to `mailbox` with this subject, once it arrives. */
async function delivered(mailbox, subject) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await fetch(`${greenmail}/api/user/${encodeURIComponent(mailbox)}/messages`);
    if (response.ok) {
      const found = (await response.json()).find(message => message.subject === subject);
      if (found) return found.mimeMessage;
    }
    await sleep(2000);
  }
  throw new Error(`no message "${subject}" for ${mailbox}`);
}

test('a PDF and a photo picked in Android\'s picker are sent from the phone composer with their bytes', { timeout: 900_000 }, async () => {
  const files = ['synthetic-report.pdf', 'synthetic-photo.jpg'];
  await pushToDownloads(...files.map(fixture));
  const { device, page } = await openApp();
  try {
    const subject = `Picked files ${Date.now().toString(36)}`;
    await navigate(page, '/mail');
    await page.getByRole('button', { name: 'Compose' }).filter({ visible: true }).first().click();
    await page.getByRole('dialog').waitFor();
    // The seeded GreenMail account; the dev seed's other accounts have no reachable server.
    // On a phone the account is on the folded "Cc/Bcc, From" line until it is opened (0.25.0).
    const line = page.getByRole('button', { name: /^Cc\/Bcc, From:/ }).filter({ visible: true }).first();
    const folded = await line.count() > 0;
    if (!folded || !(await line.textContent())?.includes('admin@mail.test')) {
      if (folded) await line.click();
      const from = page.getByRole('combobox', { name: 'From' }).filter({ visible: true }).first();
      if (!(await from.textContent())?.includes('admin@mail.test')) {
        // A synthetic click does not open the picker in the WebView (a finger does); the keyboard does.
        await from.focus();
        await page.keyboard.press('Enter');
        await page.getByRole('option', { name: /admin@mail\.test/ }).first().click();
        await page.waitForFunction(() => document.querySelector('[role="combobox"][aria-expanded="false"]'));
      }
      assert.match(await from.textContent() ?? '', /admin@mail\.test/);
    }
    await page.locator('input').and(page.getByLabel('To')).filter({ visible: true }).first().fill('sam@example.org');
    await page.locator('input').and(page.getByLabel('Subject')).filter({ visible: true }).first().fill(subject);
    await page.getByRole('button', { name: 'Attach files' }).click();
    await pickFromDownloads(files);

    const chips = page.getByRole('list', { name: 'Attachments' }).getByRole('button');
    await chips.nth(1).waitFor({ timeout: 60_000 }).catch(() => {});
    deviceScreenshot(`${evidence}/android-compose-attachments.png`);
    assert.deepEqual((await chips.allTextContents()).map(text => text.trim()).sort(), ['.jpg', '.pdf']);

    await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).first().click();
    const raw = (await delivered('sam@example.org', subject)).replace(/\r?\n/g, '');
    for (const name of files) {
      assert.ok(raw.includes(readFileSync(fixture(name)).toString('base64')), `${name} arrives with its bytes`);
    }
  } finally {
    await device.close();
  }
});
