import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixtures, outside, people, runId } from '../support/env.ts';
import { storedDrafts } from '../support/api.ts';
import { attachedFile, attachFiles, composeDialog, messageBody, onlyOn, openCompose, openFolder, removeAttachment, typeAtStart } from '../support/ui.ts';

const PDF = `${fixtures.pdf.name}:${fixtures.pdf.size}`;
const JPG = `${fixtures.jpg.name}:${fixtures.jpg.size}`;

async function reopenDraft(app: { open: (p?: string) => Promise<unknown> }, screen: Parameters<typeof openCompose>[0], browser: unknown, subject: string) {
  await openFolder(app, screen, browser, 'Drafts');
  await screen.getByText(subject).first().tap();
  await expect(composeDialog(screen)).toBeVisible();
}

// 23-28 (B-12) and 23-05: a draft with two files; the PDF is removed while "Saving
// draft..." shows (the save is held 6 s). After closing and reopening the draft from
// Drafts, its body is there and the PDF stays removed.
test('[23-28 23-05 B-12] a file removed while the draft saves stays removed after reopening', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Draft removal ${runId()}`;
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  await screen.getByLabel('To').fill(outside.sam);
  await screen.getByLabel('Subject').fill(subject);
  await typeAtStart(screen, `Draft body ${subject}.`);
  await attachFiles(browser, [fixtures.pdf.path, fixtures.jpg.path]);
  await screen.getByRole('button', 'Save draft', { visible: true }).tap();
  await expect.poll(async () => (await storedDrafts(browser, subject))[0]?.attachments, { timeout: 30_000 }).toEqual([JPG, PDF]);

  let held = 0;
  await browser.route(/\/api\/mail\/drafts\/[^/]+$/, async (route) => {
    if (route.request.method === 'PUT' && held++ === 0) await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.fallback();
  });
  await screen.getByRole('button', 'Save draft', { visible: true }).tap();
  await expect(screen.getByText('Saving draft...').first()).toBeVisible();
  await removeAttachment(screen, browser, fixtures.pdf.name);
  await expect(screen.getByText('Saving draft...').first()).toBeHidden({ timeout: 30_000 });
  await screen.getByRole('button', 'Close', { visible: true }).first().tap();
  // Closing with an unsaved change asks first; keep the change.
  const prompt = screen.getByRole('alertdialog');
  if (await prompt.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) {
    await prompt.getByRole('button', 'Save draft').tap();
  }
  await expect(composeDialog(screen)).toBeHidden({ timeout: 30_000 });

  await reopenDraft(app, screen, browser, subject);
  await expect(messageBody(screen)).toContainText(`Draft body ${subject}.`);
  await expect(attachedFile(screen, fixtures.jpg.name)).toBeVisible();
  await expect(attachedFile(screen, fixtures.pdf.name)).toHaveCount(0);
  const stored = await storedDrafts(browser, subject);
  expect(stored).toHaveLength(1);
  expect(stored[0].attachments).toEqual([JPG]);
});

// 23-28: one file added, the draft saved twice in a row and once more after reopening,
// holds the file once.
test('[23-28] one file saved twice is in the draft once', { session: 'admin', timeout: 180_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Draft twice ${runId()}`;
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  await screen.getByLabel('To').fill(outside.sam);
  await screen.getByLabel('Subject').fill(subject);
  await attachFiles(browser, [fixtures.pdf.path]);
  const save = screen.getByRole('button', 'Save draft', { visible: true });
  await save.tap();
  await save.tap();
  await expect.poll(async () => (await storedDrafts(browser, subject))[0]?.attachments, { timeout: 30_000 }).toEqual([PDF]);
  await expect(save).toBeEnabled();
  await save.tap();
  await expect(save).toBeEnabled();
  await reopenDraft(app, screen, browser, subject);
  await screen.getByRole('button', 'Save draft', { visible: true }).tap();
  await expect(screen.getByRole('button', 'Save draft', { visible: true })).toBeEnabled();
  const stored = await storedDrafts(browser, subject);
  expect(stored).toHaveLength(1);
  expect(stored[0].attachments).toEqual([PDF]);
});
