import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import { signInPassword } from '../support/env.ts';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

// 28-06 (agent part): Server settings → Instance backup says Off with what
// is missing, or runs "Back up now" when the stack's environment sets
// INSTANCE_BACKUP_DIR and INSTANCE_BACKUP_KEY (stream D adds them to the
// stack's .env). The schedule is set on the page with the
// administrator's password whether or not the backup is on.

interface Status { enabled: boolean; missing: string[]; running: boolean; last_run: { id: string; status: string } | null; time_utc: string; keep: number; schedule_defaults?: { time_utc: string; keep: number } }
// The handle for the form; the plain value for request bodies made from Node.
const password = credentials.user('admin').password;
const apiPassword = signInPassword;

test('[28-06] the instance backup page is off with what is missing, or backs up now', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/admin/instance-backup');
  const status = ok(await pageApi<Status>(browser, 'GET', '/api/admin/instance-backup'), 'status');
  if (!status.enabled) {
    await expect(screen.getByText('Off', { exact: true })).toBeVisible();
    await expect(screen.getByText(/Set INSTANCE_BACKUP_/)).toBeVisible();
    await expect(screen.getByRole('button', 'Back up now')).toBeDisabled();
    // A non-admin cannot read or start it.
    const alex = await signIn('alex');
    expect((await alex('GET', '/api/admin/instance-backup')).status).toBe(403);
    return;
  }
  await expect(screen.getByText('On', { exact: true })).toBeVisible();
  await screen.getByRole('button', 'Back up now').tap();
  await expect(screen.getByText('Backup started', { exact: true })).toBeVisible();
  await expect.poll(async () => ok(await pageApi<Status>(browser, 'GET', '/api/admin/instance-backup'), 'status').last_run?.status, { timeout: 240_000 }).toBe('succeeded');
  await browser.reload();
  await expect(screen.getByText(/Succeeded · /).first()).toBeVisible();
  const admin = await signIn('admin');
  const log = ok(await admin<{ entries: { action: string }[] }>('GET', '/api/admin/audit'), 'audit');
  expect(log.entries.some((entry) => entry.action === 'admin.instance_backup_started'), `recorded (${credentials.user('admin').username})`).toBe(true);
});

test('[28-06] the admin sets the daily time and how many to keep with their password; destination and key stay read-only', { session: 'admin', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone');
  await app.open('/admin/instance-backup');
  const before = ok(await pageApi<Status>(browser, 'GET', '/api/admin/instance-backup'), 'status');
  const restore = before.schedule_defaults ?? { time_utc: before.time_utc, keep: before.keep };
  try {
    await screen.getByRole('button', 'Change schedule…').tap();
    const dialog = screen.getByRole('dialog', 'Change the schedule?');
    await dialog.getByLabel('Time (UTC)').fill('04:45');
    await dialog.getByLabel('Backups kept').fill('7');
    const save = dialog.getByRole('button', 'Save schedule');
    await expect(save).toBeDisabled();
    await dialog.getByLabel('Your password', { exact: true }).fill(password);
    await save.tap();
    await expect(screen.getByText('Schedule saved', { exact: true })).toBeVisible();
    await expect(screen.getByText('04:45 UTC', { exact: true })).toBeVisible();
    await browser.reload();
    await expect(screen.getByText('04:45 UTC', { exact: true })).toBeVisible();
    // Destination and key have no input: they come from the environment.
    await expect(screen.getByRole('textbox')).toHaveCount(0);
    const after = ok(await pageApi<Status>(browser, 'GET', '/api/admin/instance-backup'), 'status');
    expect(after.time_utc).toBe('04:45');
    expect(after.keep).toBe(7);
    // A wrong password changes nothing; so does a non-admin.
    expect((await pageApi(browser, 'PUT', '/api/admin/instance-backup/settings', { time_utc: '05:00', keep: 3, current_password: 'not-the-admin-password' })).status).toBe(403);
    const alex = await signIn('alex');
    expect((await alex('PUT', '/api/admin/instance-backup/settings', { time_utc: '05:00', keep: 3, current_password: apiPassword })).status).toBe(403);
    expect(ok(await pageApi<Status>(browser, 'GET', '/api/admin/instance-backup'), 'status').time_utc).toBe('04:45');
    const log = ok(await (await signIn('admin'))<{ entries: { action: string }[] }>('GET', '/api/admin/audit'), 'audit');
    expect(log.entries.some((entry) => entry.action === 'admin.instance_backup_settings_changed'), 'recorded').toBe(true);
  } finally {
    ok(await (await signIn('admin'))('PUT', '/api/admin/instance-backup/settings', { ...restore, current_password: apiPassword }), 'restore schedule');
  }
});
