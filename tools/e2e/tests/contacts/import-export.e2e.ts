import { test } from '@e2e-dev/web';
import type { Screen } from 'e2e';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { chooseFile, contactFixture, createContact, getContact, listContacts, recordSavedFiles, runDigits, savedFiles, writeUpload, type ContactRecord } from '../support/contacts.ts';
import { isNarrow, onlyOn } from '../support/ui.ts';

type App = { open: (path?: string) => Promise<unknown> };

/** Opens the import dialog from the page's panel (a sheet on narrow screens). */
async function openImport(app: App, screen: Screen, browser: unknown) {
  await app.open('/contacts');
  // On narrow screens the panel is a sheet, opened from the page's scope ("All contacts").
  if (await isNarrow(browser)) await screen.getByRole('button', 'All contacts', { exact: true, visible: true }).first().tap();
  await screen.getByRole('button', 'Import contacts', { visible: true }).first().tap();
  return screen.getByRole('dialog', 'Import contacts');
}

/** Imports one file with the default decisions; returns once the result is shown. */
async function importFile(app: App, screen: Screen, browser: unknown, file: Parameters<typeof chooseFile>[1], check?: (dialog: ReturnType<Screen['getByRole']>) => Promise<void>) {
  const dialog = await openImport(app, screen, browser);
  await chooseFile(browser, file);
  await expect(dialog.getByRole('button', /^Import \d+ contacts?$/)).toBeVisible({ timeout: 60_000 });
  if (check) await check(dialog);
  await dialog.getByRole('button', /^Import \d+ contacts?$/).tap();
  await expect(dialog.getByText('Added', { exact: true })).toBeVisible({ timeout: 120_000 });
  await dialog.getByRole('button', 'Done', { exact: true }).tap();
}

const named = (contacts: ContactRecord[], run: string) => contacts.filter((contact) => contact.display_name.includes(run));
const byFamily = (contacts: ContactRecord[], family: string) => contacts.find((contact) => contact.name.family === family);

// D6: vCard 4.0, 3.0 (Apple) and 2.1 (quoted-printable UTF-8 and ISO-8859-1)
// are shown before anything is written, with the first names as a check of the
// character set, and then imported with their labels, structure and photo.
test('[26-11 D6] vCard 4.0, 3.0 and 2.1 imports show a preview first and keep every field', { session: 'alex', timeout: 480_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const run = runId();
  const digits = runDigits();

  await importFile(app, screen, browser, contactFixture('vcard40.vcf', run, digits), async (dialog) => {
    await expect(dialog.getByText('vCard 4.0', { exact: true })).toBeVisible();
    await expect(dialog.getByText(new RegExp(`Zoë Fourpoint ${run}`))).toBeVisible();
    // Nothing is written before the person confirms.
    expect(named(await listContacts(browser), run)).toHaveLength(0);
  });
  let contacts = named(await listContacts(browser), run);
  const zoe = contacts.find((contact) => contact.name.given === 'Zoë')!;
  expect(zoe, 'the 4.0 card is imported').toBeTruthy();
  expect(zoe.uid).toBe(`urn:uuid:e2e-${run}-v4-1`);
  expect(zoe.name.prefix).toBe('Dr.');
  expect(zoe.phones.map((entry) => [entry.value, entry.label, entry.preferred])).toEqual([[`+1 202 ${digits}1`, 'mobile', true], [`+1 202 ${digits}2`, 'work', false]]);
  expect(zoe.emails.map((entry) => [entry.value, entry.label])).toEqual([[`zoe.${run}@example.com`, 'work'], [`zoe.home.${run}@example.org`, 'home']]);
  expect(zoe.organization).toEqual({ name: `Example Labs ${run}`, department: 'Research' });
  expect(zoe.birthday).toMatchObject({ month: 3, day: 14 });
  expect(zoe.birthday!.year ?? null).toBeNull();
  expect(zoe.categories).toEqual(['Choir', 'Neighbours']);
  expect(zoe.nicknames.map((entry) => entry.value)).toEqual(['Zo']);
  expect(zoe.addresses[0]).toMatchObject({ street: '1 Example Road', locality: 'Exampleton', country: 'Examplia' });
  expect(zoe.notes).toBe('Two lines\nof note');
  const zoeDetail = await getContact(browser, zoe.id);
  expect(zoeDetail.properties.some((property) => property.name === 'X-E2E-KEPT' && property.value === 'kept from the import'), 'the unknown property is kept').toBe(true);

  await importFile(app, screen, browser, contactFixture('vcard30-apple.vcf', run, digits), async (dialog) => {
    await expect(dialog.getByText('vCard 3.0', { exact: true })).toBeVisible();
  });
  contacts = named(await listContacts(browser), run);
  const bea = byFamily(contacts, `Threepoint ${run}`)!;
  expect(bea, 'the Apple 3.0 card is imported').toBeTruthy();
  expect(bea.emails[0]).toMatchObject({ value: `bea.${run}@example.com`, label: 'other', preferred: true });
  expect(bea.phones.map((entry) => [entry.label, entry.custom_label])).toEqual([['mobile', null], ['custom', 'Kids']]);
  expect(bea.addresses[0]).toMatchObject({ street: 'Ringstraße 5', locality: 'Wien', country: 'Österreich' });
  expect(bea.photo, 'the embedded photo is converted').not.toBeNull();

  await importFile(app, screen, browser, contactFixture('vcard21-qp.vcf', run, digits), async (dialog) => {
    await expect(dialog.getByText('vCard 2.1', { exact: true })).toBeVisible();
    // The garbling check: the names read right before anything is written.
    await expect(dialog.getByText(new RegExp(`Jürgen Müller ${run}`))).toBeVisible();
  });
  contacts = named(await listContacts(browser), run);
  const juergen = byFamily(contacts, `Müller ${run}`)!;
  expect(juergen?.name.given).toBe('Jürgen');
  expect(juergen.phones.map((entry) => entry.label)).toEqual(['mobile', 'home']);
  const bjoern = byFamily(contacts, `Größe ${run}`)!;
  expect(bjoern?.name.given, 'ISO-8859-1 quoted-printable').toBe('Björn');
  expect(bjoern.organization.name, 'ISO-8859-1 without encoding').toBe(`Fürst AG ${run}`);
});

// D6: Google and Outlook CSV exports map their columns to labelled values.
test('[26-11 D6] Google and Outlook CSV files import with their columns mapped', { session: 'alex', timeout: 360_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const run = runId();
  const digits = runDigits();
  await importFile(app, screen, browser, contactFixture('google.csv', run, digits), async (dialog) => {
    await expect(dialog.getByText('Google CSV', { exact: true })).toBeVisible();
  });
  await importFile(app, screen, browser, contactFixture('outlook.csv', run, digits), async (dialog) => {
    await expect(dialog.getByText('Outlook CSV', { exact: true })).toBeVisible();
  });
  const contacts = named(await listContacts(browser), run);
  const gina = byFamily(contacts, `Googleton ${run}`)!;
  expect(gina, 'the Google row is imported').toBeTruthy();
  expect(gina.emails.map((entry) => entry.value)).toEqual([`gina.${run}@example.com`, `gina.home.${run}@example.org`, `gina.alt.${run}@example.org`]);
  expect(gina.phones.map((entry) => [entry.value, entry.label])).toEqual([[`+1 505 ${digits}1`, 'mobile'], [`+1 505 ${digits}2`, 'work_fax']]);
  expect(gina.organization).toEqual({ name: `Example Ltd ${run}`, department: 'Platform' });
  expect(gina.job_title).toBe('Engineer');
  expect(gina.is_favorite, '"* starred" is the favourite, not a category').toBe(true);
  expect(gina.categories).toEqual(['Friends']);
  // A line break inside a quoted field is kept as the file wrote it (CRLF here).
  expect(gina.notes?.replace(/\r\n/g, '\n')).toBe('Line one\nLine two');
  const olivia = byFamily(contacts, `Outlookson ${run}`)!;
  expect(olivia, 'the Outlook row is imported').toBeTruthy();
  expect(olivia.phones.map((entry) => [entry.value, entry.label])).toEqual(expect.arrayContaining([[`+1 606 ${digits}1`, 'work'], [`+1 606 ${digits}2`, 'home'], [`+1 606 ${digits}3`, 'mobile']]));
  expect(olivia.emails.map((entry) => entry.value)).toEqual([`olivia.${run}@example.com`, `o.outlook.${run}@example.org`]);
  expect(olivia.organization).toEqual({ name: `Example Corp ${run}`, department: 'Sales' });
  expect(olivia.birthday).toMatchObject({ year: 1985, month: 3, day: 15 });
  expect(olivia.categories).toEqual(['Clients', 'VIP']);
});

// 26-08: a vCard export of every contact, imported again, adds no contact:
// every card is recognised by its UID.
test('[26-08] exporting every contact as vCard and importing the file again adds nothing', { session: 'alex', timeout: 480_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const run = runId();
  await createContact(browser, { name: { given: `Export${run}`, family: 'Roundtrip' }, emails: [{ value: `export-${run}@example.com`, label: 'work' }],
    phones: ['+1 707 555 0100', '+1 707 555 0101', '+1 707 555 0102', '+1 707 555 0103'], categories: ['Roundtrip'] });
  await app.open('/contacts');
  await recordSavedFiles(browser);
  await screen.getByRole('button', 'Export all contacts', { visible: true }).first().tap();
  const dialog = screen.getByRole('dialog', 'Export all contacts');
  await dialog.getByRole('button', 'Export', { exact: true }).tap();
  await expect.poll(async () => (await savedFiles(browser)).length, { timeout: 60_000 }).toBe(1);
  const [file] = await savedFiles(browser);
  expect(file.name).toMatch(/\.vcf$/);
  expect(file.text).toContain('VERSION:4.0');
  expect(file.text).toContain(`Export${run}`);
  const cards = file.text.split('BEGIN:VCARD').length - 1;
  const before = (await listContacts(browser)).length;
  expect(cards).toBe(before);

  const imported = await openImport(app, screen, browser);
  await chooseFile(browser, writeUpload('export.vcf', file.text));
  await expect(imported.getByRole('button', /^Import \d+ contacts?$/)).toBeVisible({ timeout: 120_000 });
  const counts = imported.getByRole('definition');
  // Format, cards, new, already present, likely duplicates.
  await expect(counts.nth(2)).toHaveText('0');
  await expect(counts.nth(3)).toHaveText(String(cards));
  await imported.getByRole('button', /^Import \d+ contacts?$/).tap();
  await expect(imported.getByText('Added', { exact: true })).toBeVisible({ timeout: 180_000 });
  await expect(imported.getByRole('definition').first()).toHaveText('0');
  await imported.getByRole('button', 'Done', { exact: true }).tap();
  expect((await listContacts(browser)).length, 'no contact was added').toBe(before);
});

// D6: the other formats of the export dialog, for a selection from the bulk bar.
test('[26-12 D6] a selection exports as vCard 3.0, Google CSV and Outlook CSV', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const run = runId();
  const name = `Formats${run}`;
  await createContact(browser, { name: { given: name, family: 'Synthetic' }, organization: { name: `Format Co ${run}` },
    emails: [{ value: `formats-${run}@example.com`, label: 'work' }], phones: [{ value: '+1 808 555 0100', label: 'mobile' }] });
  const expected: [RegExp, string, string[]][] = [
    [/^vCard 3\.0/, '.vcf', ['VERSION:3.0', `FN:${name} Synthetic`, `ORG:Format Co ${run}`]],
    [/^Google CSV/, '.csv', ['First Name,Middle Name,Last Name', name, `formats-${run}@example.com`]],
    [/^Outlook CSV/, '.csv', ['E-mail Address', name, `Format Co ${run}`]],
  ];
  for (const [format, extension, parts] of expected) {
    await app.open('/contacts');
    await screen.getByRole('searchbox', 'Search contacts').fill(name);
    // The list follows the search after a pause, and a new search clears the
    // selection: select once the list shows only the match.
    await expect(screen.getByRole('button', /^Select /)).toHaveCount(1);
    await screen.getByRole('button', `Select ${name} Synthetic`).tap();
    await recordSavedFiles(browser);
    await screen.getByRole('button', 'Export selected', { exact: true }).tap();
    const dialog = screen.getByRole('dialog', 'Export 1 selected contact');
    await dialog.getByText(format).first().tap();
    await dialog.getByRole('button', 'Export', { exact: true }).tap();
    await expect.poll(async () => (await savedFiles(browser)).length, { timeout: 60_000 }).toBe(1);
    const [file] = await savedFiles(browser);
    expect(file.name.endsWith(extension), file.name).toBe(true);
    for (const part of parts) expect(file.text, `${format} holds ${part}`).toContain(part);
    expect(file.text.split(name).length - 1, 'only the selected contact').toBe(format.source.includes('vCard') ? 2 : 1);
  }
});

// D6: matches are decided per group before anything is written; "Review
// conflicts" shows the file's card; a merge keeps UniHub's differing value and
// appears under Recently merged with Undo; a skipped card adds nothing.
test('[26-11 D6] import decisions: merge into an existing contact, skip another, review conflicts', { session: 'alex', timeout: 360_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  // The page's own session makes the API calls below.
  await app.open('/contacts');
  const run = runId();
  const digits = runDigits();
  const dora = await createContact(browser, { name: { given: 'Dora', family: `Decide ${run}` }, organization: { name: `Old Co ${run}` }, emails: [`dora.${run}@example.com`] });
  const ezra = await createContact(browser, { name: { given: 'Ezra', family: `Decide ${run}` }, emails: [`ezra.${run}@example.com`] });
  const vcard = [
    'BEGIN:VCARD', 'VERSION:4.0', `FN:Dora Decide ${run}`, `N:Decide ${run};Dora;;;`, `ORG:New Co ${run}`, `EMAIL:dora.${run}@example.com`, `TEL;TYPE=cell:+1 909 ${digits}1`, 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:4.0', `FN:Ezra Decide ${run}`, `N:Decide ${run};Ezra;;;`, `EMAIL:ezra.${run}@example.com`, `TEL;TYPE=cell:+1 909 ${digits}2`, 'END:VCARD', '',
  ].join('\r\n');
  const dialog = await openImport(app, screen, browser);
  await chooseFile(browser, writeUpload('decide.vcf', vcard));
  await expect(dialog.getByRole('region', 'Decisions')).toBeVisible({ timeout: 60_000 });
  await dialog.getByRole('button', /^Review conflicts/).tap();
  await expect(dialog.getByText(new RegExp(`In the file: Dora Decide ${run} · New Co ${run}`))).toBeVisible();
  // The card numbers follow the file: Dora is card 1, Ezra card 2.
  await dialog.getByRole('combobox', 'Decision for contacts 2').tap();
  await screen.getByRole('option', 'Skip', { exact: true }).tap();
  await expect(dialog.getByRole('combobox', 'Decision for contacts 1')).toHaveText('Merge into existing');
  await dialog.getByRole('button', 'Import 2 contacts').tap();
  await expect(dialog.getByText('Merged', { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(dialog.getByText("Kept UniHub's value", { exact: true })).toBeVisible();
  await dialog.getByRole('button', 'Done', { exact: true }).tap();

  const after = (await listContacts(browser)).filter((contact) => contact.name.family === `Decide ${run}`);
  expect(after.map((contact) => contact.id).sort()).toEqual([dora.id, ezra.id].sort());
  const doraNow = after.find((contact) => contact.id === dora.id)!;
  expect(doraNow.organization.name, 'a merge keeps UniHub\'s differing value').toBe(`Old Co ${run}`);
  expect(doraNow.phones.map((entry) => entry.value), 'the file\'s new number is added').toEqual([`+1 909 ${digits}1`]);
  expect(after.find((contact) => contact.id === ezra.id)!.phones, 'the skipped card changed nothing').toEqual([]);

  await app.open('/contacts?view=merged');
  const entry = screen.getByRole('listitem').filter({ hasText: `Dora Decide ${run}` });
  await expect(entry).toBeVisible();
  await expect(entry.getByRole('button', `Undo the merge into Dora Decide ${run}`)).toBeEnabled();
});

// D17 for CSV: a name, organisation or title longer than its field is cut for
// the field and kept whole as an other detail; the preview names the card and
// the column, never the value.
test('[26-11 D17] a CSV value longer than its field is cut, kept whole and reported by card and column', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/contacts');
  const run = runId();
  const organisation = `Org ${run} ${'L'.repeat(300)}`;
  const csv = `First Name,Last Name,Organization Name,E-mail 1 - Label,E-mail 1 - Value\r\nCut,Longorg ${run},${organisation},* Work,cut.${run}@example.com\r\n`;
  const dialog = await openImport(app, screen, browser);
  await chooseFile(browser, writeUpload('long.csv', csv));
  await expect(dialog.getByText('Google CSV', { exact: true })).toBeVisible({ timeout: 60_000 });
  await dialog.getByText('1 warning', { exact: true }).tap();
  const warning = dialog.getByText(/^Contact 1 \(Organization Name\): A value longer than its field was cut/);
  await expect(warning).toBeVisible();
  await expect(warning).not.toContainText('LLLL');
  await dialog.getByRole('button', 'Import 1 contact').tap();
  await expect(dialog.getByText('Added', { exact: true })).toBeVisible({ timeout: 120_000 });
  await dialog.getByRole('button', 'Done', { exact: true }).tap();
  const stored = (await listContacts(browser)).find((contact) => contact.name.family === `Longorg ${run}`)!;
  expect(stored, 'the row is imported').toBeTruthy();
  expect(stored.organization.name).toBe(organisation.slice(0, 255));
  const detail = await getContact(browser, stored.id);
  expect(detail.properties.some((property) => property.name === 'X-CSV-FIELD' && property.value === organisation), 'the whole value is kept').toBe(true);
});
