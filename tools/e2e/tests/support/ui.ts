import { test } from '@e2e-dev/web';
import type { Screen } from 'e2e';
import { expect } from 'e2e';

// Steps many tests share, written the way a person does them. Each takes the
// test's own fixtures.
type App = { open: (path?: string) => Promise<unknown> };
type Page = { evaluate: <R>(fn: () => R | Promise<R>) => Promise<R> };

/** Narrow layout (phone and app targets): the panel is a sheet and attachments are toolbar squares. */
export async function isNarrow(browser: unknown) {
  return (browser as Page).evaluate(() => window.innerWidth < 768);
}

/** The compose dialog, whatever its title (New message, Reply, Edit draft). */
export const composeDialog = (screen: Screen) => screen.getByRole('dialog').filter({ has: screen.getByRole('textbox', 'Subject') });

/** The phone composer's collapsed "Cc/Bcc, From: <account>" line (0.25.0); absent on wide windows and once opened. */
export const senderLine = (screen: Screen) => screen.getByRole('button', /^Cc\/Bcc, From:/);

/** Opens the Cc, Bcc and From rows of the phone composer when they are still folded into one line. */
export async function showSenderRows(screen: Screen) {
  const line = senderLine(screen);
  if (await line.count()) await line.tap();
  await expect(screen.getByRole('combobox', 'From')).toBeVisible();
}

/** The composer's message body (rich editor or plain textarea). */
export const messageBody = (screen: Screen) => screen.getByRole('textbox', 'Message', { visible: true });

/** Opens a new message on the mail page and picks the sender account. */
export async function openCompose(screen: Screen, from: string) {
  await screen.getByRole('button', 'Compose', { visible: true }).first().tap();
  await expect(screen.getByRole('textbox', 'Subject')).toBeVisible();
  await chooseSender(screen, from);
}

export async function chooseSender(screen: Screen, from: string) {
  // On a phone the account is on the folded "Cc/Bcc, From" line until it is opened.
  const line = senderLine(screen);
  if (await line.count()) {
    if ((await line.textContent())?.includes(from)) return;
    await line.tap();
  }
  const sender = screen.getByRole('combobox', 'From');
  if ((await sender.textContent())?.includes(from)) return;
  await sender.tap();
  await screen.getByRole('option', new RegExp(escape(from))).tap();
  await expect(sender).toContainText(from);
}

/** Puts text at the start of the message body, above a signature or a quote. */
export async function typeAtStart(screen: Screen, text: string) {
  const body = messageBody(screen);
  await body.tap();
  await body.press('Control+Home');
  await body.pressSequentially(text);
}

/** Fetches new mail for one account now, through the Sync details panel. */
export async function syncNow(screen: Screen, address: string) {
  const details = screen.getByRole('button', 'Sync details', { visible: true }).first();
  await details.tap();
  await screen.getByRole('button', `Sync ${address} now`, { visible: true }).tap();
  // A bottom sheet with a Close button on touch screens; a popover on desktop that the
  // Sync details button toggles.
  const panel = screen.getByRole('dialog', 'Mail sync');
  const close = panel.getByRole('button', 'Close', { visible: true });
  if (await close.count()) await close.tap();
  else await details.tap();
  await expect(panel).toBeHidden();
}

/**
 * Waits until a message is listed, syncing its account meanwhile (new mail
 * reaches UniHub through the provider, not instantly). Returns its row.
 */
export async function waitForRow(screen: Screen, subject: string, account: string, timeout = 90_000) {
  const row = screen.getByText(subject, { exact: true, visible: true }).first();
  const end = Date.now() + timeout;
  while (!(await row.isVisible()) && Date.now() < end) {
    await syncNow(screen, account);
    await expect(row).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
  }
  await expect(row).toBeVisible();
  return row;
}

/** Opens a message from the mail list once it has arrived. */
export async function openMessage(screen: Screen, subject: string, account: string, timeout = 90_000) {
  await (await waitForRow(screen, subject, account, timeout)).tap();
}

/** Opens a folder of the mail page: the folder list on wide screens, the panel sheet on narrow ones. */
export async function openFolder(app: App, screen: Screen, browser: unknown, name: string) {
  await app.open('/mail');
  if (await isNarrow(browser)) await screen.getByRole('button', 'All accounts', { visible: true }).first().tap();
  await screen.getByRole('navigation', 'Mail folders').getByRole('button', new RegExp(`^${escape(name)}`), { visible: true }).first().tap();
}

/** Attaches files through the composer's hidden file input (the paperclip or drop zone opens it). */
export async function attachFiles(browser: unknown, paths: string[]) {
  await (browser as { locator: (css: string) => { setInputFiles: (p: string[]) => Promise<void> } })
    .locator('[role=dialog] input[type=file]').setInputFiles(paths);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A datetime-local value in the targets' time zone (UTC). */
export function localDateTime(date: Date) {
  return date.toISOString().slice(0, 16);
}

/** The next whole minute at least `ms` from now. */
export function minuteAfter(ms: number) {
  return new Date(Math.ceil((Date.now() + ms) / 60_000) * 60_000);
}

export type TargetName = 'desktop' | 'phone' | 'android-app';

/** Which configured target the page runs on (e2e.config.ts): by width and the Android shell's user agent. */
export async function targetOf(browser: unknown): Promise<TargetName> {
  const read = () => (browser as Page).evaluate(() => window.innerWidth >= 768 ? 'desktop'
    : navigator.userAgent.includes('UniHubAndroid') ? 'android-app' : 'phone') as Promise<TargetName>;
  try {
    return await read();
  } catch {
    // Before the first app.open there is no page; a blank one has the target's viewport and user agent.
    await (browser as { goto: (url: string) => Promise<unknown> }).goto('about:blank');
    return read();
  }
}

/**
 * Skips the test on other targets. Behaviour that does not depend on the
 * layout (what is delivered or stored) runs on one target, so the slow host
 * does not repeat it three times.
 */
export async function onlyOn(browser: unknown, ...names: TargetName[]) {
  const target = await targetOf(browser);
  test.skip(!names.includes(target), `covered on ${names.join(' and ')}`);
  return target;
}

/**
 * Removes an attached file the way the layout offers it: the square's menu on
 * narrow screens, the row's Remove button on desktop. The desktop button's name
 * ("Remove attachment") does not say which file, so its row is found by the name.
 */
export async function removeAttachment(screen: Screen, browser: unknown, filename: string) {
  if (await isNarrow(browser)) {
    await screen.getByRole('button', new RegExp(`^${escape(filename)},`)).tap();
    await screen.getByRole('menuitem', 'Remove attachment').tap();
  } else {
    await (browser as { locator: (css: string) => { tap: () => Promise<void> } })
      .locator(`xpath=//div[@role="dialog"]//p[normalize-space()="${filename}"]/ancestor::div[1]/following-sibling::button[@title="Remove attachment"]`).tap();
  }
}

/** The chips of a phone composer recipient field (0.25.0), by their full entries. */
export async function recipientChips(screen: Screen, field: 'To' | 'Cc' | 'Bcc') {
  const list = screen.getByRole('list', `${field} recipients`);
  if (!(await list.count())) return [];
  const names: string[] = [];
  for (const chip of await list.getByRole('button').all()) names.push((await chip.getAttribute('aria-label')) ?? '');
  return names;
}

/** An attached file as the composer shows it: a square on narrow screens, a row on desktop. */
export function attachedFile(screen: Screen, filename: string) {
  return screen.getByRole('button', new RegExp(`^${escape(filename)},`)).or(screen.getByRole('dialog').getByText(filename, { exact: true })).first();
}

export interface ViewportPoint { x: number; y: number }

/** The centre of a node in viewport pixels, once it is in view. */
export async function centreOf(target: { scrollIntoView: () => Promise<void>; boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null> }): Promise<ViewportPoint> {
  await target.scrollIntoView();
  const box = await target.boundingBox();
  if (!box) throw new Error('The node has no box to touch');
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/**
 * A finger that lands on `from`, holds still for `hold` ms, then slides to
 * `to` and lifts: the long press that picks up a ≡ handle (0.27). The touch
 * events are dispatched in the page (Touch and TouchEvent on the elements
 * under the finger), so the app's sensors see the same hold, moves and lift a
 * phone sends; the browser's own scroll decision is covered by `screen.swipe`,
 * which is a real touch gesture.
 */
export async function longPressDrag(browser: unknown, from: ViewportPoint, to: ViewportPoint, { hold = 400, steps = 10 }: { hold?: number; steps?: number } = {}) {
  await (browser as { evaluate: <R, A>(fn: (arg: A) => Promise<R>, arg: A) => Promise<R> }).evaluate(async ({ from, to, hold, steps }: { from: ViewportPoint; to: ViewportPoint; hold: number; steps: number }) => {
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const at = (point: ViewportPoint) => document.elementFromPoint(point.x, point.y) ?? document.body;
    const touch = (target: Element, point: ViewportPoint) => new Touch({ identifier: 7, target, clientX: point.x, clientY: point.y, pageX: point.x + window.scrollX, pageY: point.y + window.scrollY, radiusX: 2, radiusY: 2, force: 1 });
    const send = (target: Element, type: string, point: ViewportPoint, lifted = false) => {
      const finger = touch(target, point);
      target.dispatchEvent(new TouchEvent(type, { touches: lifted ? [] : [finger], targetTouches: lifted ? [] : [finger], changedTouches: [finger], bubbles: true, cancelable: true, composed: true }));
    };
    const start = at(from);
    send(start, 'touchstart', from);
    await wait(hold);
    for (let step = 1; step <= steps; step++) {
      const point = { x: Math.round(from.x + (to.x - from.x) * step / steps), y: Math.round(from.y + (to.y - from.y) * step / steps) };
      send(start, 'touchmove', point);
      await wait(30);
    }
    await wait(60);
    send(start, 'touchend', to, true);
  }, { from, to, hold, steps });
}

/** Drags with the mouse from one point to another in small steps, as a hand does (a drag sensor needs movement before the drop). */
export async function mouseDrag(browser: { mouse: { move: (x: number, y: number) => Promise<void>; down: () => Promise<void>; up: () => Promise<void> } }, from: ViewportPoint, to: ViewportPoint, steps = 12) {
  await browser.mouse.move(from.x, from.y);
  await browser.mouse.down();
  for (let step = 1; step <= steps; step++) {
    await browser.mouse.move(Math.round(from.x + (to.x - from.x) * step / steps), Math.round(from.y + (to.y - from.y) * step / steps));
  }
  await browser.mouse.up();
}
