import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

// 28-06 (agent part): Server settings → Instance backup says Off with what
// is missing, or runs "Back up now" when the stack's environment sets
// INSTANCE_BACKUP_DIR and INSTANCE_BACKUP_KEY (stream D adds them to the
// stack's .env).

interface Status { enabled: boolean; missing: string[]; running: boolean; last_run: { id: string; status: string } | null }

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
