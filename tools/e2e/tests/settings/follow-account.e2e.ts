import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import { ok, setSettings, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

const choices = { mailto: 'Open the device mail app', internal: 'Write in UniHub' } as const;

// 24-09: a preference changed on one device shows on another device signed in to the
// same account, and does not change another person's preference.
test('[24-09] a preference follows the account to another device, not to another person', { session: 'alex', tags: ['smoke'] }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  await app.open('/settings');
  // Start from the default, so the change is visible whatever an earlier run left.
  await setSettings(browser, { email_link_behavior: 'mailto' });
  const blair = await signIn('blair');
  ok(await blair('PUT', '/api/settings/values', { values: { email_link_behavior: 'mailto' } }), 'blair default');
  try {
    await app.open('/settings');
    const control = screen.getByLabel('Email addresses', { exact: true });
    await expect(control).toContainText(choices.mailto);
    await control.tap();
    await screen.getByRole('option', choices.internal, { exact: true }).tap();
    await expect(control).toContainText(choices.internal);

    // Another device: a fresh browser with nothing stored, signed in as alex.
    await app.clearState();
    await app.open('/auth');
    const alex = credentials.user('alex');
    await screen.getByLabel('Email').fill(alex.username);
    await screen.getByLabel('Password').fill(alex.password);
    await screen.getByRole('button', 'Sign in').tap();
    await expect(browser).toHaveURL(/\/(mail|dashboard)/);
    await app.open('/settings');
    await expect(screen.getByLabel('Email addresses', { exact: true })).toContainText(choices.internal);

    const { settings } = ok(await blair<{ settings: Record<string, { value: unknown }> }>('GET', '/api/settings/values'), 'blair settings');
    expect(settings.email_link_behavior.value, 'another person keeps their own value').toBe('mailto');
  } finally {
    await setSettings(browser, { email_link_behavior: 'mailto' });
  }
});
