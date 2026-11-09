import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import type { Screen } from 'e2e';
import { people, runId } from '../support/env.ts';
import { collectionUrl, listObjects } from '../support/caldav.ts';
import { ok, pageApi, setSettings, signIn } from '../support/api.ts';
import { createContact, listContacts } from '../support/contacts.ts';
import { isNarrow, onlyOn } from '../support/ui.ts';

// 0.28 bin (B, E; P-31): deletes go to the bin with Undo, the bin restores
// and deletes for good, the retention is the person's choice, and a synced
// event restored from the bin is created on the calendar server again, once.
// Blair's data only; the administrator's group delete acts on blair's bin.

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

/** The page's panel: the column on desktop; on a phone the sheet that the header's scope chip opens. */
async function openPanel(screen: Screen, browser: unknown, label: string, scope: string) {
  if (!(await isNarrow(browser))) return screen.getByRole('complementary', label);
  await screen.getByRole('button', scope, { exact: true }).tap();
  return screen.getByRole('dialog', label);
}
const query = async (browser: unknown) => new URL(await (browser as { url: () => Promise<string> | string }).url()).searchParams;

test('[28-20] All recordings and a category lead out of the Recordings bin', { session: 'blair', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await app.open('/recordings?view=bin');
  const search = screen.getByRole('searchbox', 'Search recordings');
  await expect(search, 'the bin: no search').toBeDisabled();

  await (await openPanel(screen, browser, 'Recording lists', 'Bin')).getByRole('button', 'All recordings', { exact: true }).tap();
  await expect(search).toBeEnabled();
  expect((await query(browser)).get('view'), 'the bin is left').toBeNull();

  await (await openPanel(screen, browser, 'Recording lists', 'All recordings')).getByRole('button', 'Bin', { exact: true }).tap();
  await expect(search).toBeDisabled();
  await (await openPanel(screen, browser, 'Recording lists', 'Bin')).getByRole('button', 'Music', { exact: true }).tap();
  await expect(search).toBeEnabled();
  const params = await query(browser);
  expect(params.get('view'), 'the bin is left').toBeNull();
  expect(params.get('category'), 'the category is chosen').toBe('music');
});

test('[28-20] New event from the Calendar bin opens the dialog over the bin', { session: 'blair', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await app.open('/calendar?view=bin');
  await expect(screen.getByRole('button', 'Back to the calendar')).toBeVisible();
  await (await openPanel(screen, browser, 'Calendars', 'Bin')).getByRole('button', 'New event', { exact: true }).tap();
  const dialog = screen.getByRole('dialog', 'New event');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', 'Cancel', { exact: true }).tap();
  await expect(dialog).toBeHidden();
  expect((await query(browser)).get('view'), 'still the bin').toBe('bin');
});

test('[28-20] the administrator deletes a grouped item of blair\'s bin for good: the calendar and all its events go', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  const blair = await signIn('blair');
  const { accounts } = ok(await blair<{ accounts: { id: string; provider: string }[] }>('GET', '/api/calendar/accounts'), 'blair accounts');
  const local = accounts.find((account) => account.provider === 'local')
    ?? ok(await blair<{ account: { id: string } }>('POST', '/api/calendar/accounts', { provider: 'local', display_name: 'Local calendars' }), 'local account').account;
  const run = runId();
  const name = `Garden ${run}`;
  const { calendar } = ok(await blair<{ calendar: { id: string } }>('POST', '/api/calendar/calendars', { account_id: local.id, name }), 'calendar');
  for (const title of ['Seed swap', 'Pruning']) {
    ok(await blair('POST', '/api/calendar/events', { title: `${title} ${run}`, calendar_id: calendar.id, start_time: '2026-09-03T10:00:00.000Z', end_time: '2026-09-03T11:00:00.000Z' }), title);
  }
  ok(await blair('DELETE', `/api/calendar/calendars/${calendar.id}`), 'delete the calendar');
  const binned = ok(await blair<{ items: BinItem[] }>('GET', '/api/bin?module=calendar'), 'blair bin').items.filter((item) => item.title === name || item.title.endsWith(run));
  expect(binned, 'the calendar and its events wait as one group').toHaveLength(3);
  const groupId = binned[0].group_id;
  expect(binned.every((item) => item.group_id === groupId), 'one group').toBe(true);

  const admin = await signIn('admin');
  const { users } = ok(await admin<{ users: { id: string; email: string }[] }>('GET', '/api/admin/users'), 'users');
  const blairId = users.find((user) => user.email === people.blair.email)!.id;
  await app.open(`/admin/users/${blairId}`);
  await screen.getByRole('button', `Delete ${name} for good`).tap();
  const confirm = screen.getByRole('dialog', `Delete ${name} for good?`);
  await expect(confirm).toContainText(`3 items of ${people.blair.name} are deleted for good`);
  await expect(confirm.getByTestId('confirm-target')).toContainText(people.blair.email);
  await confirm.getByLabel('Your password', { exact: true }).fill(credentials.user('admin').password);
  await confirm.getByRole('button', 'Delete for good', { exact: true }).tap();
  await expect(screen.getByText('3 items deleted for good', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(confirm).toBeHidden();
  await expect(screen.getByRole('button', `Delete ${name} for good`)).toBeHidden();
  const left = ok(await blair<{ items: BinItem[] }>('GET', '/api/bin?module=calendar'), 'blair bin after').items.filter((item) => item.group_id === groupId);
  expect(left, 'nothing of the group remains').toHaveLength(0);
});
