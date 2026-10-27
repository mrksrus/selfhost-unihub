import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { setSettings } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

const dayButton = /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d{1,2} [A-Z][a-z]+/;

// 24-11: Sunday as the week start and a 30-minute default reminder, chosen in Settings,
// are used by the calendar's week and by a new event.
test('[24-11] the calendar uses the chosen week start and default event reminder', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  await app.open('/settings');
  try {
    await screen.getByLabel('Week starts on', { exact: true }).tap();
    await screen.getByRole('option', 'Sunday', { exact: true }).tap();
    await screen.getByLabel('Reminder for new events', { exact: true }).tap();
    await screen.getByRole('option', '30 minutes before', { exact: true }).tap();
    await expect(screen.getByLabel('Reminder for new events', { exact: true })).toContainText('30 minutes before');

    await app.open('/calendar');
    await screen.getByRole('radio', 'Week', { exact: true }).tap();
    const days = screen.getByRole('button', dayButton);
    await expect(days).toHaveCount(7);
    await expect(days.first()).toHaveAccessibleName(/^Sunday /);
    await expect(days.last()).toHaveAccessibleName(/^Saturday /);

    await screen.getByRole('button', 'New event', { visible: true }).first().tap();
    await expect(screen.getByRole('checkbox', '30 minutes before', { exact: true })).toBeChecked();
    await expect(screen.getByRole('checkbox', 'At event time', { exact: true })).not.toBeChecked();
    await screen.getByRole('button', 'Cancel', { exact: true }).tap();
  } finally {
    // Monday and the event-time reminder are the defaults other tests expect.
    await setSettings(browser, { week_start: 'monday', default_event_reminder: 0 });
  }
});
