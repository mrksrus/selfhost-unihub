const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalJson,
  sha256Buffer,
  validateBackupPayload,
} = require('../src/services/backup');

test('canonicalJson orders object keys deterministically', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ z: [{ b: true, a: false }] }), '{"z":[{"a":false,"b":true}]}');
});

test('validateBackupPayload accepts matching file checksums', () => {
  const buffer = Buffer.from('hello backup', 'utf8');
  const backup = {
    app: 'unihub',
    version: 1,
    data: { contacts: [] },
    files: [{
      kind: 'email_attachment',
      id: 'file-1',
      sha256: sha256Buffer(buffer),
      data_base64: buffer.toString('base64'),
    }],
  };
  const validation = validateBackupPayload(backup);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
});

test('validateBackupPayload rejects tampered file content', () => {
  const backup = {
    app: 'unihub',
    version: 1,
    data: { contacts: [] },
    files: [{
      kind: 'email_attachment',
      id: 'file-1',
      sha256: sha256Buffer(Buffer.from('original', 'utf8')),
      data_base64: Buffer.from('tampered', 'utf8').toString('base64'),
    }],
  };
  const validation = validateBackupPayload(backup);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /Checksum mismatch/);
});
