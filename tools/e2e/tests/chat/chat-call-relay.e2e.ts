import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import type { Page } from 'playwright-core';
import { stack } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';
import { callScreen, chatBrowser, FAKE_MICROPHONE, gone, heard, leave, ringing, shows, startChat, twoPeople } from './chat-helpers.ts';

// A call that cannot connect directly, as from a network that lets nothing
// through but the relay: Alex's page may use only the relay's candidates, so
// the sound goes through the relay in the image (stack.sh) with the
// credentials the server handed out for the call. Blair's page connects as usual.

type Relayed = Window & { callConnection?: RTCPeerConnection; wrongRelayPassword?: true };

/** Keeps the page's connection for its statistics; with `relayOnly`, every connection may use only the relay, whose password `wrongRelayPassword` spoils. */
const connections = (page: Page, relayOnly: boolean) => page.context().addInitScript((relayOnly) => {
  const Real = window.RTCPeerConnection;
  const relayed = (configuration: RTCConfiguration = {}): RTCConfiguration => !relayOnly ? configuration : ({
    ...configuration,
    iceTransportPolicy: 'relay',
    iceServers: (configuration.iceServers ?? []).map(server => (window as Relayed).wrongRelayPassword ? { ...server, credential: 'wrong' } : server),
  });
  window.RTCPeerConnection = class extends Real {
    constructor(configuration?: RTCConfiguration) { super(relayed(configuration)); (window as Relayed).callConnection = this; }
    setConfiguration(configuration?: RTCConfiguration) { super.setConfiguration(relayed(configuration)); }
  };
}, relayOnly);

/** The candidate types of the connection's selected pair (the transport's selectedCandidatePairId). */
const selectedPair = (page: Page) => page.evaluate(async () => {
  const reports = new Map<string, Record<string, unknown>>();
  (await (window as Relayed).callConnection!.getStats()).forEach((report: Record<string, unknown>) => reports.set(report.id as string, report));
  const transport = [...reports.values()].find(report => report.type === 'transport' && report.selectedCandidatePairId);
  const pair = reports.get(transport?.selectedCandidatePairId as string);
  return { local: reports.get(pair?.localCandidateId as string)?.candidateType, remote: reports.get(pair?.remoteCandidateId as string)?.candidateType };
});

test('a call from a page that may only use the relay carries sound both ways through it, and with a wrong relay password it does not connect', { timeout: 600_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  test.skip(!process.env.UNIHUB_E2E_IMAGE, 'the relay runs in the image only (stack.sh with UNIHUB_E2E_IMAGE)');
  const people = await twoPeople();
  const [alex, blair] = people;
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let passed = false;
  try {
    opened.push(await chatBrowser(alex, FAKE_MICROPHONE), await chatBrowser(blair, FAKE_MICROPHONE));
    const [a, b] = opened.map((entry) => entry.page);
    await connections(a, true);
    await connections(b, false);
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
    const [alexPair, blairPair] = [await selectedPair(a), await selectedPair(b)];
    const [alexHears, blairHears] = [await heard(a), await heard(b)];
    console.log(`relayed call: pairs Alex ${alexPair.local}-${alexPair.remote}, Blair ${blairPair.local}-${blairPair.remote}; in 3 s Alex received ${alexHears.packets} packets (energy ${alexHears.energy.toFixed(4)}), Blair ${blairHears.packets} packets (energy ${blairHears.energy.toFixed(4)})`);
    expect(alexPair.local, 'Alex sends and receives through the relay').toBe('relay');
    expect(blairPair.remote, 'Blair reaches Alex at the relay').toBe('relay');
    for (const [who, sound] of [['Alex', alexHears], ['Blair', blairHears]] as const) {
      expect(sound.packets, `${who} receives sound packets`).toBeGreaterThan(50);
      expect(sound.energy, `${who} receives sound, not silence`).toBeGreaterThan(0);
    }
    await callScreen(a, blair.name).getByRole('button', { name: 'Hang up', exact: true }).click();
    for (const page of [a, b]) await gone(page);

    // The same call with a wrong relay password for Alex gets no relay and no connection.
    await a.evaluate(() => { (window as Relayed).wrongRelayPassword = true; });
    await call();
    for (const [page, other] of [[a, blair], [b, alex]] as const) {
      await shows(callScreen(page, other.name).getByText('Could not connect. Your administrator may need to set up the relay for calls.', { exact: true }), 120_000);
      await callScreen(page, other.name).getByRole('button', { name: 'Close', exact: true }).click();
    }
    passed = true;
  } finally {
    await leave(opened, people, passed);
  }
});
