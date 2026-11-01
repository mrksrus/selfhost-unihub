const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

const { fileRemovalGate } = require('../dist/src/services/file-removal-gate') as typeof import('../src/services/file-removal-gate');

// The instance backup's copy needs the files of rows deleted after its dump.
test('while closed, removals queue in order and run when the copy ends; a queued removal runs its own nested removals', async () => {
  const done: string[] = [];
  assert.equal(await fileRemovalGate.run(async () => { done.push('open'); return 1; }), 1);

  const reopen = fileRemovalGate.close();
  assert.equal(fileRemovalGate.isClosed(), true);
  // A removal whose caller holds a lock queues a second form that takes it afresh.
  assert.equal(await fileRemovalGate.run(async () => { done.push('now form'); }, async () => { done.push('queued form'); }), 'deferred');
  // A queued removal that calls another gated removal (a user's files, then their attachments) must not wait for itself.
  assert.equal(await fileRemovalGate.run(async () => {
    done.push('outer');
    assert.equal(await fileRemovalGate.run(async () => { done.push('nested'); return 'ran'; }), 'ran');
  }), 'deferred');
  let opened = false;
  const waiting = fileRemovalGate.whenOpen().then(() => { opened = true; });
  assert.deepEqual(done, ['open']);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(opened, false);

  const finished = await Promise.race([reopen().then(() => 'drained'), new Promise(resolve => setTimeout(() => resolve('stuck'), 2000))]);
  assert.equal(finished, 'drained');
  await waiting;
  assert.deepEqual(done, ['open', 'queued form', 'outer', 'nested']);
  // A removal arriving while the queue drains goes after it, and a removal let through nests freely.
  assert.equal(await fileRemovalGate.run(async () => fileRemovalGate.run(async () => 'nested open')), 'nested open');
  await reopen();
  assert.equal(fileRemovalGate.isClosed(), false, 'closing once and opening twice leaves it open');
});
