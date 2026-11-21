import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { runId, stack } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { acknowledge, addPerson, createGroup, dialogPassword, sweep, type Effective } from '../organisation/organisation-helpers.ts';
import { joinChat } from './chat-helpers.ts';

// What an administrator and a person decide about Chat.
// Chat turned off for a group leaves its members' navigation and is refused
// by the server; presence switched off hides the dot for the other person.
// The people are the tests' own; the second person's browser is a plain
// Playwright one.

type Someone = Awaited<ReturnType<typeof addPerson>>;
const PASSPHRASE = 'synthetic chat passphrase';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shows = (locator: Locator, timeout = 90_000) => locator.waitFor({ state: 'visible', timeout });
const appears = (locator: { count(): Promise<number> }) => expect.poll(() => locator.count(), { timeout: 90_000 }).toBeGreaterThan(0);

const cookies = (api: { cookie: string }) => api.cookie.split('; ').map((pair) => {
  const at = pair.indexOf('=');
  return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stack.url };
});

const rulesOf = async (person: Someone) => ok(await (await signIn(person.email))<Effective>('GET', '/api/policies/effective'), 'rules');
async function confirmRules(person: Someone) {
  const effective = await rulesOf(person);
  if (effective.acknowledged_revision < effective.revision) ok(await (await signIn(person.email))('POST', '/api/policies/acknowledge', { revision: effective.revision }), 'confirm the rules');
}

async function openBrowser(person: Someone): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'UTC' });
  await context.addCookies(cookies(await signIn(person.email)));
  return { browser, page: await context.newPage() };
}

test('Chat turned off for a group on the Policies page leaves its members\' navigation and is refused by the server; others keep it', { session: 'admin', timeout: 480_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await sweep();
  let other: Browser | undefined;
  try {
    const member = await addPerson('member');
    const outsider = await addPerson('outsider');
    const group = await createGroup('No chat', [member.id]);
    await confirmRules(member);
    const opened = await openBrowser(member);
    other = opened.browser;
    const page = opened.page;
    // The rail's entry and the Settings section.
    const chatLinks = page.getByRole('link', { name: /^Chat(,|$)/ });
    const railMail = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Mail/ });
    await page.goto(`${stack.url}/settings`);
    await shows(railMail);
    await expect.poll(() => chatLinks.count(), { timeout: 30_000 }).toBe(2);

    // The owner turns the module off on the group's Rules view.
    await app.open(`/admin/groups/${group.id}?view=rules`);
    await screen.getByRole('combobox', 'Chat', { exact: true }).tap();
    await screen.getByRole('option', 'Not allowed', { exact: true }).tap();
    await screen.getByRole('button', 'Save changes…').tap();
    const dialog = screen.getByRole('dialog', `Save the changed rules of ${group.name}?`);
    await dialog.getByLabel('Your password', { exact: true }).fill(dialogPassword());
    await dialog.getByRole('button', 'Save changes', { exact: true }).tap();
    await expect(screen.getByText('Policies saved', { exact: true })).toBeVisible();
    await acknowledge();
    await confirmRules(member);

    const rule = (await rulesOf(member)).policies['modules.chat'];
    expect(rule.allowed, 'the group\'s rule reaches its member').toBe(false);
    expect((await rulesOf(outsider)).policies['modules.chat'].allowed, 'not a member, not bound').toBe(true);

    // The member: no Chat in the navigation or in Settings, the page says why, and the server refuses.
    await page.goto(`${stack.url}/chat`);
    await shows(page.getByText('Chat is not available', { exact: true }));
    await shows(page.getByText(rule.reason ?? 'the server gave no reason').first());
    await page.goto(`${stack.url}/settings`);
    await shows(railMail);
    expect(await chatLinks.count(), 'Chat left the navigation and the settings sections').toBe(0);
    expect(await page.evaluate(async () => (await fetch('/api/chat/account', { credentials: 'include' })).status), 'the server refuses the module, not only the page').toBe(403);
    expect((await (await signIn(outsider.email))('GET', '/api/chat/account')).status, 'the outsider keeps Chat').toBe(200);
  } finally {
    await other?.close();
    await sweep();
  }
});

test('presence switched off under Settings › Chat hides the dot for the other person', { timeout: 600_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  await sweep();
  let other: Browser | undefined;
  try {
    const alex = await addPerson('alex');
    const blair = await addPerson('blair');
    for (const person of [alex, blair]) await confirmRules(person);

    // Both choose their passphrase; Alex starts the chat and stays in UniHub.
    await browser.setCookies(cookies(await signIn(blair.email)));
    await app.open('/chat');
    await appears(screen.getByText('Choose a chat passphrase', { exact: true }));
    await screen.getByLabel('Chat passphrase', { exact: true }).fill(PASSPHRASE);
    await screen.getByLabel('Repeat the passphrase', { exact: true }).fill(PASSPHRASE);
    await screen.getByRole('button', 'Set passphrase and open Chat').tap();
    await joinChat(browser, PASSPHRASE);
    await appears(screen.getByText('No chats yet', { exact: true }));

    const opened = await openBrowser(alex);
    other = opened.browser;
    const page = opened.page;
    await page.goto(`${stack.url}/chat`);
    await page.getByLabel('Chat passphrase', { exact: true }).fill(PASSPHRASE);
    await page.getByLabel('Repeat the passphrase', { exact: true }).fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Set passphrase and open Chat' }).click();
    await joinChat(page, PASSPHRASE);
    await shows(page.getByText('No chats yet', { exact: true }));
    await page.goto(`${stack.url}/contacts?book=company&contact=${blair.id}`);
    await page.getByRole('button', { name: 'Message', exact: true }).click();
    await page.waitForURL(/\/chat\?c=/, { timeout: 60_000 });
    const hello = `Hello Blair ${run}`;
    await page.getByRole('textbox', { name: `Message to ${blair.name}` }).fill(hello);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await shows(page.getByRole('list', { name: `Messages with ${blair.name}` }).getByText(hello, { exact: true }));

    // Blair sees that Alex has UniHub open.
    const row = screen.getByRole('list', 'Chats').getByRole('link', new RegExp(`^${escape(alex.name)}`));
    const online = async () => ((await row.textContent()) ?? '').includes(', online');
    await app.open('/chat');
    await appears(row);
    await expect.poll(online, { timeout: 60_000 }).toBe(true);

    // Alex switches presence off; UniHub stays open, and Blair no longer sees the dot.
    await page.goto(`${stack.url}/settings?section=chat`);
    const presence = page.getByRole('switch', { name: 'Show when I have UniHub open' });
    await shows(presence);
    await presence.click();
    await expect.poll(async () => ok(await (await signIn(alex.email))<{ settings: Record<string, { value: unknown }> }>('GET', '/api/settings/values'), 'Alex\'s settings').settings.chat_presence.value,
      { timeout: 30_000 }).toBe(false);
    await app.open('/chat');
    await appears(row);
    await expect.poll(online, { timeout: 30_000 }).toBe(false);
  } finally {
    await other?.close();
    await sweep();
  }
});
