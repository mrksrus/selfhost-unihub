import { readFileSync } from 'node:fs';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { fixturePath } from '../support/env.ts';
import { ok, pageApi } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

// 28-05 (agent part): an archive from before 0.28 still imports, and the
// review says what was left out when it was read. The frozen 0.27.1 fixture
// (api/tests/fixtures/backup-v6-0.27.1.*) is uploaded through the page.
// Stream A adds the fixture; until then this test skips.

const FIXTURE = '../../api/tests/fixtures/backup-v6-0.27.1.unihub-backup';
const PASSWORD_FILE = '../../api/tests/fixtures/backup-v6-0.27.1.password';

test('[28-05] an archive from before 0.28 imports with a note on what was left out', { session: 'blair', timeout: 300_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  let password: string;
  try { password = readFileSync(fixturePath(PASSWORD_FILE), 'utf8').trim(); } catch { test.skip(true, 'the frozen 0.27.1 archive is not in the checkout yet'); return; }
  await app.open('/settings?section=backup');
  await screen.getByLabel('Backup file').setInputFiles(fixturePath(FIXTURE));
  await screen.getByRole('button', 'Upload and check').tap();
  await expect(screen.getByLabel('Recovery password of this backup')).toBeVisible();
  await screen.getByLabel('Recovery password of this backup').fill(password);
  await screen.getByRole('button', 'Unlock').tap();
  const { jobs } = ok(await pageApi<{ jobs: { id: string; status: string }[] }>(browser, 'GET', '/api/backup/restore-jobs'), 'restores');
  await expect.poll(async () => ok(await pageApi<{ job: { status: string } }>(browser, 'GET', `/api/backup/restore-jobs/${jobs[0].id}`), 'read').job.status, { timeout: 180_000 }).toBe('validated');
  await browser.reload();
  await screen.getByRole('button', /From an uploaded backup/).first().tap();
  const review = screen.getByLabel('Backup review');
  await expect(review).toContainText('The backup checks out');
  await expect(review).toContainText('Left out:');
  await expect(review).toContainText(/before 0\.28/);
});
