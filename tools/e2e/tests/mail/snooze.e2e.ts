import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { sendMail } from '../support/mail.ts';
import { emailsWithSubject } from '../support/api.ts';
import { localDateTime, minuteAfter, onlyOn, openMessage } from '../support/ui.ts';

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
