const test = require('node:test');
const assert = require('node:assert/strict');
const { runMigrations } = require('../src/services/database-migrations');

function database(history = []) {
  const state = { history, locked: false, releases: 0, writes: 0 };
  const connection = {
    async execute(sql, params) {
      if (sql.includes('GET_LOCK')) { state.locked = true; return [[{ acquired: 1 }]]; }
      if (sql.includes('RELEASE_LOCK')) { state.locked = false; return [[{}]]; }
      if (sql.startsWith('SELECT id, name')) return [state.history.map(row => ({ ...row }))];
      if (sql.startsWith('INSERT INTO schema_migrations')) { state.writes++; state.history.push({ id: params[0], name: params[1] }); }
      return [[]];
    },
    release() { state.releases++; },
  };
  return { state, getConnection: async () => connection };
}

test('ordered upgrades skip completed data rewrites on successive restarts', async () => {
  const db = database();
  const calls = [];
  const step = id => ({ id, name: `step-${id}`, up: async () => calls.push(`up-${id}`), verify: async () => calls.push(`verify-${id}`) });
  await runMigrations(db, [step(1)]);
  await runMigrations(db, [step(1), step(2)]);
  await runMigrations(db, [step(1), step(2)]);
  assert.deepEqual(calls, ['up-1', 'verify-1', 'up-2', 'verify-2']);
  assert.equal(db.state.writes, 2);
  assert.equal(db.state.locked, false);
  assert.equal(db.state.releases, 3);
});

test('partial DDL survives a failure and resumes before recording completion', async () => {
  const db = database();
  let columnExists = false;
  let ddlCount = 0;
  let permitBackfill = false;
  let laterRan = false;
  const migrations = [{ id: 1, name: 'add-column-and-backfill',
    up: async () => {
      if (!columnExists) { columnExists = true; ddlCount++; }
      if (!permitBackfill) throw new Error('backfill failed');
    }, verify: async () => assert.ok(columnExists && permitBackfill),
  }, { id: 2, name: 'later', up: async () => { laterRan = true; }, verify: async () => {} }];
  await assert.rejects(runMigrations(db, migrations), /upgrade 1.*backfill failed/);
  assert.equal(db.state.history.length, 0);
  assert.equal(laterRan, false);
  assert.equal(db.state.locked, false);
  permitBackfill = true;
  await runMigrations(db, migrations);
  assert.equal(ddlCount, 1);
  assert.equal(db.state.history.length, 2);
});

test('baseline verification failure never records a successful baseline', async () => {
  const db = database();
  await assert.rejects(runMigrations(db, [{ id: 1, name: 'baseline', up: async () => {}, verify: async () => { throw new Error('Missing declared field emails.import_complete'); } }]), /baseline.*Missing declared field/);
  assert.deepEqual(db.state.history, []);
  assert.equal(db.state.locked, false);
});

test('invalid order and unknown database history stop before any migration', async () => {
  const step = id => ({ id, name: `step-${id}`, up: async () => { throw new Error('must not run'); }, verify: async () => {} });
  await assert.rejects(runMigrations(database(), [step(2), step(1)]), /increasing IDs/);
  await assert.rejects(runMigrations(database([{ id: 2, name: 'step-2' }]), [step(1), step(2)]), /unknown or out of order/);
  await assert.rejects(runMigrations(database([{ id: 1, name: 'different-history' }]), [step(1)]), /unknown or out of order/);
});
