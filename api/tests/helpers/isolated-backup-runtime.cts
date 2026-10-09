import type { FixtureValue } from './test-types.cts';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));
const Module: FixtureValue = (require('node:module') as typeof import('node:module'));

// Run two deployment configurations in one test without touching /app/uploads
// or the global require cache. Only deployment constants change; production
// SQL, workers, ZIP serialization, encryption and filesystem operations run.
function createBackupRuntime(uploadsRoot: FixtureValue, encryptionKey: FixtureValue, pool: FixtureValue) {
  assert.ok(path.isAbsolute(uploadsRoot));
  assert.ok(!/[\n\r'\\]/.test(uploadsRoot));
  const sourceRoot = path.resolve(__dirname, '../../dist/src');
  const cache = new Map();
  function load(filename: string) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const loaded: FixtureValue = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, loaded);
    const originalRequire = Module.createRequire(filename);
    loaded.require = (request: FixtureValue) => {
      const resolved = originalRequire.resolve(request);
      return resolved.startsWith(sourceRoot + path.sep)
        ? load(resolved) : originalRequire(request);
    };
    const source = fs.readFileSync(filename, 'utf8').replaceAll("'/app/uploads", "'" + uploadsRoot);
    loaded._compile(source, filename);
    if (filename === path.join(sourceRoot, 'config.js')) {
      Object.assign(loaded.exports, {
        ENCRYPTION_KEY: encryptionKey,
        BACKUP_MASTER_KEY: encryptionKey + '-backup-master',
        JWT_SECRET: encryptionKey + '-jwt',
        BOOTSTRAP_ADMIN_EMAIL: 'roundtrip-bootstrap@example.test',
        BOOTSTRAP_ADMIN_PASSWORD: 'roundtrip-bootstrap-password-2026',
        TRUSTED_MAIL_HOSTS: [],
      });
    }
    loaded.loaded = true;
    return loaded.exports;
  }
  const runtime = (relative: FixtureValue) => load(path.join(sourceRoot, relative + '.js'));
  runtime('state').setDb(pool);
  return runtime;
}

module.exports = { createBackupRuntime };
