import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { seedPeople } = require('./helpers/people.cts') as import('./helpers/people.cts').PeopleHelpers;

const skip = !process.env.MYSQL_TEST_HOST;

// Module and Music policies (0.30) with the shared people: a module a policy
// forbids is off and locked for the people it reaches, at the request
// boundary, in their module list and for the workers, and comes back with
// its data when the policy allows it again; the Music page can go alone.
test('module policies: off and locked for the people they reach, workers follow, data stays; the Music page alone', { skip, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const { ids, groups, clients, password } = await seedPeople(t, pool);
  const { admin, member: blair, stranger: casey } = clients;
  type Client = typeof admin;
  async function call(client: Client, method: string, url: string, body?: unknown, status = 200) {
    const reply = await client.request(method, url, method === 'GET' ? undefined : body ?? {});
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 500)}`);
    return reply.body as FixtureValue;
  }
  const group = (id: string, body: Record<string, unknown>) => call(admin, 'PUT', `/api/admin/groups/${id}/policies`, { current_password: password, ...body });
  const everyone = (values: Record<string, unknown>) => call(admin, 'PUT', '/api/admin/policies', { values, current_password: password });
  const modules = async (client: Client) => call(client, 'GET', '/api/modules');
  const moduleOf = async (client: Client, id: string) => (await modules(client)).modules.find((entry: FixtureValue) => entry.id === id);
  const pageOf = async (client: Client, id: string) => (await modules(client)).pages.find((entry: FixtureValue) => entry.id === id);

  // The hooks a module change runs (stopping and resuming mail work), observed.
  const mailControl = require('../dist/src/services/mail-sync-control') as typeof import('../src/services/mail-sync-control');
  const mailChanges: [string, boolean][] = [];
  t.mock.method(mailControl, 'onMailModuleChanged', async (userId: string, next: { enabled: boolean }) => { mailChanges.push([userId, next.enabled]); });
  const { blockedBackgroundModulesByUser, canRunModule } = require('../dist/src/services/access-policy') as typeof import('../src/services/access-policy');

  await t.test('Mail forbidden for a group: refused with the reason for its members only, the mail work stops, enabling it is refused', async () => {
    const reason = 'Your administrator turned Mail off.';
    await group(groups.support, { values: { 'modules.mail': 'forbidden' } });
    const refused = await call(blair, 'GET', '/api/mail/accounts', undefined, 403);
    assert.deepEqual(refused, { error: reason, code: 'MODULE_DISABLED', module: 'mail', details: { policy: 'modules.mail', reason } });
    await call(casey, 'GET', '/api/mail/accounts');
    assert.deepEqual(await moduleOf(blair, 'mail').then(module => [module.enabled, module.policy]), [false, { key: 'modules.mail', reason }]);
    assert.equal((await moduleOf(casey, 'mail')).policy, undefined);
    // The change reached running work for the members it turned Mail off for (Alex and Blair).
    assert.deepEqual(mailChanges.sort(), [[ids.manager, false], [ids.member, false]].sort());
    assert.equal(await canRunModule(ids.member, 'mail'), false);
    assert.equal(await canRunModule(ids.stranger, 'mail'), true);
    const blocked = await blockedBackgroundModulesByUser();
    assert.equal(blocked.get(ids.member)?.has('mail'), true);
    assert.equal(blocked.get(ids.stranger)?.has('mail') ?? false, false);
    // Turning it on is refused; the person's own switch stays as it was.
    const enabling = await call(blair, 'PUT', '/api/modules', { modules: { mail: { enabled: true } } }, 403);
    assert.deepEqual([enabling.code, enabling.details.policy], ['POLICY_FORBIDS', 'modules.mail']);
    await call(blair, 'PUT', '/api/modules', { modules: { mail: { visible: false } } });
    mailChanges.length = 0;
    await group(groups.support, { clear: ['modules.mail'] });
    assert.deepEqual(mailChanges.sort(), [[ids.manager, true], [ids.member, true]].sort(), 'mail work resumes');
    assert.deepEqual(await moduleOf(blair, 'mail').then(module => [module.enabled, module.visible, module.policy]), [true, false, undefined]);
    await call(blair, 'GET', '/api/mail/accounts');
  });

  await t.test('Contacts forbidden for everyone and allowed again: the data stays', async () => {
    const created = (await call(blair, 'POST', '/api/contacts', { name: { given: 'Synthetic' }, emails: ['synthetic@example.test'] })).contact;
    await everyone({ 'modules.contacts': 'forbidden' });
    for (const client of [blair, casey, admin]) assert.equal((await call(client, 'GET', '/api/contacts', undefined, 403)).code, 'MODULE_DISABLED');
    // Every person's background work stops, also of people who never saved a module switch.
    const blocked = await blockedBackgroundModulesByUser();
    for (const id of [ids.member, ids.stranger, ids.admin]) assert.equal(blocked.get(id)?.has('contacts'), true, id);
    await everyone({ 'modules.contacts': 'allowed' });
    const listed = await call(blair, 'GET', '/api/contacts');
    assert.ok(JSON.stringify(listed).includes(created.id), 'the contact is still there');
  });

  await t.test('the Music page alone goes; recordings keep working', async () => {
    await group(groups.support, { values: { 'pages.music': 'forbidden' } });
    const music = await pageOf(blair, 'music');
    assert.deepEqual([music.visible, music.policy], [false, { key: 'pages.music', reason: 'Your administrator turned the Music page off.' }]);
    assert.equal((await pageOf(blair, 'recordings')).visible, true);
    assert.equal((await moduleOf(blair, 'recordings')).enabled, true);
    await call(blair, 'GET', '/api/recordings');
    assert.equal((await pageOf(casey, 'music')).policy, undefined);
    const showing = await call(blair, 'PUT', '/api/modules', { pages: { music: { visible: true } } }, 403);
    assert.deepEqual([showing.code, showing.details.policy], ['POLICY_FORBIDS', 'pages.music']);
    // Recordings off: the module and both its pages go.
    await group(groups.support, { values: { 'modules.recordings': 'forbidden' } });
    assert.equal((await pageOf(blair, 'recordings')).visible, false);
    assert.equal((await call(blair, 'GET', '/api/recordings', undefined, 403)).code, 'MODULE_DISABLED');
    await group(groups.support, { clear: ['modules.recordings', 'pages.music'] });
    assert.equal((await pageOf(blair, 'music')).visible, true);
  });
});
