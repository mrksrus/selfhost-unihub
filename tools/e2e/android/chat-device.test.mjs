// Chat's devices run in the app's WebView under the server's headers, through
// the page's test hook (src/lib/chat/test-hook.ts): two devices in one page
// make a group from their IndexedDB stores and the MLS module, write both
// ways, and one reads on after the page loaded again
// (tools/e2e/tests/chat/chat-device.e2e.ts does it across two browsers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openApp } from '../support/android.mjs';

// The signed-in app never stays on "/", so this is always a new page load.
async function openHook(page) {
  await page.goto(new URL('/#chat-test', page.url()).href);
  await page.waitForFunction(() => 'chatTest' in window, null, { timeout: 120_000 });
}
const run = (page, name, ...args) => page.evaluate(([name, args]) => window.chatTest[name](...args), [name, args]);

test('Chat\'s devices and their stores work in the app\'s WebView', { timeout: 600_000 }, async () => {
  const { device, page } = await openApp();
  try {
    await openHook(page);
    const packageB = await run(page, 'enrol', 'b');
    await run(page, 'enrol', 'a');
    const welcome = await run(page, 'createGroup', 'a', 'test-group', [packageB]);
    assert.equal(await run(page, 'join', 'b', welcome), 'test-group');
    assert.equal(await run(page, 'decrypt', 'b', 'test-group', await run(page, 'encrypt', 'a', 'test-group', 'hello')), 'hello');
    assert.equal(await run(page, 'decrypt', 'a', 'test-group', await run(page, 'encrypt', 'b', 'test-group', 'hi back')), 'hi back');
    const later = await run(page, 'encrypt', 'a', 'test-group', 'after the reload');

    await openHook(page);
    assert.equal(await run(page, 'reopen', 'b'), true);
    assert.equal(await run(page, 'decrypt', 'b', 'test-group', later), 'after the reload');
  } finally {
    await device.close();
  }
});
