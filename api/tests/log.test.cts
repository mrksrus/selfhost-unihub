const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { log, withRequestId, captureLog } = require('../dist/src/log') as typeof import('../src/log');

test('log lines carry area, fields and the id of the request they belong to', async t => {
  const lines: [string, string][] = [];
  t.after(captureLog((level, line) => lines.push([level, line])));
  log.info('CLEANUP', 'Deleted expired sessions', { deleted: 3 });
  await withRequestId('0123456789abcdef', async () => {
    await new Promise(resolve => setTimeout(resolve, 1));
    log.error('HTTP', 'Request failed', Object.assign(new Error('Data too long'), { code: 'ER_DATA_TOO_LONG' }), { route: 'PUT /api/x/:id' });
  });
  assert.deepEqual(lines[0], ['info', '[CLEANUP] Deleted expired sessions deleted=3']);
  assert.equal(lines[1][0], 'error');
  const [first, ...stack] = lines[1][1].split('\n');
  assert.equal(first, '[HTTP] Request failed route="PUT /api/x/:id" error="Data too long" code=ER_DATA_TOO_LONG requestId=0123456789abcdef');
  assert.match(stack[0], /^Error: Data too long/);
});

test('LOG_FORMAT=json writes one object per line', t => {
  const lines: string[] = [];
  t.after(captureLog((_level, line) => lines.push(line), 'json'));
  withRequestId('fedcba9876543210', () => log.warn('DB POOL', 'Busy', { active: 10, queued: 2 }));
  const entry = JSON.parse(lines[0]);
  assert.equal(typeof entry.time, 'string');
  assert.deepEqual({ ...entry, time: undefined }, { time: undefined, level: 'warn', area: 'DB POOL', msg: 'Busy', active: 10, queued: 2, requestId: 'fedcba9876543210' });
});
