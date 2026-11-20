import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { stack } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';

// How long making and joining a group of 150 devices (50 people with three
// each) takes in the browser's MLS module, and the Welcome's size. The numbers
// go to the log; they are not a pass or fail.
test('a group of 150 devices is made and joined in the browser', { timeout: 300_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  await browser.goto(`${stack.url}/#chat-test`);
  await expect.poll(() => browser.evaluate(() => 'chatTest' in window, null), { timeout: 30_000 }).toBe(true);
  const result = JSON.parse(await browser.evaluate((count) =>
    (window as unknown as { chatTest: { measureGroup(count: number): Promise<string> } }).chatTest.measureGroup(count), 150)) as
    { joined: string; create_ms: number; join_ms: number; welcome_bytes: number };
  console.log(`[chat group of 150 devices] create ${result.create_ms} ms, join ${result.join_ms} ms, Welcome ${result.welcome_bytes} bytes`);
  expect(result.joined).toBe('measure-group');
});
