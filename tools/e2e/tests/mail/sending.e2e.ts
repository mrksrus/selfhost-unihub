import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, restartApi, runId, stack } from '../support/env.ts';
import { deliveredWithSubject, receive, waitForDelivery } from '../support/mail.ts';
import { emailsWithSubject } from '../support/api.ts';
import { composeDialog, onlyOn, openCompose, typeAtStart } from '../support/ui.ts';

const sendRequest = /\/api\/mail\/(send|drafts\/[^/]+\/send)$/;
type App = { open: (path?: string) => Promise<unknown> };

async function compose(app: App, screen: Parameters<typeof openCompose>[0], subject: string) {
  await app.open('/mail');
  await openCompose(screen, people.admin.mailbox);
  await screen.getByLabel('To').fill(outside.sam);
  await screen.getByLabel('Subject').fill(subject);
  await typeAtStart(screen, 'Sent on a slow path.');
}

// 23-15 (B-02/B-03) and B-28: a saved draft is sent on a slow connection (the request
// takes 10 s to reach the server). While it is on its way the composer shows
// "Sending..." and does not offer Send again; pressing Enter in Subject sends nothing
// more; no "Attachment error" appears; the message arrives once.
test('[23-15 B-28] a draft sent on a slow connection shows Sending… and arrives once', { session: 'admin', tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  const subject = `Slow send ${runId()}`;
  const keys: string[] = [];
  await browser.route(sendRequest, async (route) => {
    keys.push(String(route.request.headers['idempotency-key']));
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await route.fallback();
  });
  await compose(app, screen, subject);
  await screen.getByRole('button', 'Save draft', { visible: true }).tap();
  await expect(screen.getByText(/^Draft saved/).first()).toBeVisible();
  await screen.getByRole('button', 'Send', { visible: true }).tap();
  await expect.poll(() => keys.length, { timeout: 20_000 }).toBe(1);
  await expect(screen.getByRole('button', 'Sending...', { visible: true })).toBeDisabled();
  await screen.getByLabel('Subject').press('Enter');
  await expect(screen.getByText('Attachment error')).toHaveCount(0);
  await expect(composeDialog(screen)).toBeHidden({ timeout: 30_000 });
  await receive(outside.sam, subject);
  expect(new Set(keys).size, 'one send, retried under one key at most').toBe(1);
  // A late duplicate would arrive within a few seconds of the first.
  await waitForDelivery(outside.sam, subject, { count: 2, timeout: 10_000 });
  expect((await deliveredWithSubject(outside.sam, subject)).length, 'delivered exactly once').toBe(1);
});

// 23-15: the server answered that the send may have been sent (the connection to the
// mail server was lost after hand-over). "Send again" in that notice sends the open
// message once more under a new key; it arrives once and the composer closes.
test('[23-15] "Send again" after a may-have-been-sent answer sends the open message once', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const subject = `Send again ${runId()}`;
  const keys: string[] = [];
  await browser.route(sendRequest, async (route) => {
    keys.push(String(route.request.headers['idempotency-key']));
    if (keys.length === 1) {
      await route.fulfill({ status: 409, contentType: 'application/json', json: { code: 'SEND_OUTCOME_UNKNOWN',
        error: 'The connection to the mail server was lost after the message was handed over, so it may have been sent.' } });
    } else await route.fallback();
  });
  await compose(app, screen, subject);
  await screen.getByRole('button', 'Send', { visible: true }).tap();
  await expect(screen.getByText('The email may have been sent').first()).toBeVisible();
  // B-31: the notice sits outside the modal composer and stays in the accessibility tree.
  await screen.getByRole('button', 'Send again').tap();
  await receive(outside.sam, subject, 30_000);
  expect(keys).toHaveLength(2);
  expect(keys[1], 'under a new key').not.toBe(keys[0]);
  await expect(composeDialog(screen)).toBeHidden();
  expect((await deliveredWithSubject(outside.sam, subject)).length).toBe(1);
});

// The stack's pid files hold "pid start-time".
const greenmailPid = () => readFileSync(`${stack.state}/run/greenmail.pid`, 'utf8').trim().split(/\s+/)[0];
const resumeMail = () => { try { execFileSync('kill', ['-CONT', greenmailPid()]); } catch { /* not paused */ } };
afterEach(async () => { resumeMail(); });

// 23-15 (B-02/B-03) and B-29: the API restarts (as docker stop) while it is inside the
// SMTP session of a saved draft (GreenMail paused, so the hand-over hangs). Nothing is
// delivered twice and the composer stays open. Send is refused as "Still sending" only
// while the interrupted send's key reports it in progress (about 2 minutes, not the 10
// of B-29); then it says the message may have been sent, and Send again sends it once.
test('[23-15 B-29] a send interrupted by an API restart can be sent again soon, once', { session: 'admin', tags: ['slow'], timeout: 420_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const subject = `Restart send ${runId()}`;
  await compose(app, screen, subject);
  await screen.getByRole('button', 'Save draft', { visible: true }).tap();
  await expect(screen.getByText(/^Draft saved/).first()).toBeVisible();
  execFileSync('kill', ['-STOP', greenmailPid()]);
  await screen.getByRole('button', 'Send', { visible: true }).tap();
  await expect(screen.getByRole('button', 'Sending...', { visible: true })).toBeVisible();
  restartApi();
  resumeMail();
  const interrupted = Date.now();
  await expect(composeDialog(screen)).toBeVisible();
  expect((await deliveredWithSubject(outside.sam, subject)).length, 'nothing delivered by the interrupted send').toBe(0);

  const mayHaveBeenSent = screen.getByText('The email may have been sent').first();
  await expect.poll(async () => {
    if (await mayHaveBeenSent.isVisible()) return true;
    await screen.getByRole('button', 'Send', { visible: true }).tap({ timeout: 30_000 });
    await expect(mayHaveBeenSent.or(screen.getByText('Still sending').first())).toBeVisible({ timeout: 30_000 });
    return mayHaveBeenSent.isVisible();
  }, { timeout: 200_000, intervals: [15_000] }).toBe(true);
  expect(Date.now() - interrupted, 'released within the key\'s window, not the 10-minute stale limit').toBeLessThan(240_000);
  expect((await deliveredWithSubject(outside.sam, subject)).length, 'the same key sent nothing').toBe(0);
  await screen.getByRole('button', 'Send again').tap();
  await receive(outside.sam, subject, 60_000);
  await expect(composeDialog(screen)).toBeHidden();
  await waitForDelivery(outside.sam, subject, { count: 2, timeout: 10_000 });
  expect((await deliveredWithSubject(outside.sam, subject)).length, 'delivered exactly once').toBe(1);
  expect(await emailsWithSubject(browser, 'sent', subject), 'one copy in Sent').toHaveLength(1);
});
