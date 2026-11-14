import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { apiRequire, people, signInPassword, stack } from '../support/env.ts';
import { ok, pageApi, signIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';
import { createGroup, dialogPassword, effectiveOf, personByEmail, seededId, setRules, sweep } from './organisation-helpers.ts';

// 30-05: two-factor authentication required for blair's group. blair has 7
// days: a reminder at every start, nothing refused. Once they are over, blair
// can only set it up or sign out, and is led through the set-up; then
// everything works again. The rule is a group's, so the other seeded people
// are not asked for anything meanwhile.

/** The 6-digit code an authenticator app shows for this setup key now (RFC 6238: SHA-1, 30 seconds). */
function authenticatorCode(key: string) {
  const bits = [...key.replace(/=+$/, '')].map((letter) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(letter).toString(2).padStart(5, '0')).join('');
  const secret = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const at = digest[19] & 15;
  return String((digest.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// The one thing this test writes past the app: its clock. Seven days cannot
// be waited for, so the start of blair's 7 days is moved back.
async function graceStartedDaysAgo(email: string, days: number) {
  const password = /^APP_PW=(.*)$/m.exec(readFileSync(stack.dbEnvFile, 'utf8'))?.[1];
  const db = await apiRequire('mysql2/promise').createConnection({ host: '127.0.0.1', port: stack.dbPort, user: 'unihub', password, database: 'unihub_dev', timezone: 'Z' });
  try {
    const [result] = await db.execute('UPDATE users SET two_factor_required_since = UTC_TIMESTAMP() - INTERVAL ? DAY WHERE email = ? AND two_factor_required_since IS NOT NULL', [days, email]);
    if (result.affectedRows !== 1) throw new Error(`${email} has no time running to set up two-factor authentication`);
  } finally {
    await db.end();
  }
}

test('[30-05] blair is reminded while the 7 days run; after them blair can only set up two-factor authentication, does, and works again', { session: 'blair', timeout: 360_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop', 'phone', 'android-app');
  await sweep();
  const blairId = await seededId('blair');
  const owner = await signIn('admin');
  const reset = () => owner('POST', `/api/admin/users/${blairId}/2fa/reset`, { current_password: signInPassword });
  await reset();
  try {
    const group = await createGroup('Two-factor', [blairId]);
    await setRules({ 'auth.two_factor': 'required' }, { groupId: group.id, unseen: ['blair'] });
    expect((await effectiveOf('alex')).two_factor?.required ?? false, 'alex is not in the group').toBe(false);

    // The rules notice first, then the reminder; nothing is refused yet.
    await app.open('/settings');
    const notice = screen.getByRole('dialog', 'Your administrator changed the data rules');
    await notice.getByRole('button', 'OK', { exact: true }).tap();
    await expect(notice).toBeHidden();
    const reminder = screen.getByRole('status').filter({ has: screen.getByRole('button', 'Set up now') });
    await expect(reminder).toContainText('Your administrator requires two-factor authentication.');
    expect((await pageApi(browser, 'GET', '/api/settings/values')).status, 'nothing is refused during the 7 days').toBe(200);
    // Closed until the next start, where it is back.
    await reminder.getByRole('button', 'Close the reminder until the next start').tap();
    await expect(reminder).toHaveCount(0);

    await graceStartedDaysAgo(people.blair.email, 8);
    await app.open('/mail');
    await expect(screen.getByRole('heading', 'Set up two-factor authentication to continue')).toBeVisible();
    const refused = await pageApi<{ code?: string }>(browser, 'GET', '/api/settings/values');
    expect(refused.status, 'the server refuses, not only the page').toBe(403);
    expect(refused.data.code).toBe('TWO_FACTOR_REQUIRED');

    await screen.getByRole('button', 'Set up two-factor authentication', { exact: true }).tap();
    const setup = screen.getByRole('dialog', 'Set up two-factor authentication');
    const key = (await setup.getByText(/^[A-Z2-7]{16,}$/).textContent())!.trim();
    await setup.getByLabel('Current password', { exact: true }).fill(dialogPassword('blair'));
    await setup.getByLabel('Authenticator code', { exact: true }).fill(authenticatorCode(key));
    await setup.getByRole('button', 'Turn on', { exact: true }).tap();
    // The recovery codes stay until blair has them, although the requirement is already met.
    await expect(setup.getByRole('list', 'Recovery codes')).toBeVisible();
    await setup.getByRole('button', 'Done', { exact: true }).tap();

    await expect(screen.getByRole('heading', 'Set up two-factor authentication to continue')).toHaveCount(0);
    expect(ok(await pageApi<{ user: { two_factor_enabled: boolean } }>(browser, 'GET', '/api/auth/me'), 'blair').user.two_factor_enabled).toBe(true);
    expect((await pageApi(browser, 'GET', '/api/settings/values')).status, 'everything works again').toBe(200);
    // While it is required, it cannot be turned off again.
    await app.open('/settings?section=security');
    await expect(screen.getByRole('button', 'Turn off', { exact: true })).toBeDisabled();
  } finally {
    // The group goes first, so the rule no longer holds when the second factor does; blair signs in with the password alone again.
    await sweep();
    await reset();
    expect((await personByEmail(people.blair.email)).two_factor_enabled, 'blair is left without a second factor').toBe(false);
  }
});
