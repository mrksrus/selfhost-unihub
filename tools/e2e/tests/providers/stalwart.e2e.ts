import { describe, test } from '@e2e-dev/web';
import { expect, secrets } from 'e2e';
import { runId } from '../support/env.ts';
import { sendViaProvider, waitForImap, type ImapLogin } from '../support/mail.ts';
import { deleteObject, editObject, eventIcs, icsValue, putObject, waitForSummary, withValue, type DavLogin } from '../support/caldav.ts';
import { ok, pageApi } from '../support/api.ts';
import { providersFile, secretName, stalwartAccounts, type ProviderAccount } from '../support/providers.ts';
import { messageBody, onlyOn, openCompose, openMessage, typeAtStart } from '../support/ui.ts';

// Real-provider checks against a Stalwart server, with the maintainer's two test accounts
// from the private providers file (support/providers.ts). Account A is connected in UniHub
// as blair's; account B is the outside correspondent, read and written over IMAP/SMTP
// directly. A provider on a private address (VPN, LAN) must be in the API's
// TRUSTED_MAIL_HOSTS, or connecting fails with "Mail host blocked". Excluded from `npm test`; run with `npm run test:providers`. Skipped when the
// file or a block is missing. Values are e2e secrets: never log them.
const { a: A, b: B } = stalwartAccounts();
const imap = (account: ProviderAccount): ImapLogin => ({ host: account.imapHost, port: account.imapPort, user: account.username, pass: account.password });
const smtp = (account: ProviderAccount) => ({ host: account.smtpHost, port: account.smtpPort, user: account.username, pass: account.password });
const secret = (value: string) => secrets.get(secretName(value));
const fillValue = (value: string) => value.length >= 6 ? secret(value) : value;
const skipReason = `no Stalwart accounts A and B in ${providersFile}`;

describe('Stalwart mail', { serial: true, session: 'blair', tags: ['providers'], timeout: 300_000 }, () => {
  const subject = `Provider check ${runId()}`;
  let answerId = '';

  // 0-03 / 23-13: account A connects through Add mail account with its IMAP and SMTP
  // servers, and its first sync completes.
  test('[0-03 X] a Stalwart mail account connects with IMAP and SMTP', async ({ app, screen, browser }) => {
    test.skip(!A || !B, skipReason);
    await onlyOn(browser, 'desktop');
    await app.open('/mail');
    const { accounts } = ok(await pageApi<{ accounts: { email_address: string }[] }>(browser, 'GET', '/api/mail/accounts'), 'accounts');
    if (!accounts.some((account) => account.email_address === A!.email)) {
      await screen.getByRole('button', 'Add mail account').first().tap();
      const dialog = screen.getByRole('dialog');
      await dialog.getByRole('combobox', 'Email Provider').tap();
      await screen.getByRole('option', 'Other (Custom IMAP/SMTP)').tap();
      await dialog.getByLabel('Email Address').fill(secret(A!.email));
      await dialog.getByLabel('Display Name').fill('Stalwart A (e2e)');
      await dialog.getByLabel('Username').fill(fillValue(A!.username));
      await dialog.getByLabel(/^Password/).fill(secret(A!.password));
      await dialog.getByLabel('IMAP Server').fill(fillValue(A!.imapHost));
      await dialog.getByLabel('IMAP Port').fill(String(A!.imapPort));
      await dialog.getByLabel('SMTP Server').fill(fillValue(A!.smtpHost));
      await dialog.getByLabel('SMTP Port').fill(String(A!.smtpPort));
      // Sync mode, so reading and starring are written back; the calendar is connected in its own test.
      await dialog.getByRole('radio', /^Sync — works like a mail client/).check();
      await dialog.getByRole('checkbox', /^Sync the calendar too/).uncheck();
      await dialog.getByRole('button', 'Add Account').tap();
      await expect(screen.getByRole('dialog')).toBeHidden({ timeout: 120_000 });
    }
    await expect(screen.getByRole('button', new RegExp(A!.email.replace(/[.+]/g, '\\$&'))).first()).toBeVisible();
  });

  // 0-03 / 23-24 (X): a message sent from UniHub reaches B; B answers from its own mail
  // program, and the answer reaches UniHub with its text.
  test('[0-03 23-24 X] a message sent from UniHub arrives, and the answer comes back', async ({ app, screen, browser }) => {
    test.skip(!A || !B, skipReason);
    await onlyOn(browser, 'desktop');
    await app.open('/mail');
    await openCompose(screen, A!.email);
    await screen.getByLabel('To').fill(secret(B!.email));
    await screen.getByLabel('Subject').fill(subject);
    await typeAtStart(screen, 'Sent from UniHub to a real provider.');
    await screen.getByRole('button', 'Send', { visible: true }).tap();

    const atB = await waitForImap(imap(B!), subject, () => true, { timeout: 180_000 });
    expect(atB, 'delivered to B').not.toBeNull();
    answerId = await sendViaProvider(smtp(B!), { from: B!.email, to: [A!.email], subject: `Re: ${subject}`, text: 'Answer from B.',
      inReplyTo: atB!.messageId, references: [atB!.messageId!] });
    await app.open('/mail');
    await openMessage(screen, `Re: ${subject}`, A!.email, 180_000);
    await expect(screen.getByText('Answer from B.').first()).toBeVisible();
  });

  // 0-02 (X): reading and starring the answer in UniHub reaches the provider, as B's
  // and A's other mail programs see it over IMAP.
  test('[0-02 X] read and star in UniHub reach the provider', async ({ app, screen, browser }) => {
    test.skip(!A || !B || !answerId, skipReason);
    await onlyOn(browser, 'desktop');
    await app.open('/mail');
    await openMessage(screen, `Re: ${subject}`, A!.email);
    await expect(screen.getByRole('button', 'Mark unread')).toBeVisible();
    expect((await waitForImap(imap(A!), `Re: ${subject}`, (m) => m.flags.has('\\Seen')))?.flags.has('\\Seen'), 'read at the provider').toBe(true);
    await screen.getByRole('button', 'Star message').tap();
    expect((await waitForImap(imap(A!), `Re: ${subject}`, (m) => m.flags.has('\\Flagged')))?.flags.has('\\Flagged'), 'flagged at the provider').toBe(true);
    await screen.getByRole('button', 'Mark unread').tap();
    expect((await waitForImap(imap(A!), `Re: ${subject}`, (m) => !m.flags.has('\\Seen')))?.flags.has('\\Seen'), 'unread at the provider').toBe(false);
  });

  // 23-24 / 24-14 (X): a reply from UniHub to B's answer is threaded at B: its In-Reply-To
  // is the answer's Message-ID.
  test('[23-24 24-14 X] a reply from UniHub threads at the recipient', async ({ app, screen, browser }) => {
    test.skip(!A || !B || !answerId, skipReason);
    await onlyOn(browser, 'desktop');
    await app.open('/mail');
    await openMessage(screen, `Re: ${subject}`, A!.email);
    await screen.getByRole('button', 'Reply', { visible: true }).first().tap();
    await expect(messageBody(screen)).toBeVisible();
    await typeAtStart(screen, 'UniHub answers B.');
    await screen.getByRole('button', 'Send', { visible: true }).tap();
    const reply = await waitForImap(imap(B!), `Re: ${subject}`, (m) => m.inReplyTo === answerId, { timeout: 180_000, anyPrefix: true });
    // Compared without printing: Message-IDs carry the provider's domain.
    expect(reply?.inReplyTo === answerId, 'at B, In-Reply-To is the answer\'s Message-ID').toBe(true);
    expect.soft(reply?.subject === `Re: ${subject}`, 'a reply to "Re: …" keeps one Re: prefix').toBe(true);
  });
});

// 0-11 (X): A's CalDAV account connects in UniHub; an event UniHub creates in it reaches
// the server, and another client's change to it comes back. The events are removed after.
test('[0-11 X] a Stalwart CalDAV account connects and an event goes both ways', { session: 'blair', tags: ['providers'], timeout: 300_000 }, async ({ app, screen, browser }) => {
  test.skip(!A?.caldavUrl, skipReason);
  await onlyOn(browser, 'desktop');
  const dav: DavLogin = { username: A!.username, password: A!.password };
  await app.open('/calendar');
  type Account = { id: string; provider: string; username: string | null };
  const listAccounts = async () => ok(await pageApi<{ accounts: Account[] }>(browser, 'GET', '/api/calendar/accounts'), 'calendar accounts').accounts;
  if (!(await listAccounts()).some((account) => account.provider === 'caldav' && account.username === A!.username)) {
    await screen.getByRole('button', 'Add calendar account').tap();
    const dialog = screen.getByRole('dialog', 'Add calendar account');
    await dialog.getByLabel('Type').tap();
    await screen.getByRole('option', 'CalDAV server').tap();
    await dialog.getByLabel('Email').fill(secret(A!.email));
    await dialog.getByLabel('User name (optional)').fill(fillValue(A!.username));
    await dialog.getByLabel('Password').fill(secret(A!.password));
    await dialog.getByLabel('Server address (optional)').fill(fillValue(A!.caldavUrl));
    await dialog.getByLabel('Display name').fill('Stalwart A (e2e)');
    await dialog.getByRole('button', 'Connect').tap();
    await expect(dialog).toBeHidden({ timeout: 120_000 });
  }
  const account = (await listAccounts()).find((entry) => entry.provider === 'caldav' && entry.username === A!.username)!;
  type Calendar = { id: string; account_id: string; external_id: string; read_only: boolean };
  const { calendars } = ok(await pageApi<{ calendars: Calendar[] }>(browser, 'GET', '/api/calendar/calendars'), 'calendars');
  const calendar = calendars.find((entry) => entry.account_id === account.id && !entry.read_only);
  expect(calendar, 'a writable calendar on the server').toBeDefined();
  const collection = new URL(calendar!.external_id, A!.caldavUrl).href;

  const id = runId();
  const title = `Provider event ${id}`;
  const start = new Date(Date.now() + 2 * 86_400_000);
  start.setUTCHours(9, 0, 0, 0);
  const created = ok(await pageApi<{ id?: string; event?: { id: string } }>(browser, 'POST', '/api/calendar/events', {
    calendar_id: calendar!.id, title, start_time: start.toISOString(), end_time: new Date(start.getTime() + 3_600_000).toISOString() }), 'create event');
  const external = `Provider external ${id}`;
  const stored = await waitForSummary(collection, dav, title, 120_000);
  try {
    expect(icsValue(stored.ics, 'SUMMARY')).toBe(title);
    const renamed = `${title} renamed elsewhere`;
    await editObject(collection, dav, title, (ics) => withValue(ics, 'SUMMARY', renamed));
    await putObject(`${collection}e2e-${id}.ics`, dav,
      eventIcs({ uid: `e2e-${id}@example.org`, summary: external, start, end: new Date(start.getTime() + 1_800_000) }));
    ok(await pageApi(browser, 'POST', `/api/calendar/accounts/${account.id}/sync`, {}), 'sync');
    const eventId = created.event?.id ?? created.id;
    await expect.poll(async () => {
      const { data } = await pageApi<{ events: { id: string; title: string }[] }>(browser, 'GET',
        `/api/calendar/events?calendar_ids=${calendar!.id}&range_start=${new Date(start.getTime() - 86_400_000).toISOString()}&range_end=${new Date(start.getTime() + 86_400_000).toISOString()}`);
      const titles = (data.events ?? []).map((event) => event.title);
      return { renamed: titles.includes(renamed), external: titles.includes(external), old: titles.includes(title),
        same: (data.events ?? []).some((event) => event.id === eventId && event.title === renamed) };
    }, { timeout: 120_000, interval: 5000 }).toEqual({ renamed: true, external: true, old: false, same: true });
  } finally {
    await deleteObject(stored.url, dav).catch(() => undefined);
    await deleteObject(`${collection}e2e-${id}.ics`, dav).catch(() => undefined);
  }
});
