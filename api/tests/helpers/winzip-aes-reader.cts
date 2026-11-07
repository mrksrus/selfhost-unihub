// A reader for WinZip AES (AE-1/AE-2) ZIP files written only for tests, apart
// from api/src/services/backup-envelope.ts, so a test can open a backup the
// way another program would. It walks the local headers from the start (the
// writer's reader uses the central directory), derives the keys with PBKDF2,
// checks the password verifier and the HMAC, and decrypts block by block
// with its own little-endian counter. Stored and deflated entries are read.
// With `7zz` or `7z` on PATH (the official 7-Zip; CI images carry `7z`),
// sevenZip() opens the same file with 7-Zip as well.
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const zlib = (require('node:zlib') as typeof import('node:zlib'));
const childProcess = (require('node:child_process') as typeof import('node:child_process'));
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));

interface ReadEntry { name: string; encrypted: boolean; data: Buffer }

function aesCounterDecrypt(key: Buffer, ciphertext: Buffer) {
  const out = Buffer.alloc(ciphertext.length);
  for (let block = 0; block * 16 < ciphertext.length; block += 1) {
    const counter = Buffer.alloc(16);
    counter.writeBigUInt64LE(BigInt(block + 1), 0);
    const cipher = crypto.createCipheriv('aes-256-ecb', key, null);
    cipher.setAutoPadding(false);
    const stream = cipher.update(counter);
    for (let i = 0; i < 16 && block * 16 + i < ciphertext.length; i += 1) out[block * 16 + i] = ciphertext[block * 16 + i] ^ stream[i];
  }
  return out;
}

function decryptAesEntry(payload: Buffer, password: string, strength: number) {
  const keyLength = { 1: 16, 2: 24, 3: 32 }[strength];
  if (keyLength !== 32) throw new Error(`unsupported AES strength ${strength}`);
  const saltLength = keyLength / 2;
  const salt = payload.subarray(0, saltLength);
  const verifier = payload.subarray(saltLength, saltLength + 2);
  const ciphertext = payload.subarray(saltLength + 2, payload.length - 10);
  const mac = payload.subarray(payload.length - 10);
  const keys = crypto.pbkdf2Sync(password, salt, 1000, keyLength * 2 + 2, 'sha1');
  if (!keys.subarray(keyLength * 2).equals(verifier)) throw new Error('wrong password');
  const expected = crypto.createHmac('sha1', keys.subarray(keyLength, keyLength * 2)).update(ciphertext).digest().subarray(0, 10);
  if (!expected.equals(mac)) throw new Error('authentication failed');
  return aesCounterDecrypt(keys.subarray(0, keyLength), ciphertext);
}

/** Every entry of the ZIP file in `bytes`, decrypted with `password` where encrypted. Directories are skipped. */
function readZip(bytes: Buffer, password: string | null = null): ReadEntry[] {
  const entries: ReadEntry[] = [];
  let at = 0;
  while (at + 4 <= bytes.length && bytes.readUInt32LE(at) === 0x04034b50) {
    const flags = bytes.readUInt16LE(at + 6);
    let method = bytes.readUInt16LE(at + 8);
    const size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extraLength = bytes.readUInt16LE(at + 28);
    if (flags & 0x0008) throw new Error('data descriptors are not read by this test reader');
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString(flags & 0x0800 ? 'utf8' : 'latin1');
    const extra = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + extraLength);
    const start = at + 30 + nameLength + extraLength;
    let data = bytes.subarray(start, start + size);
    const encrypted = Boolean(flags & 1);
    if (encrypted) {
      if (method !== 99) throw new Error('only WinZip AES encryption is read');
      let strength = 0;
      for (let offset = 0; offset + 4 <= extra.length;) {
        const id = extra.readUInt16LE(offset), length = extra.readUInt16LE(offset + 2);
        if (id === 0x9901) { strength = extra.readUInt8(offset + 8); method = extra.readUInt16LE(offset + 9); }
        offset += 4 + length;
      }
      if (password === null) throw new Error(`${name} is encrypted`);
      data = decryptAesEntry(data, password, strength);
    }
    if (method === 8) data = zlib.inflateRawSync(data);
    else if (method !== 0) throw new Error(`method ${method} is not read`);
    if (!name.endsWith('/')) entries.push({ name, encrypted, data: Buffer.from(data) });
    at = start + size;
  }
  if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('local headers do not end at the central directory');
  return entries;
}

/** The official 7-Zip on this machine, if there is one. */
function sevenZipBinary() {
  for (const name of [process.env.UNIHUB_TEST_7Z, '7zz', '7z'].filter(Boolean) as string[]) {
    const found = childProcess.spawnSync(name, ['i'], { stdio: 'ignore' });
    if (found.status === 0) return name;
  }
  return null;
}

/** Extracts `file` with 7-Zip into `directory` (created), returning 7-Zip's exit status. */
function sevenZip(binary: string, file: string, directory: string, password: string) {
  fs.mkdirSync(directory, { recursive: true });
  return childProcess.spawnSync(binary, ['x', '-y', `-p${password}`, `-o${path.resolve(directory)}`, path.resolve(file)], { stdio: 'pipe' }).status;
}

module.exports = { readZip, sevenZipBinary, sevenZip };
