const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const {
  isRequestBodyTooLarge,
  parseBody,
  parseRawBody,
  parseRawBodyToFile,
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

test('parseBody preserves Unicode at every byte boundary', async () => {
  const expected = { title: 'Café 🎵 中文', note: 'Grüße' };
  const bytes = Buffer.from(JSON.stringify(expected));
  for (let split = 1; split < bytes.length; split += 1) {
    const req = new PassThrough();
    const parsed = parseBody(req);
    req.write(bytes.subarray(0, split));
    req.end(bytes.subarray(split));
    assert.deepEqual(await parsed, expected);
  }
});

test('parseBody rejects malformed JSON with a distinct 400 error', async () => {
  const req = new PassThrough();
  const parsed = parseBody(req);
  req.end('{"title":');
  await assert.rejects(parsed, { status: 400, message: 'Invalid JSON request body' });
});

test('parseRawBody returns binary request data', async () => {
  const req = new PassThrough();
  req.headers = {};
  const parsed = parseRawBody(req, 20);

  req.end(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  assert.deepEqual(await parsed, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
});

test('parseRawBodyToFile streams binary request data to disk', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-request-upload-'));
  const targetPath = path.join(dir, 'backup.zip');
  const req = new PassThrough();
  req.headers = {};
  const parsed = parseRawBodyToFile(req, targetPath, 20);

  req.end(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  assert.deepEqual(await parsed, { filePath: targetPath, size: 4 });
  assert.deepEqual(await fs.readFile(targetPath), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
});

test('parseRawBodyToFile removes partial uploads that exceed the limit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-request-upload-limit-'));
  const targetPath = path.join(dir, 'backup.zip');
  const req = new PassThrough();
  req.headers = {};
  const parsed = parseRawBodyToFile(req, targetPath, 3);

  req.end(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  assert.equal(await parsed, null);
  await assert.rejects(fs.stat(targetPath), { code: 'ENOENT' });
});
