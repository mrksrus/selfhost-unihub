'use strict';
import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { requireAccountId } = require('../dist/src/services/mail-engine/rollout') as typeof import('../src/services/mail-engine/rollout');
const { main } = require('../dist/mail-rollout') as typeof import('../mail-rollout');
test('rollout account identifiers are validated exactly, never repaired', () => {
  assert.doesNotThrow(() => requireAccountId('10000000-0000-4000-8000-000000000001'));
  for (const value of [null, '', 'all', '10000000-0000-4000-8000-000000000001 ', '10000000-0000-4000-8000-000000000001,other']) {
    assert.throws(() => requireAccountId(value), /exact mail-account UUID/);
  }
});
test('rollout CLI refuses invalid arguments before connecting to a database', async () => {
  for (const args of [[], ['unknown'], ['release'], ['status','extra'], ['release','all']] as const) {
    await assert.rejects(main(args as FixtureValue), /Usage:|exact mail-account UUID/);
  }
});
test('rollout prepare requires an explicit stopped-writer maintenance acknowledgement', async () => {
  const old = process.env.UNIHUB_MAIL_ROLLOUT_MAINTENANCE;
  delete process.env.UNIHUB_MAIL_ROLLOUT_MAINTENANCE;
  try {
    await assert.rejects(main(['prepare','10000000-0000-4000-8000-000000000001']), /stopped API\/provider writers/);
  } finally {
    if (old === undefined) delete process.env.UNIHUB_MAIL_ROLLOUT_MAINTENANCE;
    else process.env.UNIHUB_MAIL_ROLLOUT_MAINTENANCE = old;
  }
});
function fakePool(handler: FixtureValue) {
  const calls: FixtureValue[] = [];
  const cx = { calls, async execute(sql: string, params: FixtureValue[] = []) {
    calls.push({ sql, params });
    assert.equal((sql.match(/\?/g) || []).length, params.length, `Parameter count: ${sql}`);
    return handler(sql, params);
  }, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
  return { calls, cx, getConnection: async () => cx };
}
test('no account pause or reconnect overwrites/clears an operator canary hold', async () => {
  const runtime = require('../dist/src/services/mail-engine/runtime') as typeof import('../src/services/mail-engine/runtime');
  const { HOLD_REASON } = require('../dist/src/services/mail-engine/rollout') as typeof import('../src/services/mail-engine/rollout');
  const pool = fakePool((sql: string) => {
    if (sql.includes('FROM mail_accounts WHERE id = ? AND user_id = ? FOR UPDATE')) return [[{ id: 'A' }]];
    if (sql.includes('SELECT is_active')) return [[{ is_active: 1, disconnected_at: null }]];
    return [{ affectedRows: 0 }];
  });
  await runtime.pauseAccount({ userId: 'owner', accountId: 'A', reason: 'Account settings changing' }, pool.cx as FixtureValue);
  const pause = pool.calls.find(call => call.sql.includes('INSERT INTO mail_engine_accounts'));
  assert.match(pause.sql, /paused_reason = IF\(paused_reason <=> \?, paused_reason, VALUES\(paused_reason\)\)/);
  assert.deepEqual(pause.params, ['A', 'owner', 'Account settings changing', HOLD_REASON]);
  assert.match(pause.sql, /generation = generation \+ 1/, 'the stop still fences active workers');
  pool.calls.length = 0;
  await runtime.resumeAccount({ userId: 'owner', accountId: 'A' }, pool.cx as FixtureValue);
  const resume = pool.calls.find(call => call.sql.startsWith('UPDATE mail_engine_accounts'));
  assert.match(resume.sql, /paused_reason = IF\(paused_reason <=> \?, paused_reason, NULL\)/);
  assert.deepEqual(resume.params, [HOLD_REASON, 'A', 'owner']);
});
test('prepare replaces only user-liftable module pauses; release re-queues held read streams, never writes', async () => {
  const { HOLD_REASON, USER_PAUSES, prepareRollout, releaseRollout } = require('../dist/src/services/mail-engine/rollout') as typeof import('../src/services/mail-engine/rollout');
  const canary = '10000000-0000-4000-8000-000000000001', other = '10000000-0000-4000-8000-000000000002';
  let reason: FixtureValue = null;
  const pool = fakePool((sql: string) => {
    if (sql.startsWith('SELECT id,user_id,sync_mode FROM mail_accounts')) return [[{ id: canary, user_id: 'owner', sync_mode: 'sync' },
      { id: other, user_id: 'owner', sync_mode: 'sync' }]];
    if (sql.startsWith('SELECT id,user_id FROM mail_accounts')) return [[{ id: other, user_id: 'owner' }]];
    if (sql.includes('FROM mail_accounts WHERE id = ? AND user_id = ? FOR UPDATE')) return [[{ id: other }]];
    if (sql.includes('SELECT is_active')) return [[{ is_active: 1, disconnected_at: null }]];
    if (sql.startsWith('SELECT paused_reason')) return [[{ paused_reason: reason }]];
    if (sql.startsWith('UPDATE mail_engine_accounts SET paused_reason = NULL')) { reason = null; return [{ affectedRows: 1 }]; }
    if (sql.startsWith('UPDATE')) return [{ affectedRows: 0 }];
    return [[]];
  });
  await prepareRollout(pool as FixtureValue, canary);
  const installs = pool.calls.filter(call => call.sql.startsWith('INSERT INTO mail_engine_accounts'));
  assert.equal(installs.length, 2);
  for (const call of installs) {
    assert.match(call.sql, /IF\(paused_reason IS NULL OR paused_reason IN \(\?,\?\)/);
    assert.deepEqual(call.params.slice(2), [HOLD_REASON, ...USER_PAUSES]);
  }
  pool.calls.length = 0; reason = HOLD_REASON;
  await releaseRollout(pool as FixtureValue, other);
  const requeue = pool.calls.find(call => call.sql.startsWith('UPDATE mail_engine_jobs'));
  assert.match(requeue.sql, /state = 'queued'/);
  assert.match(requeue.sql, /state = 'paused' AND operation_id IS NULL/);
  assert.ok(pool.calls.every(call => !/mail_writebacks/.test(call.sql)));
});
