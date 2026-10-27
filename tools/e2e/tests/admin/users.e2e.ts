import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';
import { people } from '../support/env.ts';
import { ok, signIn, wrongSignIn } from '../support/api.ts';
import { onlyOn } from '../support/ui.ts';

const target = people.blair.email;

// 23-18 (B-05): deactivating or deleting a user asks for the admin's own password, and
// the action cannot be confirmed without it. Both are cancelled here.
test('[23-18] deactivating or deleting a user asks for your password', { session: 'admin' }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  await app.open('/admin/users');
  for (const action of ['Deactivate', 'Delete user']) {
    await screen.getByRole('button', `Actions for ${target}`).tap();
    await screen.getByRole('menuitem', action, { exact: true }).tap();
    const dialog = screen.getByRole('alertdialog').or(screen.getByRole('dialog')).first();
    await expect(dialog.getByLabel('Your password', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', action, { exact: true })).toBeDisabled();
    await dialog.getByRole('button', 'Cancel', { exact: true }).tap();
  }
  const blair = await signIn('blair');
  expect((await blair('GET', '/api/auth/me')).status, 'blair is still active').toBe(200);
});

// 23-17 (B-04), three people: after three wrong sign-ins to the admin account, the admin
// still changes blair's role with the right password; blair's own session then has the
// admin role. alex, not an admin, is refused the same change by the server.
test('[23-17] after wrong sign-ins an admin still changes a role; a non-admin cannot', { session: 'admin', timeout: 180_000 }, async ({ app, screen, browser }) => {
  await onlyOn(browser, 'desktop');
  const admin = await signIn('admin');
  const { users } = ok(await admin<{ users: { id: string; email: string }[] }>('GET', '/api/admin/users'), 'list users');
  const blairId = users.find((user) => user.email === target)!.id;
  try {
    for (let i = 0; i < 3; i++) expect(await wrongSignIn('admin'), 'wrong password refused').toBe(401);

    await app.open('/admin/users');
    await screen.getByRole('button', `Actions for ${target}`).tap();
    await screen.getByRole('menuitem', 'Make admin', { exact: true }).tap();
    const dialog = screen.getByRole('dialog', `Make ${target} an admin?`);
    await dialog.getByLabel('Your password', { exact: true }).fill(credentials.user('admin').password);
    await dialog.getByRole('button', 'Make admin', { exact: true }).tap();
    await expect(dialog).toBeHidden();
    const blair = await signIn('blair');
    expect(ok(await blair<{ user: { role: string } }>('GET', '/api/auth/me'), 'blair me').user.role).toBe('admin');

    const alex = await signIn('alex');
    expect((await alex('PUT', `/api/admin/users/${blairId}/role`, { role: 'user', current_password: 'local-dev-admin-password' })).status,
      'a non-admin is refused').toBe(403);

    await screen.getByRole('button', `Actions for ${target}`).tap();
    await screen.getByRole('menuitem', 'Remove admin rights', { exact: true }).tap();
    const remove = screen.getByRole('dialog', `Remove admin rights from ${target}?`);
    await remove.getByLabel('Your password', { exact: true }).fill(credentials.user('admin').password);
    await remove.getByRole('button', 'Remove admin rights', { exact: true }).tap();
    await expect(remove).toBeHidden();
    expect(ok(await blair<{ user: { role: string } }>('GET', '/api/auth/me'), 'blair me').user.role).toBe('user');
  } finally {
    // Leave blair a standard user whatever happened above.
    await admin('PUT', `/api/admin/users/${blairId}/role`, { role: 'user', current_password: 'local-dev-admin-password' });
  }
});
