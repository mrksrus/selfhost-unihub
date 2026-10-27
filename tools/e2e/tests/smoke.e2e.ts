import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test('the mail page opens for a signed-in user', { session: 'admin' }, async ({ app, screen, browser }) => {
  await app.open('/mail');
  await expect(browser).toHaveURL(/\/mail/);
  await expect(screen.getByRole('button', /compose|new message/i).first()).toBeVisible();
});
