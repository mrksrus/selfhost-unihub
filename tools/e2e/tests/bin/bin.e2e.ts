import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { people, runId } from '../support/env.ts';
import { collectionUrl, listObjects } from '../support/caldav.ts';
import { ok, pageApi, setSettings } from '../support/api.ts';
import { createContact, listContacts } from '../support/contacts.ts';
import { onlyOn } from '../support/ui.ts';

// 0.28 bin (B, E; P-31): deletes go to the bin with Undo, the bin restores
// and deletes for good, the retention is the person's choice, and a synced
// event restored from the bin is created on the calendar server again, once.
// Blair's data only.

interface BinItem { id: string; module: string; item_type: string; title: string; provider: string; group_id: string | null }
const binItems = async (browser: unknown, module?: string) =>
  ok(await pageApi<{ items: BinItem[]; retention: string }>(browser, 'GET', `/api/bin${module ? `?module=${module}` : ''}`), 'bin');

test('[28-20] a deleted contact is moved to the bin, Undo brings it back, and the bin restores it again', { session: 'blair', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await app.open('/contacts');
  const run = runId();
  const family = `Bin ${run}`;
  const contact = await createContact(browser, { name: { given: 'Dana', family }, emails: [`dana.${run}@example.com`] });
  await app.open(`/contacts?contact=${contact.id}`);
  await screen.getByRole('button', `More actions for Dana ${family}`).tap();
  await screen.getByRole('menuitem', 'Delete contact').tap();
  await screen.getByRole('button', 'Delete', { exact: true }).tap();
  const notice = screen.getByText('Moved to the bin', { exact: true });
  await expect(notice).toBeVisible();
  await screen.getByRole('button', 'Undo', { exact: true }).tap();
  await expect(screen.getByText('Restored', { exact: true })).toBeVisible();
  expect((await listContacts(browser)).some((entry) => entry.id === contact.id || entry.name.family === family), 'back after Undo').toBe(true);

  const again = (await listContacts(browser)).find((entry) => entry.name.family === family)!;
  ok(await pageApi(browser, 'DELETE', `/api/contacts/${again.id}`), 'delete again');
  await app.open('/contacts?view=bin');
  const list = screen.getByRole('list', 'Deleted items');
  await expect(list.getByText(`Dana ${family}`, { exact: true })).toBeVisible();
  await expect(list.getByText(/gone for good/).first()).toBeVisible();
  await list.getByRole('button', `Restore Dana ${family}`).tap();
  await expect(screen.getByText('Restored', { exact: true })).toBeVisible();
  expect((await listContacts(browser)).filter((entry) => entry.name.family === family), 'one copy').toHaveLength(1);
});

test('[28-20] the retention is the person\'s choice, and Empty bin deletes for good after asking', { session: 'blair', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await app.open('/settings?section=bin');
  try {
    await screen.getByRole('combobox', 'Keep deleted items for').tap();
    await screen.getByRole('option', '7 days').tap();
    await expect.poll(async () => (await binItems(browser)).retention, { timeout: 20_000 }).toBe('7');
    await expect(screen.getByText('Items stay here 7 days', { exact: false })).toBeVisible();

    const run = runId();
    const contact = await createContact(browser, { name: { given: 'Eli', family: `Empty ${run}` } });
    ok(await pageApi(browser, 'DELETE', `/api/contacts/${contact.id}`), 'delete');
    await browser.reload();
    const list = screen.getByRole('list', 'Deleted items');
    // Settings → Bin names each item's module beside its title ("… · Contacts").
    await expect(list.getByText(new RegExp(`^Eli Empty ${run}\\b`))).toBeVisible();
    await screen.getByRole('button', 'Empty bin').tap();
    await expect(screen.getByRole('alertdialog')).toContainText('deleted for good');
    await screen.getByRole('button', 'Delete for good').tap();
    await expect(screen.getByText('The bin is empty', { exact: true })).toBeVisible();
    expect((await binItems(browser)).items, 'nothing left').toHaveLength(0);
  } finally {
    await setSettings(browser, { bin_retention: '30' });
  }
});

test('[28-16] a synced event deleted in UniHub is gone at the calendar server and comes back once when restored', { session: 'blair', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/calendar');
  const { calendars } = ok(await pageApi<{ calendars: { id: string; account_provider: string; read_only: boolean; name: string }[] }>(browser, 'GET', '/api/calendar/calendars'), 'calendars');
  const synced = calendars.find((calendar) => calendar.account_provider === 'caldav' && !calendar.read_only)!;
  const run = runId();
  const title = `Bin sync ${run}`;
  const { event } = ok(await pageApi<{ event: { id: string } }>(browser, 'POST', '/api/calendar/events', {
    title, calendar_id: synced.id, start_time: '2026-09-01T10:00:00.000Z', end_time: '2026-09-01T11:00:00.000Z',
  }), 'create event');
  const atServer = async () => (await listObjects(collectionUrl(people.blair.mailbox), people.blair.mailbox)).filter((object) => object.ics.includes(title));
  await expect.poll(atServer, { timeout: 60_000 }).toHaveLength(1);

  ok(await pageApi(browser, 'DELETE', `/api/calendar/events/${event.id}`), 'delete');
  await expect.poll(atServer, { timeout: 60_000 }).toHaveLength(0);
  const item = (await binItems(browser, 'calendar')).items.find((entry) => entry.title === title)!;
  expect(item.provider, 'kept as a synced item').toBe('caldav');

  await app.open('/calendar?view=bin');
  const list = screen.getByRole('list', 'Deleted items');
  await expect(list.getByText(title, { exact: true })).toBeVisible();
  await expect(list.getByText('Restoring creates it on the calendar server again.').first()).toBeVisible();
  await list.getByRole('button', `Restore ${title}`).tap();
  await expect(screen.getByText('Restored', { exact: true })).toBeVisible();
  await expect.poll(atServer, { timeout: 90_000 }).toHaveLength(1);
  const { events } = ok(await pageApi<{ events: { title: string }[] }>(browser, 'GET', '/api/calendar/events?start=2026-09-01T00:00:00.000Z&end=2026-09-02T00:00:00.000Z'), 'events');
  expect(events.filter((entry) => entry.title === title), 'once in UniHub').toHaveLength(1);
});
