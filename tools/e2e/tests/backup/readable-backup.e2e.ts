import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { apiRequire, outside, runId, stack } from '../support/env.ts';
import { emailsWithSubject, ok, pageApi } from '../support/api.ts';
import { createContact } from '../support/contacts.ts';
import { parse, receive, sendMail } from '../support/mail.ts';
import { onlyOn } from '../support/ui.ts';

// 28-21 (D37): a backup is an AES-encrypted ZIP that opens outside UniHub
// with its recovery password, holding mail as .eml, contacts as .vcf and
// calendars as .ics. The archive is downloaded through a ticket and opened
// here, outside the app, by the test-only WinZip AES reader (written apart
// from the server's writer) and, where installed, by 7-Zip.

const require = createRequire(import.meta.url);
const { readZip, sevenZipBinary, sevenZip } = require('../../../../api/tests/helpers/winzip-aes-reader.cts');
const ICAL = apiRequire('ical.js');

interface Job { id: string; status: string; error?: string | null; recovery_password_available: boolean }

test('[28-21] a downloaded backup opens outside UniHub with its password: mail, contacts and calendars parse', { session: 'blair', timeout: 420_000 }, async ({ app, browser }) => {
  await onlyOn(browser, 'desktop');
  const run = runId();
  // A Download-mode account on a GreenMail mailbox of its own (created by the
  // first message to it, with the address as password), with one message.
  const address = `readable-${run}@example.net`;
  const subject = `Readable backup ${run}`;
  await sendMail({ from: outside.sam, to: [address], subject, text: `Grüße from ${run}.` });
  await receive(address, subject, 30_000);
  await app.open('/settings?section=backup');
  ok(await pageApi(browser, 'POST', '/api/mail/accounts', {
    email_address: address, display_name: 'Readable', provider: 'custom', username: address, encrypted_password: address,
    imap_host: stack.providerHost, imap_port: stack.imapsPort, smtp_host: stack.providerHost, smtp_port: stack.smtpsPort,
    sync_mode: 'download', sync_fetch_limit: 'all', try_calendar_sync: false,
  }), 'add the Download-mode account');
  await expect.poll(async () => (await emailsWithSubject(browser, 'inbox', subject)).length, { timeout: 120_000 }).toBeGreaterThan(0);
  const family = `Readable ${run}`;
  await createContact(browser, { name: { given: 'Vic', family }, emails: [`vic.${run}@example.com`] });
  const task = `Readable task ${run}`;
  ok(await pageApi(browser, 'POST', '/api/calendar/events', { title: task, is_todo_only: true, reminders: null }), 'create task');

  const created = ok(await pageApi<{ job: Job }>(browser, 'POST', '/api/backup/jobs', { sections: 'full' }), 'create backup').job;
  await expect.poll(async () => ok(await pageApi<{ job: Job }>(browser, 'GET', `/api/backup/jobs/${created.id}`), 'read backup').job.status, { timeout: 180_000 }).toMatch(/^(ready|failed)$/);
  const job = ok(await pageApi<{ job: Job }>(browser, 'GET', `/api/backup/jobs/${created.id}`), 'read backup').job;
  expect(job.status, job.error ?? '').toBe('ready');
  const { recovery_password: password } = ok(await pageApi<{ recovery_password: string }>(browser, 'POST', `/api/backup/jobs/${job.id}/recovery-password/reveal`), 'reveal');
  const ticket = ok(await pageApi<{ url: string; filename: string }>(browser, 'POST', '/api/files/tickets', { kind: 'backup-archive', id: job.id }), 'ticket');
  expect(ticket.filename).toMatch(/\.zip$/);
  const response = await fetch(new URL(ticket.url, stack.url));
  expect(response.headers.get('content-type')).toContain('application/zip');
  const archive = Buffer.from(await response.arrayBuffer());

  // Outside the app: the plain README, then the encrypted archive with the password.
  const wrong = (() => { try { readZip(archive, 'not-the-password'); return 'opened'; } catch (error) { return (error as Error).message; } })();
  expect(wrong).toMatch(/wrong password/);
  const outer = readZip(archive, password);
  expect(outer.map((entry: { name: string }) => entry.name)).toEqual(['README.txt', 'unihub-backup.zip']);
  const inner: { name: string; data: Buffer }[] = readZip(outer[1].data);
  const names = inner.map((entry) => entry.name);

  const eml = inner.filter((entry) => entry.name.startsWith(`Mail/${address}/`) && entry.name.endsWith('.eml'));
  expect(eml.length, names.join('\n')).toBeGreaterThan(0);
  const parsed = await Promise.all(eml.map((entry) => parse(entry.data.toString('latin1'))));
  expect(parsed.some((mail) => mail.subject === subject), 'the message parses as an email').toBe(true);

  const vcf = inner.find((entry) => entry.name === 'Contacts/Contacts.vcf');
  expect(vcf, names.join('\n')).toBeTruthy();
  const cards = ICAL.parse(vcf!.data.toString('utf8'));
  const fns = (Array.isArray(cards[0]) ? cards : [cards]).map((jcard: unknown) => new ICAL.Component(jcard).getFirstPropertyValue('fn'));
  expect(fns).toContain(`Vic ${family}`);

  const calendars = inner.filter((entry) => entry.name.startsWith('Calendars/') && entry.name.endsWith('.ics'));
  const summaries = calendars.flatMap((entry) => new ICAL.Component(ICAL.parse(entry.data.toString('utf8'))).getAllSubcomponents('vtodo')
    .map((todo: { getFirstPropertyValue(name: string): unknown }) => todo.getFirstPropertyValue('summary')));
  expect(summaries).toContain(task);

  // The same with 7-Zip, where the machine has it (CI images carry 7z).
  const binary = sevenZipBinary();
  console.log(`[28-21] 7-Zip: ${binary ?? 'not installed; the independent reader opened the archive'}`);
  if (binary) {
    const directory = mkdtempSync(join(tmpdir(), 'unihub-readable-'));
    try {
      writeFileSync(join(directory, 'backup.zip'), archive);
      expect(sevenZip(binary, join(directory, 'backup.zip'), join(directory, 'outer'), password)).toBe(0);
      expect(sevenZip(binary, join(directory, 'outer', 'unihub-backup.zip'), join(directory, 'inner'), '')).toBe(0);
      const folder = join(directory, 'inner', 'Mail', address);
      const files = readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.eml'));
      const fromDisk = await Promise.all(files.map((file) => parse(readFileSync(join(file.parentPath, file.name), 'latin1'))));
      expect(fromDisk.some((mail) => mail.subject === subject)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
