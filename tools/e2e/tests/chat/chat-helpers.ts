import { expect } from 'e2e';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { signInPassword, stack } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { addPerson, type Effective } from '../organisation/organisation-helpers.ts';

// What the chat tests share. Each test writes between two people of its own,
// each in a browser of their own: one conversation per pair, a passphrase and
// a device store per person, so no other test's chats, passphrases or devices
// are in the way. The second person's browser is a plain Playwright one.

export type Person = Awaited<ReturnType<typeof addPerson>>;
type Evaluates = { evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> };

const PASSPHRASE = 'synthetic chat passphrase';

/** Two new people who confirmed the rules in force. */
export async function twoPeople(): Promise<[Person, Person]> {
  const people: [Person, Person] = [await addPerson('alex'), await addPerson('blair')];
  for (const person of people) await confirmRules(person);
  return people;
}

/** The person confirms the rules notice, as the other tests do for the seeded people. */
export async function confirmRules(person: Person) {
  const api = await signIn(person.email);
  const effective = ok(await api<Effective>('GET', '/api/policies/effective'), 'rules');
  if (effective.acknowledged_revision < effective.revision) ok(await api('POST', '/api/policies/acknowledge', { revision: effective.revision }), 'confirm the rules');
}

export async function removePeople(people: Person[]) {
  const admin = await signIn('admin');
  for (const person of people) ok(await admin('DELETE', `/api/admin/users/${person.id}`, { current_password: signInPassword }), `remove ${person.email}`);
}

/** The person's server session as browser cookies. */
export async function cookiesOf(person: Person) {
  return (await signIn(person.email)).cookie.split('; ').map((pair) => {
    const at = pair.indexOf('=');
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stack.url };
  });
}

/** A second browser, signed in as the person, with the desktop target's window. */
export async function secondBrowser(person: Person): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'UTC' });
  await context.addCookies(await cookiesOf(person));
  return { browser, page: await context.newPage() };
}

/** The URL of Chat with the test hook (src/lib/chat/test-hook.ts) loaded. */
export const chatWithHook = '/chat#chat-test';

/**
 * Chooses the chat passphrase through the page's test hook, standing in for
 * the passphrase screen; answers the state Chat was in before.
 */
export async function choosePassphrase(page: Evaluates) {
  await expect.poll(() => page.evaluate(() => 'chatTest' in window, null), { timeout: 60_000 }).toBe(true);
  return page.evaluate((passphrase) => (window as unknown as { chatTest: { passphrase(value: string): Promise<string> } }).chatTest.passphrase(passphrase), PASSPHRASE);
}

/** Waits for a Playwright locator to show (Blair's browser has no `screen`). */
export const shows = (locator: Locator, timeout = 30_000) => locator.waitFor({ state: 'visible', timeout });

/** Where each text stands in a thread, from the top: -1 for a text it does not show. */
export async function positions(page: Evaluates, peerName: string, texts: string[]): Promise<number[]> {
  const items = await page.evaluate((label) => [...document.querySelectorAll(`ol[aria-label="${label}"] > li`)].map((item) => item.textContent ?? ''), `Messages with ${peerName}`);
  return texts.map((text) => items.findIndex((item) => item.includes(text)));
}

/** Keeps the second browser's screen for the CI artifact when the test failed. */
export async function keepScreen(page: Page, name: string) {
  await page.screenshot({ path: `.e2e/chat-${name}.png`, fullPage: true }).catch(() => undefined);
}

export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
