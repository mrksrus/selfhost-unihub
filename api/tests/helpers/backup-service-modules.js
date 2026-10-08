// The backup service facade (src/services/backup.js) re-exports these
// modules. A test that reloads the facade with stubbed dependencies must evict
// them all, or the cached modules keep the previous stubs. Returns a restore
// function for t.after.
const BACKUP_SERVICE_MODULES = ['backup', 'backup-common', 'backup-export', 'backup-validate',
  'backup-restore-mapping', 'backup-zip-reader', 'backup-import']
  .map(name => require.resolve(`../../dist/src/services/${name}`));

function evictBackupServiceModules() {
  const saved = new Map(BACKUP_SERVICE_MODULES.map(p => [p, require.cache[p]]));
  for (const p of BACKUP_SERVICE_MODULES) delete require.cache[p];
  return () => {
    for (const [p, entry] of saved) { if (entry) require.cache[p] = entry; else delete require.cache[p]; }
  };
}

module.exports = { evictBackupServiceModules };
