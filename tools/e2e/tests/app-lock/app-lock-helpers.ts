import type { Screen } from 'e2e';
import { expect } from 'e2e';
import { signInPassword } from '../support/env.ts';
import { ok, pageApi, signIn } from '../support/api.ts';

// Steps the app lock tests share. The lock is this browser's: its PIN and
// timeline live in IndexedDB `unihub-lock-v1`, its settings with the device
// record on the server (PUT /api/settings/values/device). Every test starts
// from a device without a lock and leaves none behind.

export type Person = 'admin' | 'alex' | 'blair';
export const PEOPLE: readonly Person[] = ['admin', 'alex', 'blair'];
export const PIN = '246810';
export const OTHER_PIN = '135790';

type Page = {
  evaluate: <R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A) => Promise<R>;
  reload: () => Promise<unknown>;
  keyboard: { press: (key: string) => Promise<void> };
};
type App = { open: (path?: string) => Promise<unknown> };

interface Effective { policies: Record<string, { allowed: boolean; reason: string | null; value: unknown }>; revision: number; acknowledged_revision: number; rules: string[] }
interface DeviceSettings { settings: { app_lock_scope: { value: string[]; floor?: string[] }; app_lock_relock_after: { value: string; floor?: string } } }

/** A changed rule leaves the notice due for everyone (D38): each person confirms it, except the one a test is about. */
export async function acknowledge(names: readonly Person[] = PEOPLE, revision?: number) {
  for (const name of names) {
    const api = await signIn(name);
    const due = revision ?? await (async () => { const effective = ok(await api<Effective>('GET', '/api/policies/effective'), `${name} rules`); return effective.acknowledged_revision < effective.revision ? effective.revision : null; })();
    if (due !== null) ok(await api('POST', '/api/policies/acknowledge', { revision: due }), `${name} confirms the rules`);
  }
}

/** Sets rules as the admin; everyone has seen them afterwards unless `unseen` names who has not. */
export async function setPolicy(values: Record<string, unknown>, { unseen = [] as readonly Person[] } = {}) {
  const admin = await signIn('admin');
  const saved = ok(await admin<{ revision: number }>('PUT', '/api/admin/policies', { values, current_password: signInPassword }), 'set policy');
  await acknowledge(PEOPLE.filter((name) => !unseen.includes(name)), saved.revision);
}

/** This browser's device locks nothing on the server, and keeps no PIN or timeline. */
export async function resetLock(browser: unknown) {
  await pageApi(browser, 'PUT', '/api/settings/values/device', { values: { app_lock_scope: [], app_lock_relock_after: '60', app_lock_on_device_lock: true } });
  await clearLockRecords(browser);
}

/** Removes the PIN and timeline records of everyone in this browser. */
export async function clearLockRecords(browser: unknown) {
  await (browser as Page).evaluate(() => new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('unihub-lock-v1');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  }));
}

/** How many PIN records this browser keeps (0 after a sign-out). */
export async function pinRecords(browser: unknown) {
  return (browser as Page).evaluate(() => new Promise<number>((resolve) => {
    const request = indexedDB.open('unihub-lock-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins', { keyPath: 'userId' });
      if (!db.objectStoreNames.contains('timeline')) db.createObjectStore('timeline', { keyPath: 'userId' });
    };
    request.onerror = () => resolve(-1);
    request.onsuccess = () => {
      const db = request.result;
      const count = db.transaction(['pins'], 'readonly').objectStore('pins').count();
      count.onsuccess = () => { db.close(); resolve(count.result); };
      count.onerror = () => { db.close(); resolve(-1); };
    };
  }));
}

/** This device's lock settings as the server resolves them. */
export async function deviceSettings(browser: unknown) {
  return ok(await pageApi<DeviceSettings>(browser, 'GET', '/api/settings/values/device'), 'device settings').settings;
}

/** Types a new PIN twice into the Set a UniHub PIN dialog. */
export async function setPinInDialog(screen: Screen, pin = PIN) {
  const dialog = screen.getByRole('dialog', 'Set a UniHub PIN');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('New PIN', { exact: true }).fill(pin);
  await dialog.getByLabel('New PIN again', { exact: true }).fill(pin);
  await dialog.getByRole('button', 'Set PIN', { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
}

/** Answers the "Confirm it is you" dialog a weakening change opens. */
export async function confirmInDialog(screen: Screen, pin = PIN) {
  const dialog = screen.getByRole('dialog', 'Confirm it is you');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('PIN', { exact: true }).fill(pin);
  await dialog.getByRole('button', 'Confirm', { exact: true }).tap();
  await expect(dialog).toHaveCount(0);
}

/**
 * Turns the lock on from Settings → App lock with a new PIN: the whole app,
 * or the named modules. Waits until the server has the choice.
 */
export async function turnOn(app: App, screen: Screen, browser: unknown, choice: 'app' | string[], pin = PIN) {
  await app.open('/settings?section=app-lock');
  await expect(screen.getByRole('radio', 'Off', { exact: true })).toBeChecked();
  if (choice === 'app') {
    // The row is the tap target; its input is drawn by the row (RadioRow).
    await screen.getByText('Whole app', { exact: true }).tap();
    await setPinInDialog(screen, pin);
    await expect(screen.getByRole('radio', /^Whole app/)).toBeChecked();
  } else {
    await screen.getByText('Chosen modules', { exact: true }).tap();
    const list = screen.getByRole('list', 'Locked modules');
    for (const [index, name] of choice.entries()) {
      await list.getByRole('checkbox', new RegExp(`^${name}`)).tap();
      if (index === 0) await setPinInDialog(screen, pin);
      await expect(list.getByRole('checkbox', new RegExp(`^${name}`))).toBeChecked();
    }
  }
  await expect.poll(async () => (await deviceSettings(browser)).app_lock_scope.value, { timeout: 20_000 })
    .toEqual(choice === 'app' ? ['app'] : expect.arrayContaining(choice.map((name) => name.toLowerCase().split(' ')[0])));
}

/** Chooses when UniHub asks again; a longer time asks for the PIN first. */
export async function chooseRelock(screen: Screen, label: string, { confirmWith }: { confirmWith?: string } = {}) {
  await screen.getByRole('combobox', 'Ask again').tap();
  await screen.getByRole('option', label).tap();
  if (confirmWith) await confirmInDialog(screen, confirmWith);
  await expect(screen.getByRole('combobox', 'Ask again')).toContainText(label);
}

/** The tab goes to the background, as the browser tells the page. */
export async function hidePage(browser: unknown) {
  await (browser as Page).evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/**
 * The tab comes back after `afterMs` in the background. The page's clock is
 * moved forward (the lock's timers read Date.now), so a long absence needs no
 * waiting.
 */
export async function showPage(browser: unknown, afterMs: number) {
  await (browser as Page).evaluate((ms: number) => {
    const real = Date.now;
    const offset = ms;
    Date.now = () => real() + offset;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  }, afterMs);
}

/** Unlocks on the lock screen or in an unlock dialog with the PIN. */
export async function unlockWith(screen: Screen, pin = PIN) {
  await screen.getByLabel('PIN', { exact: true }).fill(pin);
  await screen.getByRole('button', 'Unlock', { exact: true }).last().tap();
}
