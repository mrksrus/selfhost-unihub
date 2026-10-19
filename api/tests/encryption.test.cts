'use strict';
// Stored secrets stay readable across the format change and a key change.
process.env.ENCRYPTION_KEY = 'synthetic-current-encryption-key';
process.env.ENCRYPTION_KEY_PREVIOUS = 'synthetic-previous-encryption-key';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { encrypt, decrypt } = require('../dist/src/security/encryption') as typeof import('../src/security/encryption');

// The format before 0.23.0: <iv>:<tag>:<ciphertext>, written here with any key.
function legacy(text: string, secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), iv);
  const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

test('new values are versioned and read back; older ones and those under the previous key stay readable', () => {
  const stored = encrypt('imap-app-password');
  assert.match(stored, /^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
  assert.equal(decrypt(stored), 'imap-app-password');
  assert.notEqual(encrypt('imap-app-password'), stored, 'a fresh IV for every value');

  assert.equal(decrypt(legacy('stored-before-0.23', 'synthetic-current-encryption-key')), 'stored-before-0.23');
  const previous = legacy('stored-before-the-key-change', 'synthetic-previous-encryption-key');
  assert.equal(decrypt(previous), 'stored-before-the-key-change');
  assert.equal(decrypt(`v1:${previous}`), 'stored-before-the-key-change');
});

test('a value under another key, a tampered value or an unknown format is unreadable', () => {
  assert.equal(decrypt(legacy('someone else', 'synthetic-unrelated-key')), null);
  const [version, iv, tag, data] = encrypt('secret').split(':');
  const flipped = (data[0] === '0' ? '1' : '0') + data.slice(1);
  assert.equal(decrypt([version, iv, tag, flipped].join(':')), null);
  assert.equal(decrypt(`v2:${iv}:${tag}:${data}`), null);
  assert.equal(decrypt('not a stored secret'), null);
});
