import type { FixtureValue } from './test-types.cts';
// The request boundary dispatches route specs (src/http/route.ts). A harness
// that stubs the route table with plain handlers wraps them with the derived
// legacy policy, exactly as routes/index.ts does for unconverted route files.
// A key whose handler the test left undefined is dropped, so it stays a 404.
function legacyTable(handlers: Record<string, FixtureValue>) {
  const { legacyRoutes } = require('../../dist/src/routes/legacy-spec') as typeof import('../../src/routes/legacy-spec');
  return legacyRoutes(Object.fromEntries(Object.entries(handlers).filter(([, handler]) => typeof handler === 'function')));
}

module.exports = { legacyTable };
