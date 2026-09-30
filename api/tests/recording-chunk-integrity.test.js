const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const { setDb } = require('../src/state');
const { appendRecordingUploadChunk } = require('../src/services/recordings');

test('recording chunks verify their original browser bytes before writing', async t => {
  const written = [];
  const updates = [];
  t.mock.method(fs.promises, 'appendFile', async (_path, buffer) => written.push(buffer));
  const upload = {
    id: 'upload', user_id: 'user', expires_at: new Date(Date.now() + 60000),
    bytes_received: 0, total_bytes: 3, temp_path: '/app/uploads/recordings/.tmp/user/upload.part',
  };
  setDb({ async execute(sql, params) {
    if (sql.startsWith('SELECT')) return [[upload]];
    updates.push(params);
    return [{ affectedRows: 1 }];
  } });
  t.after(() => setDb(null));
  const payload = { offset: 0, data_base64: Buffer.from('abc').toString('base64') };
  const rejected = await appendRecordingUploadChunk('user', 'upload', { ...payload, sha256: '0'.repeat(64) });
  assert.equal(rejected.status, 409);
  assert.equal(written.length, 0);
  assert.equal(updates.length, 0);
  const accepted = await appendRecordingUploadChunk('user', 'upload', {
    ...payload, sha256: crypto.createHash('sha256').update('abc').digest('hex'),
  });
  assert.equal(accepted.upload.bytes_received, 3);
  assert.equal(written[0].toString(), 'abc');
  assert.deepEqual(updates, [[3, 'upload', 'user']]);
});
