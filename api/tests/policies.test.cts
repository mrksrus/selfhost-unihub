// The data-safety policy keys (F13): with no policy set every action stays
// allowed; an administrator's policy refuses with the shape clients read
// (403 POLICY_FORBIDS with the key and a plain reason), resolved level by
// level as the registry orders each key. The stored rows are faked here; the
// real table and request boundary are in policies-mysql-integration.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { POLICIES, resolvePolicy, resolvePolicies, resolvePolicyValue, assertAllowed, policyForbids } = require('../dist/src/services/settings') as typeof import('../src/services/settings');
const { clientError } = require('../dist/src/http/errors') as typeof import('../src/http/errors');
const { BIN_MIN_RETENTION } = require('../dist/src/services/settings-registry') as typeof import('../src/services/settings-registry');

const keys = Object.keys(POLICIES) as (keyof typeof POLICIES)[];

// The installation's stored policies, as setting_policies rows.
function stored(rows: { key: string; value: string; locked?: boolean }[] = []) {
  const queries: string[] = [];
  const executor = { execute: async (sql: string) => {
    queries.push(sql);
    return [rows.map(row => ({ setting_key: row.key, setting_value: row.value, locked: row.locked ? 1 : 0 }))];
  } } as never;
  return { executor, queries };
}

test('with no policy set, every key resolves to its default and allows its action', async () => {
  const { executor, queries } = stored();
  for (const key of keys) {
    const resolved = await resolvePolicy('user-a', key, executor);
    assert.deepEqual(resolved, { value: POLICIES[key].default, source: 'default', allowed: true, reason: null }, key);
  }
  await assertAllowed('user-a', keys, {}, executor);
  assert.ok(queries.every(sql => /FROM setting_policies WHERE \(target_kind = 'installation' AND target_id = ''\)/.test(sql)), queries.join(' | '));
});

test('every value a policy can take other than the default has a plain reason to show', () => {
  for (const key of keys) {
    const entry = POLICIES[key];
    const values = entry.kind.type === 'enum' ? entry.kind.values : entry.kind.type === 'integer' ? entry.kind.values ?? [] : [];
    for (const value of values.filter(value => value !== entry.default)) {
      assert.ok(entry.reasons[String(value)]?.trim(), `${key} = ${value} has no reason`);
    }
    for (const value of entry.refuses) assert.ok((values as readonly unknown[]).includes(value), `${key} refuses a value it cannot take`);
  }
});

test('a refusal answers 403 POLICY_FORBIDS with the key and the reason', () => {
  const reason = POLICIES['bin.delete'].reasons.forbidden;
  assert.deepEqual(clientError(policyForbids('bin.delete', reason), 'fallback'),
    { error: reason, status: 403, code: 'POLICY_FORBIDS', details: { policy: 'bin.delete', reason } });
});

test('an installation policy forbids its action for everyone, except an administrator on the admin path', async () => {
  const { executor, queries } = stored([{ key: 'policy.account.delete', value: 'forbidden' }]);
  const reason = POLICIES['account.delete'].reasons.forbidden;
  assert.deepEqual(await resolvePolicy('user-a', 'account.delete', executor), { value: 'forbidden', source: 'policy', allowed: false, reason });
  for (const user of ['user-a', 'user-b']) {
    await assert.rejects(assertAllowed(user, 'account.delete', {}, executor),
      (error: unknown) => { assert.deepEqual(clientError(error, 'x'), { error: reason, status: 403, code: 'POLICY_FORBIDS', details: { policy: 'account.delete', reason } }); return true; });
  }
  const before = queries.length;
  await assertAllowed('user-a', 'account.delete', { adminId: 'admin-1' }, executor);
  assert.equal(queries.length, before, 'the admin path reads no policy');
  // The other keys keep their defaults.
  assert.equal((await resolvePolicy('user-a', 'backup.delete', executor)).allowed, true);
});

test('the boundary checks every declared key with one read and refuses with the first forbidden one', async () => {
  const { executor, queries } = stored([{ key: 'policy.accounts.reset', value: 'forbidden' }, { key: 'policy.data.clear', value: 'forbidden' }]);
  await assert.rejects(assertAllowed('user-a', ['accounts.remove', 'data.clear', 'accounts.reset'], {}, executor),
    (error: unknown) => (clientError(error, 'x') as { details: { policy: string } }).details.policy === 'data.clear');
  assert.equal(queries.length, 1);
  await assertAllowed('user-a', [], {}, executor);
  assert.equal(queries.length, 1, 'no key, no read');
});

test('deleting data is also refused while deleting from the bin for good is, with its own reason', async () => {
  const { executor } = stored([{ key: 'policy.bin.delete', value: 'forbidden' }]);
  assert.deepEqual(await resolvePolicy('user-a', 'data.clear', executor),
    { value: 'allowed', source: 'policy', allowed: false, reason: POLICIES['data.clear'].reasons.forbidden });
  await assert.rejects(assertAllowed('user-a', 'data.clear', {}, executor), (error: unknown) => (clientError(error, 'x') as { code: string }).code === 'POLICY_FORBIDS');
});

test('a stored value the key cannot take and an unknown key read as no policy', async () => {
  const { executor } = stored([
    { key: 'policy.backup.delete', value: 'maybe' }, { key: 'policy.backup.unknown', value: 'forbidden' },
    { key: 'policy.backup.server_retention_days', value: '45' }, { key: 'policy.backup.restore', value: 'forbidden' },
  ]);
  const all = await resolvePolicies('user-a', executor);
  assert.deepEqual(all['backup.delete'], { value: 'allowed', source: 'default', allowed: true, reason: null });
  assert.deepEqual(all['backup.server_retention_days'], { value: null, source: 'default', allowed: true, reason: null });
  assert.equal(all['backup.restore'].allowed, false);
  assert.deepEqual(Object.keys(all).sort(), [...keys].sort());
  const retention = stored([{ key: 'policy.backup.server_retention_days', value: '90' }]);
  assert.deepEqual(await resolvePolicy('user-a', 'backup.server_retention_days', retention.executor),
    { value: 90, source: 'policy', allowed: true, reason: POLICIES['backup.server_retention_days'].reasons['90'] });
});

// The app lock's requirement (0.29) is a list whose strictness is
// containment: across levels and groups the union holds, the whole app
// stands alone, and the maximum time in the background is the shortest.
test('app lock: the requirement is the union of the levels, the whole app stands alone, and each requirement has its words', () => {
  const required = POLICIES['app_lock.required'];
  const level = (value: string[], locked = false) => [{ value, locked }];
  assert.deepEqual(resolvePolicyValue(required, [level(['contacts']), level(['mail'])]), { value: ['mail', 'contacts'], source: 'policy' });
  assert.deepEqual(resolvePolicyValue(required, [undefined, [{ value: ['recordings'], locked: false }, { value: ['app', 'mail'], locked: false }]]), { value: ['app'], source: 'policy' });
  assert.deepEqual(resolvePolicyValue(required, [level(['mail'], true), level(['app'])]), { value: ['mail'], source: 'policy' }, 'a locked requirement stands');
  assert.deepEqual(resolvePolicyValue(required, [undefined, []]), { value: [], source: 'default' });
  const longest = POLICIES['app_lock.max_background'];
  assert.deepEqual(resolvePolicyValue(longest, [[{ value: '900', locked: false }], [{ value: '60', locked: false }, { value: '300', locked: false }]]), { value: '60', source: 'policy' });
  assert.equal(required.reasonOf!([]), null);
  assert.equal(required.reasonOf!(['app']), 'Your administrator requires the app lock for the whole app.');
  assert.equal(required.reasonOf!(['contacts', 'mail']), 'Your administrator requires the app lock for Mail and Contacts.');
  assert.equal(required.reasonOf!(['recordings', 'calendar', 'mail']), 'Your administrator requires the app lock for Mail, Calendar and ToDo, and Recordings and Music.');
  // None of the three refuses a route by name: the request boundary's app lock check does.
  for (const key of ['app_lock.required', 'app_lock.max_background', 'app_lock.screenshots'] as const) assert.deepEqual(POLICIES[key].refuses, [], key);
});

// Groups (0.30) are one more level after the installation's; the rules are
// those of the policies on settings.
test('levels: a locked value stands, an unlocked one is a floor along the key\'s order, and the strictest group wins', () => {
  const backupDelete = POLICIES['backup.delete'];
  const level = (value: string, locked = false) => [{ value, locked }];
  // Locked "allowed" for the installation: no group can forbid it.
  assert.deepEqual(resolvePolicyValue(backupDelete, [level('allowed', true), level('forbidden')]), { value: 'allowed', source: 'policy' });
  // Unlocked "forbidden": a group cannot loosen the floor; unlocked "allowed": a group can tighten it.
  assert.deepEqual(resolvePolicyValue(backupDelete, [level('forbidden'), level('allowed')]), { value: 'forbidden', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(backupDelete, [level('allowed'), level('forbidden')]), { value: 'forbidden', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(backupDelete, [level('forbidden'), level('allowed', true)]), { value: 'forbidden', source: 'policy' }, 'a narrower lock loosens no floor');
  assert.deepEqual(resolvePolicyValue(backupDelete, [undefined, [{ value: 'allowed', locked: false }, { value: 'forbidden', locked: false }]]), { value: 'forbidden', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(backupDelete, [undefined, []]), { value: 'allowed', source: 'default' });
  // Without an order a group's value replaces the installation's unless that
  // one refuses the action (a group only makes a rule stricter, 0.30); among
  // groups the one that refuses wins, and groups that disagree set nothing.
  const providerDelete = POLICIES['mail.provider_delete'];
  assert.deepEqual(resolvePolicyValue(providerDelete, [level('forbidden'), level('required')]), { value: 'forbidden', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(providerDelete, [level('user_choice'), level('required')]), { value: 'required', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(providerDelete, [level('forbidden', true), level('required')]), { value: 'forbidden', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(providerDelete, [undefined, [{ value: 'required', locked: false }, { value: 'forbidden', locked: false }]]), { value: 'forbidden', source: 'policy' });
  const newAccounts = POLICIES['mail.mode.new_accounts'];
  assert.deepEqual(resolvePolicyValue(newAccounts, [level('download'), [{ value: 'sync', locked: false }, { value: 'sync', locked: false }]]), { value: 'sync', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(newAccounts, [level('download'), [{ value: 'sync', locked: false }, { value: 'download_delete', locked: false }]]), { value: 'download', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(newAccounts, [undefined, [{ value: 'sync', locked: false }, { value: 'download', locked: false }]]), { value: 'user_choice', source: 'default' });
  // The bin's minimum defaults to its strictest value: a group cannot go below it, the installation can.
  const minimum = BIN_MIN_RETENTION as unknown as typeof backupDelete;
  assert.deepEqual(resolvePolicyValue(minimum, [undefined, level('30')]), { value: 'forever', source: 'default' });
  assert.deepEqual(resolvePolicyValue(minimum, [level('30'), level('90')]), { value: '90', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(minimum, [level('90'), level('30')]), { value: '90', source: 'policy' });
});

// R1 (0.30): with only the installation's policies, the group level changes
// nothing: any stored values resolve to themselves, any other key to its default.
test('installation policies alone resolve as before groups, for random combinations', async () => {
  let seed = 30;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const scalar = keys.filter(key => POLICIES[key].kind.type !== 'list');
  for (let round = 0; round < 200; round++) {
    const chosen = new Map<string, unknown>();
    for (const key of scalar) {
      const kind = POLICIES[key].kind as { type: string; values?: readonly unknown[]; nullable?: boolean };
      const values: readonly unknown[] = kind.type === 'enum' ? kind.values! : [...(kind.nullable ? [null] : []), ...(kind.values ?? [])];
      if (random() < 0.4) chosen.set(key, values[Math.floor(random() * values.length)]);
    }
    const { executor } = stored([...chosen].map(([key, value]) => ({ key: `policy.${key}`, value: value === null ? '' : String(value) })));
    for (const key of scalar) {
      const { value, source } = await resolvePolicy('user-a', key, executor);
      // A key implied by a refusing one (data.clear by bin.delete) takes that one's source, as before.
      const implied = POLICIES[key].impliedBy && chosen.get(POLICIES[key].impliedBy!) === 'forbidden';
      assert.deepEqual({ value, source }, chosen.has(key) ? { value: chosen.get(key), source: 'policy' } : { value: POLICIES[key].default, source: implied ? 'policy' : 'default' }, `${round} ${key}`);
    }
  }
});
