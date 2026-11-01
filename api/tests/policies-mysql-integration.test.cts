import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Data-safety policies (F13) at the request boundary, through the real
// request handler and MariaDB. Every route that declares a policy is walked
// with exactly that policy forbidden for the installation: each of three
// people (the owner of the records, another user aiming at the owner's
// records, an administrator on the user route) gets 403 POLICY_FORBIDS with
// the key and its plain reason, and no table changes. Without a policy the
// same routes behave as before.
test('a forbidding installation policy refuses every declared route before any side effect, for everyone', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const routes = require('../dist/src/routes') as typeof import('../src/routes');
  const { routePolicies } = require('../dist/src/http/route') as typeof import('../src/http/route');
  const { POLICIES } = require('../dist/src/services/settings') as typeof import('../src/services/settings');

  const password = 'synthetic-policies-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const [name, role] of [['alex', 'user'], ['blair', 'user'], ['admin', 'admin']] as const) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name, role]);
  }
  async function signIn(name: string) {
    const client = api.client();
    const reply = await client.request('POST', '/api/auth/signin', { email: `${name}@example.test`, password });
    assert.equal(reply.status, 200, String(reply.body.error));
    return client;
  }
  type Client = Awaited<ReturnType<typeof signIn>>;
  const people: [string, Client][] = [['alex', await signIn('alex')], ['blair', await signIn('blair')], ['admin', await signIn('admin')]];
  const alex = people[0][1], blair = people[1][1];
  async function call(client: Client, method: string, url: string, body: unknown = {}, status = 200) {
    const reply = await client.request(method, url, method === 'GET' ? undefined : body);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 400)}`);
    return reply.body as FixtureValue;
  }

  // Alex's records the walk aims at, so a handler that ran would change them.
  const contactId = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Casey' }, emails: ['casey@example.test'] })).contact.id as string;
  const ids = { contact: contactId, recording: crypto.randomUUID(), mail: crypto.randomUUID(), exportJob: crypto.randomUUID(), restoreJob: crypto.randomUUID() };
  await pool.execute("INSERT INTO recordings (id, user_id, title, content_type, storage_path) VALUES (?, ?, 'Synthetic memo', 'audio/webm', 'synthetic/memo.webm')", [ids.recording, users.alex]);
  await pool.execute("INSERT INTO mail_accounts (id, user_id, email_address, provider) VALUES (?, ?, 'alex@example.test', 'custom')", [ids.mail, users.alex]);
  await pool.execute("INSERT INTO data_export_jobs (id, user_id) VALUES (?, ?)", [ids.exportJob, users.alex]);
  await pool.execute("INSERT INTO backup_restore_jobs (id, user_id) VALUES (?, ?)", [ids.restoreJob, users.alex]);
  // A folder only UniHub has: deleting it with server=1 or true would go ahead
  // (nothing at the provider to refuse it), so a missed refusal changes a table.
  const folder = 'synthetic-projects';
  await pool.execute("INSERT INTO mail_folders (user_id, slug, display_name, is_system) VALUES (?, ?, 'Projects', FALSE)", [users.alex, folder]);
  const idFor = (pattern: string) => pattern.startsWith('/api/contacts/') ? ids.contact
    : pattern.startsWith('/api/recordings/') ? ids.recording
      : pattern.startsWith('/api/mail/accounts/') ? ids.mail
        : pattern.startsWith('/api/backup/jobs/') ? ids.exportJob
          : pattern.startsWith('/api/backup/restore-jobs/') ? ids.restoreJob
            : pattern.startsWith('/api/mail/folders/') ? folder : crypto.randomUUID();

  // Every table but the sessions, whose expiry slides with each request.
  const tables = ((await pool.query<RowDataPacket[]>('SHOW TABLES'))[0]).map(row => String(Object.values(row)[0])).filter(name => name !== 'sessions');
  const checksums = async () => (await pool.query<RowDataPacket[]>(`CHECKSUM TABLE ${tables.map(name => pool.escapeId(name)).join(', ')}`))[0]
    .map(row => `${row.Table}=${row.Checksum}`).join('\n');
  const forbid = async (key: string, { value = 'forbidden', locked = false } = {}) => {
    await pool.execute('DELETE FROM setting_policies');
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', ?, ?, ?)", [`policy.${key}`, value, locked ? 1 : 0]);
  };

  // Each route, each query variant that adds a policy (every accepted value
  // of every named parameter), each of its policies alone.
  const variants = (query: Readonly<Record<string, string | readonly string[]>>) => Object.entries(query).reduce<string[][][]>(
    (sets, [name, value]) => sets.flatMap(set => (typeof value === 'string' ? [value] : [...value]).map(one => [...set, [name, one]])), [[]])
    .map(pairs => new URLSearchParams(pairs.map(([name, value]) => [name, value])).toString());
  const cases: { key: string; url: string; policy: keyof typeof POLICIES }[] = [];
  for (const [key, spec] of Object.entries(routes)) {
    const conditional = [...spec.destructive ?? [], ...spec.requires ?? []].flatMap(entry => typeof entry === 'string' ? [] : variants(entry.query));
    for (const query of ['', ...conditional]) {
      const [, pattern] = key.split(' ');
      const url = pattern.replace(/:(\w+)/g, () => idFor(pattern)) + (query ? `?${query}` : '');
      for (const policy of routePolicies(spec, new URLSearchParams(query))) cases.push({ key, url, policy });
    }
  }
  assert.ok(cases.length >= 25, `${cases.length} cases`);
  assert.ok(cases.some(entry => entry.key === 'DELETE /api/mail/accounts/:id' && entry.policy === 'accounts.reset'), 'the purge variant is walked');
  assert.deepEqual(cases.filter(entry => entry.key === 'DELETE /api/mail/folders/:slug').map(entry => [entry.url, entry.policy]).sort(),
    [[`/api/mail/folders/${folder}?server=1`, 'mail.provider_delete'], [`/api/mail/folders/${folder}?server=true`, 'mail.provider_delete']], 'both server spellings are walked');

  for (const { key, url, policy } of cases) {
    await forbid(policy);
    const before = await checksums();
    const reason = POLICIES[policy].reasons.forbidden;
    for (const [name, client] of people) {
      const reply = await client.request(key.split(' ')[0], url, {});
      assert.deepEqual([reply.status, reply.body], [403, { error: reason, status: 403, code: 'POLICY_FORBIDS', details: { policy, reason } }], `${name}: ${key} ${url} under ${policy}`);
    }
    assert.equal(await checksums(), before, `${key} under ${policy} changed nothing`);
  }
  const [[kept]] = await pool.query<RowDataPacket[]>(`SELECT
    (SELECT COUNT(*) FROM contacts WHERE id = ?) AS contacts, (SELECT COUNT(*) FROM recordings WHERE id = ?) AS recordings,
    (SELECT COUNT(*) FROM mail_accounts WHERE id = ?) AS mail, (SELECT COUNT(*) FROM data_export_jobs WHERE id = ?) AS exports,
    (SELECT COUNT(*) FROM backup_restore_jobs WHERE id = ?) AS restores, (SELECT COUNT(*) FROM users WHERE id IN (?, ?, ?)) AS users`, [ids.contact, ids.recording, ids.mail, ids.exportJob, ids.restoreJob, users.alex, users.blair, users.admin]);
  assert.deepEqual({ ...kept }, { contacts: 1, recordings: 1, mail: 1, exports: 1, restores: 1, users: 3 });

  // Forbidding deletion at the provider leaves a folder only UniHub has free
  // to go: its mail returns to Inbox and nothing is deleted anywhere.
  await forbid('mail.provider_delete');
  await call(alex, 'DELETE', `/api/mail/folders/${folder}`);
  const [[folders]] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM mail_folders WHERE user_id = ? AND slug = ?', [users.alex, folder]);
  assert.equal(Number(folders.count), 0);

  // Deleting from the bin for good forbidden also forbids deleting data, with that key's reason.
  await forbid('bin.delete');
  const dataReason = POLICIES['data.clear'].reasons.forbidden;
  assert.deepEqual((await call(alex, 'POST', '/api/settings/clear-contacts', {}, 403)).details, { policy: 'data.clear', reason: dataReason });
  // A locked policy refuses as well; a value the key cannot take is no policy.
  await forbid('data.clear', { locked: true });
  await call(alex, 'POST', '/api/settings/clear-contacts', {}, 403);
  await forbid('data.clear', { value: 'maybe' });
  const spare = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Spare' } })).contact.id as string;
  assert.equal((await call(alex, 'POST', '/api/settings/clear-contacts')).deleted, 2);
  // Policies of settings are not read as data-safety policies.
  await pool.execute('DELETE FROM setting_policies');
  await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'user.week_start', 'sunday', 1)");

  // No data-safety policy: the routes behave as before, the owner scope included.
  // (Deleting a contact answers the same whether it was there; only the owner's goes.)
  const again = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Again' } })).contact.id as string;
  await call(blair, 'DELETE', `/api/contacts/${again}`);
  const count = async (sql: string, id: string) => Number(((await pool.query<RowDataPacket[]>(sql, [id]))[0][0]).count);
  assert.equal(await count('SELECT COUNT(*) AS count FROM contacts WHERE id = ?', again), 1, 'another user cannot delete it');
  await call(alex, 'DELETE', `/api/contacts/${again}`);
  assert.equal(await count('SELECT COUNT(*) AS count FROM contacts WHERE user_id = ?', users.alex), 0);
  await call(blair, 'DELETE', `/api/recordings/${ids.recording}`, undefined, 404);
  await call(blair, 'DELETE', `/api/backup/jobs/${ids.exportJob}`, undefined, 404);
  assert.equal(await count('SELECT COUNT(*) AS count FROM recordings WHERE id = ?', ids.recording), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM data_export_jobs WHERE id = ?', ids.exportJob), 1);
});
