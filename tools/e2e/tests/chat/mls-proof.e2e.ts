import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium } from 'playwright-core';
import { stack } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';

// Chat's MLS module (OpenMLS built to WebAssembly) runs in the page under the
// image's own headers, whose script-src must allow compiling WebAssembly. Two
// browser profiles are two devices; the test carries the blobs between them,
// as the server will. The proof page keeps its device in localStorage.
const proofPage = `${stack.url}/mls-proof.html#dev`;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
// Runs one function of the page's window.mlsProof (src/lib/chat/mls-proof.ts).
const run = ([name, args]: [string, Json[]]) =>
  (window as unknown as { mlsProof: Record<string, (...args: Json[]) => Promise<Json>> }).mlsProof[name](...args);

test('two browsers enrol, make a group, write both ways, and one reads on after a reload', { timeout: 300_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const other = await chromium.launch();
  try {
    const blair = await (await other.newContext()).newPage();
    await blair.goto(proofPage);
    const inBlair = (name: string, ...args: Json[]) => blair.evaluate(run, [name, args] as [string, Json[]]);
    const inAlex = (name: string, ...args: Json[]) => browser.evaluate(run, [name, args] as [string, Json[]]);

    await browser.goto(proofPage);
    await expect(browser.locator('#status')).toHaveText('MLS module ready');
    const blairPackage = await inBlair('enrol', 'blair-1');
    await inAlex('enrol', 'alex-1');
    const welcome = await inAlex('createGroup', 'proof-group', [blairPackage]);
    expect(await inBlair('join', welcome)).toBe('proof-group');

    expect(await inBlair('decrypt', 'proof-group', await inAlex('encrypt', 'proof-group', 'hello from alex'))).toBe('hello from alex');
    expect(await inAlex('decrypt', 'proof-group', await inBlair('encrypt', 'proof-group', 'hello from blair'))).toBe('hello from blair');

    await browser.reload();
    await expect(browser.locator('#status')).toHaveText('MLS module ready');
    expect(await inAlex('reopen'), 'the device came back from its stored state').toBe(true);
    expect(await inAlex('decrypt', 'proof-group', await inBlair('encrypt', 'proof-group', 'after the reload'))).toBe('after the reload');
    expect(await inBlair('decrypt', 'proof-group', await inAlex('encrypt', 'proof-group', 'still writing'))).toBe('still writing');

    // How long making and joining a group takes in this browser.
    for (const devices of [2, 10, 150]) {
      const result = await inAlex('measure', devices) as { read: string[] };
      console.log(`mls-proof measure: ${JSON.stringify(result)}`);
      expect(result.read).toEqual(['hello', 'hi back', 'after reload']);
    }
  } finally {
    await other.close();
  }
});
