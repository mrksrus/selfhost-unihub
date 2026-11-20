import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { runId, signInPassword, stack } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { addPerson, type Effective } from '../organisation/organisation-helpers.ts';

// Blair's chat on a new browser. New messages arrive there at once;
// the earlier ones come with the chat passphrase, through the real screens,
// the engine, the MLS module and the server. Blair's first browser is the
// test's; Alex and Blair's later browsers are plain Playwright ones, each
// with a session and a profile of its own, so each is a device of its own.

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
  await page.getByRole('button', { name: 'Get my earlier messages' }).click();
}

test('a new browser reads new messages at once and the earlier ones after the passphrase; a passphrase set anew on the first browser opens a third', { timeout: 900_000 }, async ({ app, screen, browser }) => {
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
    // Blair opens Chat for the first time and chooses the passphrase.
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

    // A second browser: Chat asks for the passphrase, and can wait for it.
    const second = await open(blair, 'blair-second', 'second browser');
    await second.goto(`${stack.url}/chat`);
    await shows(second.getByRole('heading', { name: 'Enter your chat passphrase' }));
    const fresh = `After the new browser ${run}`;
    await send(alexPage, blair, fresh);
    await second.getByRole('button', { name: 'Not now' }).click();
    await second.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${escape(alex.name)}`) }).click();
    await shows(thread(second, alex).getByText(fresh, { exact: true }));
    expect(await thread(second, alex).getByText(earlier, { exact: true }).count(), 'the earlier message is not on the new browser yet').toBe(0);

    // A wrong passphrase stays on the prompt; the right one brings the history, and the new browser writes.
    await second.getByRole('button', { name: 'Enter passphrase' }).click();
    await enterPassphrase(second, 'not the chat passphrase');
    await shows(second.getByText(/^This is not your chat passphrase\./));
    await enterPassphrase(second, FIRST_PASSPHRASE);
    await shows(thread(second, alex).getByText(earlier, { exact: true }));
    await shows(thread(second, alex).getByText(answer, { exact: true }));
    const fromSecond = `From the second browser ${run}`;
    await send(second, alex, fromSecond);
    await shows(thread(alexPage, blair).getByText(fromSecond, { exact: true }));

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

    // A third browser: the old passphrase no longer opens the history, the new one does.
    const third = await open(blair, 'blair-third', 'third browser');
    await third.goto(`${stack.url}/chat`);
    await shows(third.getByRole('heading', { name: 'Enter your chat passphrase' }));
    await enterPassphrase(third, FIRST_PASSPHRASE);
    await shows(third.getByText(/^This is not your chat passphrase\./));
    await enterPassphrase(third, NEW_PASSPHRASE);
    await third.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${escape(alex.name)}`) }).click();
    for (const text of [earlier, answer, fresh, fromSecond]) await shows(thread(third, alex).getByText(text, { exact: true }));
    passed = true;
  } finally {
    // The other browsers' screens, for the run's artifact when the test failed.
    if (!passed) for (const other of opened) await other.page.screenshot({ path: `.e2e/chat-new-device-${other.name}.png`, fullPage: true }).catch(() => undefined);
    for (const other of opened) await other.browser.close();
    const admin = await signIn('admin');
    for (const person of [alex, blair]) ok(await admin('DELETE', `/api/admin/users/${person.id}`, { current_password: signInPassword }), `remove ${person.email}`);
  }
});
