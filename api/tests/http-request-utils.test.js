const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const {
  isRequestBodyTooLarge,
  parseBody,
} = require('../src/http/request');

test('isRequestBodyTooLarge rejects oversized content-length before body parsing', () => {
  assert.equal(
    isRequestBodyTooLarge({ headers: { 'content-length': '1001' } }, 1000),
    true
  );
  assert.equal(
    isRequestBodyTooLarge({ headers: { 'content-length': '1000' } }, 1000),
    false
  );
  assert.equal(
    isRequestBodyTooLarge({ headers: {} }, 1000),
    false
  );
});

test('parseBody resolves immediately when a chunked body exceeds the limit', async () => {
  const req = new PassThrough();
  req.headers = {};
  const parsed = parseBody(req, 10);

  req.write('{"payload":"too-large"}');

  assert.equal(await parsed, null);
});
