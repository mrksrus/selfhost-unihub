const test = require('node:test');
const assert = require('node:assert/strict');

test('additive refresh migration upgrades preexisting engine jobs without losing accepted work', async () => {
  const { migrateManualMailRefresh } = require('../src/services/mail-engine/schema');
  const fields = new Set(['id', 'kind', 'state']), existingJobs = [{ id: 'accepted', state: 'paused' }];
  const sql = [];
  const db = { async execute(statement) {
    sql.push(statement);
    if (statement === 'SHOW COLUMNS FROM `mail_engine_jobs`')
      return [[...fields].map(Field => ({ Field }))];
    if (statement.includes('ADD COLUMN manual_refresh')) {
      fields.add('manual_refresh');
      existingJobs.forEach(row => { row.manual_refresh = 0; });
      return [{ affectedRows: 0 }];
    }
    assert.fail(statement);
  } };
  await migrateManualMailRefresh(db);
  await migrateManualMailRefresh(db);
  assert.equal(sql.filter(statement => statement.includes('ALTER TABLE')).length, 1);
  assert.deepEqual(existingJobs, [{ id: 'accepted', state: 'paused', manual_refresh: 0 }]);
});

// Exercise the real durable enqueue path, not an in-memory scheduler shim.
test('manual requests promote queued work and retain one successor behind a running scan', async t => {
  const repoPath = require.resolve('../src/services/mail-engine/repository');
  const runtimePath = require.resolve('../src/services/mail-engine/runtime');
  const oldRepo = require.cache[repoPath], oldRuntime = require.cache[runtimePath];
  require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: {
    ownAccount: async () => ({ id: 'account' }), withTransaction: fn => fn(),
  } };
  delete require.cache[runtimePath];
  t.after(() => {
    if (oldRepo) require.cache[repoPath] = oldRepo; else delete require.cache[repoPath];
    if (oldRuntime) require.cache[runtimePath] = oldRuntime; else delete require.cache[runtimePath];
  });
  const runtime = require(runtimePath);
  const jobs = [], writes = [];
  const cx = { async execute(sql, params = []) {
    writes.push({ sql, params });
    if (sql.startsWith('SELECT id FROM mail_remote_mailboxes')) return [[{ id: 'box' }]];
    if (sql.includes('FROM mail_engine_jobs WHERE user_id')) {
      const [user, account, kind, box, operation] = params;
      return [[...jobs].filter(j => j.user_id === user && j.mail_account_id === account &&
        j.kind === kind && j.mailbox_id === box && j.operation_id === operation &&
        ['queued', 'running', 'paused'].includes(j.state))
        .sort((a, b) => ({ queued: 0, paused: 1, running: 2 })[a.state] -
          ({ queued: 0, paused: 1, running: 2 })[b.state]).slice(0, 1)];
    }
    if (sql.startsWith('UPDATE mail_engine_jobs SET manual_refresh')) {
      const row = jobs.find(j => j.id === params[0]);
      assert(['queued', 'paused'].includes(row.state));
      row.manual_refresh = 1;
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT INTO mail_engine_jobs')) {
      jobs.push({ id: params[0], user_id: params[1], mail_account_id: params[2], mailbox_id: params[3],
        operation_id: params[4], kind: params[5], priority: params[6], manual_refresh: Number(params[8]), state: 'queued' });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT * FROM mail_engine_jobs WHERE id')) return [[jobs.find(j => j.id === params[0])]];
    assert.fail(`Unexpected query: ${sql}`);
  } };
  const input = { userId: 'owner', accountId: 'account', kind: 'sync', priority: 5 };
  const queued = await runtime.enqueueJob(input, cx);
  const promoted = await runtime.enqueueJob({ ...input, manualRefresh: true }, cx);
  assert.equal(queued.id, promoted.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].manual_refresh, 1);
  jobs[0].state = 'running';
  const successor = await runtime.enqueueJob({ ...input, manualRefresh: true }, cx);
  assert.notEqual(successor.id, queued.id, 'in-flight scan cannot consume a newer request');
  assert.equal(successor.manual_refresh, 1);
  assert.equal((await runtime.enqueueJob({ ...input, manualRefresh: true }, cx)).id, successor.id);
  assert.equal(jobs.length, 2, 'repeat clicks are bounded to one queued successor');
  jobs[1].state = 'paused';
  assert.equal((await runtime.enqueueJob(input, cx)).id, successor.id, 'background cannot drop paused manual intent');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].manual_refresh, 1, 'running job is never altered');

  const stream = { ...input, mailboxId: 'box', kind: 'flags' };
  const active = await runtime.enqueueJob(stream, cx);
  active.state = 'running';
  const later = await runtime.enqueueJob({ ...stream, manualRefresh: true }, cx);
  await runtime.enqueueJob({ ...stream, manualRefresh: true }, cx);
  assert.equal(later.manual_refresh, 1);
  assert.equal(jobs.filter(j => j.kind === 'flags').length, 2);
  assert(!writes.some(w => w.sql.includes('DELETE FROM mail_engine_jobs')));
  await assert.rejects(runtime.enqueueJob({ ...input, kind: 'body', manualRefresh: true }, cx), /Manual refresh/);
});
