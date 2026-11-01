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

// The review's deadlock: a queued photo cleanup waits for the person's photo
// lock while a request holding that lock reaches the gate during the drain.
test('a request holding the photo lock never waits for the drain that needs its lock', async () => {
  const { withContactPhotoLock } = require('../dist/src/services/contact-photos') as typeof import('../src/services/contact-photos');
  const userId = '00000000-0000-4000-8000-0000000000a1';
  const done: string[] = [];
  const reopen = fileRemovalGate.close();
  // Queued during the copy: it takes the lock afresh when it runs.
  assert.equal(await fileRemovalGate.run(async () => {}, () => withContactPhotoLock(userId, async () => { done.push('queued cleanup'); })), 'deferred');
  let lockHeld!: () => void;
  const held = new Promise<void>(resolve => { lockHeld = resolve; });
  let drainStarted!: () => void;
  const started = new Promise<void>(resolve => { drainStarted = resolve; });
  const request = withContactPhotoLock(userId, async () => {
    lockHeld();
    await started;
    // A second removal of this person's photos, while the drain waits for this lock.
    const answer = await fileRemovalGate.run(async () => { done.push('request now'); }, () => withContactPhotoLock(userId, async () => { done.push('request queued'); }));
    done.push(`request answered ${String(answer)}`);
  });
  await held;
  const drained = reopen();
  drainStarted();
  const outcome = await Promise.race([Promise.all([request, drained]).then(() => 'finished'), new Promise(resolve => setTimeout(() => resolve('deadlocked'), 3000))]);
  assert.equal(outcome, 'finished');
  assert.deepEqual(done, ['request answered deferred', 'queued cleanup', 'request queued']);
  assert.equal(fileRemovalGate.isClosed(), false);
  await fileRemovalGate.whenOpen();
});
