// The mail service facade (src/services/mail.js) re-exports these modules.
// A test that reloads the facade with stubbed dependencies must evict them
// all, or the cached modules keep the previous stubs. Returns a restore
// function for t.after.
const MAIL_SERVICE_MODULES = ['mail', 'mail-host-policy', 'mail-folders', 'mail-durable-jobs',
  'mail-server-delete', 'mail-sync-control', 'mail-send']
  .map(name => require.resolve(`../../src/services/${name}`));

function evictMailServiceModules() {
  const saved = new Map(MAIL_SERVICE_MODULES.map(p => [p, require.cache[p]]));
  for (const p of MAIL_SERVICE_MODULES) delete require.cache[p];
  return () => {
    for (const [p, entry] of saved) { if (entry) require.cache[p] = entry; else delete require.cache[p]; }
  };
}

module.exports = { evictMailServiceModules };
