import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

// An administrator's view of a person's devices: they see the signed-in
// ones, sign one or all of them out with their password, the devices' live
// streams close and their next request answers 401; the person's data stays.
test('an administrator lists a person\'s devices and signs one or all of them out', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, clients, password, api } = await seedPeople(t, pool);
  const { admin, manager: alex, member: blair } = clients;
  const { realtime } = require('../dist/src/services/realtime') as typeof import('../src/services/realtime');
  const closed: string[] = [];
  const closeSessionKey = realtime.closeSessionKey;
  realtime.closeSessionKey = ((key: string, options: FixtureValue) => { closed.push(key); return closeSessionKey.call(realtime, key, options); }) as typeof closeSessionKey;
  t.after(() => { realtime.closeSessionKey = closeSessionKey; });

  // Blair on a second device, with a contact of her own.
  const phone = api.client();
  assert.equal((await phone.request('POST', '/api/auth/signin', { email: 'blair@example.test', password, device: { key: crypto.randomBytes(32).toString('base64url'), kind: 'web' } })).status, 200);
  assert.equal((await blair.request('POST', '/api/contacts', { first_name: 'Kept' })).status < 300, true);
  const devicesOf = async () => (await admin.request('GET', `/api/admin/users/${ids.member}/devices`)).body.devices as FixtureValue[];
  const listed = await devicesOf();
  assert.equal(listed.length, 2);
  assert.ok(listed.every(device => !('current' in device)));

  // Not for a manager or a member.
  for (const client of [alex, blair]) {
    assert.equal((await client.request('GET', `/api/admin/users/${ids.member}/devices`)).status, 403);
    assert.equal((await client.request('DELETE', `/api/admin/users/${ids.member}/devices`, { current_password: password })).status, 403);
  }

  // One device: the password, then that device only is signed out.
  const phoneDevice = ((await phone.request('GET', '/api/devices')).body.devices as FixtureValue[]).find(device => device.current);
  assert.ok(listed.some(device => device.id === phoneDevice.id));
  assert.equal((await admin.request('DELETE', `/api/admin/users/${ids.member}/devices/${phoneDevice.id}`, { current_password: 'not-the-password' })).status, 403);
  assert.deepEqual((await admin.request('DELETE', `/api/admin/users/${ids.manager}/devices/${phoneDevice.id}`, { current_password: password })).body.code, 'DEVICE_NOT_FOUND', 'only the person\'s own');
  assert.deepEqual((await admin.request('DELETE', `/api/admin/users/${ids.member}/devices/${phoneDevice.id}`, { current_password: password })).body, { ended: 1 });
  assert.equal(closed.length, 1, 'its live stream closes');
  assert.equal((await phone.request('GET', '/api/auth/me')).status, 401);
  assert.equal((await blair.request('GET', '/api/auth/me')).status, 200);
  assert.equal((await devicesOf()).length, 1);

  // All of them.
  assert.deepEqual((await admin.request('DELETE', `/api/admin/users/${ids.member}/devices`, { current_password: password })).body, { ended: 1 });
  assert.equal((await blair.request('GET', '/api/auth/me')).status, 401);
  assert.deepEqual(await devicesOf(), []);
  assert.equal((await alex.request('GET', '/api/auth/me')).status, 200, 'other people stay signed in');
  const [[contacts]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?', [ids.member]);
  assert.equal(Number(contacts.n), 1, 'her data stays');

  const [entries] = await pool.query<RowDataPacket[]>("SELECT action, actor_id, target_user_id FROM audit_log WHERE action IN ('admin.device_removed', 'admin.devices_ended') ORDER BY action");
  assert.deepEqual(entries.map(row => [row.action, row.actor_id, row.target_user_id]), [['admin.device_removed', ids.admin, ids.member], ['admin.devices_ended', ids.admin, ids.member]]);
});
