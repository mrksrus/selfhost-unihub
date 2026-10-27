import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { plainText, receive, sendMail } from '../support/mail.ts';
import { setSettings } from '../support/api.ts';
import { messageBody, onlyOn, openCompose, openMessage } from '../support/ui.ts';

const mailbox = people.admin.mailbox;

// 24-16: a template made in Settings → Mail → Templates starts a new message (its
// subject and text) and a reply (its text; the reply keeps "Re: …" and its threading).
test('[24-16] a template starts a new message and a reply', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const id = runId();
  const name = `Thanks ${id}`;
  const templateSubject = `Template subject ${id}`;
  const templateText = `Thank you for your message (template ${id}).`;

  await app.open('/settings?section=mail');
  await setSettings(browser, { compose_templates: true, compose_format: 'rich' });
  await app.open('/settings?section=mail');
  await screen.getByRole('button', 'New template').tap();
  await screen.getByLabel('Name').fill(name);
  await screen.getByLabel('Subject').fill(templateSubject);
  const text = screen.getByRole('textbox', 'Text');
  await text.tap();
  await text.pressSequentially(templateText);
  await screen.getByRole('button', 'Save').tap();
  await expect(screen.getByText('Template added').first()).toBeVisible();

  await app.open('/mail');
  await openCompose(screen, mailbox);
  await screen.getByLabel('To').fill(outside.sam);
  await screen.getByRole('button', 'Templates', { visible: true }).tap();
  await screen.getByRole('menuitem', name).tap();
  await expect(screen.getByLabel('Subject')).toHaveValue(templateSubject);
  await expect(messageBody(screen)).toContainText(templateText);
  await screen.getByRole('button', 'Send', { visible: true }).tap();
  expect(plainText(await receive(outside.sam, templateSubject))).toContain(templateText);

  const subject = `Template reply ${id}`;
  const original = await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'Can you confirm?' });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('button', 'Reply', { visible: true }).first().tap();
  await screen.getByRole('button', 'Templates', { visible: true }).tap();
  await screen.getByRole('menuitem', name).tap();
  await expect(messageBody(screen)).toContainText(templateText);
  await screen.getByRole('button', 'Send', { visible: true }).tap();
  const reply = await receive(outside.sam, `Re: ${subject}`);
  expect(reply.inReplyTo).toBe(original);
  expect(plainText(reply)).toContain(templateText);
});
