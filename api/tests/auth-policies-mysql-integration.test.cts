import type { RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// RFC 6238 with SHA-1, 6 digits, 30 s, independent of the service.
function otp(secret: string) {
  let bits = '';
  for (const char of secret) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  return String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// The sign-in policies (0.30) through the real request handler on the
// disposable MariaDB, with the shared people (admin, Alex the manager, Blair
// the member, Casey the stranger, Drew):
// - auth.password_min_length at sign-up, a password change, an admin's reset,
//   Add person's typed first password and a setup link
// - auth.session_max_days: an older session ends at its next request, a younger one works
// - auth.two_factor: the 7-day grace starts at the save (and lazily at the
//   gate), nothing is refused during it, then only the exempt routes answer,
//   administrators included; setting 2FA up ends the grace, turning it off is
//   refused at once; removing the rule ends every grace, a new rule starts a
//   new one; the save preview counts who lacks 2FA and who is in grace
test('sign-in policies: password minimum, session lifetime and 2FA required with its grace', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async (t) => {
  const pool = await withTestDatabase(t);
  const people = await seedPeople(t, pool);
  const { ids, clients, password, groups } = people;
  const rows = async (sql: string, values: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, values))[0];
  const setPolicies = async (values: Record<string, unknown>) => {
    const saved = await clients.admin.request('PUT', '/api/admin/policies', { values, current_password: password });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  };
  const since = async (id: string) => (await rows('SELECT two_factor_required_since AS since FROM users WHERE id = ?', [id]))[0].since as Date | null;

  // --- Password minimum ---
  await setPolicies({ 'auth.password_min_length': 16 });
  await (require('../dist/src/services/settings') as typeof import('../src/services/settings')).setSignupMode('open');
  const newcomer = people.api.client();
  const signup = (pass: string) => newcomer.request('POST', '/api/auth/signup', { email: 'newcomer@example.test', password: pass, full_name: 'Newcomer' });
  const short = await signup('fifteen-chars-x');
  assert.deepEqual([short.status, short.body.error], [400, 'Password must be at least 16 characters']);
  assert.equal((await signup('sixteen-chars-xx')).status, 200);

  const change = (pass: string) => clients.member.request('PUT', '/api/auth/password', { current_password: password, new_password: pass });
  assert.deepEqual([(await change('fifteen-chars-x')).status], [400]);
  assert.equal((await change('member-new-password-16')).status, 200);
  assert.equal(clients.member.signedIn, false, 'a password change signs this browser out');
  assert.equal((await rows('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', [ids.member]))[0].count, 0, 'and ends every session');

  const reset = (pass: string) => clients.admin.request('PUT', `/api/admin/users/${ids.stranger}/password`, { new_password: pass, current_password: password });
  assert.equal((await reset('fifteen-chars-x')).status, 400);
  assert.equal((await reset(password)).status, 200);
  // Add person with a first password the administrator types: refused short, and then nobody exists.
  const addPerson = (email: string, extra: Record<string, unknown>) =>
    clients.admin.request('POST', '/api/admin/users', { email, full_name: 'Added', role: 'user', current_password: password, ...extra });
  const typed = await addPerson('typed@example.test', { password: 'fifteen-chars-x' });
  assert.deepEqual([typed.status, typed.body.code], [400, 'PASSWORD_TOO_SHORT']);
  assert.equal((await rows('SELECT COUNT(*) AS count FROM users WHERE email = ?', ['typed@example.test']))[0].count, 0);
  assert.equal((await addPerson('typed@example.test', { password: 'sixteen-chars-xx' })).status, 200);
  assert.equal((await people.api.client().request('POST', '/api/auth/signin', { email: 'typed@example.test', password: 'sixteen-chars-xx' })).status, 200);

  // A setup link: the password chosen on it meets the same minimum.
  const invited = await addPerson('invited@example.test', {});
  assert.equal(invited.status, 200, JSON.stringify(invited.body));
  const token = String((invited.body.setup_link as { url: string }).url.split('#')[1]);
  const invitee = people.api.client();
  const accept = (pass: string) => invitee.request('POST', '/api/auth/invite/accept', { token, password: pass });
  const shortAccept = await accept('fifteen-chars-x');
  assert.deepEqual([shortAccept.status, shortAccept.body.code], [400, 'PASSWORD_TOO_SHORT']);
  assert.equal((await accept('sixteen-chars-xx')).status, 200);
  assert.equal(invitee.signedIn, true);

  await setPolicies({ 'auth.password_min_length': 12 });

  // --- Session lifetime: Casey's sign-in is eight days old, Alex's new ---
  const casey = people.api.client();
  const caseyIn = await casey.request('POST', '/api/auth/signin', { email: 'casey@example.test', password });
  assert.equal(caseyIn.status, 200);
  await pool.execute('UPDATE sessions SET created_at = UTC_TIMESTAMP() - INTERVAL 8 DAY WHERE user_id = ?', [ids.stranger]);
  assert.equal((await casey.request('GET', '/api/auth/me')).status, 200, 'no limit: an old session works');
  await setPolicies({ 'auth.session_max_days': '7' });
  assert.equal((await casey.request('GET', '/api/auth/me')).status, 401);
  assert.equal((await rows('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', [ids.stranger]))[0].count, 0, 'the session row is gone');
  assert.equal((await clients.manager.request('GET', '/api/auth/me')).status, 200, 'a younger session works');
  await setPolicies({ 'auth.session_max_days': 'none' });
  assert.equal((await casey.request('POST', '/api/auth/signin', { email: 'casey@example.test', password })).status, 200);
  const blair = people.api.client();
  assert.equal((await blair.request('POST', '/api/auth/signin', { email: 'blair@example.test', password: 'member-new-password-16' })).status, 200);

  // --- 2FA required: the grace starts at the save for everyone without 2FA ---
  const before = Date.now();
  await setPolicies({ 'auth.two_factor': 'required' });
  for (const person of ['admin', 'manager', 'member', 'stranger'] as const) {
    const start = await since(ids[person]);
    assert.ok(start && start.getTime() >= before - 2000 && start.getTime() <= Date.now(), `${person}'s grace starts at the save`);
  }
  const effective = await blair.request('GET', '/api/policies/effective');
  assert.equal(effective.body.two_factor && (effective.body.two_factor as { required: boolean }).required, true);
  assert.equal((effective.body.two_factor as { grace_ends_at: string }).grace_ends_at, new Date((await since(ids.member))!.getTime() + 7 * 86400000).toISOString());
  assert.equal((await blair.request('GET', '/api/contacts')).status, 200, 'nothing is refused during the grace');

  // The gate starts a grace it finds missing (a person the save did not reach), once.
  await pool.execute('UPDATE users SET two_factor_required_since = NULL WHERE id = ?', [ids.stranger]);
  assert.equal((await casey.request('GET', '/api/contacts')).status, 200);
  const lazy = await since(ids.stranger);
  assert.ok(lazy);
  await casey.request('GET', '/api/contacts');
  assert.equal((await since(ids.stranger))!.getTime(), lazy!.getTime(), 'set only while empty');

  // The save preview: everyone, a group, an unknown group.
  const everyone = await clients.admin.request('POST', '/api/admin/policies/preview', {});
  const active = Number((await rows('SELECT COUNT(*) AS count FROM users WHERE is_active = TRUE AND two_factor_enabled = FALSE'))[0].count);
  assert.equal((everyone.body.two_factor as { without: number }).without, active);
  assert.equal((everyone.body.two_factor as { in_grace: unknown[] }).in_grace.length, active);
  const support = await clients.admin.request('POST', '/api/admin/policies/preview', { group_id: groups.support });
  assert.deepEqual((support.body.two_factor as { in_grace: { id: string }[] }).in_grace.map(person => person.id).sort(), [ids.manager, ids.member].sort());
  assert.equal((await clients.admin.request('POST', '/api/admin/policies/preview', { group_id: crypto.randomUUID() })).status, 404);
  assert.equal((await clients.manager.request('POST', '/api/admin/policies/preview', {})).status, 403, 'administrators only');

  // Eight days later for Blair: only the exempt routes answer.
  await pool.execute('UPDATE users SET two_factor_required_since = UTC_TIMESTAMP() - INTERVAL 8 DAY WHERE id = ?', [ids.member]);
  const refused = await blair.request('GET', '/api/contacts');
  assert.deepEqual([refused.status, refused.body.code], [403, 'TWO_FACTOR_REQUIRED']);
  assert.equal((refused.body.details as { reason: string }).reason, 'Your administrator requires two-factor authentication.');
  assert.ok(Date.parse((refused.body.details as { grace_ended_at: string }).grace_ended_at) < Date.now());
  assert.equal((await blair.request('GET', '/api/policies/effective')).status, 200);
  assert.equal((await blair.request('GET', '/api/auth/2fa/status')).status, 200);
  const sync = await blair.request('GET', '/api/contacts', undefined, { 'X-Background-Sync': '1', 'User-Agent': 'UniHubAndroid/0.29.0 (29000)' });
  assert.equal(sync.status, 200, 'the Android app\'s contacts sync keeps working');
  const upload = await blair.request('POST', '/api/recordings/uploads/start', {}, { 'X-Background-Sync': '1' });
  assert.notEqual(upload.body.code, 'TWO_FACTOR_REQUIRED', 'so do recording uploads');

  // Administrators too; setting 2FA up passes the gate and ends the grace.
  await pool.execute('UPDATE users SET two_factor_required_since = UTC_TIMESTAMP() - INTERVAL 8 DAY WHERE id = ?', [ids.admin]);
  assert.equal((await clients.admin.request('GET', '/api/admin/policies')).body.code, 'TWO_FACTOR_REQUIRED');
  const setup = await clients.admin.request('POST', '/api/auth/2fa/setup/start', {});
  assert.equal(setup.status, 200);
  const secret = String(setup.body.secret);
  const confirmed = await clients.admin.request('POST', '/api/auth/2fa/setup/confirm', { secret, code: otp(secret), current_password: password });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(await since(ids.admin), null);
  assert.equal((await clients.admin.request('GET', '/api/admin/policies')).status, 200);
  const off = await clients.admin.request('POST', '/api/auth/2fa/disable', { current_password: password, code: otp(secret) });
  assert.deepEqual([off.status, off.body.code], [403, 'POLICY_FORBIDS'], 'turning it off is refused at once');

  // The rule removed ends every grace; required again, a new one starts at that save.
  await setPolicies({ 'auth.two_factor': 'optional' });
  assert.equal(await since(ids.member), null);
  assert.equal((await blair.request('GET', '/api/contacts')).status, 200);
  const again = Date.now();
  await setPolicies({ 'auth.two_factor': 'required' });
  assert.ok((await since(ids.member))!.getTime() >= again - 2000, 'a new grace, not the old one');
  assert.equal((await blair.request('GET', '/api/contacts')).status, 200);
});
