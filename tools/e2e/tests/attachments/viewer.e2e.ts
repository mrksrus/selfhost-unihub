import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixtures, fixturePath, outside, people, runId } from '../support/env.ts';
import { sendMail } from '../support/mail.ts';
import { onlyOn, openMessage } from '../support/ui.ts';

const mailbox = people.admin.mailbox;

async function mailWithAttachments(subject: string) {
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'Two files attached.', attachments: [
    { filename: fixtures.pdf.name, path: fixturePath(fixtures.pdf.path), contentType: 'application/pdf' },
    { filename: fixtures.jpg.name, path: fixturePath(fixtures.jpg.path), contentType: 'image/jpeg' },
  ] });
}

// 0-17 / 23-16 / 25-06 (B-19): a mailed one-page PDF opens in the attachment viewer and
// shows its text. On 0.24.2 nginx serves the pdf.js worker (.mjs) as
// application/octet-stream with nosniff, so every browser refuses it.
test('[0-17 23-16 B-19] a mailed PDF opens in the viewer and shows its text', { session: 'admin', tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `PDF ${runId()}`;
  await mailWithAttachments(subject);
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  const worker = browser.waitForResponse(/pdf\.worker[^/]*\.mjs/, { timeout: 30_000 });
  await screen.getByRole('region', 'Attachments').getByRole('button', new RegExp(`^${fixtures.pdf.name.replace('.', '\\.')}`)).tap();
  const viewer = screen.getByRole('dialog', fixtures.pdf.name);
  await expect(viewer).toBeVisible();
  expect.soft((await worker).headers['content-type'], 'the pdf.js worker is served as JavaScript').toMatch(/javascript/);
  await expect(viewer.getByText('Could not show this PDF')).toHaveCount(0);
  await expect(viewer.getByText(fixtures.pdf.text)).toBeVisible({ timeout: 30_000 });
});

// 23-06 / 0-03: a mailed photo opens in the viewer as the image itself.
test('[0-03] a mailed photo opens in the viewer', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Photo ${runId()}`;
  await mailWithAttachments(subject);
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('region', 'Attachments').getByRole('button', new RegExp(`^${fixtures.jpg.name.replace('.', '\\.')}`)).tap();
  const viewer = screen.getByRole('dialog', fixtures.jpg.name);
  await expect(viewer.getByRole('image', fixtures.jpg.name)).toBeVisible();
  await expect(viewer.getByText('Could not show this image')).toHaveCount(0);
  // The picture decoded (a broken image would still show its alt text).
  await expect.poll(() => browser.evaluate((name: string) => (document.querySelector(`[role=dialog] img[alt="${name}"]`) as HTMLImageElement | null)?.naturalWidth ?? 0, fixtures.jpg.name))
    .toBeGreaterThan(0);
});

// 25-07 (0.25.0): Open with, Save and Share are the Android app's (with a native
// bridge); in a browser, and in app mode without the bridge, the viewer still
// downloads the file itself, whole, under its name.
test('[25-07] the viewer still downloads the file in a browser and without the app\'s bridge', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Download ${runId()}`;
  await mailWithAttachments(subject);
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('region', 'Attachments').getByRole('button', new RegExp(`^${fixtures.jpg.name.replace('.', '\\.')}`)).tap();
  const viewer = screen.getByRole('dialog', fixtures.jpg.name);
  await expect(viewer.getByRole('image', fixtures.jpg.name)).toBeVisible();
  await expect(viewer.getByRole('button', 'Share')).toHaveCount(0);
  // The page saves through a download link to the loaded file; record what it hands the browser.
  await browser.evaluate(() => {
    const record = window as unknown as { blobs: Map<string, number>; saved?: { name: string; size: number } };
    record.blobs = new Map();
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object);
      if (object instanceof Blob) record.blobs.set(url, object.size);
      return url;
    };
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      record.saved = { name: this.download, size: record.blobs.get(this.href) ?? -1 };
    };
  });
  await viewer.getByRole('button', 'Download', { exact: true }).tap();
  await expect.poll(() => browser.evaluate(() => (window as unknown as { saved?: unknown }).saved ?? null)).not.toBeNull();
  const saved = await browser.evaluate(() => (window as unknown as { saved?: { name: string; size: number } }).saved ?? null);
  expect(saved).toEqual({ name: fixtures.jpg.name, size: fixtures.jpg.size });
});
