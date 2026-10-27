import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { outside, people, runId } from '../support/env.ts';
import { sendMail } from '../support/mail.ts';
import { setSettings } from '../support/api.ts';
import { onlyOn, waitForRow } from '../support/ui.ts';

const mailbox = people.admin.mailbox;

// 24-15: with Preview lines set to 0 to 5, a long message's row shows that many lines of
// its text (none at 0), and the list never gets wider than the screen.
test('[24-15] the mail list shows 0 to 5 preview lines and stays within the screen', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const subject = `Preview ${runId()}`;
  const opening = `Preview words ${subject}`;
  await sendMail({ from: `Sam Sender <${outside.sam}>`, to: [mailbox], subject,
    text: `${opening}. ${'Readable synthetic words for the mail list preview. '.repeat(40)}` });
  await app.open('/mail');
  await setSettings(browser, { mail_preview_lines: 1 });
  try {
    await app.open('/mail');
    await waitForRow(screen, subject, mailbox);
    const row = screen.getByRole('listitem').filter({ hasText: subject });
    const preview = row.getByText(new RegExp(`^${opening}`));
    const oneLine = (await preview.boundingBox())!.height;

    for (const lines of [0, 2, 3, 4, 5]) {
      await setSettings(browser, { mail_preview_lines: lines });
      await app.open('/mail');
      await expect(row).toBeVisible();
      if (lines === 0) {
        await expect(preview).toHaveCount(0);
      } else {
        const height = (await preview.boundingBox())!.height;
        expect(Math.round(height / oneLine), `${lines} lines of preview`).toBe(lines);
      }
      const width = await browser.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: window.innerWidth }));
      expect(width.page, 'no sideways scrolling').toBeLessThanOrEqual(width.screen);
    }
  } finally {
    await setSettings(browser, { mail_preview_lines: 1 });
  }
});
