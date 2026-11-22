import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { stack } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';
import { callScreen, chatBrowser, chatRow, FAKE_MICROPHONE, gone, heard, keepConnections, leave, messagesOf, ringing, shows, startChat, twoPeople } from './chat-helpers.ts';

// A voice call end to end: two people in two browsers, the real screens, the
// server's ring and signals, and a real connection between the two Chromiums.
// Each microphone is Chromium's generated tone, so received sound can be
// counted in the connection's own statistics.

test('a call between two browsers carries sound both ways, muting stops it one way, and every call leaves its entry in both chats', { timeout: 900_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const people = await twoPeople();
  const [alex, blair] = people;
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let passed = false;
  try {
    opened.push(await chatBrowser(alex, FAKE_MICROPHONE), await chatBrowser(blair, FAKE_MICROPHONE));
    const [a, b] = opened.map((entry) => entry.page);
    for (const page of [a, b]) await keepConnections(page);
    await startChat(a, blair);
    const [alexSees, blairSees] = [messagesOf(a, blair.name), messagesOf(b, alex.name)];

    // Alex calls from the chat; Blair is on another page of UniHub and answers there.
    await b.goto(`${stack.url}/settings`);
    await shows(b.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ }), 90_000);
    await a.getByRole('button', { name: `Call ${blair.name}`, exact: true }).click();
    await shows(callScreen(a, blair.name).getByText('Calling…', { exact: true }));
    await shows(ringing(b, alex.name), 60_000);
    expect(await b.title(), 'the tab says who calls').toBe(`${alex.name} is calling`);
    await ringing(b, alex.name).getByRole('button', { name: 'Answer', exact: true }).click();
    for (const [page, other] of [[a, blair], [b, alex]] as const) await shows(callScreen(page, other.name).getByRole('timer', { name: 'Call time' }), 60_000);
    expect(await b.title(), 'the tab has its title back').not.toContain('is calling');

    // Both receive the other's tone.
    const [alexHears, blairHears] = [await heard(a), await heard(b)];
    console.log(`call: in 3 s Alex received ${alexHears.packets} packets (energy ${alexHears.energy.toFixed(4)}), Blair ${blairHears.packets} packets (energy ${blairHears.energy.toFixed(4)})`);
    for (const [who, sound] of [['Alex', alexHears], ['Blair', blairHears]] as const) {
      expect(sound.packets, `${who} receives sound packets`).toBeGreaterThan(50);
      expect(sound.energy, `${who} receives sound, not silence`).toBeGreaterThan(0);
    }

    // Alex mutes: Blair receives silence, Alex still hears Blair.
    await callScreen(a, blair.name).getByRole('button', { name: 'Mute', exact: true }).click();
    await shows(callScreen(a, blair.name).getByText('Your microphone is off.', { exact: true }));
    // What was on its way when the microphone went off has arrived.
    await a.waitForTimeout(1500);
    const [blairMuted, alexStill] = [await heard(b), await heard(a)];
    console.log(`call, Alex muted: in 3 s Blair received energy ${blairMuted.energy.toFixed(6)} in ${blairMuted.packets} packets, Alex ${alexStill.energy.toFixed(4)} in ${alexStill.packets} packets`);
    expect(blairMuted.energy, 'Blair receives no sound from a muted Alex').toBeLessThan(blairHears.energy / 100);
    expect(alexStill.energy, 'Alex still hears Blair').toBeGreaterThan(0);

    // Blair hangs up: both screens close and both chats have the call.
    await callScreen(b, alex.name).getByRole('button', { name: 'Hang up', exact: true }).click();
    for (const page of [a, b]) await gone(page);
    await shows(alexSees.getByRole('listitem').filter({ hasText: 'Voice call, 1 min' }).getByText('You called', { exact: false }), 60_000);
    await b.goto(`${stack.url}/chat`);
    await shows(chatRow(b, alex.name).filter({ hasText: 'Voice call, 1 min' }), 90_000);
    expect(await chatRow(b, alex.name).filter({ hasText: 'unread' }).count(), 'an answered call is not unread').toBe(0);
    await chatRow(b, alex.name).click();
    await shows(blairSees.getByRole('listitem').filter({ hasText: 'Voice call, 1 min' }).getByText(`${alex.name} called`, { exact: false }), 60_000);

    // Blair calls back from the entry and Alex declines.
    await blairSees.getByRole('button', { name: 'Call back', exact: true }).click();
    await shows(ringing(a, blair.name), 60_000);
    await ringing(a, blair.name).getByRole('button', { name: 'Decline', exact: true }).click();
    await shows(callScreen(b, alex.name).getByText(`${alex.name} declined the call.`, { exact: true }), 60_000);
    await callScreen(b, alex.name).getByRole('button', { name: 'Close', exact: true }).click();
    for (const thread of [alexSees, blairSees]) await shows(thread.getByText('Call declined', { exact: true }), 60_000);

    // Nobody answers Alex's call: it ends after the ring time and is a missed call for Blair alone, unread.
    await b.goto(`${stack.url}/settings`);
    await shows(b.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chat', exact: true }), 90_000);
    await a.getByRole('button', { name: `Call ${blair.name}`, exact: true }).click();
    await shows(ringing(b, alex.name), 60_000);
    await shows(callScreen(a, blair.name).getByText(`${blair.name} did not answer.`, { exact: true }), 90_000);
    await callScreen(a, blair.name).getByRole('button', { name: 'Close', exact: true }).click();
    await gone(b);
    await shows(alexSees.getByText('No answer', { exact: true }), 60_000);
    await shows(b.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chat, 1 unread', exact: true }), 60_000);
    await b.goto(`${stack.url}/chat`);
    await shows(chatRow(b, alex.name).filter({ hasText: 'Missed call' }).filter({ hasText: '1 unread' }), 90_000);
    expect(await chatRow(a, blair.name).filter({ hasText: 'unread' }).count(), 'not unread for the caller').toBe(0);

    // A call from the colleague's entry in Contacts › Company rings too; Alex gives it up.
    await a.goto(`${stack.url}/contacts?book=company&contact=${blair.id}`);
    await a.getByRole('button', { name: 'Call', exact: true }).click();
    await shows(ringing(b, alex.name), 60_000);
    await callScreen(a, blair.name).getByRole('button', { name: 'Hang up', exact: true }).click();
    for (const page of [a, b]) await gone(page);
    passed = true;
  } finally {
    await leave(opened, people, passed);
  }
});
