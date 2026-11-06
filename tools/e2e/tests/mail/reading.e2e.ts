import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { createProviderMailbox, providerFlags, sendMail, setProviderFlags, waitForDelivery, waitForProviderFlag } from '../support/mail.ts';
import { addMailAccount, emailsWithSubject, ok, pageApi } from '../support/api.ts';
import { dbRead } from '../support/db.ts';
import { onlyOn, openMessage, syncNow } from '../support/ui.ts';

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

// B-35: a Download account takes read and star from the provider once, at import.
// After that what the person set in UniHub stays, also when another mail program
// changes the message at the provider and a later sweep (here the history sweep
// that follows every import) observes it. The list does not show when that sweep
// has run, so the test waits on the account's own engine state: the history
// checkpoint past both messages and the provider flags it recorded there.
test('[B-35] a Download account keeps read and star set in UniHub when another mail program changes them', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const id = runId();
  const mailbox = `download-${id}@mail.test`;
  const readHere = `Read here ${id}`, starredHere = `Starred here ${id}`;
  await createProviderMailbox(mailbox);
  await app.open('/mail');
  const account = await addMailAccount(browser, mailbox, mailbox, { syncMode: 'download' });
  try {
    expect(account.sync_mode).toBe('download');
    const inbox = async () => (await dbRead<{ recent: number | null; history: number | null; busy: number }>(`SELECT
        (SELECT c.covered_through FROM mail_engine_cursors c WHERE c.mailbox_id = m.id AND c.uidvalidity = m.uidvalidity AND c.stream = 'recent') AS recent,
        (SELECT c.covered_through FROM mail_engine_cursors c WHERE c.mailbox_id = m.id AND c.uidvalidity = m.uidvalidity AND c.stream = 'history') AS history,
        (SELECT COUNT(*) FROM mail_engine_jobs j WHERE j.mail_account_id = m.mail_account_id AND j.state IN ('queued','running')) AS busy
      FROM mail_remote_mailboxes m WHERE m.mail_account_id = ? AND m.remote_name = 'INBOX'`, [account.id]))[0];
    const messages = async () => Object.fromEntries((await dbRead<{ subject: string; remote_uid: number; observed_flags: string | string[] | null }>(
      `SELECT e.subject, e.remote_uid, o.observed_flags FROM emails e JOIN mail_remote_occurrences o ON o.email_id = e.id AND o.user_id = e.user_id
       WHERE e.mail_account_id = ?`, [account.id])).map((row) => [row.subject, { uid: Number(row.remote_uid),
      provider: (typeof row.observed_flags === 'string' ? JSON.parse(row.observed_flags) : row.observed_flags ?? []) as string[] }]));
    const stored = async (subject: string) => {
      const [email] = await emailsWithSubject(browser, 'inbox', subject);
      return email && { read: email.is_read, starred: email.is_starred };
    };

    // The account's first pass over its empty INBOX is done, so the mail below arrives
    // as new mail: imported by the recent stream, not yet revisited by history.
    await expect.poll(async () => { const box = await inbox(); return !!box && box.recent !== null && Number(box.busy) === 0; },
      { message: 'first pass of the new account finished', timeout: 90_000, interval: 2_000 }).toBe(true);
    for (const subject of [readHere, starredHere]) {
      await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: `Body of ${subject}.` });
      await waitForDelivery(mailbox, subject);
    }
    // No manual sync here: that would run the history sweep before the person's change.
    await expect.poll(async () => [await stored(readHere), await stored(starredHere)],
      { message: 'imported unread and not starred', timeout: 120_000, interval: 2_000 })
      .toEqual([{ read: false, starred: false }, { read: false, starred: false }]);

    // The person marks one read and stars the other, in the list.
    await app.open('/mail');
    const readRow = screen.getByRole('listitem').filter({ hasText: readHere });
    const starRow = screen.getByRole('listitem').filter({ hasText: starredHere });
    await readRow.getByRole('button', `Select ${readHere}`).tap();
    await screen.getByRole('button', 'Mark selected as read', { visible: true }).tap();
    await starRow.getByRole('button', `Star ${starredHere}`).tap();
    await expect(starRow.getByRole('button', `Unstar ${starredHere}`)).toBeVisible();
    await expect.poll(async () => [await stored(readHere), await stored(starredHere)], { message: 'saved in UniHub', timeout: 30_000 })
      .toEqual([{ read: true, starred: false }, { read: false, starred: true }]);
    const uids = Object.values(await messages()).map((message) => message.uid);
    expect(uids).toHaveLength(2);
    expect(Number((await inbox()).history ?? 0), 'the history sweep has not reached the messages yet').toBeLessThan(Math.max(...uids));

    // Another mail program changes both at the provider: the read one is now unread
    // and flagged there, the starred one read and not flagged.
    await setProviderFlags(mailbox, readHere, ['\\Flagged']);
    await setProviderFlags(mailbox, starredHere, ['\\Seen']);
    expect([...await providerFlags(mailbox, readHere) ?? []]).toEqual(['\\Flagged']);
    expect([...await providerFlags(mailbox, starredHere) ?? []]).toEqual(['\\Seen']);

    // Sync now; the sweep has seen the change once its checkpoint covers both
    // messages and it recorded the provider's new flags on them.
    await syncNow(screen, mailbox);
    await expect.poll(async () => {
      const box = await inbox(), seen = await messages();
      return Number(box.history ?? 0) >= Math.max(...uids) && seen[readHere]?.provider.includes('\\Flagged') && seen[starredHere]?.provider.includes('\\Seen');
    }, { message: 'the history sweep observed the provider\'s change', timeout: 120_000, interval: 2_000 }).toBe(true);

    // UniHub keeps the person's choices.
    await app.open('/mail');
    await expect(readRow.getByRole('button', `Star ${readHere}`)).toBeVisible();
    await expect(readRow.getByText('(unread)')).toHaveCount(0);
    await expect(starRow.getByRole('button', `Unstar ${starredHere}`)).toBeVisible();
    await expect(starRow.getByText('(unread)')).toHaveCount(1);
    expect([await stored(readHere), await stored(starredHere)]).toEqual([{ read: true, starred: false }, { read: false, starred: true }]);
  } finally {
    ok(await pageApi(browser, 'DELETE', `/api/mail/accounts/${account.id}?purge=true&disconnect=true&confirm_purge=${encodeURIComponent(mailbox)}`), 'remove the added account');
  }
});
