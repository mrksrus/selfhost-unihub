const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSingleByteRange } = require('../src/http/range');

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
