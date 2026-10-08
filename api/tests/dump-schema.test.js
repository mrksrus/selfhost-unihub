const test = require('node:test');
const assert = require('node:assert/strict');
const { dumpSchema, describeDifference } = require('../scripts/dump-schema.cts');

test('schema dump is sorted and strips AUTO_INCREMENT counters', async () => {
  const created = {
    zeta: 'CREATE TABLE `zeta` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4',
    alpha: 'CREATE TABLE `alpha` (\n  `id` char(36) NOT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  };
  const fake = {
    async query(sql) {
      if (sql.startsWith('SELECT TABLE_NAME')) return [[{ name: 'zeta' }, { name: 'alpha' }]];
      const name = sql.match(/`(\w+)`/)[1];
      return [[{ 'Create Table': created[name] }]];
    },
  };
  const dump = await dumpSchema(fake);
  assert.ok(dump.indexOf('CREATE TABLE `alpha`') < dump.indexOf('CREATE TABLE `zeta`'));
  assert.match(dump, /`id` int NOT NULL AUTO_INCREMENT,/);
  assert.doesNotMatch(dump, /AUTO_INCREMENT=/);
  assert.match(dump, /\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n$/);
  assert.equal(await dumpSchema(fake), dump);
});

test('schema difference names the changed lines and their table', () => {
  const before = 'CREATE TABLE `a` (\n  `x` int,\n  `y` int\n);';
  const after = 'CREATE TABLE `a` (\n  `y` int,\n  `x` int\n);';
  const diff = describeDifference(before, after);
  assert.match(diff, /^[-+] {3}`[xy]` int,? {4}\[CREATE TABLE `a`\]$/m);
  assert.equal(describeDifference(before, before), '');
});
