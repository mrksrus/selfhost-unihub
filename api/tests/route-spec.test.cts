const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const routes = require('../dist/src/routes') as typeof import('../src/routes');
const { PUBLIC_ROUTE_KEYS, STREAMING_ROUTE_KEYS, bodyLimitFor } = require('../dist/src/routes/legacy-spec') as typeof import('../src/routes/legacy-spec');
const { getModuleForPath } = require('../dist/src/services/module-catalog') as typeof import('../src/services/module-catalog');
const { getRestoreSectionForWrite } = require('../dist/src/services/backup-catalog') as typeof import('../src/services/backup-catalog');

// Route files converted to defineRoutes() declare their own policy; the rest
// derive it from the tables the boundary used before specs existed. This test
// pins the derivation to those lookups, applied to a concrete request path as
// the boundary applied them, and shrinks as files are converted.
const NATIVE_ROUTE_FILES = ['notifications', 'admin'];
const nativeKeys = new Set(NATIVE_ROUTE_FILES.flatMap(name => Object.keys(require(`../dist/src/routes/${name}`))));

test('every derived route spec equals the policy the boundary looked up before specs existed', () => {
  const derived = Object.entries(routes).filter(([key]) => !nativeKeys.has(key));
  assert.ok(derived.length > 0, 'at least one route file still derives its policy');
  for (const [key, spec] of derived) {
    const [method, pattern] = key.split(' ');
    const pathname = pattern.replace(/:(\w+)/g, (_, name) => `sample-${name}`);
    const mutating = ['POST', 'PUT', 'DELETE'].includes(method);
    const expected = {
      auth: PUBLIC_ROUTE_KEYS.has(key) ? 'public' : 'user',
      module: getModuleForPath(pathname),
      restoreSection: mutating ? (pathname === '/api/modules' ? 'settings' : getRestoreSectionForWrite(pathname)) : undefined,
      body: { limit: bodyLimitFor(key), kind: key === 'POST /api/backup/import' ? 'backup-upload' : 'json' },
      ...(STREAMING_ROUTE_KEYS.has(key) ? { response: 'stream' } : {}),
    };
    const { handler, ...policy } = spec;
    assert.equal(typeof handler, 'function', key);
    assert.deepEqual(policy, expected, key);
  }
});

test('the derived public set and the streaming set name routes that exist', () => {
  for (const key of [...PUBLIC_ROUTE_KEYS, ...STREAMING_ROUTE_KEYS]) assert.ok(key in routes, `${key} is listed but has no route`);
});
