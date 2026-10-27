// B-20 (0.24.2): files picked in Android's own document picker reach the phone
// composer. The composer's file input allows several files, so the picker
// answers through its selection mode (ClipData), which the shell must read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deviceScreenshot, navigate, openApp, pickFromDownloads, pushToDownloads } from '../support/android.mjs';

const fixture = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const evidence = process.env.UNIHUB_E2E_EVIDENCE ?? `${process.env.TMPDIR ?? '/tmp'}`;

test('a PDF and a photo picked in Android\'s picker show as squares in the phone composer', { timeout: 900_000 }, async () => {
  pushToDownloads(fixture('synthetic-report.pdf'), fixture('synthetic-photo.jpg'));
  const { device, page } = await openApp();
  try {
    await navigate(page, '/mail');
    await page.getByRole('button', { name: 'Compose' }).filter({ visible: true }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('button', { name: 'Attach files' }).click();
    await pickFromDownloads(['synthetic-report.pdf', 'synthetic-photo.jpg']);

    const chips = page.getByRole('list', { name: 'Attachments' }).getByRole('button');
    await chips.first().waitFor({ timeout: 60_000 }).catch(() => {});
    deviceScreenshot(`${evidence}/android-compose-attachments.png`);
    assert.deepEqual((await chips.allTextContents()).map(text => text.trim()).sort(), ['.jpg', '.pdf']);
  } finally {
    await device.close();
  }
});
