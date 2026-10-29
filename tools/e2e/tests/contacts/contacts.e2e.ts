import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId } from '../support/env.ts';
import { ok, pageApi } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

interface Contact { id: string; email: string | null; email2: string | null; email3: string | null; phone: string | null; phone2: string | null;
  phone3: string | null; company: string | null; notes: string | null }

async function contactsWithEmail(browser: unknown, email: string) {
  const { contacts } = ok(await pageApi<{ contacts: Contact[] }>(browser, 'GET', '/api/contacts?limit=5000'), 'list contacts');
  return contacts.filter((contact) => [contact.email, contact.email2, contact.email3].includes(email));
}

// 23-09: a contact note of 15,000+ characters saves and reloads exactly, also
// beside a second entry for the same email.
test('[23-09] a long contact note saves whole', { session: 'alex', timeout: 240_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const id = runId();
  const name = `Merge${id}`;
  const email = `merge-${id}@example.com`;
  const extra = `merge-extra-${id}@example.org`;
  const longNote = Array.from({ length: 240 }, (_, i) => `Line ${i}: a deliberately long synthetic contact note.`).join('\n');
  const shortNote = `Second entry note ${id}`;
  // Phone numbers unique to the run: an equal number would make an earlier run's contact a duplicate too.
  const digits = String(Date.now()).slice(-6);
  const [phoneA, phoneB] = [`+1202${digits}1`, `+1202${digits}2`];
  const entries = [
    { phone: phoneA, company: `Company A ${id}`, note: longNote },
    { phone: phoneB, company: `Company B ${id}`, note: shortNote, extra },
  ];
  for (const entry of entries) {
    await app.open('/contacts?action=new');
    const dialog = screen.getByRole('dialog');
    await dialog.getByLabel('First name', { exact: true }).fill(name);
    await dialog.getByLabel('Last name', { exact: true }).fill('Synthetic');
    await dialog.getByRole('group', 'Email').getByRole('textbox').first().fill(email);
    if (entry.extra) {
      await dialog.getByRole('button', 'Add another email').tap();
      await dialog.getByLabel('Email 2', { exact: true }).fill(entry.extra);
    }
    await dialog.getByRole('group', 'Phone').getByRole('textbox').first().fill(entry.phone);
    await dialog.getByLabel('Company', { exact: true }).fill(entry.company);
    await dialog.getByRole('textbox', 'Notes', { exact: true }).fill(entry.note);
    await dialog.getByRole('button', 'Add contact').tap();
    await expect(screen.getByRole('dialog')).toBeHidden();
  }
  const pair = await contactsWithEmail(browser, email);
  expect(pair).toHaveLength(2);
  const long = pair.find((contact) => contact.notes === longNote);
  expect(long, `the ${longNote.length}-character note is stored whole`).toBeDefined();
  await app.open(`/contacts?contact=${long!.id}`);
  await screen.getByRole('button', 'Edit', { exact: true }).tap();
  await expect(screen.getByRole('dialog').getByRole('textbox', 'Notes', { exact: true })).toHaveValue(longNote);
  await screen.getByRole('button', 'Cancel', { exact: true }).tap();

  // The 0.25 automatic merge is gone in 0.26 (it deleted for good, without
  // undo); merge review, undo and Merge all are proved by merge.e2e.ts.
});
