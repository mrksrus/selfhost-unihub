import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));
const { assertInventoryCoverage, verifyDatabaseInventory } = require('../dist/src/services/data-inventory');

// Independent input: actual production DDL declarations, never a snapshot made
// from the policy catalog. MySQL startup tests below cover executed/dynamic DDL.
function sourceColumns(source: FixtureValue) {
  const rows = new Map();
  const add = (table: string, column: string) => rows.set(`${table}.${column}`, { table_name: table, column_name: column });
  source = source.replace(/\\`/g, '`');
  for (const match of source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`? \(([\s\S]*?)\) ENGINE=/g)) {
    for (const column of match[2].matchAll(/(?:^|\n|,)\s*`?([a-z][a-z_0-9]*)`?\s+(?:CHAR|VARCHAR|TEXT|LONGTEXT|MEDIUMTEXT|INT|TINYINT|BIGINT|SMALLINT|BOOLEAN|BOOL|DATETIME|TIMESTAMP|DATE|JSON|ENUM|DECIMAL|DOUBLE|FLOAT)\b/gi)) add(match[1], column[1]);
  }
  for (const match of source.matchAll(/ALTER TABLE (\w+) ADD COLUMN (?:IF NOT EXISTS )?(\w+)/g)) add(match[1], match[2]);
  // Grouped additive migration declarations are independently read from real
  // schema source too, never synthesized from the recovery policy under test.
  for (const match of source.matchAll(/await addColumns\(db, '(\w+)', \[([\s\S]*?)\n {2}\]\);/g)) {
    for (const column of match[2].matchAll(/\['([a-z_]+)',/g)) add(match[1], column[1]);
  }
  return [...rows.values()];
}
const serviceSource = (name: FixtureValue) => fs.readFileSync(path.join(__dirname, '../src/services', `${name}.ts`), 'utf8');
function productionColumns() {
  return sourceColumns(['database-baseline', 'database', 'database-migrations', 'notifications'].map(serviceSource).join('\n'));
}

test('every runtime schema table and field has an explicit recovery policy', () => {
  const columns = productionColumns();
  assert.ok(columns.length > 400, 'The DDL reader must inspect the full production schema');
  assertInventoryCoverage(columns);
});

// The baseline stands for steps 1 to 11: with the runner's own history table
// it must create exactly what the inventory requires through step 11, and
// nothing a later step adds.
test('the 0.16.0 baseline creates the fields declared through migration 11', () => {
  const baseline = sourceColumns(['database-baseline', 'database-migrations'].map(serviceSource).join('\n'));
  assert.ok(baseline.length > 400, 'The DDL reader must inspect the whole baseline');
  assert.doesNotThrow(() => assertInventoryCoverage(baseline, { includeNotifications: false, throughMigration: 11 }));
  assert.throws(() => assertInventoryCoverage(baseline, { includeNotifications: false, throughMigration: 12 }), /Missing declared field calendar_accounts.mail_account_id/);
  assert.ok(!baseline.some(row => row.table_name === 'notes'), 'Notes tables were removed in step 11');
  assert.throws(() => assertInventoryCoverage([...baseline, { table_name: 'notes', column_name: 'title' }], { includeNotifications: false, throughMigration: 11 }),
    /Removed field still present notes.title/);
});

test('new tables and columns fail coverage until classified', () => {
  const columns = productionColumns();
  assert.throws(() => assertInventoryCoverage([...columns, ...sourceColumns('CREATE TABLE IF NOT EXISTS journal (id CHAR(36), content TEXT) ENGINE=InnoDB')]), /Unclassified field journal.content/);
  assert.throws(() => assertInventoryCoverage([...columns, ...sourceColumns('ALTER TABLE emails ADD COLUMN local_annotation TEXT')]), /Unclassified field emails.local_annotation/);
  assert.throws(() => assertInventoryCoverage(columns.filter(row => row.table_name !== 'tetris_scores')), /Missing declared field tetris_scores.score/);
});

test('generated fresh-install schema is fully classified', () => {
  const schema: FixtureValue = fs.readFileSync(path.join(__dirname, '../../docker/mariadb/schema.sql'), 'utf8');
  const columns = sourceColumns(schema);
  assert.equal(columns.length, schema.match(/^ {2}`[a-z]/gm).length, 'The DDL reader must parse every generated column');
  assertInventoryCoverage(columns);
});

test('database verifier reads information_schema rather than assuming the catalog is the schema', async () => {
  let sql: FixtureValue;
  await assert.rejects(verifyDatabaseInventory({ async execute(query: string) { sql = query; return [[{ table_name: 'emails', column_name: 'surprise' }]]; } }), /Unclassified field emails.surprise/);
  assert.match((sql as string), /FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\)/);
});
