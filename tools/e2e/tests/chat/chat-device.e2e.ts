import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright-core';
import { stack } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';

// Chat's devices (their IndexedDB stores and the MLS module, which the image's
// script-src must allow to compile) in the app's own page, through its test
// hook (src/lib/chat/test-hook.ts). Two browser profiles are two devices; the
// test carries the blobs between them, as the server will.
type Json = string | boolean | Json[];
type Page = { goto(url: string): Promise<unknown>; evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> };
const hookPage = `${stack.url}/#chat-test`;

async function openHook(page: Page) {
  await page.goto(hookPage);
  await expect.poll(() => page.evaluate(() => 'chatTest' in window, null), { timeout: 30_000 }).toBe(true);
}
// Runs one function of the page's window.chatTest.
const run = (page: Page, name: string, ...args: Json[]) => page.evaluate(([name, args]) =>
  (window as unknown as { chatTest: Record<string, (...args: Json[]) => Promise<Json>> }).chatTest[name](...args), [name, args] as [string, Json[]]);

test('two browsers enrol, make a group, write both ways, and one reads on after a reload', { timeout: 300_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const other = await chromium.launch();
  try {
    const blair = await (await other.newContext()).newPage();
    await openHook(blair);
    await openHook(browser);
    const blairPackage = await run(blair, 'enrol', 'blair');
    await run(browser, 'enrol', 'alex');
    const welcome = await run(browser, 'createGroup', 'alex', 'test-group', [blairPackage]);
    expect(await run(blair, 'join', 'blair', welcome)).toBe('test-group');

    expect(await run(blair, 'decrypt', 'blair', 'test-group', await run(browser, 'encrypt', 'alex', 'test-group', 'hello from alex'))).toBe('hello from alex');
    expect(await run(browser, 'decrypt', 'alex', 'test-group', await run(blair, 'encrypt', 'blair', 'test-group', 'hello from blair'))).toBe('hello from blair');

    await openHook(browser);
    expect(await run(browser, 'reopen', 'alex'), 'the device came back from its store').toBe(true);
    expect(await run(browser, 'decrypt', 'alex', 'test-group', await run(blair, 'encrypt', 'blair', 'test-group', 'after the reload'))).toBe('after the reload');
    expect(await run(blair, 'decrypt', 'blair', 'test-group', await run(browser, 'encrypt', 'alex', 'test-group', 'still writing'))).toBe('still writing');
  } finally {
    await other.close();
  }
});
