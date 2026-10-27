import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Screen } from 'e2e';
import { people } from '../support/env.ts';
import { setSettings } from '../support/api.ts';
import { composeDialog, messageBody, onlyOn, openCompose } from '../support/ui.ts';

type Box = { x: number; y: number; width: number; height: number };
const middle = (box: Box) => box.y + box.height / 2;

async function labelBeside(screen: Screen, label: string, field: string) {
  const dialog = composeDialog(screen);
  const labelBox = (await dialog.getByText(label, { exact: true }).first().boundingBox())!;
  const fieldBox = (await dialog.getByLabel(field, { exact: true }).first().boundingBox())!;
  expect(Math.abs(middle(labelBox) - middle(fieldBox)), `${label} label on the field's row`).toBeLessThan(8);
  expect(labelBox.x + labelBox.width, `${label} label left of the field`).toBeLessThanOrEqual(fieldBox.x + 1);
}

// 24-25 (B-17) and 24-19 (P-26): on a phone the new-message composer fills the screen from
// the top; From, To and Subject each sit on one row with the label beside the field; with
// the optional features on (templates, Send later) the message body still has most of the
// screen. Keyboard insets need a device (tools/e2e/android).
test('[24-25 24-19] the phone composer fills the screen, one row per field, and leaves the body room', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'phone', 'android-app');
  await app.open('/mail');
  await setSettings(browser, { compose_templates: true, compose_scheduled_send: true });
  try {
    await app.open('/mail');
    await openCompose(screen, people.admin.mailbox);
    const viewport = await browser.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const dialog = (await composeDialog(screen).boundingBox())!;
    expect(dialog.y, 'from the top').toBeLessThanOrEqual(1);
    expect(dialog.x).toBeLessThanOrEqual(1);
    expect(dialog.width).toBeGreaterThanOrEqual(viewport.width - 1);
    expect(dialog.height).toBeGreaterThanOrEqual(viewport.height - 1);
    await labelBeside(screen, 'To', 'To');
    await labelBeside(screen, 'Subject', 'Subject');
    const body = (await messageBody(screen).boundingBox())!;
    expect(body.height, 'the message body has at least half the screen').toBeGreaterThanOrEqual(viewport.height / 2);
    const send = (await screen.getByRole('button', 'Send', { visible: true }).boundingBox())!;
    expect(send.y + send.height, 'Send on screen').toBeLessThanOrEqual(viewport.height);
  } finally {
    await setSettings(browser, { compose_templates: false, compose_scheduled_send: false });
  }
});
