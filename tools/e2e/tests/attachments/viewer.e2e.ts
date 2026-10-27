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
