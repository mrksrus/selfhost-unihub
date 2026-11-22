import http from 'node:http';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { stack } from '../support/env.ts';
import { onlyOn } from '../support/ui.ts';
import { callScreen, chatBrowser, FAKE_MICROPHONE, gone, heard, keepConnections, leave, messagesOf, ringing, shows, startChat, twoPeople, type Kept } from './chat-helpers.ts';

// Calls between two browsers that cannot connect directly and have no relay:
// each call connection gets no servers and may use only the relay, so it has
// no candidates and never connects. The sound then goes through UniHub's own
// connection (the call's WebSocket), encrypted by the two pages.

// Received sound energy in three seconds: the generated tone gives about 0.3 to 0.9, silence near 0.
const SOUND = 0.05;

/** A proxy that passes every request but no WebSocket, as a reverse proxy with WebSocket support off (browsers tunnel WebSockets with CONNECT). */
async function proxyWithoutWebSockets() {
  const proxy = http.createServer((req, res) => {
    const out = http.request(req.url!, { method: req.method, headers: req.headers }, answer => {
      res.writeHead(answer.statusCode!, answer.headers);
      answer.pipe(res);
    });
    out.on('error', () => res.destroy());
    req.pipe(out);
  });
  proxy.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address() as { port: number };
  return { proxy, args: [`--proxy-server=http://127.0.0.1:${port}`, '--proxy-bypass-list=<-loopback>'] };
}

test('a call between two browsers that cannot connect directly carries sound both ways through UniHub, muting stops it one way, and it leaves its entry', { timeout: 600_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const people = await twoPeople();
  const [alex, blair] = people;
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let passed = false;
  try {
    opened.push(await chatBrowser(alex, FAKE_MICROPHONE), await chatBrowser(blair, FAKE_MICROPHONE));
    const [a, b] = opened.map(entry => entry.page);
    for (const page of [a, b]) await keepConnections(page, 'none');
    await startChat(a, blair);
    await b.goto(`${stack.url}/settings`);
    await shows(b.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ }), 90_000);

    await a.getByRole('button', { name: `Call ${blair.name}`, exact: true }).click();
    await shows(ringing(b, alex.name), 60_000);
    await ringing(b, alex.name).getByRole('button', { name: 'Answer', exact: true }).click();
    const answered = Date.now();
    for (const [page, other] of [[a, blair], [b, alex]] as const) await shows(callScreen(page, other.name).getByRole('timer', { name: 'Call time' }), 60_000);
    await expect.poll(async () => (await heard(a)).energy, { timeout: 60_000, interval: 1 }).toBeGreaterThan(SOUND);
    const toSound = (Date.now() - answered) / 1000;
    const [alexHears, blairHears] = [await heard(a), await heard(b)];
    console.log(`call through UniHub: sound ${toSound.toFixed(1)} s after the answer; in 3 s Alex received ${alexHears.packets} packets (energy ${alexHears.energy.toFixed(4)}), Blair ${blairHears.packets} packets (energy ${blairHears.energy.toFixed(4)})`);
    for (const [who, sound] of [['Alex', alexHears], ['Blair', blairHears]] as const) expect(sound.energy, `${who} hears the other`).toBeGreaterThan(SOUND);
    for (const page of [a, b]) expect(await page.evaluate(() => (window as Kept).directConnected ?? false), 'the direct connection never came').toBe(false);

    // Blair mutes: Alex receives silence, Blair still hears Alex.
    await callScreen(b, alex.name).getByRole('button', { name: 'Mute', exact: true }).click();
    await shows(callScreen(b, alex.name).getByText('Your microphone is off.', { exact: true }));
    // What was on its way, and in the jitter buffer, when the microphone went off has played.
    await b.waitForTimeout(1500);
    const [alexMuted, blairStill] = [await heard(a), await heard(b)];
    console.log(`call through UniHub, Blair muted: in 3 s Alex received energy ${alexMuted.energy.toFixed(6)}, Blair ${blairStill.energy.toFixed(4)}`);
    expect(alexMuted.energy, 'Alex receives no sound from a muted Blair').toBeLessThan(alexHears.energy / 100);
    expect(blairStill.energy, 'Blair still hears Alex').toBeGreaterThan(SOUND);

    await callScreen(a, blair.name).getByRole('button', { name: 'Hang up', exact: true }).click();
    for (const page of [a, b]) await gone(page);
    await shows(messagesOf(a, blair.name).getByRole('listitem').filter({ hasText: 'Voice call' }).getByText('You called', { exact: false }), 60_000);
    passed = true;
  } finally {
    await leave(opened, people, passed);
  }
});

test('behind a proxy that does not pass WebSockets, a call that cannot connect directly fails and says what the proxy must pass', { timeout: 600_000 }, async ({ browser }) => {
  await onlyOn(browser, 'desktop');
  const people = await twoPeople();
  const [alex, blair] = people;
  const { proxy, args } = await proxyWithoutWebSockets();
  const opened: Awaited<ReturnType<typeof chatBrowser>>[] = [];
  let passed = false;
  try {
    opened.push(await chatBrowser(alex, FAKE_MICROPHONE), await chatBrowser(blair, [...FAKE_MICROPHONE, ...args]));
    const [a, b] = opened.map(entry => entry.page);
    for (const page of [a, b]) await keepConnections(page, 'none');
    await startChat(a, blair);
    await b.goto(`${stack.url}/settings`);
    await shows(b.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ }), 90_000);

    await a.getByRole('button', { name: `Call ${blair.name}`, exact: true }).click();
    await shows(ringing(b, alex.name), 60_000);
    await ringing(b, alex.name).getByRole('button', { name: 'Answer', exact: true }).click();
    await shows(callScreen(b, alex.name).getByText(/the reverse proxy in front of UniHub does not pass on/), 120_000);
    await shows(callScreen(a, blair.name).getByRole('button', { name: 'Close', exact: true }), 60_000);
    passed = true;
  } finally {
    await leave(opened, people, passed);
    proxy.closeAllConnections();
    proxy.close();
  }
});
