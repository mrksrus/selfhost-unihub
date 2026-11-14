import { credentials } from 'e2e';
import { people, runId, signInPassword, stack, type Person } from '../support/env.ts';
import { ok, signIn } from '../support/api.ts';

// What the organisation tests share. The seeded admin is the owner, alex the
// grantee (a group's member or manager) and blair the stranger. A test makes
// its own people and groups, named so that `sweep` finds what a run that
// stopped half-way left behind. It never ends a seeded person's sessions
// (deactivation, a new password, "Sign out all"): the rest of the run still
// uses them, so those actions get a person of the test's own.

export const SEEDED = ['admin', 'alex', 'blair'] as const;
/** The handle fills dialogs; bodies sent from Node need the value itself (synthetic). */
export const dialogPassword = (name: Person = 'admin') => credentials.user(name).password;

export interface PersonRow {
  id: string; email: string; full_name: string | null; role: string; status: string; is_active: boolean;
  two_factor_enabled: boolean; groups: { id: string; name: string; role: string }[];
}
export interface GroupRow { id: string; name: string; member_count: number; manager_count: number; has_policies: boolean }
export interface Effective {
  policies: Record<string, { allowed: boolean; reason: string | null; value: unknown }>;
  revision: number; acknowledged_revision: number; rules: string[];
  two_factor?: { required: boolean; grace_ends_at: string | null } | null;
}

const PERSON_PREFIX = 'e2e-org-';
const GROUP_PREFIX = 'e2e ';
export const newEmail = (label: string) => `${PERSON_PREFIX}${label}-${runId()}@example.com`;
export const newGroupName = (label: string) => `${GROUP_PREFIX}${label} ${runId()}`;

const owner = () => signIn('admin');

export async function listPeople() {
  return ok(await (await owner())<{ users: PersonRow[] }>('GET', '/api/admin/users'), 'people').users;
}
export async function personByEmail(email: string) {
  const person = (await listPeople()).find((entry) => entry.email === email);
  if (!person) throw new Error(`no person ${email}`);
  return person;
}
export const seededId = async (name: Person) => (await personByEmail(people[name].email)).id;

/** A person of the test's own, added by the owner; with a password they sign in as the seeded people do. */
export async function addPerson(label: string, { password = true, groups = [] as string[] } = {}) {
  const email = newEmail(label);
  const name = `${label[0].toUpperCase()}${label.slice(1)} ${runId()}`;
  const answer = ok(await (await owner())<{ user: PersonRow; setup_link: { url: string } | null }>('POST', '/api/admin/users', {
    email, full_name: name, role: 'user', group_ids: groups, ...(password ? { password: signInPassword } : {}), current_password: signInPassword,
  }), `add ${email}`);
  return { id: answer.user.id, email, name, setupLink: answer.setup_link?.url ?? null };
}

/** A sign-in with the password, counted by the login limiter like any other; the status tells whether it was let in. */
export async function passwordSignIn(email: string) {
  return (await fetch(`${stack.url}/api/auth/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'UniHub e2e helper' }, body: JSON.stringify({ email, password: signInPassword }),
  })).status;
}

export async function createGroup(label: string, members: string[] = []) {
  const api = await owner();
  const { group } = ok(await api<{ group: GroupRow }>('POST', '/api/admin/groups', { name: newGroupName(label) }), `create group ${label}`);
  if (members.length) ok(await api('POST', `/api/groups/${group.id}/members`, { user_ids: members }), `add members to ${group.name}`);
  return group;
}
export async function setManager(groupId: string, userId: string, manager = true) {
  ok(await (await owner())('PUT', `/api/admin/groups/${groupId}/managers/${userId}`, { manager }), 'set manager');
}

// A changed rule leaves its notice due for the people it reaches, and the
// notice covers the page: each seeded person confirms it here, except where a
// test is about that notice.
export async function acknowledge(names: readonly Person[] = SEEDED) {
  for (const name of names) {
    const api = await signIn(name);
    const effective = ok(await api<Effective>('GET', '/api/policies/effective'), `${name} rules`);
    if (effective.acknowledged_revision < effective.revision) ok(await api('POST', '/api/policies/acknowledge', { revision: effective.revision }), `${name} confirms the rules`);
  }
}

/** Sets rules as the owner, for everyone or for one group; the seeded people have seen them afterwards unless `unseen` names who has not. */
export async function setRules(values: Record<string, unknown>, { groupId, unseen = [] as readonly Person[] }: { groupId?: string; unseen?: readonly Person[] } = {}) {
  ok(await (await owner())('PUT', groupId ? `/api/admin/groups/${groupId}/policies` : '/api/admin/policies', { values, current_password: signInPassword }), 'set rules');
  await acknowledge(SEEDED.filter((name) => !unseen.includes(name)));
}

export const effectiveOf = async (name: Person) => ok(await (await signIn(name))<Effective>('GET', '/api/policies/effective'), `${name} rules`);

/** Removes the people and groups these tests made (this run's and an earlier, interrupted one's), then confirms the rules that changed with them. */
export async function sweep() {
  const api = await owner();
  for (const person of (await listPeople()).filter((entry) => entry.email.startsWith(PERSON_PREFIX))) {
    ok(await api('DELETE', `/api/admin/users/${person.id}`, { current_password: signInPassword }), `remove ${person.email}`);
  }
  const { groups } = ok(await api<{ groups: GroupRow[] }>('GET', '/api/admin/groups'), 'groups');
  for (const group of groups.filter((entry) => entry.name.startsWith(GROUP_PREFIX))) {
    ok(await api('DELETE', `/api/admin/groups/${group.id}`, { current_password: signInPassword }), `remove ${group.name}`);
  }
  await acknowledge();
}
