const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { dateRank, itemKey, RANK_SCALE } = require('../dist/src/services/task-order') as typeof import('../src/services/task-order');

test('date ranks follow the date, stay safe integers for every DATETIME and rarely tie within a second', () => {
  const task = (id: string, start: string, created = start, todoOnly = 0) => ({ id, start_time: start, created_at: created, is_todo_only: todoOnly });
  for (const start of ['1000-01-01 00:00:00', '1970-01-01 00:00:00', '9999-12-31 23:59:59']) {
    assert.ok(Number.isSafeInteger(dateRank(task('7f0c2c4e-0000-4000-8000-000000000001', start))), start);
  }
  // A later second always ranks later, whatever the ids.
  const ids = Array.from({ length: 50 }, (_, index) => `7f0c2c4e-0000-4000-8000-${String(index).padStart(12, '0')}`);
  for (const id of ids) {
    assert.ok(dateRank(task(id, '2026-11-20 09:00:00')) < dateRank(task(ids[0], '2026-11-20 09:00:01')));
    assert.ok(dateRank(task(id, '2026-11-20 09:00:00')) >= Date.UTC(2026, 10, 20, 9) / 1000 * RANK_SCALE);
  }
  assert.ok(new Set(ids.map(id => dateRank(task(id, '2026-11-20 09:00:00')))).size > 45, 'tasks of one second spread by id');
  // A task without a date ranks by its creation, not its placeholder start.
  assert.equal(dateRank(task(ids[0], '2030-01-01 00:00:00', '2026-10-01 08:00:00', 1)), dateRank(task(ids[0], '2026-10-01 08:00:00')));
});

test('an order row is keyed by the identity it names, so a restore rebuilds the same key', () => {
  const synced = { calendar_id: 'c1', remote_uid: 'review@example.test', recurrence_id: '' };
  assert.equal(itemKey({ ...synced, event_id: null }), itemKey({ ...synced, recurrence_id: null }));
  assert.notEqual(itemKey(synced), itemKey({ ...synced, recurrence_id: '20261120T090000Z' }), 'each occurrence has its own place');
  assert.notEqual(itemKey(synced), itemKey({ ...synced, calendar_id: 'c2' }), 'per calendar');
  assert.notEqual(itemKey({ event_id: 'e1' }), itemKey({ event_id: 'e2' }));
  assert.match(itemKey({ event_id: 'e1' }), /^[0-9a-f]{64}$/);
});

test('a synced task ranks by its provider identity, so a rebuilt row keeps its place', () => {
  const row = (id: string) => ({ id, start_time: '2026-11-20 09:00:00', created_at: '2026-10-01 08:00:00', is_todo_only: 0 });
  const identity = { uid: 'review@example.test', recurrenceId: '' };
  assert.equal(dateRank(row('7f0c2c4e-0000-4000-8000-000000000001'), identity), dateRank(row('7f0c2c4e-0000-4000-8000-000000000002'), identity));
  assert.notEqual(dateRank(row('7f0c2c4e-0000-4000-8000-000000000001'), identity), dateRank(row('7f0c2c4e-0000-4000-8000-000000000001'), { ...identity, recurrenceId: '20261120T090000Z' }));
});

test('copy keys share their base: the same rank as the original, after it, in counter order', () => {
  const { copyKey, keyBase, copyNumber, sortKey } = require('../dist/src/services/task-order') as typeof import('../src/services/task-order');
  const base = '7f0c2c4e-0000-4000-8000-000000000001';
  const row = (key: string) => ({ id: '7f0c2c4e-0000-4000-8000-0000000000ff', order_key: key, start_time: '2026-10-04 08:00:00', created_at: '2026-10-04 08:00:00', is_todo_only: 1 });
  const keys = [base, copyKey(base, 1), copyKey(base, 2), copyKey(base, 10)];
  assert.deepEqual([...keys].sort(), keys, 'plain string order is the copy order');
  assert.equal(new Set(keys.map(key => dateRank(row(key)))).size, 1);
  assert.deepEqual(keys.map(key => [keyBase(key), copyNumber(key, base)]), [[base, 0], [base, 1], [base, 2], [base, 10]]);
  // The same UID in two calendars: one rank, two keys.
  const synced = (source: string) => sortKey(row(base), { uid: 'shared@example.test', recurrenceId: '', source });
  assert.notEqual(synced('https://dav.example.test\n/a/'), synced('https://dav.example.test\n/b/'));
  assert.equal(dateRank(row(base), { uid: 'shared@example.test', recurrenceId: '', source: 'x' }), dateRank(row(base), { uid: 'shared@example.test', recurrenceId: '', source: 'y' }));
});
