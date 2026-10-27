import { test } from '@e2e-dev/web';
import type { Screen } from 'e2e';
import { expect } from 'e2e';
import { outside, people, restartApi, runId, stack } from '../support/env.ts';
import { deliveredWithSubject, receive, sendMail, waitForDelivery } from '../support/mail.ts';
import { emailsWithSubject, ok, setSettings, signIn } from '../support/api.ts';
import { composeDialog, localDateTime, minuteAfter, onlyOn, openCompose, openFolder, typeAtStart } from '../support/ui.ts';

// These wait on the server's scheduled-send worker (every 15 s) and real minutes,
// so they are tagged slow and kept out of test:smoke.
type App = { open: (path?: string) => Promise<unknown> };

async function schedule(app: App, screen: Screen, from: string, subject: string, at: Date) {
  await app.open('/mail');
  await openCompose(screen, from);
  await screen.getByLabel('To').fill(outside.sam);
  await screen.getByLabel('Subject').fill(subject);
  await typeAtStart(screen, `Scheduled message ${subject}.`);
  await screen.getByRole('button', 'Send later', { visible: true }).tap();
  await screen.getByRole('menuitem', 'Pick a date and time…').tap();
  await screen.getByLabel(/date and time/i).fill(localDateTime(at));
  await screen.getByRole('button', 'Schedule').tap();
  await expect(composeDialog(screen)).toBeHidden();
}

// 24-18: three messages scheduled for the same minute, about 3 minutes ahead. A is left
// alone, B is due just after the API restarts, C is cancelled from Drafts. A and B
// arrive once each, not before that minute; C never arrives and stays in Drafts unscheduled.
test('[24-18] scheduled sends arrive once at their time, across an API restart, and cancel works', { session: 'admin', tags: ['slow'], timeout: 600_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const id = runId();
  const [a, b, c] = ['A', 'B', 'C'].map((x) => `Scheduled ${x} ${id}`);
  await app.open('/mail');
  await setSettings(browser, { compose_scheduled_send: true, compose_format: 'rich' });
  const due = minuteAfter(210_000);
  for (const subject of [a, b, c]) await schedule(app, screen, people.admin.mailbox, subject, due);

  await openFolder(app, screen, browser, 'Drafts');
  const rowC = screen.getByRole('listitem').filter({ hasText: c });
  await expect(rowC).toContainText('Scheduled for');
  await rowC.getByRole('button', 'Cancel schedule').tap();
  await expect(rowC).not.toContainText('Scheduled for');
  expect(Date.now(), 'cancelled before the due time').toBeLessThan(due.getTime() - 60_000);

  // Restart the API one minute before the due time: the schedule is stored, not held in memory.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, due.getTime() - 60_000 - Date.now())));
  restartApi();

  for (const subject of [a, b]) {
    const message = await receive(outside.sam, subject, due.getTime() + 120_000 - Date.now());
    expect(message.date!.getTime(), `${subject} not before its time`).toBeGreaterThanOrEqual(due.getTime() - 1000);
    expect(message.date!.getTime(), `${subject} within 90 s of its time`).toBeLessThan(due.getTime() + 90_000);
  }
  // A repeat would arrive within a few worker rounds.
  await waitForDelivery(outside.sam, a, { count: 2, timeout: 45_000 });
  for (const subject of [a, b]) expect((await deliveredWithSubject(outside.sam, subject)).length, `${subject} exactly once`).toBe(1);
  expect((await deliveredWithSubject(outside.sam, c)).length, 'cancelled C not sent').toBe(0);
  const draftC = await emailsWithSubject(browser, 'drafts', c);
  expect(draftC, 'C stays in Drafts').toHaveLength(1);
  expect(draftC[0].scheduled_send_status ?? null).toBeNull();
  expect([...await emailsWithSubject(browser, 'drafts', a), ...await emailsWithSubject(browser, 'drafts', b)], 'sent drafts left Drafts').toHaveLength(0);
});

const refusing = 'refused-sender@example.net';

/**
 * A mail account of admin whose SMTP server refuses the connection: GreenMail
 * accepts every recipient, so the refusal is a closed SMTP port. Its IMAP side is
 * a GreenMail mailbox of its own (created by the first message to it, with the
 * address as password), so it passes the connection check and imports nobody
 * else's mail.
 */
async function ensureRefusingAccount() {
  const api = await signIn('admin');
  const { accounts } = ok(await api<{ accounts: { email_address: string }[] }>('GET', '/api/mail/accounts'), 'list accounts');
  if (accounts.some((account) => account.email_address === refusing)) return;
  await sendMail({ from: outside.sam, to: [refusing], subject: 'Mailbox for the refusing account' });
  await receive(refusing, 'Mailbox for the refusing account', 15_000);
  ok(await api('POST', '/api/mail/accounts', {
    email_address: refusing, display_name: 'Refusing sender', provider: 'custom', username: refusing,
    encrypted_password: refusing, imap_host: stack.providerHost, imap_port: stack.imapsPort,
    smtp_host: stack.providerHost, smtp_port: 2465, sync_mode: 'download', sync_fetch_limit: 'all',
  }), 'add the refusing account');
}

// 24-22: a scheduled send that the server refuses shows "Not sent" in Drafts with Send
// now and Reschedule, and Reschedule sets a new time. The notification about it needs
// a subscribed push device, which the stack has not.
test('[24-22] a refused scheduled send shows Not sent and can be rescheduled', { session: 'admin', tags: ['slow'], timeout: 420_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await ensureRefusingAccount();
  const subject = `Refused ${runId()}`;
  await app.open('/mail');
  await setSettings(browser, { compose_scheduled_send: true, compose_format: 'rich' });
  const due = minuteAfter(90_000);
  await schedule(app, screen, refusing, subject, due);

  await openFolder(app, screen, browser, 'Drafts');
  const row = screen.getByRole('listitem').filter({ hasText: subject });
  await expect(row).toContainText('Scheduled for');
  await expect(row).toContainText('Not sent', { timeout: due.getTime() - Date.now() + 120_000 });
  await expect(row.getByRole('button', 'Send now')).toBeVisible();
  expect((await deliveredWithSubject(outside.sam, subject)).length).toBe(0);

  await row.getByRole('button', 'Reschedule').tap();
  await screen.getByLabel(/date and time/i).fill(localDateTime(minuteAfter(600_000)));
  await screen.getByRole('dialog').getByRole('button', /^(Schedule|Reschedule|Save)$/).tap();
  await expect(row).toContainText('Scheduled for');
  await expect(row).not.toContainText('Not sent');
  // Leave it unscheduled, so it does not fail again later.
  await row.getByRole('button', 'Cancel schedule').tap();
  await expect(row).not.toContainText('Scheduled for');
});
