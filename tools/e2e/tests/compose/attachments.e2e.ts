import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixtures, outside, people, runId } from '../support/env.ts';
import { receive } from '../support/mail.ts';
import { storedDrafts } from '../support/api.ts';
import { attachFiles, composeDialog, onlyOn, openCompose, typeAtStart } from '../support/ui.ts';

const square = (name: string) => new RegExp(`^${name.replace('.', '\\.')}, `);

// 24-26 / 23-22 (B-18, B-20) on phone widths: a PDF and a JPEG attached in a new message
// show as two squares ".pdf" and ".jpg" in the paperclip's row, inside the screen; each
// turns to "Saved with the draft"; tapping one shows its name, size and Remove. The
// draft holds both once. (The Android shell's own file picker needs a device.)
test('[24-26 23-22] attached files show as squares in the toolbar row and stay with the draft', { session: 'admin', tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'phone', 'android-app');
  const subject = `Attachments ${runId()}`;
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  await screen.getByLabel('To').fill(outside.sam);
  await screen.getByLabel('Subject').fill(subject);
  const clip = screen.getByRole('button', 'Attach files');
  await expect(clip).toBeVisible();
  await attachFiles(browser, [fixtures.pdf.path, fixtures.jpg.path]);

  const strip = screen.getByRole('list', 'Attachments');
  await expect(strip.getByRole('button')).toHaveCount(2);
  await expect(strip.getByRole('button', square(fixtures.pdf.name))).toHaveText('.pdf');
  await expect(strip.getByRole('button', square(fixtures.jpg.name))).toHaveText('.jpg');
  const clipBox = (await clip.boundingBox())!;
  const width = await browser.evaluate(() => window.innerWidth);
  for (const name of [fixtures.pdf.name, fixtures.jpg.name]) {
    const box = (await strip.getByRole('button', square(name)).boundingBox())!;
    expect(Math.abs(box.y + box.height / 2 - (clipBox.y + clipBox.height / 2)), `${name} in the paperclip's row`).toBeLessThan(8);
    expect(box.x + box.width, `${name} inside the screen`).toBeLessThanOrEqual(width);
  }

  await screen.getByRole('button', 'Save draft', { visible: true }).tap();
  for (const name of [fixtures.pdf.name, fixtures.jpg.name]) {
    await expect(strip.getByRole('button', new RegExp(`^${name.replace('.', '\\.')}, .*Saved with the draft$`))).toBeVisible({ timeout: 30_000 });
  }
  await strip.getByRole('button', square(fixtures.pdf.name)).tap();
  await expect(screen.getByRole('menu')).toContainText(fixtures.pdf.name);
  await expect(screen.getByRole('menu')).toContainText(`${fixtures.pdf.size} B`);
  await expect(screen.getByRole('menuitem', 'Remove attachment')).toBeVisible();
  await screen.getByRole('menuitem', 'Remove attachment').press('Escape');

  const drafts = await storedDrafts(browser, subject);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].attachments).toEqual([`${fixtures.jpg.name}:${fixtures.jpg.size}`, `${fixtures.pdf.name}:${fixtures.pdf.size}`]);
});

// On the phone the system file picker covers the WebView: the page goes hidden and
// comes back before the files arrive. Files that arrive in that order still show.
test('[24-26 B-20] files chosen while the page was hidden still show as squares', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'android-app');
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  await screen.getByLabel('Subject').fill(`Picker ${runId()}`);
  for (const state of ['hidden', 'visible']) {
    await browser.evaluate((s: string) => {
      Object.defineProperty(document, 'visibilityState', { value: s, configurable: true });
      Object.defineProperty(document, 'hidden', { value: s === 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(s === 'hidden' ? 'blur' : 'focus'));
    }, state);
  }
  await attachFiles(browser, [fixtures.pdf.path, fixtures.jpg.path]);
  await expect(screen.getByRole('list', 'Attachments').getByRole('button')).toHaveCount(2);
});

// 25-09 / 23-22 (B-20) on desktop: the attached files are listed in view in the compose
// dialog, not cut off below its visible part; the message is sent with both.
test('[23-22 B-20] desktop: attached files are listed in view and sent with the message', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const subject = `Desktop attachments ${runId()}`;
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  await screen.getByLabel('To').fill(outside.sam);
  await screen.getByLabel('Subject').fill(subject);
  await typeAtStart(screen, 'Two files attached.');
  await attachFiles(browser, [fixtures.pdf.path, fixtures.jpg.path]);
  const dialog = composeDialog(screen);
  const dialogBox = (await dialog.boundingBox())!;
  const viewportHeight = await browser.evaluate(() => window.innerHeight);
  for (const name of [fixtures.pdf.name, fixtures.jpg.name]) {
    const row = dialog.getByText(name, { exact: true });
    await expect(row).toBeVisible();
    const box = (await row.boundingBox())!;
    expect.soft(box.y + box.height, `${name} within the dialog's visible part`).toBeLessThanOrEqual(Math.min(dialogBox.y + dialogBox.height, viewportHeight));
  }
  await screen.getByRole('button', 'Send', { visible: true }).tap();
  const message = await receive(outside.sam, subject);
  expect(message.attachments.map((a) => `${a.filename}:${a.size}`).sort())
    .toEqual([`${fixtures.jpg.name}:${fixtures.jpg.size}`, `${fixtures.pdf.name}:${fixtures.pdf.size}`]);
});
