import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { ok, pageApi } from '../support/api.ts';
import { createContact, getContact, listContacts, runDigits, type ContactRecord } from '../support/contacts.ts';
import { onlyOn } from '../support/ui.ts';

// Blair's contacts are used by these tests only: "Merge all" merges every
// high-confidence group of the account, also those left by earlier runs.

interface Group { id: string; confidence: string; auto_merge: boolean; conflicts: string[]; members: { id: string; version: number }[] }

async function duplicateGroups(browser: unknown) {
  return ok(await pageApi<{ groups: Group[] }>(browser, 'GET', '/api/contacts/duplicates?min=low'), 'list duplicates').groups;
}
const groupOf = (groups: Group[], ids: string[]) => groups.find((group) => ids.every((id) => group.members.some((member) => member.id === id)));
const values = (list: { value: string }[]) => list.map((entry) => entry.value);

// 26-03 and 26-04: two entries for one person (the same email written
// differently, different companies and numbers) are suggested with their
// reason; the review keeps every number and email, and the company is chosen.
test('[26-03 26-04] a suggested duplicate is merged with every number and email kept and the chosen company', { session: 'blair', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const run = runId();
  const digits = runDigits();
  const phone = (n: number) => `+1 212 ${digits}${n}`;
  const a = await createContact(browser, { name: { given: 'Hana', family: `Merge ${run}` }, organization: { name: `Alpha ${run}` },
    emails: [{ value: `hana.${run}@example.com`, label: 'work' }, `hana.work.${run}@example.com`], phones: [phone(1), phone(2), phone(3)] });
  const b = await createContact(browser, { name: { given: 'Hana', family: `Merge ${run}` }, organization: { name: `Beta ${run}` },
    emails: [`HANA.${run}@example.com`, `hana.private.${run}@example.org`], phones: [phone(3), phone(4), phone(5)] });

  await app.open('/contacts?view=duplicates');
  const group = screen.getByRole('region', /^Group of 2, high confidence/).filter({ hasText: `Merge ${run}` });
  await expect(group).toBeVisible({ timeout: 60_000 });
  await expect(group.getByText(new RegExp(`Same email hana\\.${run}@example\\.com`, 'i'))).toBeVisible();
  await expect(group.getByText('Needs your choice', { exact: true })).toBeVisible();
  await group.getByRole('button', 'Review and merge').tap();

  const review = screen.getByRole('dialog', 'Merge 2 contacts into one');
  const kept = review.getByRole('region', 'Kept from all contacts');
  for (const value of [phone(1), phone(2), phone(3), phone(4), phone(5), `hana.work.${run}@example.com`, `hana.private.${run}@example.org`]) {
    await expect(kept.getByText(value, { exact: true })).toBeVisible();
  }
  await expect(kept.getByRole('checkbox')).toHaveCount(0);
  await expect(review.getByRole('button', 'Merge', { exact: true })).toBeDisabled();
  // The radio's input is drawn by its row; a person taps the row's text.
  await review.getByText(`Beta ${run}`, { exact: true }).first().tap();
  await expect(review.getByRole('radio', `Beta ${run}`)).toBeChecked();
  await review.getByRole('button', 'Merge', { exact: true }).tap();
  await expect(screen.getByText('Merged into Hana', { exact: false }).first()).toBeVisible({ timeout: 60_000 });

  const left = (await listContacts(browser)).filter((contact) => contact.name.family === `Merge ${run}`);
  expect(left, 'one contact is left').toHaveLength(1);
  const merged = left[0];
  expect([a.id, b.id]).toContain(merged.id);
  expect(merged.organization.name, 'the chosen company').toBe(`Beta ${run}`);
  expect(values(merged.phones).sort()).toEqual([1, 2, 3, 4, 5].map(phone).sort());
  expect(values(merged.emails).map((email) => email.toLowerCase()).sort()).toEqual(
    [`hana.${run}@example.com`, `hana.work.${run}@example.com`, `hana.private.${run}@example.org`].sort());
});

// 26-05: "Not the same person" is stored on the server and survives a reload.
test('[26-05] "Not the same person" is remembered after a reload', { session: 'blair', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const run = runId();
  const shared = `office.${run}@example.com`;
  const a = await createContact(browser, { name: { given: 'Ivo', family: `Apart ${run}` }, emails: [shared] });
  const b = await createContact(browser, { name: { given: 'Ivo', family: `Apart ${run}` }, emails: [shared], phones: [`+1 313 ${runDigits()}1`] });
  await app.open('/contacts?view=duplicates');
  const group = screen.getByRole('region', /^Group of 2/).filter({ hasText: `Apart ${run}` });
  await expect(group).toBeVisible({ timeout: 60_000 });
  await group.getByRole('button', 'Not the same person').tap();
  await expect(group).toBeHidden({ timeout: 30_000 });
  await (browser as { reload: () => Promise<unknown> }).reload();
  await expect(screen.getByRole('region', /^Group of/).first().or(screen.getByText('No duplicates found'))).toBeVisible({ timeout: 60_000 });
  await expect(screen.getByRole('region', /^Group of 2/).filter({ hasText: `Apart ${run}` })).toHaveCount(0);
  expect(groupOf(await duplicateGroups(browser), [a.id, b.id]), 'the server keeps them apart').toBeUndefined();
  expect((await listContacts(browser)).filter((contact) => contact.name.family === `Apart ${run}`)).toHaveLength(2);
});

// 26-06: a merge is undone from "Recently merged": both contacts are back as
// they were, with their own values.
test('[26-06] undoing a merge from Recently merged brings both contacts back', { session: 'blair', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const run = runId();
  const digits = runDigits();
  const a = await createContact(browser, { name: { given: 'Jon', family: `Undo ${run}` }, emails: [`jon.${run}@example.com`], phones: [`+1 414 ${digits}1`] });
  const b = await createContact(browser, { name: { given: 'Jon', family: `Undo ${run}` }, emails: [`jon.${run}@example.com`, `jon.other.${run}@example.org`], phones: [`+1 414 ${digits}2`] });
  const group = groupOf(await duplicateGroups(browser), [a.id, b.id]);
  expect(group, 'the pair is suggested').toBeDefined();
  ok(await pageApi(browser, 'POST', '/api/contacts/merges', { contact_ids: [a.id, b.id], survivor_id: a.id, choices: {}, versions: { [a.id]: a.version, [b.id]: b.version } }), 'merge');
  expect((await listContacts(browser)).filter((contact) => contact.name.family === `Undo ${run}`)).toHaveLength(1);

  await app.open('/contacts?view=merged');
  const entry = screen.getByRole('listitem').filter({ hasText: `Jon Undo ${run}` }).first();
  await expect(entry).toContainText('Undo until');
  await entry.getByRole('button', `Undo the merge into Jon Undo ${run}`).tap();
  await expect(entry).toContainText('Undone', { timeout: 60_000 });

  const back = (await listContacts(browser)).filter((contact) => contact.name.family === `Undo ${run}`);
  expect(back.map((contact) => contact.id).sort()).toEqual([a.id, b.id].sort());
  const restoredA = await getContact(browser, a.id);
  const restoredB = await getContact(browser, b.id);
  expect(values(restoredA.emails)).toEqual([`jon.${run}@example.com`]);
  expect(values(restoredA.phones)).toEqual([`+1 414 ${digits}1`]);
  expect(values(restoredB.emails)).toEqual([`jon.${run}@example.com`, `jon.other.${run}@example.org`]);
  expect(restoredB.uid).toBe(b.uid);
});

// Slice 6: "Merge all high-confidence" merges only the groups with nothing
// to choose, after a confirmation; a group that needs a choice stays.
test('[26-04] Merge all merges the high-confidence groups without conflicts and leaves the others', { session: 'blair', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const run = runId();
  const digits = runDigits();
  let numbers = 0;
  const pair = async (given: string, extra: Record<string, unknown> = {}, other: Record<string, unknown> = {}) => [
    await createContact(browser, { name: { given, family: `All ${run}` }, emails: [`${given.toLowerCase()}.${run}@example.com`], phones: [`+1 515 ${digits}${++numbers}`], ...extra }),
    await createContact(browser, { name: { given, family: `All ${run}` }, emails: [`${given.toLowerCase()}.${run}@example.com`], ...other }),
  ];
  const kim = await pair('Kim');
  const lea = await pair('Leander');
  const max = await pair('Max', { organization: { name: `One ${run}` } }, { organization: { name: `Two ${run}` } });
  const groups = await duplicateGroups(browser);
  expect(groupOf(groups, kim.map((c) => c.id))?.auto_merge).toBe(true);
  expect(groupOf(groups, lea.map((c) => c.id))?.auto_merge).toBe(true);
  expect(groupOf(groups, max.map((c) => c.id))?.auto_merge, 'a company to choose keeps the group out').toBe(false);

  await app.open('/contacts?view=duplicates');
  await screen.getByRole('button', /^Merge all high-confidence \(\d+\)$/).tap();
  const confirm = screen.getByRole('alertdialog');
  await expect(confirm).toContainText('only groups where nothing has to be chosen are merged');
  await confirm.getByRole('button', 'Merge', { exact: true }).tap();
  await expect(screen.getByText(/groups? merged$/).first()).toBeVisible({ timeout: 120_000 });

  const after = (await listContacts(browser)).filter((contact: ContactRecord) => contact.name.family === `All ${run}`);
  const count = (given: string) => after.filter((contact) => contact.name.given === given).length;
  expect([count('Kim'), count('Leander'), count('Max')]).toEqual([1, 1, 2]);
  const kimNow = after.find((contact) => contact.name.given === 'Kim')!;
  expect(values(kimNow.phones), 'the merge kept the number').toEqual([`+1 515 ${digits}1`]);
  await expect(screen.getByRole('region', /^Group of 2/).filter({ hasText: `Max All ${run}` })).toBeVisible();
});
