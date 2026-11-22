import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Page } from 'playwright-core';
import { stack } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';
import { callScreen, chatBrowser, FAKE_MICROPHONE, gone, heard, keepConnections, leave, ringing, shows, startChat, twoPeople, type Kept } from './chat-helpers.ts';

// A call between two networks that let nothing through but the relay: both
// pages may use only the relay's candidates, so the sound goes from one
// allocation of the relay in the image (stack.sh) to another, with the
// credentials the server handed out for the call.

/** The candidate types of the connection's selected pair (the transport's selectedCandidatePairId). */
const selectedPair = (page: Page) => page.evaluate(async () => {
  const reports = new Map<string, Record<string, unknown>>();
  (await (window as Kept).callConnection!.getStats()).forEach((report: Record<string, unknown>) => reports.set(report.id as string, report));
  const transport = [...reports.values()].find(report => report.type === 'transport' && report.selectedCandidatePairId);
  const pair = reports.get(transport?.selectedCandidatePairId as string);
  return { local: reports.get(pair?.localCandidateId as string)?.candidateType, remote: reports.get(pair?.remoteCandidateId as string)?.candidateType };
});

test('a call between two pages that may only use the relay carries sound both ways through it; with a wrong relay password it goes through UniHub instead', { timeout: 600_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  test.skip(!process.env.UNIHUB_E2E_IMAGE, 'the relay runs in the image only (stack.sh with UNIHUB_E2E_IMAGE)');
  const people = await twoPeople();
  const [alex, blair] = people;
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let passed = false;
  try {
    opened.push(await chatBrowser(alex, FAKE_MICROPHONE), await chatBrowser(blair, FAKE_MICROPHONE));
    const [a, b] = opened.map((entry) => entry.page);
    for (const page of [a, b]) await keepConnections(page, 'relay');
    await startChat(a, blair);
    // Blair takes the call on another page of UniHub, loaded with the kept connection.
    await b.goto(`${stack.url}/settings`);
    await shows(b.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ }), 90_000);

    const call = async () => {
      await a.getByRole('button', { name: `Call ${blair.name}`, exact: true }).click();
      await shows(ringing(b, alex.name), 60_000);
      await ringing(b, alex.name).getByRole('button', { name: 'Answer', exact: true }).click();
    };

    await call();
    for (const [page, other] of [[a, blair], [b, alex]] as const) await shows(callScreen(page, other.name).getByRole('timer', { name: 'Call time' }), 60_000);
    // The call may already run through UniHub before the relay connects.
    for (const page of [a, b]) await expect.poll(() => page.evaluate(() => (window as Kept).directConnected ?? false), { timeout: 60_000 }).toBe(true);
    const [alexPair, blairPair] = [await selectedPair(a), await selectedPair(b)];
    const [alexHears, blairHears] = [await heard(a), await heard(b)];
    console.log(`relayed call: pairs Alex ${alexPair.local}-${alexPair.remote}, Blair ${blairPair.local}-${blairPair.remote}; in 3 s Alex received ${alexHears.packets} packets (energy ${alexHears.energy.toFixed(4)}), Blair ${blairHears.packets} packets (energy ${blairHears.energy.toFixed(4)})`);
    for (const [who, pair] of [['Alex', alexPair], ['Blair', blairPair]] as const) {
      expect(pair, `${who} sends through the relay to the other's allocation of it`).toEqual({ local: 'relay', remote: 'relay' });
    }
    for (const [who, sound] of [['Alex', alexHears], ['Blair', blairHears]] as const) {
      expect(sound.packets, `${who} receives sound packets`).toBeGreaterThan(50);
      expect(sound.energy, `${who} receives sound, not silence`).toBeGreaterThan(0);
    }
    await callScreen(a, blair.name).getByRole('button', { name: 'Hang up', exact: true }).click();
    for (const page of [a, b]) await gone(page);

    // The same call with a wrong relay password for Alex gets no relay: its direct connection never comes, and the call goes through UniHub.
    await a.evaluate(() => { const kept = window as Kept; kept.wrongRelayPassword = true; kept.directConnected = false; });
    await call();
    for (const [page, other] of [[a, blair], [b, alex]] as const) await shows(callScreen(page, other.name).getByRole('timer', { name: 'Call time' }), 60_000);
    expect(await a.evaluate(() => (window as Kept).directConnected), 'the direct connection never came').toBe(false);
    await callScreen(a, blair.name).getByRole('button', { name: 'Hang up', exact: true }).click();
    for (const page of [a, b]) await gone(page);
    passed = true;
  } finally {
    await leave(opened, people, passed);
  }
});
