import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { delivered, providerFlags, receive, sendMail } from '../support/mail.ts';
import { emailsWithSubject, setSettings } from '../support/api.ts';
import { composeDialog, messageBody, onlyOn, openFolder, openMessage, typeAtStart, waitForRow } from '../support/ui.ts';

const mailbox = people.admin.mailbox;

// 23-24 / 24-14: sam writes to admin; admin replies from UniHub. At sam's mailbox the
// reply carries In-Reply-To = the original's Message-ID and References ending with it,
// so sam's mail program files it in the same conversation.
test('[23-24 24-14] a reply from UniHub carries In-Reply-To and References', { session: 'admin', tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Thread ${runId()}`;
  const original = await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'First message of the thread.' });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('button', 'Reply', { visible: true }).first().tap();
  await typeAtStart(screen, 'Direct reply from UniHub.');
  await screen.getByRole('button', 'Send', { visible: true }).tap();

  const reply = await receive(outside.sam, `Re: ${subject}`);
  expect(reply.from).toBe(mailbox);
  expect(reply.inReplyTo).toBe(original);
  expect(reply.references.at(-1)).toBe(original);
  expect(reply.text).toContain('Direct reply from UniHub.');
});

// 23-24 (a reply finished later from Drafts), 23-05 (the draft opens with its body) and
// 24-14 (threaded view): admin starts a reply, saves it as a draft, reopens it from
// Drafts on a fresh page and sends it. Sam answers. With Conversations on, UniHub
// lists the original, the reply and sam's answer as one conversation.
test('[23-24 23-05 24-14] a reply finished from Drafts is threaded, and the conversation is one row', { session: 'admin', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const subject = `Draft thread ${runId()}`;
  const original = await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'Please answer later.' });
  await app.open('/mail');
  await setSettings(browser, { mail_threaded_view: false });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('button', 'Reply', { visible: true }).first().tap();
  await typeAtStart(screen, 'Reply written now, sent later from Drafts.');
  await screen.getByRole('button', 'Save draft', { visible: true }).tap();
  await expect(screen.getByText(/^Draft saved/).first()).toBeVisible();

  await openFolder(app, screen, browser, 'Drafts');
  await screen.getByText(`Re: ${subject}`).first().tap();
  await expect(composeDialog(screen)).toBeVisible();
  await expect(messageBody(screen)).toContainText('Reply written now, sent later from Drafts.');
  await screen.getByRole('button', 'Send', { visible: true }).tap();

  const reply = await receive(outside.sam, `Re: ${subject}`);
  expect.soft(reply.inReplyTo, 'In-Reply-To of the reply sent from Drafts').toBe(original);
  expect.soft(reply.references, 'References of the reply sent from Drafts').toContain(original);

  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject: `Re: ${subject}`, text: 'Thanks, got it.',
    inReplyTo: reply.messageId, references: [original, reply.messageId!] });
  await setSettings(browser, { mail_threaded_view: true });
  try {
    await app.open('/mail');
    await waitForRow(screen, `Re: ${subject}`, mailbox);
    // One row for the conversation: the original is not listed on its own.
    await expect(screen.getByRole('listitem').filter({ hasText: subject })).toHaveCount(1);
    await screen.getByText(`Re: ${subject}`, { exact: true, visible: true }).tap();
    // The open conversation holds the original, the reply and the answer.
    await expect(screen.getByRole('region', 'Conversation, 3 messages')).toBeVisible();
    const inbox = [...await emailsWithSubject(browser, 'inbox', subject), ...await emailsWithSubject(browser, 'inbox', `Re: ${subject}`)];
    expect(new Set(inbox.map((e) => e.thread_key)).size, 'one conversation').toBe(1);
  } finally {
    await setSettings(browser, { mail_threaded_view: false });
  }
});

// 24-12: sam writes To admin and alex, Cc carol and Dana. Admin answers with Reply all:
// the reply reaches sam, alex, carol and Dana, and not admin's own mailbox.
test('[24-12] reply all reaches To and Cc but not the sender', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Reply all ${runId()}`;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox, people.alex.mailbox],
    cc: [outside.carol, 'Dana Example <dana@example.net>'], subject, text: 'Everyone, please reply all.' });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('button', 'Reply all', { visible: true }).first().tap();
  await typeAtStart(screen, 'Replying to all of you.');
  await screen.getByRole('button', 'Send', { visible: true }).tap();

  const replySubject = `Re: ${subject}`;
  const atSam = await receive(outside.sam, replySubject);
  for (const recipient of [people.alex.mailbox, outside.carol, 'dana@example.net']) {
    expect.soft((await receive(recipient, replySubject, 15_000)).subject, `delivered to ${recipient}`).toBe(replySubject);
  }
  expect([...atSam.to, ...atSam.cc]).not.toContain(mailbox);
  expect(atSam.to).toContain(outside.sam);
  expect(atSam.cc).toEqual(expect.arrayContaining([outside.carol, 'dana@example.net']));
  // Not delivered back to the sender's own inbox (a copy in Sent is expected).
  expect(await providerFlags(mailbox, replySubject, 'INBOX'), 'no copy in the sender\'s inbox').toBeNull();
});

// 23-24: answering a message whose subject already starts with "Re:" keeps one prefix, as
// mail programs do; "Re: Re: …" piles up in long threads. (On 0.24.2 the composer always
// adds "Re: ", src/hooks/use-mail-compose.ts.)
test('[23-24] a reply to a "Re:" message keeps a single Re: prefix', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const id = runId();
  const subject = `Re: Prefix ${id}`;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'An answer in a longer thread.' });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('button', 'Reply', { visible: true }).first().tap();
  await expect(screen.getByLabel('Subject')).toHaveValue(subject);
  await typeAtStart(screen, 'Still the same thread.');
  await screen.getByRole('button', 'Send', { visible: true }).tap();
  // Sam's mailbox holds only the reply; wait for it whatever its subject became.
  await expect.poll(async () => (await delivered(outside.sam)).filter((m) => m.subject.endsWith(`Prefix ${id}`)).map((m) => m.subject),
    { timeout: 60_000 }).toEqual([subject]);
});
