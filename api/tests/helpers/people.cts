import type { TestContext } from 'node:test';
import type { Pool } from 'mysql2/promise';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { startTestApi } = require('./test-database.cts') as import('./test-database.cts').TestDatabaseHelpers;

// The shared organisation fixture (0.30): every feature that others can
// reach is tested with the same people, each signed in through the real
// sign-in of the request handler on the disposable database:
// - admin: the owner (handed over from the bootstrap administrator, who stays an administrator)
// - manager (Alex): manager of Support, member of Finance (two groups)
// - member (Blair): member of Support
// - stranger (Casey): in no group
// - revoked (Drew): was a manager of Support and was removed
// Groups are written as rows until their routes exist; the people are
// ordinary accounts. Synthetic names on reserved domains only.

type ApiClient = ReturnType<Awaited<ReturnType<typeof startTestApi>>['client']>;
type PersonName = 'admin' | 'manager' | 'member' | 'stranger' | 'revoked';

const PEOPLE: Readonly<Record<PersonName, { email: string; name: string; role: 'admin' | 'user' }>> = {
  admin: { email: 'ada.admin@example.test', name: 'Ada Admin', role: 'admin' },
  manager: { email: 'alex@example.test', name: 'Alex Manager', role: 'user' },
  member: { email: 'blair@example.test', name: 'Blair Member', role: 'user' },
  stranger: { email: 'casey@example.test', name: 'Casey Stranger', role: 'user' },
  revoked: { email: 'drew@example.test', name: 'Drew Revoked', role: 'user' },
};
const PASSWORD = 'organisation-fixture-password';

interface People {
  password: string;
  ids: Record<PersonName, string>;
  groups: { support: string; finance: string };
  clients: Record<PersonName, ApiClient>;
  api: Awaited<ReturnType<typeof startTestApi>>;
}

/** Seeds the people and groups on a migrated test database and signs each person in. */
async function seedPeople(t: TestContext, pool: Pool): Promise<People> {
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(PASSWORD, 10);
  const ids = {} as Record<PersonName, string>;
  for (const [key, person] of Object.entries(PEOPLE) as [PersonName, typeof PEOPLE[PersonName]][]) {
    ids[key] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name, role, email_verified) VALUES (?, ?, ?, ?, ?, TRUE)',
      [ids[key], person.email, passwordHash, person.name, person.role]);
  }
  // Step 28 made the bootstrap administrator the owner; the fixture's administrator takes over.
  await pool.execute("UPDATE users SET role = 'admin' WHERE role = 'owner'");
  await pool.execute("UPDATE users SET role = 'owner' WHERE id = ?", [ids.admin]);
  const groups = { support: crypto.randomUUID(), finance: crypto.randomUUID() };
  await pool.execute("INSERT INTO org_groups (id, name, description, created_by) VALUES (?, 'Support', 'Customer support', ?), (?, 'Finance', NULL, ?)",
    [groups.support, ids.admin, groups.finance, ids.admin]);
  const member = (group: string, user: string, role: 'member' | 'manager') =>
    pool.execute('INSERT INTO org_group_members (group_id, user_id, role, added_by) VALUES (?, ?, ?, ?)', [group, user, role, ids.admin]);
  await member(groups.support, ids.manager, 'manager');
  await member(groups.finance, ids.manager, 'member');
  await member(groups.support, ids.member, 'member');
  await member(groups.support, ids.revoked, 'manager');
  await pool.execute('DELETE FROM org_group_members WHERE group_id = ? AND user_id = ?', [groups.support, ids.revoked]);

  const api = await startTestApi(t);
  const clients = {} as Record<PersonName, ApiClient>;
  for (const key of Object.keys(PEOPLE) as PersonName[]) {
    const client = api.client();
    const signin = await client.request('POST', '/api/auth/signin', { email: PEOPLE[key].email, password: PASSWORD, device: { key: crypto.randomBytes(32).toString('base64url'), kind: 'web' } });
    assert.equal(signin.status, 200, `${key} signs in: ${String(signin.body.error)}`);
    clients[key] = client;
  }
  return { password: PASSWORD, ids, groups, clients, api };
}

export type { People, PersonName };
export type PeopleHelpers = { seedPeople: typeof seedPeople; PEOPLE: typeof PEOPLE };
module.exports = { seedPeople, PEOPLE };
