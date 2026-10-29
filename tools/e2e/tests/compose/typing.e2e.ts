import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { people } from '../support/env.ts';
import { composeDialog, messageBody, onlyOn, openCompose } from '../support/ui.ts';

type Eval = { evaluate: <R, A = undefined>(fn: (arg: A) => R, arg?: A) => Promise<R> };

/**
 * Where the line being written is, against the part of the composer's scroller
 * on screen: the caret's box, or for a caret on an empty new line (which has
 * no box) the line it sits in.
 */
async function caretPlace(browser: unknown) {
  return (browser as Eval).evaluate(() => {
    const selection = window.getSelection()!;
    const range = selection.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (!rect.height) {
      const node = range.startContainer;
      rect = (node instanceof Element ? node : node.parentElement!).getBoundingClientRect();
    }
    let scroller = document.getElementById('compose-body')!.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const room = scroller!.getBoundingClientRect();
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), roomTop: Math.round(room.top), roomBottom: Math.round(room.bottom), scrollTop: Math.round(scroller!.scrollTop) };
  });
}

// B-22: on a phone the composer sometimes jumped to the top of the message while typing,
// right after Enter (Pixel 8a, app). The on-screen keyboard changes its height while
// typing (its suggestion strip comes and goes, for example after Enter), and every
// such resize scrolled the composer back to the top of the message. Here the keyboard
// is a smaller viewport whose height changes every few lines: the line being written
// stays on screen after every Enter and the composer never scrolls back up.
test('[B-22] on a phone the line being written stays on screen after Enter, in a message longer than the screen', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'phone', 'android-app');
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  const body = messageBody(screen);
  await body.tap();
  const viewport = browser as unknown as { setViewport(size: { width: number; height: number }): Promise<void> };
  const width = await browser.evaluate(() => window.innerWidth);
  // The keyboard opens.
  await viewport.setViewport({ width, height: 560 });
  const keyboard = (browser as unknown as { keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> } }).keyboard;
  const places: Awaited<ReturnType<typeof caretPlace>>[] = [];
  let highest = 0;
  for (let line = 1; line <= 40; line++) {
    await keyboard.type(`Line ${line} of a long synthetic message`);
    await keyboard.press('Enter');
    // The keyboard's suggestion strip appears or goes.
    if (line % 3 === 0) await viewport.setViewport({ width, height: line % 2 ? 520 : 560 });
    // Smooth scrolling and the editor's own updates settle.
    await new Promise((resolve) => setTimeout(resolve, 350));
    const place = await caretPlace(browser);
    places.push(place);
    expect(place.top, `line ${line}: the caret is not above the visible part`).toBeGreaterThanOrEqual(place.roomTop - 2);
    expect(place.bottom, `line ${line}: the caret is not below the visible part`).toBeLessThanOrEqual(place.roomBottom + 2);
    // A taller visible area may lower it by its growth (the browser keeps the end in place), no more.
    expect(place.scrollTop, `line ${line}: no jump back up`).toBeGreaterThanOrEqual(highest - 42);
    highest = Math.max(highest, place.scrollTop);
  }
  console.log(`caret and scroller per line: ${JSON.stringify(places)}`);
  expect(highest, 'the message did become longer than the screen').toBeGreaterThan(400);
  await expect(composeDialog(screen)).toBeVisible();
  await viewport.setViewport({ width, height: 915 });
});
