import { test } from '@e2e-dev/web';
import type { Screen } from 'e2e';
import { expect } from 'e2e';
import { people, runId } from '../support/env.ts';
import { editObject, eventIcs, icsValue, putObject, collectionUrl, waitForSummary, withValue } from '../support/caldav.ts';
import { onlyOn } from '../support/ui.ts';

const mailbox = people.admin.mailbox;
const account = `${people.admin.name} (CalDAV)`;

/** Asks UniHub to sync the CalDAV account now (calendar panel, the account's actions). */
async function syncCalendar(screen: Screen) {
  await screen.getByRole('button', `Actions for ${account}`, { visible: true }).tap();
  await screen.getByRole('menuitem', 'Sync now').tap();
}

/** Waits until an event title shows in the week view, syncing meanwhile and looking one week ahead. */
async function waitForEvent(screen: Screen, title: string, timeout = 90_000) {
  const event = screen.getByText(title, { exact: true, visible: true }).first();
  const end = Date.now() + timeout;
  for (let round = 0; !(await event.isVisible()) && Date.now() < end; round++) {
    if (round === 1) await screen.getByRole('button', 'Next week').tap();
    if (round === 2) await screen.getByRole('button', 'Previous week').tap();
    await syncCalendar(screen);
    await expect(event).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
  }
  await expect(event).toBeVisible();
}

// 0-11 / 23-20: CalDAV both ways with Radicale. An event created in UniHub on the CalDAV
// calendar reaches the server; another client's change to it, and an event another client
// creates, come back to UniHub. Nothing is duplicated.
test('[0-11 23-20] a CalDAV event made in UniHub reaches the server and another client\'s changes come back', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const id = runId();
  const title = `CalDAV event ${id}`;
  await app.open('/calendar');
  await screen.getByRole('radio', 'Week', { exact: true }).tap();
  await screen.getByRole('button', 'New event', { visible: true }).first().tap();
  const dialog = screen.getByRole('dialog');
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByLabel('Calendar', { exact: true }).tap();
  await screen.getByRole('option', 'Calendar', { exact: true }).tap();
  await dialog.getByLabel('Notes', { exact: true }).fill(`Made in UniHub (${id}).`);
  await dialog.getByRole('button', 'Create', { exact: true }).tap();
  await expect(screen.getByRole('dialog')).toBeHidden();

  const calendar = collectionUrl(mailbox);
  const stored = await waitForSummary(calendar, mailbox, title);
  expect(icsValue(stored.ics, 'DESCRIPTION')).toBe(`Made in UniHub (${id}).`);

  // Another client renames it (keeping its UID and replacing only the version it read).
  const renamed = `${title} renamed elsewhere`;
  await editObject(calendar, mailbox, title, (ics) => withValue(ics, 'SUMMARY', renamed));
  // And adds an event of its own, tomorrow at noon UTC.
  const external = `External event ${id}`;
  const noon = new Date(Date.now() + 86_400_000);
  noon.setUTCHours(12, 0, 0, 0);
  await putObject(`${calendar}e2e-${id}.ics`, mailbox,
    eventIcs({ uid: `e2e-${id}@example.org`, summary: external, start: noon, end: new Date(noon.getTime() + 3_600_000) }));

  await app.open('/calendar');
  await screen.getByRole('radio', 'Week', { exact: true }).tap();
  await waitForEvent(screen, renamed);
  await expect(screen.getByText(title, { exact: true })).toHaveCount(0);
  await waitForEvent(screen, external);
  await expect(screen.getByText(external, { exact: true })).toHaveCount(1);
  // The server still has one object for the event made in UniHub.
  expect((await waitForSummary(calendar, mailbox, renamed)).href).toBe(stored.href);
});
