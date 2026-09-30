const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createAudioConversionQueue } = require('../src/services/audio-conversion-queue');
const { buildAudioConversionArgs, runAudioConversion, MAX_CONVERTED_BYTES } = require('../src/services/audio-transcode');

const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('conversions run one at a time, recover after failure and reject an oversized queue', async () => {
  const queue = createAudioConversionQueue({ maxWaiting: 1, maxPerUser: 2 });
  const first = gate();
  const second = gate();
  const started = [];
  const a = queue.enqueue('a', () => { started.push('a'); return first.promise; });
  const b = queue.enqueue('b', () => { started.push('b'); return second.promise; });
  await assert.rejects(queue.enqueue('c', () => assert.fail('queue exceeded its limit')), { status: 429 });
  await tick();
  assert.deepEqual(started, ['a']);
  const failed = assert.rejects(a, /bad audio/);
  first.reject(new Error('bad audio'));
  await failed;
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  second.resolve('finished');
  assert.equal(await b, 'finished');
  await tick();
  assert.equal(await queue.enqueue('c', () => 'ready'), 'ready');
});

test('one user cannot fill every queue position', async () => {
  const queue = createAudioConversionQueue();
  const first = gate();
  const a = queue.enqueue('a', () => first.promise);
  const a2 = queue.enqueue('a', () => 2);
  await assert.rejects(queue.enqueue('a', () => 3), { status: 429 });
  const b = queue.enqueue('b', () => 'another user');
  first.resolve(1);
  assert.deepEqual(await Promise.all([a, a2, b]), [1, 2, 'another user']);
});

test('FFmpeg options constrain threads, formats, nested references and output size', () => {
  const args = buildAudioConversionArgs('/input.wav', '/output.mp3', 'wav');
  const value = name => args[args.indexOf(name) + 1];
  assert.equal(value('-protocol_whitelist'), 'file');
  assert.equal(value('-format_whitelist'), 'wav');
  assert.equal(value('-f'), 'wav');
  assert.equal(value('-fs'), String(MAX_CONVERTED_BYTES));
  assert.equal(value('-filter_threads'), '1');
  assert.equal(args.filter(value => value === '-threads').length, 2);
  assert.equal(value('-threads'), '1');
  assert.equal(args.at(-1), '/output.mp3');
  assert.throws(() => buildAudioConversionArgs('/input.m3u', '/output.mp3', 'hls'), /Unsupported/);
  const mov = buildAudioConversionArgs('/input.m4a', '/output.mp3', 'mov');
  assert.equal(mov[mov.indexOf('-enable_drefs') + 1], '0');
  assert.equal(mov[mov.indexOf('-use_absolute_path') + 1], '0');
});

test('a stuck conversion is killed and remains pending until the child closes', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed;
  child.kill = signal => { killed = signal; };
  let settled = false;
  const job = runAudioConversion('/input.wav', '/output.mp3', 'wav', {
    spawnProcess: () => child,
    timeoutMs: 5,
  });
  const result = assert.rejects(job, { status: 503 }).then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(killed, 'SIGKILL');
  assert.equal(settled, false);
  child.emit('close', null);
  await result;
});

test('spawn failures and decoder errors are reported rather than hanging exports', async () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const job = runAudioConversion('/input.wav', '/output.mp3', 'wav', { spawnProcess: () => child });
  child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await assert.rejects(job, /ffmpeg is not installed/);
  const failed = runAudioConversion('/input.wav', '/output.mp3', 'wav', { spawnProcess: () => child });
  child.stderr.emit('data', Buffer.from('Invalid audio data'));
  child.emit('close', 1);
  await assert.rejects(failed, /Invalid audio data/);
});

test('waiting exports expire without starting background work and release the user quota', async () => {
  const queue = createAudioConversionQueue({ maxWaitMs: 5, maxPerUser: 1 });
  const first = gate();
  const active = queue.enqueue('a', () => first.promise);
  const expired = assert.rejects(queue.enqueue('b', () => assert.fail('expired work started')), { status: 429 });
  await new Promise(resolve => setTimeout(resolve, 15));
  await expired;
  first.resolve();
  await active;
  await tick();
  assert.equal(await queue.enqueue('b', () => 'allowed again'), 'allowed again');
});
