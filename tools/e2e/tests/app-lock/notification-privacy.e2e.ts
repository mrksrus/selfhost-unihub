import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { people, outside, runId } from '../support/env.ts';
import { pageApi } from '../support/api.ts';
import { sendMail } from '../support/mail.ts';
import { dbRead } from '../support/db.ts';
import { onlyOn } from '../support/ui.ts';
import { createECDH, randomBytes } from 'node:crypto';
import { acknowledge, hidePage, resetLock, turnOn } from './app-lock-helpers.ts';

// 0.29 notification privacy while locked (F6, row 29-05): alex's browser
// locks Mail and goes to the background; new mail then reaches the device
// with its generic text only. There is no browser push service here, and the
// delivery record keeps no rendered text, so this test proves what the server
// stores: the shared event keeps the person's own rendering (a locked device
// never strips it for the others), and the device reported itself locked
// (its open_until has passed). The display itself is proved on Android
// (tools/e2e/android/app-lock-notifications.test.mjs).

test('[29-05] mail that arrives while the device is in the background with Mail locked keeps the shared event intact and the device reported closed', { session: 'alex', timeout: 480_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await acknowledge(['alex']);
  await app.open('/settings?section=app-lock');
  await resetLock(browser);
  // The first import of a folder is a baseline and notifies nothing: a first
  // message, imported before the test's own, makes that one a new arrival.
  const me = (await pageApi<{ user: { id: string } }>(browser, 'GET', '/api/auth/me')).data.user;
  const warmUp = `Before the lock ${runId()}`;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [people.alex.mailbox], subject: warmUp, text: 'Synced before the test.' });
  await expect.poll(async () => (await dbRead<{ id: string }>('SELECT id FROM emails WHERE user_id = ? AND subject = ?', [me.id, warmUp])).length, { timeout: 150_000 }).toBe(1);
  // A notification is stored only for a person with a reachable device: this
  // browser's session gets a push channel of a synthetic endpoint (the push
  // service refuses it later; the stored event is what this test reads).
  const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-notification-privacy-${runId()}`;
  const keys = { p256dh: createECDH('prime256v1').generateKeys().toString('base64url'), auth: randomBytes(16).toString('base64url') };
  expect((await pageApi(browser, 'POST', '/api/notifications/subscription', { subscription: { endpoint, keys } })).status, 'push channel').toBeLessThan(300);
  try {
    await turnOn(app, screen, browser, ['Mail']);
    const device = (await pageApi<{ device: { id: string } }>(browser, 'GET', '/api/devices/current')).data.device;
    // The page leaves: it reports "background" with keepalive, so the server's open_until is at most the relock time away.
    await hidePage(browser);
    await expect.poll(async () => (await dbRead<{ open_until: Date | null }>('SELECT open_until FROM devices WHERE id = ?', [device.id]))[0]?.open_until, { timeout: 20_000 })
      .toBeTruthy();
    const subject = `Locked mail ${runId()}`;
    await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [people.alex.mailbox], subject, text: `Body of ${subject}.` });
    // The event the server stores for this person keeps its own rendering: a locked device never changes it for the others.
    const query = () => dbRead<{ payload: string }>(
      "SELECT payload FROM notification_events WHERE user_id = ? AND kind LIKE 'mail%' AND payload LIKE ? ORDER BY created_at DESC LIMIT 1", [me.id, `%${subject}%`],
    );
    await expect.poll(async () => (await query()).length, { timeout: 180_000 }).toBe(1);
    const events = await query();
    expect(events[0].payload, 'the shared event keeps the subject').toContain(subject);
    // While the device counts as locked, its open_until is in the past (at most relock_after after the background report).
    await expect.poll(async () => {
      const row = (await dbRead<{ open_until: Date | null }>('SELECT open_until FROM devices WHERE id = ?', [device.id]))[0];
      return row?.open_until ? new Date(row.open_until).getTime() <= Date.now() + 61_000 : false;
    }, { timeout: 20_000 }).toBe(true);
  } finally {
    await pageApi(browser, 'DELETE', '/api/notifications/subscription', { endpoint });
    await resetLock(browser);
  }
});
