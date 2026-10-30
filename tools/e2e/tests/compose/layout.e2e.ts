import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Screen } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { setSettings, storedDrafts } from '../support/api.ts';
import { receive } from '../support/mail.ts';
import { chooseSender, composeDialog, messageBody, onlyOn, openCompose, openFolder, recipientChips, senderLine, showSenderRows, typeAtStart } from '../support/ui.ts';

type Box = { x: number; y: number; width: number; height: number };
const middle = (box: Box) => box.y + box.height / 2;

async function labelBeside(screen: Screen, label: string, field: string) {
  const dialog = composeDialog(screen);
  const labelBox = (await dialog.getByText(label, { exact: true }).first().boundingBox())!;
  const fieldBox = (await dialog.getByLabel(field, { exact: true }).first().boundingBox())!;
  expect(Math.abs(middle(labelBox) - middle(fieldBox)), `${label} label on the field's row`).toBeLessThan(8);
  expect(labelBox.x + labelBox.width, `${label} label left of the field`).toBeLessThanOrEqual(fieldBox.x + 1);
}

type Eval = { evaluate: <R, A = undefined>(fn: (arg: A) => R, arg?: A) => Promise<R> };

/** The part of the message editor on screen, clipped by every scrolling box around it and by the bar below it. */
async function visibleEditorHeight(browser: unknown) {
  return (browser as Eval).evaluate(() => {
    const element = document.getElementById('compose-body')!;
    let { top, bottom } = element.getBoundingClientRect();
    for (let box = element.parentElement; box; box = box.parentElement) {
      if (getComputedStyle(box).overflowY === 'visible') continue;
      const rect = box.getBoundingClientRect();
      top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
    }
    return Math.min(bottom, window.innerHeight) - top;
  });
}

// 24-25 (B-17) and 24-19 (P-26), reworked in 0.25.0: on a phone the composer fills the
// screen from the top; To and Subject each sit on one row with the label beside the
// field; Cc, Bcc and From are folded into one line "Cc/Bcc, From: <account>" that opens
// into three rows; with the optional features on (templates, Send later) the message
// still has most of the screen, and the formatting toolbar is pinned above the buttons.
test('[24-25 24-19 25-01] the phone composer: one row per field, a folded Cc/Bcc/From line and the body room', { session: 'admin', tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'phone', 'android-app');
  await app.open('/mail');
  await setSettings(browser, { compose_templates: true, compose_scheduled_send: true });
  try {
    await app.open('/mail');
    // Not openCompose: that opens the folded line to pick the sender.
    await screen.getByRole('button', 'Compose', { visible: true }).first().tap();
    await expect(screen.getByRole('textbox', 'Subject')).toBeVisible();
    // Measure the settled dialog: it opens with a short zoom and slide.
    await browser.evaluate(() => Promise.all([...document.querySelectorAll('[role="dialog"]')]
      .flatMap(element => element.getAnimations({ subtree: true }))
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => undefined))).then(() => true));
    const viewport = await browser.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const dialog = (await composeDialog(screen).boundingBox())!;
    expect(dialog.y, 'from the top').toBeLessThanOrEqual(1);
    expect(dialog.x).toBeLessThanOrEqual(1);
    expect(dialog.width).toBeGreaterThanOrEqual(viewport.width - 1);
    expect(dialog.height).toBeGreaterThanOrEqual(viewport.height - 1);
    await labelBeside(screen, 'To', 'To');
    await labelBeside(screen, 'Subject', 'Subject');
    // The folded line names the sending account (the default one, P-17); Cc, Bcc and From are not rows yet.
    await expect(senderLine(screen)).toHaveText(/^Cc\/Bcc, From: ?\S+@\S+$/);
    await expect(screen.getByLabel('Cc', { exact: true })).toHaveCount(0);
    await expect(screen.getByRole('combobox', 'From')).toHaveCount(0);
    const body = (await messageBody(screen).boundingBox())!;
    expect(await visibleEditorHeight(browser), 'the message body has at least half the screen').toBeGreaterThanOrEqual(viewport.height / 2);
    // The toolbar is one row pinned between the message and the buttons, the buttons on screen.
    const bold = (await screen.getByRole('button', 'Bold', { visible: true }).boundingBox())!;
    const send = (await screen.getByRole('button', 'Send', { visible: true }).boundingBox())!;
    const clip = (await screen.getByRole('button', 'Attach files', { visible: true }).boundingBox())!;
    expect(send.y + send.height, 'Send on screen').toBeLessThanOrEqual(viewport.height);
    expect(Math.abs(middle(bold) - middle(clip)), 'attach button in the toolbar row').toBeLessThan(8);
    expect(bold.y, 'toolbar below the message').toBeGreaterThan(body.y + viewport.height / 2);
    expect(send.y - (bold.y + bold.height), 'toolbar directly above the buttons').toBeLessThan(24);

    await senderLine(screen).tap();
    await expect(screen.getByLabel('Cc', { exact: true })).toBeFocused();
    await labelBeside(screen, 'Cc', 'Cc');
    await labelBeside(screen, 'Bcc', 'Bcc');
    await labelBeside(screen, 'From', 'From');
    await expect(senderLine(screen)).toHaveCount(0);
    // The From row is the usual account control (P-17).
    await chooseSender(screen, people.admin.mailbox);
  } finally {
    await setSettings(browser, { compose_templates: false, compose_scheduled_send: false });
  }
});

// 25-01: on a phone a typed address becomes a chip on a comma, on Enter and on leaving
// the field; a chip is removed from its menu; the draft keeps the chips and shows them
// again when reopened; the message reaches every chip.
test('[25-01] recipients become chips that the draft keeps and the message reaches', { session: 'admin', timeout: 180_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'phone', 'android-app');
  const subject = `Chips ${runId()}`;
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  const to = screen.getByLabel('To', { exact: true });
  await to.pressSequentially(`${outside.sam},`);
  expect(await recipientChips(screen, 'To')).toEqual([outside.sam]);
  await expect(to).toHaveValue('');
  await to.pressSequentially('Carol Example <carol@example.org>');
  await to.press('Enter');
  await to.pressSequentially('dropped@example.net');
  await screen.getByLabel('Subject', { exact: true }).tap();
  expect(await recipientChips(screen, 'To')).toEqual([outside.sam, 'Carol Example <carol@example.org>', 'dropped@example.net']);
  await expect(composeDialog(screen), 'still the composer, not sent by Enter').toBeVisible();
  await screen.getByRole('list', 'To recipients').getByRole('button', 'dropped@example.net').tap();
  await screen.getByRole('menuitem', 'Remove recipient').tap();
  expect(await recipientChips(screen, 'To')).toEqual([outside.sam, 'Carol Example <carol@example.org>']);
  await expect(screen.getByRole('list', 'To recipients').getByRole('button', 'Carol Example <carol@example.org>')).toHaveText('Carol Example');

  await screen.getByLabel('Subject', { exact: true }).fill(subject);
  await typeAtStart(screen, 'To two chips.');
  await screen.getByRole('button', 'Save draft', { visible: true }).tap();
  await expect.poll(async () => (await storedDrafts(browser, subject)).length, { timeout: 30_000 }).toBe(1);
  await screen.getByRole('button', 'Close', { visible: true }).first().tap();
  const prompt = screen.getByRole('alertdialog');
  if (await prompt.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await prompt.getByRole('button', 'Save draft').tap();
  await expect(composeDialog(screen)).toBeHidden({ timeout: 30_000 });

  await openFolder(app, screen, browser, 'Drafts');
  await screen.getByText(subject).first().tap();
  await expect(composeDialog(screen)).toBeVisible();
  expect(await recipientChips(screen, 'To')).toEqual([outside.sam, 'Carol Example <carol@example.org>']);
  await screen.getByRole('button', 'Send', { visible: true }).tap();
  await expect(composeDialog(screen)).toBeHidden({ timeout: 30_000 });
  const atSam = await receive(outside.sam, subject);
  expect(atSam.to).toEqual([outside.sam, outside.carol]);
  await receive(outside.carol, subject, 15_000);
});

// 25-02: keyboard handling on the web. The browser is asked to shrink the page above the
// keyboard (interactive-widget=resizes-content); where it shrinks only the visual
// viewport, the composer follows that height (lib/visible-area.ts). Simulated here by
// a 600 px visual viewport in a 915 px window: the composer is 600 px tall, the toolbar
// and Send are inside it, and after tapping into the message at least 240 px of it show
// with the header rows scrolled away.
test('[25-02] the composer sizes itself to the visible area above the keyboard', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'phone', 'android-app');
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  await screen.getByLabel('To', { exact: true }).fill(outside.sam);
  await browser.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, 'height', { value: 600, configurable: true });
    Object.defineProperty(viewport, 'offsetTop', { value: 0, configurable: true });
    viewport.dispatchEvent(new Event('resize'));
  });
  try {
    await expect.poll(async () => (await composeDialog(screen).boundingBox())!.height).toBe(600);
    await messageBody(screen).tap();
    await messageBody(screen).pressSequentially('Hello');
    await expect.poll(() => visibleEditorHeight(browser), { timeout: 5000 }).toBeGreaterThanOrEqual(240);
    const to = (await screen.getByLabel('To', { exact: true }).boundingBox())!;
    const editor = (await messageBody(screen).boundingBox())!;
    expect(to.y + to.height, 'the header rows scrolled away above the message').toBeLessThanOrEqual(editor.y + 1);
    for (const name of ['Bold', 'Attach files', 'Send']) {
      const box = (await screen.getByRole('button', name, { visible: true }).boundingBox())!;
      expect(box.y + box.height, `${name} inside the visible area`).toBeLessThanOrEqual(600);
    }
    // With the keyboard gone the composer is the whole screen again.
    await browser.evaluate(() => {
      const viewport = window.visualViewport!;
      delete (viewport as unknown as Record<string, unknown>).height;
      delete (viewport as unknown as Record<string, unknown>).offsetTop;
      viewport.dispatchEvent(new Event('resize'));
    });
    await expect.poll(async () => (await composeDialog(screen).boundingBox())!.height).toBe(915);
  } finally {
    await browser.evaluate(() => {
      const viewport = window.visualViewport!;
      delete (viewport as unknown as Record<string, unknown>).height;
      delete (viewport as unknown as Record<string, unknown>).offsetTop;
      viewport.dispatchEvent(new Event('resize'));
    });
  }
});

// The wide composer is unchanged by the phone rework: labels above their fields, Cc and
// Bcc as quiet buttons at the right end of To, no chips and no folded sender line.
test('[25-01] the wide composer keeps its layout', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  await expect(senderLine(screen)).toHaveCount(0);
  await expect(screen.getByRole('combobox', 'From')).toBeVisible();
  await expect(screen.getByRole('button', 'Cc', { visible: true })).toBeVisible();
  await expect(screen.getByRole('button', 'Bcc', { visible: true })).toBeVisible();
  const to = screen.getByLabel('To', { exact: true });
  await to.fill(`${outside.sam}, ${outside.carol}`);
  await expect(to).toHaveValue(`${outside.sam}, ${outside.carol}`);
  expect(await recipientChips(screen, 'To')).toEqual([]);
  const label = (await composeDialog(screen).getByText('To', { exact: true }).first().boundingBox())!;
  const field = (await to.boundingBox())!;
  expect(label.y + label.height, 'label above the field').toBeLessThanOrEqual(field.y + 1);
  await showSenderRows(screen);
});
