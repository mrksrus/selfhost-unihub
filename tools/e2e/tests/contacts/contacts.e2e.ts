import { test } from '@e2e-dev/web';
import type { Screen } from 'e2e';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { ok, pageApi } from '../support/api.ts';
import { onlyOn, targetOf } from '../support/ui.ts';
import { createContact, getContact, listContacts, runDigits } from '../support/contacts.ts';

/** Picks a label for a value row of the open editor (a Radix select: the trigger, then the option). */
async function pickLabel(screen: Screen, row: string, label: string) {
  await screen.getByRole('dialog').getByRole('combobox', `Label of ${row}`).tap();
  await screen.getByRole('option', label, { exact: true }).tap();
}

// 23-09: a contact note of 15,000+ characters saves and reloads exactly, also
// beside a second entry for the same email.
test('[23-09] a long contact note saves whole', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const id = runId();
  const email = `note-${id}@example.com`;
  const longNote = Array.from({ length: 240 }, (_, i) => `Line ${i}: a deliberately long synthetic contact note.`).join('\n');
  const digits = runDigits();
  for (const [phone, note] of [[`+1202${digits}1`, longNote], [`+1202${digits}2`, `Second entry note ${id}`]]) {
    await app.open('/contacts?action=new');
    const dialog = screen.getByRole('dialog');
    await dialog.getByLabel('First name', { exact: true }).fill(`Note${id}`);
    await dialog.getByLabel('Last name', { exact: true }).fill('Synthetic');
    await dialog.getByLabel('Email', { exact: true }).fill(email);
    await dialog.getByLabel('Phone', { exact: true }).fill(phone);
    await dialog.getByRole('textbox', 'Notes', { exact: true }).fill(note);
    await dialog.getByRole('button', 'Add contact').tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
  }
  const pair = (await listContacts(browser)).filter((contact) => contact.emails.some((entry) => entry.value === email));
  expect(pair).toHaveLength(2);
  const long = pair.find((contact) => contact.notes === longNote);
  expect(long, `the ${longNote.length}-character note is stored whole`).toBeDefined();
  await app.open(`/contacts?contact=${long!.id}`);
  await screen.getByRole('button', 'Edit', { exact: true }).tap();
  await expect(screen.getByRole('dialog').getByRole('textbox', 'Notes', { exact: true })).toHaveValue(longNote);
  await screen.getByRole('button', 'Cancel', { exact: true }).tap();
});

// 26-02 (web part; the phone's contacts store is tools/e2e/android/contacts.test.mjs):
// a contact with 5 numbers and 4 emails, each labelled, is saved from the editor
// and shown with its labels; the old apps' 3+3 projection holds the first three.
test('[26-02] a contact with 5 numbers and 4 emails keeps every value and label', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  const target = await targetOf(browser);
  const id = runId();
  const digits = runDigits();
  const phones = [['+1 303', 'Mobile'], ['+1 304', 'Work'], ['+1 305', 'Home'], ['+1 306', 'Pager'], ['+1 307', 'Main']].map(([prefix, label], i) => ({ value: `${prefix} ${digits}${i}`, label }));
  const emails = [['work', 'Work'], ['home', 'Home'], ['other', 'Other'], ['mobile', 'Mobile']].map(([kind, label]) => ({ value: `${kind}.${id}@example.com`, label }));
  await app.open('/contacts?action=new');
  const dialog = screen.getByRole('dialog');
  await dialog.getByLabel('First name', { exact: true }).fill(`Many${id}`);
  await dialog.getByLabel('Last name', { exact: true }).fill(`Values ${target}`);
  await dialog.getByLabel('Phone', { exact: true }).fill(phones[0].value);
  for (let i = 1; i < phones.length; i++) {
    await dialog.getByRole('button', 'Add another phone number').tap();
    await dialog.getByLabel(`Phone ${i + 1}`, { exact: true }).fill(phones[i].value);
  }
  for (let i = 0; i < phones.length; i++) await pickLabel(screen, `phone ${i + 1}`, phones[i].label);
  await dialog.getByLabel('Email', { exact: true }).fill(emails[0].value);
  for (let i = 1; i < emails.length; i++) {
    await dialog.getByRole('button', 'Add another email').tap();
    await dialog.getByLabel(`Email ${i + 1}`, { exact: true }).fill(emails[i].value);
  }
  for (let i = 0; i < emails.length; i++) await pickLabel(screen, `email ${i + 1}`, emails[i].label);
  await dialog.getByRole('button', 'Preferred phone 2').tap();
  await dialog.getByRole('button', 'Add contact').tap();
  await expect(screen.getByRole('dialog')).toBeHidden();

  const saved = (await listContacts(browser)).find((contact) => contact.name.given === `Many${id}`);
  expect(saved, 'the contact is stored').toBeDefined();
  expect(saved!.phones.map((entry) => [entry.value, entry.label, entry.preferred])).toEqual(
    phones.map((phone, i) => [phone.value, phone.label.toLowerCase(), i === 1]));
  expect(saved!.emails.map((entry) => [entry.value, entry.label])).toEqual(emails.map((email) => [email.value, email.label.toLowerCase()]));
  // What an Android app of 0.24.3 to 0.25.1 reads: the first three of each, by position.
  expect([saved!.phone, saved!.phone2, saved!.phone3]).toEqual(phones.slice(0, 3).map((phone) => phone.value));
  expect([saved!.email, saved!.email2, saved!.email3]).toEqual(emails.slice(0, 3).map((email) => email.value));

  await app.open(`/contacts?contact=${saved!.id}`);
  const detail = screen.getByRole('article', `Many${id} Values ${target}`);
  const numbers = detail.getByRole('region', 'Phone', { exact: true });
  for (const phone of phones) await expect(numbers.getByText(phone.value, { exact: true })).toBeVisible();
  await expect(numbers.getByText('Pager', { exact: true })).toBeVisible();
  const addresses = detail.getByRole('region', 'Email', { exact: true });
  for (const email of emails) await expect(addresses.getByText(email.value, { exact: true })).toBeVisible();
});

// D17 and F12: a contact changed elsewhere since the editor opened is not
// overwritten silently; the person keeps their edits and chooses.
test('[26-02] a stale save keeps the edits and offers their version or mine', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/contacts');
  const id = runId();
  const created = await createContact(browser, { name: { given: `Stale${id}`, family: 'Original' }, emails: [{ value: `stale-${id}@example.com`, label: 'work' }] });
  await app.open(`/contacts?contact=${created.id}`);
  await screen.getByRole('button', 'Edit', { exact: true }).tap();
  const dialog = screen.getByRole('dialog');
  await dialog.getByLabel('Last name', { exact: true }).fill('Mine');
  // Another device saves first.
  const theirs = { name: { given: `Stale${id}`, family: 'Theirs' }, emails: [{ id: created.emails[0].id, value: `stale-${id}@example.com`, label: 'work' }], version: created.version };
  ok(await pageApi(browser, 'PUT', `/api/contacts/${created.id}`, theirs), 'save from another device');
  await dialog.getByRole('button', 'Save', { exact: true }).tap();
  await expect(dialog.getByText(/changed on another device meanwhile/)).toBeVisible();
  await expect(dialog.getByLabel('Last name', { exact: true })).toHaveValue('Mine');
  await dialog.getByRole('button', 'Load their version').tap();
  await expect(dialog.getByLabel('Last name', { exact: true })).toHaveValue('Theirs');
  await dialog.getByLabel('Last name', { exact: true }).fill('Mine after all');
  await dialog.getByRole('button', 'Save', { exact: true }).tap();
  await expect(screen.getByRole('dialog')).toBeHidden();
  const stored = await getContact(browser, created.id);
  expect(stored.name.family).toBe('Mine after all');
  // The email kept its row: the same id, so its place for old apps stays.
  expect(stored.emails.map((entry) => entry.id)).toEqual([created.emails[0].id]);
  expect(stored.version).toBe(created.version + 2);
});
