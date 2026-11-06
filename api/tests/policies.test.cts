// The data-safety policy keys (F13): with no policy set every action stays
// allowed; an administrator's policy refuses with the shape clients read
// (403 POLICY_FORBIDS with the key and a plain reason), resolved level by
// level as the registry orders each key. The stored rows are faked here; the
// real table and request boundary are in policies-mysql-integration.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { POLICIES, resolvePolicy, resolvePolicies, resolvePolicyValue, assertAllowed, policyForbids } = require('../dist/src/services/settings') as typeof import('../src/services/settings');
const { clientError } = require('../dist/src/http/errors') as typeof import('../src/http/errors');

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
  assert.ok(queries.every(sql => /FROM setting_policies\s+WHERE target_kind = 'installation' AND target_id = '' AND setting_key LIKE 'policy\.%'/.test(sql)), queries.join(' | '));
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
  // Without an order a narrower level replaces the value, and among groups the one that refuses wins.
  const providerDelete = POLICIES['mail.provider_delete'];
  assert.deepEqual(resolvePolicyValue(providerDelete, [level('forbidden'), level('required')]), { value: 'required', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(providerDelete, [level('forbidden', true), level('required')]), { value: 'forbidden', source: 'policy' });
  assert.deepEqual(resolvePolicyValue(providerDelete, [undefined, [{ value: 'required', locked: false }, { value: 'forbidden', locked: false }]]), { value: 'forbidden', source: 'policy' });
});
