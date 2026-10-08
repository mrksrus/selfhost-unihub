const test = require('node:test');
const assert = require('node:assert/strict');
const { runMigrations } = require('../dist/src/services/database-migrations');
const { BASELINE } = require('../dist/src/services/database-baseline');

function database(history = []) {
  const state = { history, locked: false, releases: 0, writes: 0 };
  const connection = {
    async execute(sql, params) {
      if (sql.includes('GET_LOCK')) { state.locked = true; return [[{ acquired: 1 }]]; }
      if (sql.includes('RELEASE_LOCK')) { state.locked = false; return [[{}]]; }
      if (sql.startsWith('SELECT id, name')) return [state.history.map(row => ({ ...row }))];
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        state.writes++;
        for (let index = 0; index < params.length; index += 2) state.history.push({ id: params[index], name: params[index + 1] });
      }
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

test('a new database runs the baseline once and records the history it replaces', async () => {
  const db = database();
  const calls = [];
  const baseline = { history: [{ id: 1, name: 'old-1' }, { id: 2, name: 'old-2' }],
    up: async () => calls.push('baseline'), verify: async () => calls.push('verify-baseline') };
  const step = { id: 3, name: 'step-3', up: async () => calls.push('up-3'), verify: async () => calls.push('verify-3') };
  await runMigrations(db, [step], baseline);
  await runMigrations(db, [step], baseline);
  assert.deepEqual(calls, ['baseline', 'verify-baseline', 'up-3', 'verify-3']);
  assert.deepEqual(db.state.history, [{ id: 1, name: 'old-1' }, { id: 2, name: 'old-2' }, { id: 3, name: 'step-3' }]);
});

test('a database with the replaced history skips the baseline and continues', async () => {
  const db = database([{ id: 1, name: 'old-1' }, { id: 2, name: 'old-2' }]);
  const calls = [];
  const baseline = { history: [{ id: 1, name: 'old-1' }, { id: 2, name: 'old-2' }],
    up: async () => { throw new Error('must not run'); }, verify: async () => {} };
  await runMigrations(db, [{ id: 3, name: 'step-3', up: async () => calls.push('up-3'), verify: async () => {} }], baseline);
  assert.deepEqual(calls, ['up-3']);
  assert.equal(db.state.history.length, 3);
});

test('the baseline records nothing when it fails, and refuses a half-finished older setup', async () => {
  const baseline = { history: [{ id: 1, name: 'old-1' }, { id: 2, name: 'old-2' }],
    up: async () => {}, verify: async () => { throw new Error('Missing declared field users.id'); } };
  const db = database();
  await assert.rejects(runMigrations(db, [], baseline), /Database setup failed: Missing declared field/);
  assert.deepEqual(db.state.history, []);
  assert.equal(db.state.locked, false);
  await assert.rejects(runMigrations(database([{ id: 1, name: 'old-1' }]), [], { ...baseline, verify: async () => {} }), /did not finish/);
  await assert.rejects(runMigrations(database([{ id: 1, name: 'other' }]), [], baseline), /unknown or out of order/);
  await assert.rejects(runMigrations(database(), [{ id: 2, name: 'step-2', up: async () => {}, verify: async () => {} }], baseline), /increasing IDs/);
});

test('the baseline sets up only an empty database or its own unfinished setup', async () => {
  const STOP = new Error('creating tables');
  const connection = (tables, counts = {}) => ({
    async query(sql) {
      if (sql.includes('information_schema.TABLES')) return [tables.map(name => ({ name }))];
      return [[{ count: counts[/FROM (\w+)/.exec(sql)[1]] || 0 }]];
    },
    async execute(sql) { if (sql.startsWith('CREATE TABLE')) throw STOP; return [[]]; },
  });
  await assert.rejects(BASELINE.up(connection([])), STOP);
  await assert.rejects(BASELINE.up(connection(['schema_migrations', 'users', 'contacts'], { users: 1 })), STOP);
  for (const [tables, counts] of [[['users'], { users: 2 }], [['users', 'contacts'], { contacts: 1 }], [['emails'], { emails: 3 }],
    [['mail_accounts'], { mail_accounts: 1 }], [['calendar_events'], { calendar_events: 1 }], [['users', 'notification_config'], {}]]) {
    await assert.rejects(BASELINE.up(connection(tables, counts)), /no upgrade history/, JSON.stringify(tables));
  }
});
