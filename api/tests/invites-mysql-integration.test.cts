import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// Add person and setup links through the real request handler: the account
// exists at once, a link works once within 7 days, renewing or revoking it
// ends the earlier one, only its hash is stored, and the person cannot sign
// in before they chose a password. It works while sign-ups are closed (a
// fresh installation's default).
test('Add person: a setup link works once and only for its person, or the administrator types a first password', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { groups, clients, password, api } = await seedPeople(t, pool);
  const { admin, manager: alex } = clients;
  const status = async (reply: Promise<{ status: number; body: FixtureValue }>) => { const { status: code, body } = await reply; return [code, body.code ?? null]; };
  const tokenOf = (url: string) => url.slice(url.indexOf('#') + 1);
  const add = (body: Record<string, unknown>) => admin.request('POST', '/api/admin/users', { role: 'user', current_password: password, ...body });

  // A rule in force, so the page has a revision to show.
  assert.equal((await admin.request('PUT', '/api/admin/policies', { values: { 'backup.delete': 'forbidden' }, current_password: password })).status, 200);
  const [[revisionRow]] = await pool.query<RowDataPacket[]>("SELECT setting_value FROM system_settings WHERE setting_key = 'policy_revision'");
  const revision = Number(revisionRow.setting_value);

  // Only an administrator adds people, with their password.
  assert.equal((await alex.request('POST', '/api/admin/users', { email: 'x@example.test', role: 'user', current_password: password })).status, 403);
  assert.equal((await add({ email: 'eve@example.test', current_password: 'not-the-password' })).status, 403);
  assert.deepEqual(await status(add({ email: 'not an address' })), [400, 'EMAIL_INVALID']);
  assert.deepEqual(await status(add({ email: 'alex@example.test' })), [409, 'USER_EXISTS']);
  assert.deepEqual(await status(add({ email: 'eve@example.test', group_ids: [crypto.randomUUID()] })), [404, 'GROUP_NOT_FOUND']);

  // Eve: in Support at once, invited, with a link shown once.
  const eve = await add({ email: 'eve@example.test', full_name: 'Eve Example', group_ids: [groups.support] });
  assert.equal(eve.status, 200, String(eve.body.error));
  const eveUser = eve.body.user as FixtureValue;
  assert.deepEqual([eveUser.status, eveUser.role, eveUser.groups.map((group: FixtureValue) => group.name)], ['invited', 'user', ['Support']]);
  const link = eve.body.setup_link as FixtureValue;
  assert.match(link.url, /\/invite#[A-Za-z0-9_-]{43}$/);
  const token = tokenOf(link.url);
  const [stored] = await pool.query<RowDataPacket[]>('SELECT * FROM invites WHERE user_id = ?', [eveUser.id]);
  assert.equal(stored[0].token_hash, crypto.createHash('sha256').update(token).digest('hex'), 'only the hash is stored');
  assert.ok(!JSON.stringify(stored).includes(token));
  assert.ok(Math.abs(new Date(link.expires_at).getTime() - Date.now() - 7 * 86400000) < 120000, 'valid for 7 days');

  // Eve has no password: no password signs her in, and bcrypt is never asked.
  const bcrypt = require('bcryptjs') as typeof import('bcryptjs');
  const compare = bcrypt.compare;
  let compared = 0;
  bcrypt.compare = ((...args: Parameters<typeof compare>) => { compared++; return compare(...args); }) as typeof compare;
  try {
    for (const attempt of ['', 'x', 'anything-at-all-long-enough']) {
      const signin = await api.client().request('POST', '/api/auth/signin', { email: 'eve@example.test', password: attempt || ' ' });
      assert.equal(signin.status, 401);
    }
  } finally { bcrypt.compare = compare; }
  assert.equal(compared, 0);

  // The page asks who the link is for, with her rules and their revision.
  const anonymous = api.client();
  const checked = await anonymous.request('POST', '/api/auth/invite/check', { token });
  assert.equal(checked.status, 200);
  assert.deepEqual([checked.body.email, checked.body.full_name, checked.body.rules_revision], ['eve@example.test', 'Eve Example', revision]);
  assert.ok((checked.body.data_rules as string[]).length > 0);
  assert.deepEqual(await status(anonymous.request('POST', '/api/auth/invite/check', { token: token.replace(/^./, token[0] === 'A' ? 'B' : 'A') })), [404, 'INVITE_INVALID']);

  // A password below her minimum is refused; then she is signed in, with the revision confirmed.
  assert.deepEqual(await status(anonymous.request('POST', '/api/auth/invite/accept', { token, password: 'short' })), [400, 'PASSWORD_TOO_SHORT']);
  const accepted = await anonymous.request('POST', '/api/auth/invite/accept', { token, password: 'eve-chose-this-password', full_name: 'Eve E.', rules_revision: revision });
  assert.equal(accepted.status, 200, String(accepted.body.error));
  assert.equal(anonymous.signedIn, true);
  assert.equal(((await anonymous.request('GET', '/api/auth/me')).body.user as FixtureValue).full_name, 'Eve E.');
  const [notices] = await pool.query<RowDataPacket[]>('SELECT revision FROM policy_notices WHERE user_id = ?', [eveUser.id]);
  assert.deepEqual(notices.map(row => Number(row.revision)), [revision]);
  assert.equal((await api.client().request('POST', '/api/auth/signin', { email: 'eve@example.test', password: 'eve-chose-this-password' })).status, 200);

  // Used up: the link answers as any invalid one.
  assert.deepEqual(await status(api.client().request('POST', '/api/auth/invite/check', { token })), [404, 'INVITE_INVALID']);
  assert.deepEqual(await status(api.client().request('POST', '/api/auth/invite/accept', { token, password: 'another-long-password' })), [404, 'INVITE_INVALID']);
  assert.deepEqual(await status(admin.request('POST', `/api/admin/users/${eveUser.id}/setup-link`, { current_password: password })), [400, 'ALREADY_SET_UP']);

  // Renewing ends the earlier link; revoking ends the new one; a link ends after its time.
  const finn = await add({ email: 'finn@example.test' });
  const finnId = (finn.body.user as FixtureValue).id;
  const first = tokenOf((finn.body.setup_link as FixtureValue).url);
  const renewed = await admin.request('POST', `/api/admin/users/${finnId}/setup-link`, { current_password: password });
  assert.equal(renewed.status, 200);
  const second = tokenOf((renewed.body.setup_link as FixtureValue).url);
  assert.deepEqual(await status(api.client().request('POST', '/api/auth/invite/check', { token: first })), [404, 'INVITE_INVALID']);
  assert.equal((await api.client().request('POST', '/api/auth/invite/check', { token: second })).status, 200);
  assert.deepEqual((await admin.request('DELETE', `/api/admin/users/${finnId}/setup-link`)).body, { revoked: true });
  assert.deepEqual(await status(api.client().request('POST', '/api/auth/invite/check', { token: second })), [404, 'INVITE_INVALID']);
  const people = (await admin.request('GET', '/api/admin/users')).body.users as FixtureValue[];
  assert.equal(people.find(person => person.id === finnId).status, 'not_set_up');
  const third = tokenOf(((await admin.request('POST', `/api/admin/users/${finnId}/setup-link`, { current_password: password })).body.setup_link as FixtureValue).url);
  await pool.execute('UPDATE invites SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE user_id = ?', [finnId]);
  assert.deepEqual(await status(api.client().request('POST', '/api/auth/invite/check', { token: third })), [404, 'INVITE_INVALID']);

  // A first password typed by the administrator: their minimum applies, then the person signs in with it.
  assert.deepEqual(await status(add({ email: 'gus@example.test', password: 'short' })), [400, 'PASSWORD_TOO_SHORT']);
  assert.equal((await pool.query<RowDataPacket[]>("SELECT id FROM users WHERE email = 'gus@example.test'"))[0].length, 0, 'nothing was created');
  const gus = await add({ email: 'gus@example.test', password: 'typed-by-the-admin' });
  assert.deepEqual([(gus.body.user as FixtureValue).status, gus.body.setup_link], ['active', null]);
  assert.equal((await api.client().request('POST', '/api/auth/signin', { email: 'gus@example.test', password: 'typed-by-the-admin' })).status, 200);

  const [actions] = await pool.query<RowDataPacket[]>("SELECT action FROM audit_log WHERE action IN ('admin.user_created', 'admin.setup_link_created', 'admin.setup_link_revoked', 'auth.setup_completed')");
  assert.deepEqual([...new Set(actions.map(row => row.action))].sort(), ['admin.setup_link_created', 'admin.setup_link_revoked', 'admin.user_created', 'auth.setup_completed']);

  // Accepting spends the sign-up budget of the address: a guessing run ends in 429.
  let last = 0;
  for (let attempt = 0; attempt < 12 && last !== 429; attempt++) {
    last = (await api.client().request('POST', '/api/auth/invite/accept', { token: crypto.randomBytes(32).toString('base64url'), password: 'guessing-a-link-here' })).status;
  }
  assert.equal(last, 429);
});
