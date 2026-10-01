const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertInventoryCoverage, verifyDatabaseInventory } = require('../src/services/data-inventory');

// Independent input: actual production DDL declarations, never a snapshot made
// from the policy catalog. MySQL startup tests below cover executed/dynamic DDL.
function sourceColumns(source) {
  const rows = new Map();
  const add = (table, column) => rows.set(`${table}.${column}`, { table_name: table, column_name: column });
  source = source.replace(/\\`/g, '`');
  for (const match of source.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?`?(\w+)`? \(([\s\S]*?)\) ENGINE=/g)) {
    for (const column of match[2].matchAll(/(?:^|\n|,)\s*`?([a-z][a-z_0-9]*)`?\s+(?:CHAR|VARCHAR|TEXT|LONGTEXT|MEDIUMTEXT|INT|TINYINT|BIGINT|SMALLINT|BOOLEAN|BOOL|DATETIME|TIMESTAMP|DATE|JSON|ENUM|DECIMAL|DOUBLE|FLOAT)\b/gi)) add(match[1], column[1]);
  }
  for (const match of source.matchAll(/ALTER TABLE (\w+) ADD COLUMN (?:IF NOT EXISTS )?(\w+)/g)) add(match[1], match[2]);
  // Grouped additive migration declarations are independently read from real
  // schema source too, never synthesized from the recovery policy under test.
  for (const match of source.matchAll(/await addColumns\(db, '(\w+)', \[([\s\S]*?)\n  \]\);/g)) {
    for (const column of match[2].matchAll(/\['([a-z_]+)',/g)) add(match[1], column[1]);
  }
  return [...rows.values()];
}
function productionColumns() {
  return sourceColumns(['database.js', 'database-migrations.js', 'notifications.js', 'mail-engine/schema.js'].map(file => fs.readFileSync(path.join(__dirname, '../src/services', file), 'utf8')).join('\n'));
}

test('every runtime schema table and field has an explicit recovery policy', () => {
  const columns = productionColumns();
  assert.ok(columns.length > 400, 'The DDL reader must inspect the full production schema');
  assertInventoryCoverage(columns);
});

test('new tables and columns fail coverage until classified', () => {
  const columns = productionColumns();
  assert.throws(() => assertInventoryCoverage([...columns, ...sourceColumns('CREATE TABLE IF NOT EXISTS notes (id CHAR(36), content TEXT) ENGINE=InnoDB')]), /Unclassified field notes.content/);
  assert.throws(() => assertInventoryCoverage([...columns, ...sourceColumns('ALTER TABLE emails ADD COLUMN local_annotation TEXT')]), /Unclassified field emails.local_annotation/);
  assert.throws(() => assertInventoryCoverage(columns.filter(row => row.table_name !== 'tetris_scores')), /Missing declared field tetris_scores.score/);
});

test('manual refresh column is required only after its additive migration', () => {
  const before = productionColumns().filter(row => !(row.table_name === 'mail_engine_jobs' && row.column_name === 'manual_refresh'));
  assert.doesNotThrow(() => assertInventoryCoverage(before, { throughMigration: 7 }));
  assert.throws(() => assertInventoryCoverage(before, { throughMigration: 8 }), /Missing declared field mail_engine_jobs.manual_refresh/);
});

test('generated fresh-install schema is fully classified', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../../docker/mysql/init/01-schema.sql'), 'utf8');
  const columns = sourceColumns(schema);
  assert.equal(columns.length, schema.match(/^ {2}`[a-z]/gm).length, 'The DDL reader must parse every generated column');
  assertInventoryCoverage(columns);
});

test('database verifier reads information_schema rather than assuming the catalog is the schema', async () => {
  let sql;
  await assert.rejects(verifyDatabaseInventory({ async execute(query) { sql = query; return [[{ table_name: 'emails', column_name: 'surprise' }]]; } }), /Unclassified field emails.surprise/);
  assert.match(sql, /FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE\(\)/);
});

test('mail sync policy fields are required only after migration 10', () => {
  const added = new Set(['mail_accounts.sync_window_days', 'mail_accounts.trash_window_days', 'mail_accounts.sync_policy_confirmed_at',
    'mail_remote_occurrences.internal_date', 'data_export_jobs.mail_account_id']);
  const all = productionColumns();
  assert.equal(all.filter(row => added.has(row.table_name + '.' + row.column_name)).length, added.size);
  const before = all.filter(row => !added.has(row.table_name + '.' + row.column_name));
  assert.doesNotThrow(() => assertInventoryCoverage(before, { throughMigration: 9 }));
  assert.throws(() => assertInventoryCoverage(before, { throughMigration: 10 }), /Missing declared field mail_accounts.sync_window_days/);
});
