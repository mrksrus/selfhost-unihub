import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { sendMail, waitForProviderFlag } from '../support/mail.ts';
import { emailsWithSubject } from '../support/api.ts';
import { onlyOn, openMessage } from '../support/ui.ts';

const mailbox = people.admin.mailbox;

// 0-02: a message from outside reaches the inbox, opens with its text, and the reader's
// read and star controls reach the provider, as another mail program sees it.
test('[0-02] a received message opens, and read and star reach the provider', { session: 'admin', tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Reading ${runId()}`;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: `Body of ${subject}.` });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await expect(screen.getByText(`Body of ${subject}.`).first()).toBeVisible();

  // Opening marks it read, here and at the provider.
  await expect(screen.getByRole('button', 'Mark unread')).toBeVisible();
  expect((await waitForProviderFlag(mailbox, subject, '\\Seen', true))?.has('\\Seen'), 'read at the provider').toBe(true);

  await screen.getByRole('button', 'Mark unread').tap();
  await expect(screen.getByRole('button', 'Mark read')).toBeVisible();
  expect((await waitForProviderFlag(mailbox, subject, '\\Seen', false))?.has('\\Seen'), 'unread at the provider').toBe(false);
  // The reader keeps the explicit choice instead of marking it read again.
  await expect(screen.getByRole('button', 'Mark read')).toBeVisible({ timeout: 5_000 });

  await screen.getByRole('button', 'Star message').tap();
  await expect(screen.getByRole('button', 'Unstar message')).toBeVisible();
  expect((await waitForProviderFlag(mailbox, subject, '\\Flagged', true))?.has('\\Flagged'), 'flagged at the provider').toBe(true);

  const [stored] = await emailsWithSubject(browser, 'inbox', subject);
  expect(stored).toMatchObject({ is_read: false, is_starred: true });
});
