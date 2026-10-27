import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { receive } from '../support/mail.ts';
import { mailAccount, ok, pageApi, setSettings } from '../support/api.ts';
import { messageBody, onlyOn, openCompose, typeAtStart } from '../support/ui.ts';

const mailbox = people.admin.mailbox;

// 24-10 / 24-13 / 24-08: admin@mail.test's signature is written in Settings → Mail →
// Signatures with a bold first line. A formatted message carries it formatted; a
// plain-text message carries its plain version on two lines and arrives as text/plain
// only. B-27: the plain version loses the line break ("Sam SenderSynthetic Testing Ltd").
describe('per-account signature', { serial: true, session: 'admin' }, () => {
  test('[24-10] the signature is written in Settings', async ({ app, screen, browser }) => {
    await onlyOn(browser, 'desktop');
    await app.open('/settings?section=mail');
    await setSettings(browser, { compose_format: 'rich', compose_format_switch: true });
    // Start from no signature, so the editor opens empty with plain (not bold) typing.
    ok(await pageApi(browser, 'PUT', `/api/mail/accounts/${(await mailAccount(browser, mailbox)).id}/signature`, { html: '', text: '' }), 'clear the signature');
    await app.open('/settings?section=mail');
    // The row's button ("Add signature") does not name its account; the row does.
    await browser.locator(`xpath=//p[normalize-space()="${mailbox}"]/ancestor::div[contains(@class,"py-4")][1]//button`).tap();
    const field = screen.getByRole('textbox', 'Signature');
    await field.tap();
    await field.press('Control+b');
    await field.pressSequentially('Avery Admin');
    await field.press('Control+b');
    await field.press('Enter');
    await field.pressSequentially('Synthetic Testing Ltd');
    await screen.getByRole('button', 'Save').tap();
    await expect(screen.getByText('Signature saved').first()).toBeVisible();
  });

  test('[24-10 24-08] a formatted message carries the formatted signature', async ({ app, screen, browser }) => {
    await onlyOn(browser, 'desktop');
    const subject = `Rich signature ${runId()}`;
    await app.open('/mail');
    await setSettings(browser, { compose_format: 'rich' });
    await app.open('/mail');
    await openCompose(screen, mailbox);
    await screen.getByLabel('To').fill(outside.sam);
    await screen.getByLabel('Subject').fill(subject);
    await expect(messageBody(screen)).toContainText('Synthetic Testing Ltd');
    await typeAtStart(screen, 'Formatted body line.');
    await screen.getByRole('button', 'Send', { visible: true }).tap();
    const message = await receive(outside.sam, subject);
    expect(String(message.html)).toMatch(/<(b|strong)>\s*Avery Admin\s*<\/(b|strong)>/);
    expect(String(message.html)).toContain('Synthetic Testing Ltd');
  });

  test('[24-10 24-13 B-27] a plain-text message carries the plain signature on its own lines', async ({ app, screen, browser }) => {
    await onlyOn(browser, 'desktop');
    const subject = `Plain signature ${runId()}`;
    await app.open('/mail');
    await setSettings(browser, { compose_format: 'plain' });
    try {
      await app.open('/mail');
      await openCompose(screen, mailbox);
      await screen.getByLabel('To').fill(outside.sam);
      await screen.getByLabel('Subject').fill(subject);
      await expect(messageBody(screen)).toHaveValue(/Avery Admin/);
      await typeAtStart(screen, 'Plain body line.');
      await screen.getByRole('button', 'Send', { visible: true }).tap();
      const message = await receive(outside.sam, subject);
      expect(message.contentType, 'plain text only').toBe('text/plain');
      expect(message.html).toBeFalsy();
      expect(message.text).toMatch(/Plain body line\.[\s\S]*-- \r?\nAvery Admin/);
      expect(message.text).not.toMatch(/<[a-z]+>|\*\*/);
      expect(message.text, 'the signature keeps its line break').toMatch(/Avery Admin\r?\nSynthetic Testing Ltd/);
    } finally {
      await setSettings(browser, { compose_format: 'rich' });
    }
  });
});
