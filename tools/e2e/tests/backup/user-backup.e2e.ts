import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { runId, stack } from '../support/env.ts';
import { ok, pageApi } from '../support/api.ts';
import { createContact, listContacts } from '../support/contacts.ts';
import { onlyOn } from '../support/ui.ts';

// 0.28 backups (A, E): every backup is encrypted, holds UniHub's own data and
// leaves out what a provider holds, leaves the server through a download
// ticket and restores without duplicates. Alex's backups only.

interface Job { id: string; status: string; encryption_enabled: boolean; contents: { included: string[]; left_out: { what: string; count?: number }[] } | null; recovery_password_available: boolean }
interface RestoreJob { id: string; status: string; validation_result: { valid: boolean; contents?: { left_out: { what: string }[] } } | null }

async function waitForJob(browser: unknown, id: string, status: string, timeout = 180_000) {
  await expect.poll(async () => ok(await pageApi<{ job: Job }>(browser, 'GET', `/api/backup/jobs/${id}`), 'read backup').job.status, { timeout }).toBe(status);
  return ok(await pageApi<{ job: Job }>(browser, 'GET', `/api/backup/jobs/${id}`), 'read backup').job;
}
async function waitForRestore(browser: unknown, id: string, statuses: string[], timeout = 180_000) {
  await expect.poll(async () => ok(await pageApi<{ job: RestoreJob }>(browser, 'GET', `/api/backup/restore-jobs/${id}`), 'read restore').job.status, { timeout }).toMatch(new RegExp(`^(${statuses.join('|')})$`));
  return ok(await pageApi<{ job: RestoreJob }>(browser, 'GET', `/api/backup/restore-jobs/${id}`), 'read restore').job;
}

test('[28-01 28-04] a backup is always encrypted, says what it leaves out, and offers no encryption switch', { session: 'alex', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await app.open('/settings?section=backup');
  await expect(screen.getByRole('button', 'Create backup')).toBeEnabled();
  await expect(screen.getByRole('switch', /encrypt/i)).toHaveCount(0);
  // The ledger names what a provider holds as left out before anything is created.
  await expect(screen.getByText('Left out', { exact: true })).toBeVisible();
  await expect(screen.getByText(/mail of Sync-mode accounts/i)).toBeVisible();
  await screen.getByRole('button', 'Create backup').tap();
  // The toast shows the title and announces it again in its live region.
  await expect(screen.getByRole('status').filter({ hasText: 'Backup started' })).toHaveCount(1);
  const { jobs } = ok(await pageApi<{ jobs: Job[] }>(browser, 'GET', '/api/backup/jobs'), 'list backups');
  const job = await waitForJob(browser, jobs[0].id, 'ready');
  expect(job.encryption_enabled, 'encrypted without asking').toBe(true);
  // Alex's mail account is Sync mode: its mail is left out and the row says so.
  expect(job.contents?.left_out.some((entry) => /sync/i.test(entry.what)), 'Sync-mode mail left out').toBe(true);
  await browser.reload();
  // The newest backup is the first row; earlier runs and targets leave theirs below.
  await expect(screen.getByText(/^Left out: .*Sync/).first()).toBeVisible();
  // An old client that still asks for an unencrypted backup gets an encrypted one.
  const legacy = ok(await pageApi<{ job: Job }>(browser, 'POST', '/api/backup/jobs', { sections: 'full', encrypt: false }), 'legacy create').job;
  expect((await waitForJob(browser, legacy.id, 'ready')).encryption_enabled).toBe(true);
});

test('[28-17] a backup downloads through a ticket that needs no session cookie', { session: 'alex', timeout: 300_000 }, async ({ app, browser }) => {
  await onlyOn(browser, 'desktop', 'android-app');
  await app.open('/settings?section=backup');
  const ready = ok(await pageApi<{ jobs: Job[] }>(browser, 'GET', '/api/backup/jobs'), 'list backups').jobs.find((job) => job.status === 'ready')
    ?? await waitForJob(browser, ok(await pageApi<{ job: Job }>(browser, 'POST', '/api/backup/jobs', { sections: ['contacts'] }), 'create').job.id, 'ready');
  // The first download waits until the person has seen the recovery password.
  if (ready.recovery_password_available) ok(await pageApi(browser, 'POST', `/api/backup/jobs/${ready.id}/recovery-password/reveal`), 'reveal');
  const ticket = ok(await pageApi<{ url: string; filename: string; size: number }>(browser, 'POST', '/api/files/tickets', { kind: 'backup-archive', id: ready.id }), 'ticket');
  expect(ticket.filename).toMatch(/\.unihub-backup$/);
  // Fetched from Node without any cookie, as the app's download manager does.
  const response = await fetch(new URL(ticket.url, stack.url), { redirect: 'manual' });
  expect(response.status, 'the ticket answers without a session').toBe(200);
  expect(response.headers.get('content-type')).toContain('application/vnd.unihub.backup');
  expect((await response.arrayBuffer()).byteLength).toBe(ticket.size);
  // The grant allows a resumed download (Range) for the same archive.
  const partial = await fetch(new URL(ticket.url, stack.url), { headers: { Range: 'bytes=0-9' } });
  expect([200, 206]).toContain(partial.status);
});

test('[28-02 28-03] restoring the same backup twice brings a deleted contact back once', { session: 'alex', timeout: 600_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/settings?section=backup');
  const run = runId();
  const family = `Restore ${run}`;
  await createContact(browser, { name: { given: 'Rae', family }, emails: [`rae.${run}@example.com`] });
  const created = ok(await pageApi<{ job: Job }>(browser, 'POST', '/api/backup/jobs', { sections: ['contacts'] }), 'create').job;
  await waitForJob(browser, created.id, 'ready');
  // Delete the contact for good (bin included), then restore from the stored backup.
  const victim = (await listContacts(browser)).find((contact) => contact.name.family === family)!;
  ok(await pageApi(browser, 'DELETE', `/api/contacts/${victim.id}`), 'delete');
  await pageApi(browser, 'POST', '/api/bin/empty', { module: 'contacts' });
  expect((await listContacts(browser)).some((contact) => contact.name.family === family), 'gone').toBe(false);

  for (const round of [1, 2]) {
    await browser.reload();
    const row = screen.getByRole('button', /^Restore Contacts backup/).first();
    await row.tap();
    const { jobs } = ok(await pageApi<{ jobs: RestoreJob[] }>(browser, 'GET', '/api/backup/restore-jobs'), 'restores');
    const validated = await waitForRestore(browser, jobs[0].id, ['validated']);
    expect(validated.validation_result?.valid).toBe(true);
    await browser.reload();
    await screen.getByRole('button', /From a backup on this server/).first().tap();
    await expect(screen.getByText('The backup checks out', { exact: false })).toBeVisible();
    await screen.getByRole('button', 'Restore', { exact: true }).first().tap();
    await waitForRestore(browser, jobs[0].id, ['completed']);
    const copies = (await listContacts(browser)).filter((contact) => contact.name.family === family);
    expect(copies, `round ${round}: one copy`).toHaveLength(1);
  }
});
