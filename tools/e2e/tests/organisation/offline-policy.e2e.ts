import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { onlyOn } from '../support/ui.ts';
import { createGroup, effectiveOf, seededId, setRules, sweep } from './organisation-helpers.ts';

// Offline reading forbidden for alex's group: the copy this browser already
// holds is deleted at the next start, and Settings › Offline is greyed with
// the server's reason. blair, not in the group, may still keep a copy.

type Page = { evaluate: <R>(fn: () => R | Promise<R>) => Promise<R> };

/** How many offline copies this browser holds (src/lib/offline.ts: database unihub-offline-v1, store snapshot). */
function savedCopies(browser: unknown) {
  return (browser as Page).evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('unihub-offline-v1', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('snapshot'); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const count = request.result.transaction('snapshot').objectStore('snapshot').count();
      count.onsuccess = () => { request.result.close(); resolve(count.result); };
      count.onerror = () => { request.result.close(); reject(count.error); };
    };
  }));
}

test('offline reading forbidden for alex\'s group deletes this browser\'s copy and greys the setting with its reason', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await sweep();
  try {
    const group = await createGroup('No offline', [await seededId('alex')]);
    await app.open('/settings?section=offline');
    const turnOn = screen.getByRole('button', 'Turn on', { exact: true });
    if (await turnOn.count()) await turnOn.tap();
    await expect(screen.getByRole('button', 'Refresh now', { exact: true })).toBeVisible();
    expect(await savedCopies(browser), 'a copy is kept on this device').toBeGreaterThan(0);

    await setRules({ 'offline.copies': 'forbidden' }, { groupId: group.id });
    const rule = (await effectiveOf('alex')).policies['offline.copies'];
    expect(rule.allowed).toBe(false);
    expect((await effectiveOf('blair')).policies['offline.copies'].allowed, 'blair is not in the group').toBe(true);

    await app.open('/settings?section=offline');
    await expect(screen.getByRole('button', 'Turn on', { exact: true })).toBeDisabled();
    await expect(screen.getByText('Not available on this server.', { exact: true })).toBeVisible();
    await expect(screen.getByText(rule.reason ?? 'the server gave no reason').first()).toBeVisible();
    await expect.poll(() => savedCopies(browser), { timeout: 20_000, message: 'the copy is gone from this device' }).toBe(0);
  } finally {
    await sweep();
  }
});
