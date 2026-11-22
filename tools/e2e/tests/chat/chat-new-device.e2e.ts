import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { runId, signInPassword, stack } from '../support/env.ts';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { addPerson, type Effective } from '../organisation/organisation-helpers.ts';

// Blair's chat on a new browser, through the real screens, the engine, the
// MLS module and the server. A new browser gets nothing of Chat until Blair
// lets it in: by approving it on her first browser, where both show the same
// code, or with the chat passphrase; either way the earlier messages come
// along. Blair's first browser is the test's; Alex and Blair's later browsers
// are plain Playwright ones, each with a session and a profile of its own, so
// each is a device of its own.

type Someone = Awaited<ReturnType<typeof addPerson>>;
const FIRST_PASSPHRASE = 'synthetic chat passphrase';
const NEW_PASSPHRASE = 'another synthetic passphrase';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shows = (locator: Locator, timeout = 90_000) => locator.waitFor({ state: 'visible', timeout });
/** For the test's own browser, where starting Chat (the module, the device) can take longer than an assertion waits. */
const appears = (locator: { count(): Promise<number> }) => expect.poll(() => locator.count(), { timeout: 90_000 }).toBeGreaterThan(0);

const cookies = (api: { cookie: string }) => api.cookie.split('; ').map((pair) => {
  const at = pair.indexOf('=');
  return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stack.url };
});

async function confirmRules(person: Someone) {
  const api = await signIn(person.email);
  const effective = ok(await api<Effective>('GET', '/api/policies/effective'), 'rules');
  if (effective.acknowledged_revision < effective.revision) ok(await api('POST', '/api/policies/acknowledge', { revision: effective.revision }), 'confirm the rules');
}

/** A browser of its own for the person: `device` names a new sign-in, so the server sees another device. */
async function openBrowser(person: Someone, device?: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'UTC' });
  await context.addCookies(cookies(await signIn(person.email, device ? { fresh: true, userAgent: `UniHub e2e ${device}` } : {})));
  return { browser, page: await context.newPage() };
}

const thread = (page: Page, peer: Someone) => page.getByRole('list', { name: `Messages with ${peer.name}` });
async function send(page: Page, peer: Someone, text: string) {
  await page.getByRole('textbox', { name: `Message to ${peer.name}` }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await shows(thread(page, peer).getByText(text, { exact: true }));
}
async function enterPassphrase(page: Page, passphrase: string) {
  await page.getByLabel('Chat passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Let this device in' }).click();
}
const WAITING = 'This device is not in Chat yet';
/** Chat's entry in the rail, as a screen reader names it: with the unread count, or as not on this device. */
const chatEntry = (page: Page) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ }).getAttribute('aria-label');
/** The code as the screens say it, digit by digit. */
const CODE = /^Code: \d( \d){5}$/;

test('a new browser gets nothing of Chat until it is approved by the code or let in with the passphrase; "Not now" leaves Chat closed, "This was not me" removes the request', { timeout: 900_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  const alex = await addPerson('alex');
  const blair = await addPerson('blair');
  for (const person of [alex, blair]) await confirmRules(person);
  const opened: { browser: Browser; page: Page; name: string }[] = [];
  const open = async (person: Someone, name: string, device?: string) => {
    const next = { ...(await openBrowser(person, device)), name };
    opened.push(next);
    return next.page;
  };
  let passed = false;
  try {
    // Blair opens Chat for the first time and chooses the passphrase, which lets this browser in.
    await browser.setCookies(cookies(await signIn(blair.email)));
    await app.open('/chat');
    await appears(screen.getByText('Choose a chat passphrase', { exact: true }));
    await screen.getByLabel('Chat passphrase', { exact: true }).fill(FIRST_PASSPHRASE);
    await expect(screen.getByRole('button', 'Set passphrase and open Chat')).toBeDisabled();
    await screen.getByLabel('Repeat the passphrase', { exact: true }).fill(FIRST_PASSPHRASE);
    await screen.getByRole('button', 'Set passphrase and open Chat').tap();
    await appears(screen.getByText('No chats yet', { exact: true }));

    // Alex does the same, starts the chat from Blair's entry in the company directory and writes.
    const alexPage = await open(alex, 'alex');
    await alexPage.goto(`${stack.url}/chat`);
    await alexPage.getByLabel('Chat passphrase', { exact: true }).fill(FIRST_PASSPHRASE);
    await alexPage.getByLabel('Repeat the passphrase', { exact: true }).fill(FIRST_PASSPHRASE);
    await alexPage.getByRole('button', { name: 'Set passphrase and open Chat' }).click();
    await shows(alexPage.getByText('No chats yet', { exact: true }));
    await alexPage.goto(`${stack.url}/contacts?book=company&contact=${blair.id}`);
    await alexPage.getByRole('button', { name: 'Message', exact: true }).click();
    await alexPage.waitForURL(/\/chat\?c=/, { timeout: 60_000 });
    const earlier = `Before the new browser ${run}`;
    await send(alexPage, blair, earlier);

    // Blair reads it on the first browser and answers: both messages are history for any later device.
    await app.open('/chat');
    await appears(screen.getByRole('list', 'Chats').getByRole('link', new RegExp(`^${escape(alex.name)}`)));
    await screen.getByRole('list', 'Chats').getByRole('link', new RegExp(`^${escape(alex.name)}`)).tap();
    const firstBrowser = screen.getByRole('list', `Messages with ${alex.name}`);
    await appears(firstBrowser.getByText(earlier, { exact: true }));
    const answer = `Blair answers ${run}`;
    await screen.getByRole('textbox', `Message to ${alex.name}`).fill(answer);
    await screen.getByRole('button', 'Send', { exact: true }).tap();
    await shows(thread(alexPage, blair).getByText(answer, { exact: true }));

    // A second browser waits: no chats, no unread count, and the server gives it nothing of Chat, also not what Alex writes now.
    const second = await open(blair, 'blair-second', 'second browser');
    await second.goto(`${stack.url}/chat`);
    await shows(second.getByRole('heading', { name: WAITING }));
    const whileWaiting = `While the new browser waits ${run}`;
    await send(alexPage, blair, whileWaiting);
    await appears(firstBrowser.getByText(whileWaiting, { exact: true }));
    expect((await pageApi(second, 'GET', '/api/chat/conversations')).status, 'the chats of a waiting browser').toBe(403);
    expect(await chatEntry(second)).toBe('Chat, not on this device yet');
    expect(await second.getByRole('list', { name: 'Chats' }).count(), 'no chats on a waiting browser').toBe(0);

    // "Not now" leaves Chat closed there, and the rest works.
    await second.getByRole('button', { name: 'Not now' }).click();
    await second.waitForURL((url) => !url.pathname.startsWith('/chat'), { timeout: 30_000 });
    await second.goto(`${stack.url}/mail`);
    await shows(second.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Mail/ }));
    expect((await pageApi(second, 'GET', '/api/mail/accounts')).status, 'Mail on a browser that is not in Chat').toBe(200);
    expect(await chatEntry(second)).toBe('Chat, not on this device yet');
    await second.goto(`${stack.url}/chat`);
    await shows(second.getByRole('heading', { name: WAITING }));

    // It asks; the first browser shows the same code over the page it is on, and approves once its copies of the three messages are kept.
    await second.getByRole('button', { name: 'Ask for approval' }).click();
    await shows(second.getByText(CODE));
    const code = await second.getByText(CODE).textContent();
    const asks = screen.getByRole('dialog', 'A device asks to join your chats');
    await appears(asks.getByText(CODE));
    expect(await asks.getByText(CODE).textContent(), 'the code on the approving browser').toBe(code);
    await expect.poll(async () => (await pageApi<{ copies: unknown[] }>(browser, 'GET', '/api/chat/archive?limit=500')).data.copies?.length ?? 0, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
    await asks.getByRole('button', 'Approve', { exact: true }).tap();

    // The second browser is in Chat with the history and no passphrase; it reads what comes next and writes.
    await second.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${escape(alex.name)}`) }).click({ timeout: 90_000 });
    for (const text of [earlier, answer, whileWaiting]) await shows(thread(second, alex).getByText(text, { exact: true }));
    const fresh = `After the approval ${run}`;
    await send(alexPage, blair, fresh);
    await shows(thread(second, alex).getByText(fresh, { exact: true }));
    const fromSecond = `From the second browser ${run}`;
    await send(second, alex, fromSecond);
    await shows(thread(alexPage, blair).getByText(fromSecond, { exact: true }));

    // A third browser asks; "This was not me" removes the request, offers to sign that browser out, and the browser keeps waiting.
    const third = await open(blair, 'blair-third', 'third browser');
    await third.goto(`${stack.url}/chat`);
    await shows(third.getByRole('heading', { name: WAITING }));
    await third.getByRole('button', { name: 'Ask for approval' }).click();
    await shows(third.getByText(CODE));
    await appears(asks.getByRole('button', 'This was not me'));
    await asks.getByRole('button', 'This was not me').tap();
    const removed = screen.getByRole('dialog', 'The request was removed');
    await appears(removed.getByRole('button', 'Sign that device out'));
    await removed.getByRole('button', 'Keep it signed in').tap();
    await shows(third.getByRole('button', { name: 'Ask for approval' }));
    expect(await third.getByText(CODE).count(), 'the code of a removed request').toBe(0);

    // The first browser holds the history, so a new passphrase needs only the account password.
    await app.open('/settings?section=chat');
    await appears(screen.getByRole('button', 'Set a new passphrase…'));
    await screen.getByRole('button', 'Set a new passphrase…').tap();
    const dialog = screen.getByRole('dialog', 'Set a new chat passphrase');
    await dialog.getByLabel('Chat passphrase', { exact: true }).fill(NEW_PASSPHRASE);
    await dialog.getByLabel('Repeat the passphrase', { exact: true }).fill(NEW_PASSPHRASE);
    await dialog.getByLabel('Your password', { exact: true }).fill(signInPassword);
    await dialog.getByRole('button', 'Set new passphrase', { exact: true }).tap();
    await expect(screen.getByText('The chat passphrase was changed', { exact: true })).toBeVisible();

    // The third browser: the old passphrase lets nothing in, the new one does, with the history.
    await enterPassphrase(third, FIRST_PASSPHRASE);
    await shows(third.getByText(/^This is not your chat passphrase\./));
    await shows(third.getByRole('heading', { name: WAITING }));
    await enterPassphrase(third, NEW_PASSPHRASE);
    await third.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${escape(alex.name)}`) }).click({ timeout: 90_000 });
    for (const text of [earlier, answer, whileWaiting, fresh, fromSecond]) await shows(thread(third, alex).getByText(text, { exact: true }));
    passed = true;
  } finally {
    // The other browsers' screens, for the run's artifact when the test failed.
    if (!passed) for (const other of opened) await other.page.screenshot({ path: `.e2e/chat-new-device-${other.name}.png`, fullPage: true }).catch(() => undefined);
    for (const other of opened) await other.browser.close();
    const admin = await signIn('admin');
    for (const person of [alex, blair]) ok(await admin('DELETE', `/api/admin/users/${person.id}`, { current_password: signInPassword }), `remove ${person.email}`);
  }
});
