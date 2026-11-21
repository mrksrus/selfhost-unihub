import crypto from 'node:crypto';
import { expect } from 'e2e';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { signInPassword, stack } from '../support/env.ts';
import { ok, pageApi, signIn } from '../support/api.ts';
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

/** The person's server session as browser cookies; `device` names a sign-in of its own, which the server sees as another device. */
export async function cookiesOf(person: Person, device?: string) {
  return (await signIn(person.email, device ? { fresh: true, userAgent: `UniHub e2e ${device}` } : {})).cookie.split('; ').map((pair) => {
    const at = pair.indexOf('=');
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: stack.url };
  });
}

/** Chromium answers the microphone with a generated tone and asks nobody. */
export const FAKE_MICROPHONE = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

/** A second browser, signed in as the person, with the desktop target's window. */
export async function secondBrowser(person: Person, { args = [] as string[], device = undefined as string | undefined } = {}): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ args });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', timezoneId: 'UTC', permissions: args.length ? ['microphone'] : [] });
  await context.addCookies(await cookiesOf(person, device));
  return { browser, page: await context.newPage() };
}

/** A browser of the person's own with Chat open and their passphrase chosen; they have no chat yet. */
export async function chatBrowser(person: Person, args: string[] = []) {
  const opened = await secondBrowser(person, { args });
  await opened.page.goto(`${stack.url}${chatWithHook}`);
  await choosePassphrase(opened.page);
  await shows(opened.page.getByText('No chats yet', { exact: true }), 60_000);
  return opened;
}

/**
 * Joins the page's device to Chat by the proof of the history key, as a
 * device that knows the passphrase does: it unwraps the key backup, opens the
 * server's challenge and sends it back. For browsers whose screens do not
 * join a waiting device yet; the page should be reloaded afterwards.
 */
export async function joinChat(page: Page, passphrase: string) {
  await expect.poll(async () => (await pageApi(page, 'GET', '/api/chat/devices/current')).status, { timeout: 60_000 }).toBe(200);
  const { account } = ok(await pageApi<{ account: { key_backup: { salt: string; rounds: number; wrapped: string } } }>(page, 'GET', '/api/chat/account'), 'the key backup');
  const wrapped = Buffer.from(account.key_backup.wrapped, 'base64url');
  const unwrapping = crypto.pbkdf2Sync(passphrase.normalize('NFC'), Buffer.from(account.key_backup.salt, 'base64url'), account.key_backup.rounds, 32, 'sha256');
  const unwrap = crypto.createDecipheriv('aes-256-gcm', unwrapping, wrapped.subarray(0, 12));
  unwrap.setAuthTag(wrapped.subarray(wrapped.length - 16));
  const jwk = JSON.parse(Buffer.concat([unwrap.update(wrapped.subarray(12, wrapped.length - 16)), unwrap.final()]).toString('utf8')) as { d: string };
  const history = crypto.createECDH('prime256v1');
  history.setPrivateKey(Buffer.from(jwk.d, 'base64url'));
  // RFC 8291 with the history key's fixed auth secret, as the page's seal.ts opens it.
  const sealed = Buffer.from(ok(await pageApi<{ sealed: string }>(page, 'POST', '/api/chat/devices/current/challenge'), 'the challenge').sealed, 'base64url');
  const salt = sealed.subarray(0, 16);
  const sender = sealed.subarray(21, 21 + sealed[20]);
  const record = sealed.subarray(21 + sealed[20]);
  const hkdf = (key: Buffer, ikm: Buffer, info: string | Buffer, length: number) => Buffer.from(crypto.hkdfSync('sha256', ikm, key, info, length));
  const ikm = hkdf(Buffer.alloc(16), history.computeSecret(sender), Buffer.concat([Buffer.from('WebPush: info\0'), history.getPublicKey(), sender]), 32);
  const open = crypto.createDecipheriv('aes-128-gcm', hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16), hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12));
  open.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([open.update(record.subarray(0, record.length - 16)), open.final()]);
  ok(await pageApi(page, 'POST', '/api/chat/devices/current/proof', { value: padded.subarray(0, padded.lastIndexOf(2)).toString('base64url') }), 'the proof');
}

/** A chat's row in the list, its messages when it is open, and a message written into it. */
export const chatRow = (page: Page, chat: string) => page.getByRole('list', { name: 'Chats' }).getByRole('link', { name: new RegExp(`^${escape(chat)}`) });
export const messagesOf = (page: Page, chat: string) => page.getByRole('list', { name: `Messages with ${chat}` });
export async function write(page: Page, chat: string, text: string) {
  await page.getByLabel(`Message to ${chat}`, { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await shows(messagesOf(page, chat).getByText(text, { exact: true }));
}

/** The person starts the 1:1 chat from the other's entry in the company directory. */
export async function startChat(page: Page, withPerson: Person) {
  await page.goto(`${stack.url}/contacts?book=company&contact=${withPerson.id}`);
  await page.getByRole('button', { name: 'Message', exact: true }).click();
  await page.waitForURL(/\/chat\?c=/, { timeout: 60_000 });
}

/** Whether the server still serves the person the chat's messages. */
export const readsChat = async (person: Person, conversationId: string | null) =>
  (await (await signIn(person.email))('GET', `/api/chat/conversations/${conversationId}/messages?after=0&limit=200`)).status === 200;

/** Closes the browsers (keeping each screen of a failed test) and removes the test's people, also those already gone, and its group. */
export async function leave(opened: { browser: Browser; page: Page }[], people: Person[], passed: boolean, groupId?: string) {
  for (const [index, entry] of opened.entries()) {
    if (!passed) await keepScreen(entry.page, `person-${index + 1}`);
    await entry.browser.close().catch(() => undefined);
  }
  const admin = await signIn('admin');
  for (const person of people) await admin('DELETE', `/api/admin/users/${person.id}`, { current_password: signInPassword });
  if (groupId) await admin('DELETE', `/api/admin/groups/${groupId}`, { current_password: signInPassword });
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
