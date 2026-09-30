'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requireAccountId } = require('../src/services/mail-engine/rollout');
const { main } = require('../mail-rollout');
test('rollout account identifiers are validated exactly, never repaired', () => {
  assert.doesNotThrow(() => requireAccountId('10000000-0000-4000-8000-000000000001'));
  for (const value of [null, '', 'all', '10000000-0000-4000-8000-000000000001 ', '10000000-0000-4000-8000-000000000001,other']) {
    assert.throws(() => requireAccountId(value), /exact mail-account UUID/);
  }
});
test('rollout CLI refuses invalid arguments before connecting to a database', async () => {
  for (const args of [[], ['unknown'], ['release'], ['status','extra'], ['release','all']]) {
    await assert.rejects(main(args), /Usage:|exact mail-account UUID/);
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
