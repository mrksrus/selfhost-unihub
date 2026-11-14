// The organisation of an e2e stack for the tests run with node --test (the
// Android app's, tools/e2e/android/): the three seeded people's sessions,
// groups with a manager, people of a test's own, rules for everyone or a
// group, and a reset run before and after each file, so a file that fails
// half-way leaves nothing for the next one. The web tests have the same
// steps in TypeScript (tests/organisation/organisation-helpers.ts); both use
// the `e2e-org-` and `e2e ` prefixes, so either clean-up removes what the
// other left.
//
// Since 0.28 a changed rule leaves its notice due for the people it reaches,
// and the notice covers the page: every change here confirms it for the
// seeded people (and the test's own people it names).

export const PASSWORD = 'local-dev-admin-password';
export const SEEDED = ['admin@example.com', 'alex@example.com', 'blair@example.com'];
const PERSON_PREFIX = 'e2e-org-';
const GROUP_PREFIX = 'e2e ';
const run = Date.now().toString(36).slice(-5);

/** A session of a person against the stack's API, from the test itself; each call answers status and body. */
export async function stackSession(email = 'admin@example.com', password = PASSWORD) {
  const base = process.env.UNIHUB_E2E_URL ?? `http://127.0.0.1:${8087 + Number(process.env.UNIHUB_E2E_INSTANCE ?? '1')}`;
  const response = await fetch(`${base}/api/auth/signin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`sign-in as ${email}: ${response.status}`);
  const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return async (method, path, data) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Cookie: cookie, 'X-CSRF-Token': body.csrfToken,
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, data: json };
  };
}

// One sign-in per seeded person and test file: each counts against the
// account's sign-in limit (10 in 10 minutes).
let seeded;
/** The seeded people's sessions: admin (the owner), alex and blair. */
export async function people() {
  seeded ??= await Promise.all(SEEDED.map(email => stackSession(email)));
  return seeded;
}

/** Answers the body of a call that must succeed, or throws with what came back. */
export async function ok(call, what) {
  const { status, data } = await call;
  if (status < 200 || status > 299) throw new Error(`${what}: ${status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/** Confirms the rules notice for the seeded people and any other sessions given, where it is due. */
export async function acknowledge(others = []) {
  for (const api of [...await people(), ...others]) {
    const data = await ok(api('GET', '/api/policies/effective'), 'effective rules');
    if (data.acknowledged_revision < data.revision) await ok(api('POST', '/api/policies/acknowledge', { revision: data.revision }), 'confirm the rules');
  }
}

/**
 * The administrator's session, ready to change rules. Their own device is
 * held to an app lock they require, the policies routes included: the
 * session reports a whole-app lock, as a page does once its lock is set up,
 * so it can always turn the rules off again.
 */
async function rulesSession() {
  const [admin] = await people();
  await ok(admin('PUT', '/api/devices/current/lock', {
    applied: { scope: ['app'], relock_after: '0', on_device_lock: false, method: 'pin' },
    capabilities: { lock: 'pin', secure_window: false, recents_hidden: false, device_lock_signal: false },
  }), "report the rules session's lock");
  return admin;
}

/**
 * Sets rules as the administrator, for everyone or (with `group`) for one
 * group, where `clear` gives a group's rules up again; then confirms the
 * notice for the seeded people and the sessions in `others`.
 */
export async function setRules(values, { group, clear, others = [] } = {}) {
  const admin = await rulesSession();
  await ok(admin('PUT', group ? `/api/admin/groups/${group}/policies` : '/api/admin/policies', { values, ...(clear ? { clear } : {}), current_password: PASSWORD }), 'save rules');
  await acknowledge(others);
}

/** The seeded people's ids by email. */
export async function seededIds() {
  const { users } = await ok((await people())[0]('GET', '/api/admin/users'), 'people');
  return Object.fromEntries(SEEDED.map(email => [email, users.find(user => user.email === email).id]));
}

/** A group the administrator creates, with members and managers (ids); managers become members too. */
export async function createGroup(label, { members = [], managers = [] } = {}) {
  const [admin] = await people();
  const { group } = await ok(admin('POST', '/api/admin/groups', { name: `${GROUP_PREFIX}${label} ${run}` }), `create group ${label}`);
  if (members.length) await ok(admin('POST', `/api/groups/${group.id}/members`, { user_ids: members }), `members of ${label}`);
  for (const id of managers) await ok(admin('PUT', `/api/admin/groups/${group.id}/managers/${id}`, { manager: true }), `manager of ${label}`);
  return group;
}

/**
 * The organisation of the shared API fixture (api/tests/helpers/people.cts):
 * Support, managed by alex with blair as a member, and Finance, managed by
 * alex. Admin is in no group.
 */
export async function seedOrganisation() {
  const ids = await seededIds();
  const alex = ids['alex@example.com'], blair = ids['blair@example.com'];
  const support = await createGroup('Support', { members: [blair], managers: [alex] });
  const finance = await createGroup('Finance', { managers: [alex] });
  return { ids, support, finance };
}

/** A person of the test's own, added by the administrator with the seeded password, and a session of theirs. */
export async function addPerson(label, { groups = [] } = {}) {
  const [admin] = await people();
  const email = `${PERSON_PREFIX}${label}-${run}@example.com`;
  const { user } = await ok(admin('POST', '/api/admin/users', { email, full_name: `${label} ${run}`, role: 'user', group_ids: groups,
    password: PASSWORD, current_password: PASSWORD }), `add ${email}`);
  return { id: user.id, email, session: () => stackSession(email) };
}

/**
 * Leaves the organisation as a new installation has it: every policy at its
 * default, no groups (their rules go with them), none of the test's own
 * people, and the notice confirmed. Run before and after each file.
 * shortcut: bin_min_retention is left as it is; reset it here once a file changes it.
 */
export async function resetPeople() {
  const admin = await rulesSession();
  const { policies } = await ok(admin('GET', '/api/admin/policies'), 'policies');
  const changed = Object.fromEntries(Object.entries(policies)
    .filter(([, policy]) => JSON.stringify(policy.value) !== JSON.stringify(policy.default)).map(([key, policy]) => [key, policy.default]));
  if (Object.keys(changed).length) await ok(admin('PUT', '/api/admin/policies', { values: changed, current_password: PASSWORD }), 'policies to their defaults');
  const { groups } = await ok(admin('GET', '/api/admin/groups'), 'groups');
  for (const { id } of groups) await ok(admin('DELETE', `/api/admin/groups/${id}`, { current_password: PASSWORD }), 'remove group');
  const { users } = await ok(admin('GET', '/api/admin/users'), 'people');
  for (const { id } of users.filter(user => user.email.startsWith(PERSON_PREFIX))) {
    await ok(admin('DELETE', `/api/admin/users/${id}`, { current_password: PASSWORD }), 'remove person');
  }
  await acknowledge();
}
