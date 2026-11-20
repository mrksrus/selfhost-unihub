// Chat's MLS module (WebAssembly) runs in the app's WebView under the server's
// headers: the proof page makes a group of two devices inside the page, they
// write both ways, and the joined device reads on after it was loaded again
// from its stored state (tools/e2e/tests/chat/mls-proof.e2e.ts for two browsers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openApp } from '../support/android.mjs';

test('the MLS proof page runs in the app\'s WebView', { timeout: 600_000 }, async () => {
  const { device, page } = await openApp();
  try {
    await page.goto(new URL('/mls-proof.html?dev', page.url()).href);
    await page.locator('#status').getByText('MLS module ready').waitFor({ timeout: 120_000 });
    const result = await page.evaluate(() => window.mlsProof.measure(2));
    console.log(`mls-proof measure in the WebView: ${JSON.stringify(result)}`);
    assert.deepEqual(result.read, ['hello', 'hi back', 'after reload']);
  } finally {
    await device.close();
  }
});
