import type {} from 'node:module';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-for-backup-container';
process.env.BACKUP_MASTER_KEY = process.env.BACKUP_MASTER_KEY || 'test-backup-master-key';

const {
  encryptBackupFile,
  decryptBackupFile,
  unlockContainerWithPassword,
  wrapDataKeyForServer,
  unwrapDataKeyFromServer,
  protectRecoveryPassword,
  revealProtectedRecoveryPassword,
  encryptPortableCredentialBundle,
  decryptPortableCredentialBundle,
  wrapEnvelopePasswordForServer,
  unwrapEnvelopePasswordFromServer,
} = require('../dist/src/services/backup-container') as typeof import('../src/services/backup-container');

test('encrypted UniHub backup is portable with its password and detects damage', async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unihub-container-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  const inputPath = path.join(dir, 'input.zip');
  const encryptedPath = path.join(dir, 'backup.unihub-backup');
  const outputPath = path.join(dir, 'output.zip');
  const password = 'portable-test-recovery-password';
  const source = crypto.randomBytes((4 * 1024 * 1024) + 12345);
  await fs.promises.writeFile(inputPath, source);

  const encrypted = await encryptBackupFile(inputPath, encryptedPath, {
    recoveryPassword: password,
  });
  const unlocked = await unlockContainerWithPassword(encryptedPath, password);
  await decryptBackupFile(encryptedPath, outputPath, unlocked.dataKey);
  assert.deepEqual(await fs.promises.readFile(outputPath), source);

  await assert.rejects(
    unlockContainerWithPassword(encryptedPath, 'wrong-password'),
    /Unable to unlock backup/
  );

  const damagedPath = path.join(dir, 'damaged.unihub-backup');
  const damaged = await fs.promises.readFile(encryptedPath);
  damaged[damaged.length - 20] ^= 0xff;
  await fs.promises.writeFile(damagedPath, damaged);
  const damagedOutput = path.join(dir, 'damaged.zip');
  await assert.rejects(
    decryptBackupFile(damagedPath, damagedOutput, unlocked.dataKey),
    /Unable to unlock backup/
  );

  const wrapped = wrapDataKeyForServer(encrypted.dataKey, encrypted.backupUuid);
  assert.deepEqual(
    unwrapDataKeyFromServer(wrapped, encrypted.backupUuid),
    encrypted.dataKey
  );
  const protectedPassword = protectRecoveryPassword(password, encrypted.backupUuid);
  assert.equal(
    revealProtectedRecoveryPassword(protectedPassword, encrypted.backupUuid),
    password
  );
});

test('portable credential bundle round trips without exposing plaintext fields', () => {
  const dataKey = crypto.randomBytes(32);
  const credentials = {
    mail_accounts: [{ id: 'mail-account', password: 'mail-secret' }],
    calendar_accounts: [{
      id: 'calendar-account',
      password: 'calendar-secret',
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
    }],
  };
  const bundle = encryptPortableCredentialBundle(credentials, dataKey);
  assert.equal(JSON.stringify(bundle).includes('mail-secret'), false);
  assert.deepEqual(decryptPortableCredentialBundle(bundle, dataKey), credentials);
});

test('the server copy of a backup password names its key version, which is authenticated', () => {
  const uuid = crypto.randomUUID();
  const wrapped = JSON.parse(wrapEnvelopePasswordForServer('synthetic-password', uuid));
  assert.equal(wrapped.version, 'v1');
  assert.equal(unwrapEnvelopePasswordFromServer(JSON.stringify(wrapped), uuid), 'synthetic-password');
  // An unknown or missing version is refused, not guessed.
  assert.throws(() => unwrapEnvelopePasswordFromServer(JSON.stringify({ ...wrapped, version: 'v2' }), uuid), /key version/);
  const { version: _version, ...unversioned } = wrapped;
  assert.throws(() => unwrapEnvelopePasswordFromServer(JSON.stringify(unversioned), uuid), /key version/);
  // Neither wrap is read as the other or under another backup's UUID.
  assert.throws(() => unwrapDataKeyFromServer(JSON.stringify(wrapped), uuid));
  assert.throws(() => unwrapEnvelopePasswordFromServer(JSON.stringify({ version: 'v1', ...JSON.parse(wrapDataKeyForServer(crypto.randomBytes(32), uuid)) }), uuid));
  assert.throws(() => unwrapEnvelopePasswordFromServer(JSON.stringify(wrapped), crypto.randomUUID()));
});
