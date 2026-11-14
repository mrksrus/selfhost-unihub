// 0.30.0 (30-07, the app's side): an administrator signs out a person's
// Android app from the person's page. The open app is signed out at its next
// request and shows the sign-in form; the person's other device stays signed
// in, and their password still lets them in. The person is the test's own,
// so no seeded session ends. (The browser's side is
// tools/e2e/tests/organisation/admin-devices.e2e.ts.)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGE, openApp, signOutApp, sleep } from '../support/android.mjs';
import { PASSWORD, addPerson, ok, people, resetPeople } from '../support/people.mjs';

before(async () => {
  await resetPeople();
  await signOutApp();
});

after(resetPeople);

/** Waits until the app's page shows the sign-in form, looking at whichever page target the WebView has now. */
async function signInFormShown(device, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const page = await (await device.webView({ pkg: PACKAGE }, { timeout: 10_000 })).page();
      if (new URL(page.url()).pathname.startsWith('/auth') && await page.getByLabel('Email').isVisible()) return true;
    } catch { /* the target went away mid-check; take the next one */ }
    await sleep(2000);
  }
  return false;
}

test('[30-07 agent part] an administrator signs out the app; the app shows the sign-in form, the other device stays, the password still works', { timeout: 600_000 }, async () => {
  const person = await addPerson('signout');
  const desk = await person.session();
  let { device } = await openApp({ email: person.email });
  try {
    const [admin] = await people();
    const { devices } = await ok(admin('GET', `/api/admin/users/${person.id}/devices`), "the person's devices");
    const app = devices.find(d => d.app_version !== null);
    assert.ok(app, `the app is one of the person's devices: ${JSON.stringify(devices)}`);
    assert.equal(devices.length, 2, 'the app and the test session');

    // Not without the administrator's own password.
    assert.equal((await admin('DELETE', `/api/admin/users/${person.id}/devices/${app.id}`, {})).status, 400);
    await ok(admin('DELETE', `/api/admin/users/${person.id}/devices/${app.id}`, { current_password: PASSWORD }), 'sign out the app');

    assert.ok(await signInFormShown(device, 120_000), 'the app shows the sign-in form');
    const left = (await ok(admin('GET', `/api/admin/users/${person.id}/devices`), "the person's devices")).devices;
    assert.deepEqual(left.map(d => d.id), devices.filter(d => d.id !== app.id).map(d => d.id), 'only the app was signed out');
    assert.equal((await desk('GET', '/api/auth/me')).status, 200, 'the other device stays signed in');
  } finally {
    await device.close();
  }

  // Signed out, not locked out: the app signs in again with the password.
  ({ device } = await openApp({ email: person.email, restart: false }));
  await device.close();
});
