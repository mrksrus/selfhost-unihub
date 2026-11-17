import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { people, runId } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';
import { isNarrow, onlyOn } from '../support/ui.ts';
import { createGroup, seededId, sweep } from '../organisation/organisation-helpers.ts';
import { calendarsOf, makeCalendar, removeCalendars, share } from './shared-helpers.ts';

// 32-19, two people: blair offers one of her calendars to alex and can
// withdraw the offer; alex accepts an offer and the calendar is his, with
// blair still editing it. Who may offer to whom, and what moves with the
// calendar, is the server's rule (api/tests, calendar-ownership).

interface Offered { id: string; permission?: string; owner?: { id: string } | null; offer?: { to: { id: string } } | null }
const entry = async (api: Awaited<ReturnType<typeof signIn>>, id: string) => (await calendarsOf(api) as Offered[]).find((calendar) => calendar.id === id);

async function clean() {
  for (const name of ['blair', 'alex'] as const) await removeCalendars(await signIn(name));
  await sweep();
}

/** A calendar of blair's that alex reads, in a group both are in (her reach). */
async function sharedWithAlex(label: string) {
  const alexId = await seededId('alex');
  await createGroup('Support', [alexId, await seededId('blair')]);
  const blair = await signIn('blair');
  const calendar = await makeCalendar(blair, `e2e ${label} ${runId()}`);
  await share(blair, calendar.id, { kind: 'user', id: alexId }, 'read');
  return { alexId, blair, calendar };
}

test('[32-19] blair offers her calendar to alex from its settings and withdraws the offer', { session: 'blair', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await clean();
  try {
    const { alexId, calendar } = await sharedWithAlex('Rota');
    const alex = await signIn('alex');

    await app.open('/calendar');
    await screen.getByRole('button', `Settings for ${calendar.name}`).tap();
    const settings = screen.getByRole('dialog', calendar.name);
    await settings.getByRole('button', 'Hand over…', { exact: true }).tap();
    const dialog = screen.getByRole('dialog', `Hand over ${calendar.name}`);
    await dialog.getByLabel('New owner', { exact: true }).first().fill(people.alex.email);
    await dialog.getByText(people.alex.name, { exact: true }).tap();
    await dialog.getByRole('button', 'Offer', { exact: true }).tap();
    await expect(screen.getByText(`${calendar.name} offered to ${people.alex.name}`, { exact: true }).first()).toBeVisible();
    await expect(settings.getByText(`Offered to ${people.alex.name}`, { exact: true })).toBeVisible();
    expect((await entry(alex, calendar.id))?.offer?.to.id, 'alex has the offer').toBe(alexId);

    await settings.getByRole('button', 'Withdraw offer', { exact: true }).tap();
    await expect(screen.getByText('Offer withdrawn', { exact: true }).first()).toBeVisible();
    await expect(settings.getByRole('button', 'Hand over…', { exact: true })).toBeVisible();
    expect((await entry(alex, calendar.id))?.offer ?? null, 'the offer is gone').toBeNull();
    expect((await entry(alex, calendar.id))?.permission, 'nothing else changed').toBe('read');
  } finally {
    await clean();
  }
});

test('[32-19] alex accepts a calendar blair offers him: it is his, and blair still edits it', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await clean();
  try {
    const { alexId, blair, calendar } = await sharedWithAlex('Roster');
    ok(await blair('POST', `/api/calendar/calendars/${calendar.id}/hand-over`, { to: alexId }), 'blair offers it');
    const alex = await signIn('alex');

    await app.open('/calendar');
    // On a phone the calendars are in the panel's sheet, behind the header's scope.
    if (await isNarrow(browser)) await screen.getByRole('button', /calendars$/, { visible: true }).first().tap();
    const offer = screen.getByRole('region', `Offer of ${calendar.name}`);
    await expect(offer.getByText(people.blair.name, { exact: true }).first()).toBeVisible();
    await offer.getByRole('button', 'Accept', { exact: true }).tap();
    await expect(screen.getByText(`${calendar.name} is your calendar now`, { exact: true }).first()).toBeVisible();
    await expect(offer).toHaveCount(0);
    expect(await entry(alex, calendar.id), 'alex owns it').toMatchObject({ permission: 'manage', owner: null, offer: null });
    expect(await entry(blair, calendar.id), 'blair keeps editing it').toMatchObject({ permission: 'edit', owner: { id: alexId } });
  } finally {
    await clean();
  }
});
