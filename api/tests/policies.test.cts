// The data-safety policy keys (F13) before an administrator sets any: every
// action stays allowed, and a refusal, when it comes, has the shape clients
// read (403 POLICY_FORBIDS with the key and a plain reason).
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { POLICIES, resolvePolicy, assertAllowed, policyForbids } = require('../dist/src/services/settings') as typeof import('../src/services/settings');
const { clientError } = require('../dist/src/http/errors') as typeof import('../src/http/errors');

const keys = Object.keys(POLICIES) as (keyof typeof POLICIES)[];
// Nothing is read for a default; a query would mean a stored policy is consulted.
const noDatabase = { execute: async () => { throw new Error('no query expected'); } } as never;

test('with no policy set, every key resolves to its default and allows its action', async () => {
  for (const key of keys) {
    const resolved = await resolvePolicy('user-a', key, noDatabase);
    assert.deepEqual(resolved, { value: POLICIES[key].default, source: 'default', allowed: true, reason: null }, key);
    await assertAllowed('user-a', key, {}, noDatabase);
  }
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
