const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));

// Two branches that each append the next migration id collide only at
// container start (runMigrations refuses non-increasing ids, the inventory
// check refuses an introducedIn beyond the applied schema). These checks need
// no database, so the fast suite reports the collision first.
const { MIGRATIONS, LATEST_MIGRATION_ID } = require('../dist/src/services/database') as typeof import('../src/services/database');
const { BASELINE } = require('../dist/src/services/database-baseline') as typeof import('../src/services/database-baseline');
const { declaredFields } = require('../dist/src/services/data-inventory') as typeof import('../src/services/data-inventory');

test('migration ids continue the baseline history without gaps and names are unique kebab-case', () => {
  const first = BASELINE.history[BASELINE.history.length - 1].id + 1;
  assert.equal(first, 12, 'the frozen 0.16.0 baseline covers steps 1 to 11');
  assert.deepEqual(MIGRATIONS.map(step => step.id), MIGRATIONS.map((_, index) => first + index));
  assert.equal(LATEST_MIGRATION_ID, MIGRATIONS[MIGRATIONS.length - 1].id);
  const names = [...BASELINE.history, ...MIGRATIONS].map(step => step.name);
  assert.equal(new Set(names).size, names.length, `duplicate migration name in ${names.join(', ')}`);
  for (const step of MIGRATIONS) {
    assert.match(step.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `migration ${step.id} name "${step.name}" is not kebab-case`);
    assert.equal(typeof step.up, 'function');
    assert.equal(typeof step.verify, 'function');
  }
});

test('every inventory field is introduced and removed within the known migrations', () => {
  for (const [field, policy] of declaredFields()) {
    assert.ok(policy.introducedIn <= LATEST_MIGRATION_ID, `${field} introducedIn ${policy.introducedIn} is beyond migration ${LATEST_MIGRATION_ID}`);
    assert.ok(policy.removedIn === Infinity || policy.removedIn <= LATEST_MIGRATION_ID, `${field} removedIn ${policy.removedIn} is beyond migration ${LATEST_MIGRATION_ID}`);
  }
});

test('the committed schema file was generated through the latest migration', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../../docker/mariadb/schema.sql'), 'utf8');
  const through = schema.match(/^-- Through migration (\d+)\.$/m);
  assert.ok(through, 'docker/mariadb/schema.sql has no "Through migration" header line');
  assert.equal(Number(through![1]), LATEST_MIGRATION_ID, 'docker/mariadb/schema.sql is stale; run scripts/local-db.sh schema-dump');
});
