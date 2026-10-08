const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// docker/mariadb/schema.sql is generated from the startup migrations. If
// this fails after a schema change, run scripts/local-db.sh schema-dump and
// commit the regenerated file together with the migration.
test('committed 01-schema.sql equals a freshly migrated database', {
  skip: !process.env.MYSQL_TEST_HOST,
  timeout: 300000,
}, async (t) => {
  assert.match(process.env.MYSQL_TEST_DATABASE || '', /_test$/, 'Use a dedicated database ending in _test');
  delete process.env.DATABASE_URL;
  for (const name of ['HOST', 'PORT', 'DATABASE', 'USER', 'PASSWORD']) {
    if (process.env['MYSQL_TEST_' + name]) process.env['MYSQL_' + name] = process.env['MYSQL_TEST_' + name];
  }
  process.env.JWT_SECRET = 'ci-test-jwt-secret-for-schema-file';
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-test-encryption-key';
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'ci-admin@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'ci-bootstrap-password-2026';
  const mysql = require('mysql2/promise');
  const { getDb, setDb } = require('../dist/src/state');
  const { SCHEMA_FILE, dumpSchema, migrateCurrentSchema, describeDifference } = require('../scripts/dump-schema.cts');
  const connection = await mysql.createConnection({
    host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD, timezone: '+00:00',
  });
  let ownsDatabase = false;
  t.after(async () => {
    try {
      if (getDb()) { await getDb().end(); setDb(null); }
      if (ownsDatabase) {
        await connection.execute('SET FOREIGN_KEY_CHECKS = 0');
        try {
          const [tables] = await connection.query('SHOW TABLES');
          for (const row of tables) await connection.execute('DROP TABLE `' + Object.values(row)[0] + '`');
        } finally { await connection.execute('SET FOREIGN_KEY_CHECKS = 1'); }
      }
    } finally { await connection.end(); }
  });
  const [existing] = await connection.query('SHOW TABLES');
  assert.equal(existing.length, 0, 'The schema comparison requires an empty dedicated test database');
  ownsDatabase = true;

  const db = await migrateCurrentSchema();
  const actual = await dumpSchema(db);
  const expected = fs.readFileSync(SCHEMA_FILE, 'utf8');
  assert.ok(expected === actual,
    'docker/mariadb/schema.sql is stale; run scripts/local-db.sh schema-dump (- file, + database):\n' +
    describeDifference(expected, actual));
  // Startup code is idempotent: a restart leaves the same schema.
  await db.end();
  setDb(null);
  await migrateCurrentSchema();
  assert.equal(await dumpSchema(getDb()), actual);
});
