import type {} from 'node:module';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { parseSingleByteRange, fileValidators, rangeAllowed } = require('../dist/src/http/range') as typeof import('../src/http/range');

test('parseSingleByteRange parses bounded, open, and suffix ranges', () => {
  assert.deepEqual(parseSingleByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseSingleByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseSingleByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseSingleByteRange('bytes=90-200', 100), { start: 90, end: 99 });
});

test('parseSingleByteRange rejects invalid or unsupported ranges', () => {
  assert.equal(parseSingleByteRange('bytes=100-101', 100), null);
  assert.equal(parseSingleByteRange('bytes=20-10', 100), null);
  assert.equal(parseSingleByteRange('bytes=0-1,4-5', 100), null);
  assert.equal(parseSingleByteRange('items=0-10', 100), null);
  assert.equal(parseSingleByteRange('', 100), null);
});

test('file validators are strong and change with size or modification time', () => {
  const mtime = new Date('2026-09-01T10:00:00.250Z');
  const validators = fileValidators({ size: 4096, mtime });
  assert.equal(validators!.etag, `"1000-${mtime.getTime().toString(16)}"`);
  assert.equal(validators!.lastModified, 'Tue, 01 Sep 2026 10:00:00 GMT');
  assert.notEqual(fileValidators({ size: 4097, mtime })!.etag, validators!.etag);
  assert.notEqual(fileValidators({ size: 4096, mtime: new Date(mtime.getTime() + 1) })!.etag, validators!.etag);
  assert.equal(fileValidators(null), null);
  assert.equal(fileValidators({ size: 1, mtime: new Date(NaN) }), null);
});

test('If-Range resumes only the same file', () => {
  const validators = fileValidators({ size: 10, mtime: new Date('2026-09-01T10:00:00Z') });
  assert.equal(rangeAllowed(undefined, validators), true);
  assert.equal(rangeAllowed(validators!.etag, validators), true);
  assert.equal(rangeAllowed(validators!.lastModified, validators), true);
  assert.equal(rangeAllowed('"other"', validators), false);
  assert.equal(rangeAllowed(`W/${validators!.etag}`, validators), false);
  assert.equal(rangeAllowed('Mon, 31 Aug 2026 10:00:00 GMT', validators), false);
  assert.equal(rangeAllowed(validators!.etag, null), false);
});
