import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { sendMail } from '../support/mail.ts';
import { emailsWithSubject } from '../support/api.ts';
import { onlyOn, openMessage } from '../support/ui.ts';

const mailbox = people.admin.mailbox;

// 0-04: a task made from a message is listed in ToDo with a link back to the message,
// and Show email peeks at the message there.
test('[0-04] a task made from a message shows the message in ToDo', { session: 'admin', tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Email task ${runId()}`;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'Please review the synthetic report.' });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('button', 'Add task').tap();
  const title = `Review ${subject}`;
  await screen.getByLabel('Title', { exact: true }).fill(title);
  await screen.getByRole('dialog').getByRole('button', 'Add task').tap();
  await expect(screen.getByRole('dialog')).toBeHidden();
  await expect(screen.getByRole('region', 'Tasks').getByRole('link', new RegExp(title))).toBeVisible();

  await app.open('/todo');
  const row = screen.getByRole('listitem').filter({ hasText: title });
  await row.getByRole('button', 'Show email').tap();
  const peek = screen.getByRole('dialog', 'Email');
  await expect(peek).toContainText(subject);
  await expect(peek).toContainText('Please review the synthetic report.');
  await expect(peek.getByRole('link', 'Open in Mail')).toBeVisible();
});

// 23-07 / 0-04 (task link): a task made from a message leads back to it, and
// the reader opened that way settles, so its read control works. B-25: from
// Show email → Open in Mail the reader keeps loading and turns unread back to read.
test('[23-07 0-04 B-25] a message opened from its task settles and stays unread when marked unread', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Task link ${runId()}`;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'A message that becomes a task.' });
  const readCommands: string[] = [];
  await browser.route(/\/api\/mail\/emails\/[^/]+\/read$/, async (route) => {
    readCommands.push(String(route.request.postData));
    await route.fallback();
  });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('button', 'Add task').tap();
  const title = `Follow up ${subject}`;
  await screen.getByLabel('Title', { exact: true }).fill(title);
  await screen.getByRole('dialog').getByRole('button', 'Add task').tap();
  await expect(screen.getByRole('dialog')).toBeHidden();

  // The reader lists the task; its link opens ToDo, which peeks at the message.
  await screen.getByRole('region', 'Tasks').getByRole('link', new RegExp(title)).tap();
  await expect(browser).toHaveURL(/\/todo/);
  await screen.getByRole('listitem').filter({ hasText: title }).getByRole('button', 'Show email').tap();
  await screen.getByRole('link', 'Open in Mail').tap();
  await expect(browser).toHaveURL(/\/mail/);
  await expect(screen.getByText('A message that becomes a task.').first()).toBeVisible();
  await expect(screen.getByRole('button', 'Mark unread')).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByRole('status').filter({ hasText: 'Loading email' })).toHaveCount(0);

  const before = readCommands.length;
  await screen.getByRole('button', 'Mark unread').tap();
  await expect(screen.getByRole('button', 'Mark read')).toBeVisible();
  await expect.poll(async () => (await emailsWithSubject(browser, 'inbox', subject))[0]?.is_read, { timeout: 15_000 }).toBe(false);
  await expect(screen.getByRole('button', 'Mark read')).toBeVisible();
  expect(readCommands.slice(before), 'one unread command, not unread then read').toEqual([expect.stringContaining('false')]);
});

// B-38: the Add task dialog keeps a long subject inside its width. The dialog never
// scrolls sideways (also not when the title takes focus), and Cancel and Add task
// stay inside it, on desktop and on a phone.
test('[B-38] the Add task dialog fits a long subject on desktop and phone', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const subject = `Long subject ${runId()}: quarterly planning notes for the platform, infrastructure and documentation working groups, with the revised schedule and the follow-up actions`;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject, text: 'A message whose subject is longer than the dialog.' });
  await app.open('/mail');
  await openMessage(screen, subject, mailbox);
  await screen.getByRole('button', 'Add task').tap();
  const dialog = screen.getByRole('dialog', 'Add task');
  await expect(dialog.getByText(subject)).toBeVisible();
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue(subject);
  // Measure the settled dialog: it opens with a short zoom and slide.
  await browser.evaluate(() => Promise.all([...document.querySelectorAll('[role="dialog"]')]
    .flatMap(element => element.getAnimations({ subtree: true }))
    .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => undefined))).then(() => true));

  const geometry = await browser.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')!;
    const box = dialog.getBoundingClientRect();
    const actions = [...dialog.querySelectorAll('button')]
      .filter(button => /^(Cancel|Add task)$/.test(button.textContent?.trim() ?? ''))
      .map(button => ({ text: button.textContent?.trim(), ...button.getBoundingClientRect().toJSON() }));
    return { scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth, scrollLeft: dialog.scrollLeft, left: box.left, right: box.right, screen: window.innerWidth, page: document.documentElement.scrollWidth, actions };
  });
  expect(geometry.scrollWidth, 'the dialog has no sideways overflow').toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.scrollLeft, 'focusing the title did not scroll the dialog sideways').toBe(0);
  expect(geometry.right, 'the dialog is within the screen').toBeLessThanOrEqual(geometry.screen);
  expect(geometry.page, 'the page has no sideways scrolling').toBeLessThanOrEqual(geometry.screen);
  expect(geometry.actions.map(action => action.text), 'both footer actions are in the dialog').toEqual(['Cancel', 'Add task']);
  for (const action of geometry.actions) {
    expect(action.left, `${action.text} starts inside the dialog`).toBeGreaterThanOrEqual(geometry.left);
    expect(action.right, `${action.text} ends inside the dialog`).toBeLessThanOrEqual(geometry.right);
  }
  await dialog.getByRole('button', 'Cancel').tap();
  await expect(dialog).toBeHidden();
});
