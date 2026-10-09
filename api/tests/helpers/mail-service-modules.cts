import type { FixtureValue } from './test-types.cts';
// The mail service facade (src/services/mail.js) and the mail routes
// (src/routes/mail.js) re-export these modules. A test that reloads a facade
// with stubbed dependencies must evict them all, or the cached modules keep
// the previous stubs. Each evict function returns a restore function for t.after.
const MAIL_SERVICE_MODULES = ['mail', 'mail-host-policy', 'mail-folders', 'mail-durable-jobs',
  'mail-server-delete', 'mail-sync-control', 'mail-send']
  .map(name => require.resolve(`../../dist/src/services/${name}`));
const MAIL_ROUTE_MODULES = ['mail', 'mail-route-helpers', 'mail-folders', 'mail-accounts', 'mail-drafts',
  'mail-messages', 'mail-operations', 'mail-sync']
  .map(name => require.resolve(`../../dist/src/routes/${name}`));

function evict(paths: FixtureValue) {
  const saved = new Map<string, NodeJS.Module | undefined>(paths.map((p: FixtureValue) => [p, require.cache[p]]));
  for (const p of paths) delete require.cache[p];
  return () => {
    for (const [p, entry] of saved) { if (entry) require.cache[(p as FixtureValue)] = entry; else delete require.cache[(p as FixtureValue)]; }
  };
}

const evictMailServiceModules = () => evict(MAIL_SERVICE_MODULES);
const evictMailRouteModules = () => evict(MAIL_ROUTE_MODULES);

module.exports = { evictMailServiceModules, evictMailRouteModules };
