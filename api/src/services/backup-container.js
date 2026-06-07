const crypto = require('crypto');
const fs = require('fs');
const { promisify } = require('util');
const { BACKUP_MASTER_KEY, ENCRYPTION_KEY } = require('../config');

const scrypt = promisify(crypto.scrypt);
const CONTAINER_MAGIC = Buffer.from('UNIHUBBK1', 'ascii');
const CONTAINER_VERSION = 1;
const CONTAINER_FORMAT = 'unihub-encrypted-backup';
const CONTAINER_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_HEADER_SIZE = 1024 * 1024;
const SCRYPT_PARAMS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  keyLength: 32,
});

function deriveMasterKey() {
  const secret = String(BACKUP_MASTER_KEY || ENCRYPTION_KEY || '');
  if (!secret) throw new Error('BACKUP_MASTER_KEY or ENCRYPTION_KEY is required.');
  return crypto.createHash('sha256').update(`unihub-backup-master:${secret}`).digest();
}

function aesGcmEncrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function aesGcmDecrypt(key, wrapped, aad) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(wrapped.iv, 'base64')
  );
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
    decipher.final(),
  ]);
}

function getCoreHeader(header) {
  return {
    format: header.format,
    version: header.version,
    backup_uuid: header.backup_uuid,
    chunk_size: header.chunk_size,
    plaintext_size: header.plaintext_size,
    chunk_count: header.chunk_count,
    nonce_prefix: header.nonce_prefix,
    kdf: header.kdf,
  };
}

function getCoreHeaderBytes(header) {
  return Buffer.from(JSON.stringify(getCoreHeader(header)), 'utf8');
}

function getChunkNonce(prefix, index) {
  const nonce = Buffer.alloc(12);
  Buffer.from(prefix, 'base64').copy(nonce, 0, 0, 8);
  nonce.writeUInt32BE(index >>> 0, 8);
  return nonce;
}

function getChunkAad(headerBytes, index) {
  const indexBuffer = Buffer.alloc(4);
  indexBuffer.writeUInt32BE(index >>> 0, 0);
  return Buffer.concat([headerBytes, indexBuffer]);
}

async function derivePasswordKey(password, kdf) {
  if (
    !kdf
    || kdf.name !== 'scrypt'
    || kdf.N !== SCRYPT_PARAMS.N
    || kdf.r !== SCRYPT_PARAMS.r
    || kdf.p !== SCRYPT_PARAMS.p
    || kdf.key_length !== SCRYPT_PARAMS.keyLength
  ) {
    throw new Error('Unsupported backup password derivation settings.');
  }
  return scrypt(
    String(password),
    Buffer.from(kdf.salt, 'base64'),
    kdf.key_length,
    {
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      maxmem: 128 * 1024 * 1024,
    }
  );
}

function generateRecoveryPassword() {
  return crypto.randomBytes(32).toString('base64url');
}

function wrapDataKeyForServer(dataKey, backupUuid) {
  return JSON.stringify(aesGcmEncrypt(
    deriveMasterKey(),
    dataKey,
    Buffer.from(`unihub-backup-key:${backupUuid}`, 'utf8')
  ));
}

function unwrapDataKeyFromServer(wrappedValue, backupUuid) {
  return aesGcmDecrypt(
    deriveMasterKey(),
    typeof wrappedValue === 'string' ? JSON.parse(wrappedValue) : wrappedValue,
    Buffer.from(`unihub-backup-key:${backupUuid}`, 'utf8')
  );
}

function protectRecoveryPassword(password, backupUuid) {
  return JSON.stringify(aesGcmEncrypt(
    deriveMasterKey(),
    Buffer.from(String(password), 'utf8'),
    Buffer.from(`unihub-backup-password:${backupUuid}`, 'utf8')
  ));
}

function revealProtectedRecoveryPassword(protectedValue, backupUuid) {
  return aesGcmDecrypt(
    deriveMasterKey(),
    typeof protectedValue === 'string' ? JSON.parse(protectedValue) : protectedValue,
    Buffer.from(`unihub-backup-password:${backupUuid}`, 'utf8')
  ).toString('utf8');
}

function encryptPortableCredentialBundle(value, dataKey) {
  return {
    format: 'aes-256-gcm',
    ...aesGcmEncrypt(
      dataKey,
      Buffer.from(JSON.stringify(value), 'utf8'),
      Buffer.from('unihub-portable-credentials-v1', 'utf8')
    ),
  };
}

function decryptPortableCredentialBundle(value, dataKey) {
  if (!value || value.format !== 'aes-256-gcm') {
    throw new Error('Portable credential bundle is invalid.');
  }
  return JSON.parse(aesGcmDecrypt(
    dataKey,
    value,
    Buffer.from('unihub-portable-credentials-v1', 'utf8')
  ).toString('utf8'));
}

async function encryptBackupFile(inputPath, outputPath, {
  backupUuid = crypto.randomUUID(),
  dataKey = crypto.randomBytes(32),
  recoveryPassword = generateRecoveryPassword(),
  onProgress = null,
  checkCancelled = null,
} = {}) {
  const stat = await fs.promises.stat(inputPath);
  const salt = crypto.randomBytes(16);
  const noncePrefix = crypto.randomBytes(8);
  const header = {
    format: CONTAINER_FORMAT,
    version: CONTAINER_VERSION,
    backup_uuid: backupUuid,
    chunk_size: CONTAINER_CHUNK_SIZE,
    plaintext_size: stat.size,
    chunk_count: Math.ceil(stat.size / CONTAINER_CHUNK_SIZE),
    nonce_prefix: noncePrefix.toString('base64'),
    kdf: {
      name: 'scrypt',
      salt: salt.toString('base64'),
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      key_length: SCRYPT_PARAMS.keyLength,
    },
  };
  const passwordKey = await derivePasswordKey(recoveryPassword, header.kdf);
  header.password_key = aesGcmEncrypt(passwordKey, dataKey, getCoreHeaderBytes(header));
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBytes.length > MAX_HEADER_SIZE) throw new Error('Encrypted backup header is too large.');

  await fs.promises.mkdir(require('path').dirname(outputPath), { recursive: true });
  const input = await fs.promises.open(inputPath, 'r');
  const output = await fs.promises.open(outputPath, 'wx', 0o600);
  let processed = 0;
  try {
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(headerBytes.length, 0);
    await output.write(CONTAINER_MAGIC);
    await output.write(lengthBuffer);
    await output.write(headerBytes);

    for (let index = 0; index < header.chunk_count; index += 1) {
      if (checkCancelled) await checkCancelled();
      const size = Math.min(CONTAINER_CHUNK_SIZE, stat.size - processed);
      const plaintext = Buffer.allocUnsafe(size);
      const { bytesRead } = await input.read(plaintext, 0, size, processed);
      if (bytesRead !== size) throw new Error('Backup ZIP ended unexpectedly during encryption.');
      const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, getChunkNonce(header.nonce_prefix, index));
      cipher.setAAD(getChunkAad(headerBytes, index));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const chunkLength = Buffer.alloc(4);
      chunkLength.writeUInt32BE(ciphertext.length, 0);
      await output.write(chunkLength);
      await output.write(ciphertext);
      await output.write(cipher.getAuthTag());
      processed += size;
      if (onProgress) await onProgress(processed, stat.size);
    }
  } catch (error) {
    await output.close().catch(() => {});
    await input.close().catch(() => {});
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
  await output.close();
  await input.close();
  return {
    backupUuid,
    dataKey,
    recoveryPassword,
    header,
    fileSize: (await fs.promises.stat(outputPath)).size,
  };
}

async function readContainerHeader(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const prefix = Buffer.alloc(CONTAINER_MAGIC.length + 4);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (bytesRead < CONTAINER_MAGIC.length || !prefix.subarray(0, CONTAINER_MAGIC.length).equals(CONTAINER_MAGIC)) {
      return null;
    }
    if (bytesRead !== prefix.length) throw new Error('Encrypted backup header is incomplete.');
    const headerLength = prefix.readUInt32BE(CONTAINER_MAGIC.length);
    if (headerLength <= 0 || headerLength > MAX_HEADER_SIZE) {
      throw new Error('Encrypted backup header is invalid.');
    }
    const headerBytes = Buffer.alloc(headerLength);
    const result = await handle.read(headerBytes, 0, headerLength, prefix.length);
    if (result.bytesRead !== headerLength) throw new Error('Encrypted backup header is incomplete.');
    const header = JSON.parse(headerBytes.toString('utf8'));
    if (
      header.format !== CONTAINER_FORMAT
      || header.version !== CONTAINER_VERSION
      || !header.backup_uuid
      || !header.password_key
      || header.chunk_size !== CONTAINER_CHUNK_SIZE
      || !Number.isSafeInteger(header.plaintext_size)
      || header.plaintext_size < 0
      || !Number.isSafeInteger(header.chunk_count)
      || header.chunk_count !== Math.ceil(header.plaintext_size / CONTAINER_CHUNK_SIZE)
      || Buffer.from(header.nonce_prefix || '', 'base64').length !== 8
    ) {
      throw new Error('Encrypted backup format is unsupported.');
    }
    return {
      header,
      headerBytes,
      dataOffset: prefix.length + headerLength,
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Encrypted backup header is invalid.');
    throw error;
  } finally {
    await handle.close();
  }
}

async function unlockContainerWithPassword(filePath, password) {
  try {
    const parsed = await readContainerHeader(filePath);
    if (!parsed) throw new Error('Not an encrypted UniHub backup.');
    const passwordKey = await derivePasswordKey(password, parsed.header.kdf);
    return {
      ...parsed,
      dataKey: aesGcmDecrypt(
        passwordKey,
        parsed.header.password_key,
        getCoreHeaderBytes(parsed.header)
      ),
    };
  } catch {
    throw new Error('Unable to unlock backup. The password is incorrect or the backup is damaged.');
  }
}

async function decryptBackupFile(inputPath, outputPath, dataKey, {
  onProgress = null,
  checkCancelled = null,
} = {}) {
  const parsed = await readContainerHeader(inputPath);
  if (!parsed) throw new Error('Not an encrypted UniHub backup.');
  const { header, headerBytes } = parsed;
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) {
    throw new Error('Unable to unlock backup. The password is incorrect or the backup is damaged.');
  }

  await fs.promises.mkdir(require('path').dirname(outputPath), { recursive: true });
  const input = await fs.promises.open(inputPath, 'r');
  const output = await fs.promises.open(outputPath, 'wx', 0o600);
  const inputStat = await input.stat();
  let inputOffset = parsed.dataOffset;
  let processed = 0;
  try {
    for (let index = 0; index < header.chunk_count; index += 1) {
      if (checkCancelled) await checkCancelled();
      const lengthBuffer = Buffer.alloc(4);
      const lengthRead = await input.read(lengthBuffer, 0, 4, inputOffset);
      if (lengthRead.bytesRead !== 4) throw new Error('Encrypted backup ended unexpectedly.');
      inputOffset += 4;
      const chunkLength = lengthBuffer.readUInt32BE(0);
      const expectedLength = Math.min(header.chunk_size, header.plaintext_size - processed);
      if (chunkLength !== expectedLength || chunkLength > header.chunk_size) {
        throw new Error('Encrypted backup chunk metadata is invalid.');
      }
      const ciphertext = Buffer.allocUnsafe(chunkLength);
      const chunkRead = await input.read(ciphertext, 0, chunkLength, inputOffset);
      if (chunkRead.bytesRead !== chunkLength) throw new Error('Encrypted backup ended unexpectedly.');
      inputOffset += chunkLength;
      const tag = Buffer.alloc(16);
      const tagRead = await input.read(tag, 0, 16, inputOffset);
      if (tagRead.bytesRead !== 16) throw new Error('Encrypted backup ended unexpectedly.');
      inputOffset += 16;

      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        dataKey,
        getChunkNonce(header.nonce_prefix, index)
      );
      decipher.setAAD(getChunkAad(headerBytes, index));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      await output.write(plaintext);
      processed += plaintext.length;
      if (onProgress) await onProgress(processed, header.plaintext_size);
    }
    if (processed !== header.plaintext_size) throw new Error('Encrypted backup size is invalid.');
    if (inputOffset !== inputStat.size) throw new Error('Encrypted backup contains unexpected trailing data.');
  } catch {
    await output.close().catch(() => {});
    await input.close().catch(() => {});
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    throw new Error('Unable to unlock backup. The password is incorrect or the backup is damaged.');
  }
  await output.close();
  await input.close();
  return parsed.header;
}

module.exports = {
  CONTAINER_MAGIC,
  CONTAINER_FORMAT,
  CONTAINER_VERSION,
  CONTAINER_CHUNK_SIZE,
  generateRecoveryPassword,
  wrapDataKeyForServer,
  unwrapDataKeyFromServer,
  protectRecoveryPassword,
  revealProtectedRecoveryPassword,
  encryptPortableCredentialBundle,
  decryptPortableCredentialBundle,
  encryptBackupFile,
  decryptBackupFile,
  readContainerHeader,
  unlockContainerWithPassword,
};
