import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { sendMail } from '../support/mail.ts';
import { emailsWithSubject, setSettings } from '../support/api.ts';
import { dbRead } from '../support/db.ts';
import { isNarrow, localDateTime, minuteAfter, onlyOn, openMessage } from '../support/ui.ts';

const mailbox = people.admin.mailbox;

// 24-17: a message snoozed to a chosen time leaves the inbox, is listed under Snoozed,
// and comes back by itself at that time, without reloading the page. Waits on the
// server's snooze timer (about 2 to 3 minutes), so it is not in test:smoke.
test('[24-17] a snoozed message leaves the inbox and comes back at the chosen time', { session: 'admin', tags: ['slow'], timeout: 420_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const subject = `Snooze ${runId()}`;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'Remind me later.' });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('button', 'Snooze', { exact: true }).tap();
  await screen.getByRole('menuitem', 'Pick a date and time…').tap();
  const until = minuteAfter(120_000);
  await screen.getByLabel('Or pick a date and time').fill(localDateTime(until));
  await screen.getByRole('dialog').getByRole('button', 'Snooze', { exact: true }).tap();

  const row = screen.getByRole('listitem').filter({ hasText: subject });
  await expect(row).toHaveCount(0);
  expect(await emailsWithSubject(browser, 'snoozed', subject), 'listed under Snoozed').toHaveLength(1);

  // Back in the open inbox once due (the snooze worker runs about every 30 s).
  await expect(row).toHaveCount(1, { timeout: until.getTime() - Date.now() + 120_000 });
  expect(Date.now(), 'not before the chosen time').toBeGreaterThanOrEqual(until.getTime() - 1000);
  expect(await emailsWithSubject(browser, 'snoozed', subject), 'no longer snoozed').toHaveLength(0);
});

// D28 (0.25.0): with Settings > Mail "Keep in the folder" the snoozed message stays in
// the inbox, marked with its time, is still listed under Snoozed, and comes back at
// the chosen time as before (the worker's return, which also queues the notification
// for a subscribed device). Alex's own setting, put back afterwards, so the test above
// keeps the default. Waits on the snooze timer, like the test above.
test('[25-D28] kept in the folder, a snoozed message stays in the inbox with its time and comes back at the chosen time', { session: 'alex', tags: ['slow'], timeout: 420_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const inbox = people.alex.mailbox;
  const subject = `Snooze kept ${runId()}`;
  await app.open('/mail');
  await setSettings(browser, { snoozed_messages: 'keep' });
  try {
    await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [inbox], subject, text: 'Keep me in view.' });
    await app.open('/mail');
    await openMessage(screen, subject, inbox);
    await screen.getByRole('button', 'Snooze', { exact: true }).tap();
    await screen.getByRole('menuitem', 'Pick a date and time…').tap();
    const until = minuteAfter(120_000);
    await screen.getByLabel('Or pick a date and time').fill(localDateTime(until));
    await screen.getByRole('dialog').getByRole('button', 'Snooze', { exact: true }).tap();

    // The reader stays open and says so; the list keeps the row with its mark.
    await expect(screen.getByText(/^Snoozed until [^.]+\. It stays in its folder; you get a notification then\.$/)).toBeVisible();
    await expect(screen.getByRole('button', 'Unsnooze', { exact: true })).toBeVisible();
    if (await isNarrow(browser)) await screen.getByRole('button', /^Back to /).first().tap();
    const row = screen.getByRole('listitem').filter({ hasText: subject });
    await expect(row).toHaveCount(1);
    await expect(row.getByText(/^Snoozed until /)).toBeVisible();
    expect(await emailsWithSubject(browser, 'snoozed', subject), 'listed under Snoozed').toHaveLength(1);

    // Due: the mark goes without reloading the page, the row stays.
    await expect(row.getByText(/^Snoozed until /)).toHaveCount(0, { timeout: until.getTime() - Date.now() + 120_000 });
    expect(Date.now(), 'not before the chosen time').toBeGreaterThanOrEqual(until.getTime() - 1000);
    await expect(row).toHaveCount(1);
    expect(await emailsWithSubject(browser, 'snoozed', subject), 'no longer snoozed').toHaveLength(0);
    const [stored] = await dbRead<{ snoozed_until: Date | null; snooze_returned_at: Date | null }>(
      'SELECT e.snoozed_until, e.snooze_returned_at FROM emails e JOIN users u ON u.id = e.user_id WHERE u.email = ? AND e.subject = ?', [people.alex.email, subject]);
    expect(stored.snoozed_until, 'cleared by the worker').toBeNull();
    expect(stored.snooze_returned_at, 'returned by the worker, as when hidden').toBeTruthy();
  } finally {
    await setSettings(browser, { snoozed_messages: 'hide' });
  }
});
