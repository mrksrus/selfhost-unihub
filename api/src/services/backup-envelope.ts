// The envelope of a user backup (D37, 0.28.0): a standard ZIP that 7-Zip,
// Keka, Ark, WinRAR and `7z x` open with the recovery password. It holds a
// plain README.txt and one entry, unihub-backup.zip (the archive itself, an
// ordinary stored ZIP), encrypted with WinZip AES (AE-2: PBKDF2-HMAC-SHA1
// with 1000 iterations, AES-256 in WinZip's counter mode, HMAC-SHA1 over the
// ciphertext). One entry keeps the names and sizes of what is inside hidden.
// The ZIP comment names the backup's UUID, which the server needs before the
// password to find its own copy of the key; it is not authenticated, and
// needs not be: only the right password opens the entry.
//
// The recovery password is 256 random bits (backup-container.ts
// generateRecoveryPassword), so AE-2's 1000 PBKDF2 iterations cost nothing in
// strength. The key for the portable credentials inside (backup-export.ts)
// is derived from the same password, so anyone who can open the archive can
// restore it on another server, as with the earlier container.
//
// Older archives (the UNIHUBBK1 container, unencrypted ZIPs) are read by
// backup-container.ts and backup-zip-reader.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';

const pbkdf2 = promisify(crypto.pbkdf2);

const INNER_NAME = 'unihub-backup.zip';
const README_NAME = 'README.txt';
const COMMENT = /^UniHub backup ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const SALT_LENGTH = 16;
const VERIFIER_LENGTH = 2;
const MAC_LENGTH = 10;
const OVERHEAD = SALT_LENGTH + VERIFIER_LENGTH + MAC_LENGTH;
const ITERATIONS = 1000;
const AES_METHOD = 99;
const ZIP32_MAX = 0xffffffff;
const UNLOCK_FAILED = 'Unable to unlock backup. The password is incorrect or the backup is damaged.';

const README = `UniHub backup
=============

This file is a password-protected ZIP archive made by UniHub. It is
encrypted with AES-256. Open it with the recovery password UniHub showed
when the backup was made.

1. Open this file with 7-Zip (Windows, Linux), Keka (macOS), Ark (KDE),
   WinRAR, or on the command line with "7z x" followed by the file name.
   The built-in ZIP support of Windows Explorer and the macOS Archive
   Utility cannot open AES-encrypted ZIP files.
2. Enter the recovery password. Inside is unihub-backup.zip: an ordinary
   ZIP archive. Open or extract it as usual.
3. Inside unihub-backup.zip:
   Mail/          messages as .eml files, by account and folder
   Contacts/      contacts as a vCard (.vcf) file
   Calendars/     calendars and tasks as iCalendar (.ics) files
   Recordings/    recordings as their original audio files
   UniHub restore data/   what UniHub needs to restore the backup

Thunderbird: install the ImportExportTools NG add-on and use "Import all
messages from a directory" on a folder of .eml files, or drag .eml files
onto a folder. Import contacts and calendars with File > Import.

To restore into UniHub, upload this file unchanged under Settings >
Backups. Do not upload unihub-backup.zip or the extracted files.
`;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32(buffer: Buffer) {
  let crc = 0 ^ -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** The AES, HMAC and verifier keys of an AE-2 entry (WinZip AES, 256 bits). */
async function deriveKeys(password: string, salt: Buffer) {
  const keys = await pbkdf2(Buffer.from(password, 'utf8'), salt, ITERATIONS, 32 + 32 + VERIFIER_LENGTH, 'sha1');
  return { aes: keys.subarray(0, 32), mac: keys.subarray(32, 64), verifier: keys.subarray(64) };
}

/**
 * WinZip's AES counter mode: a 128-bit little-endian counter, starting at 1
 * for the first block, encrypted with AES-ECB and XORed with the data. Node's
 * aes-256-ctr counts big-endian, so the counter blocks are made here.
 */
function counterMode(key: Buffer) {
  const ecb = crypto.createCipheriv('aes-256-ecb', key, null);
  ecb.setAutoPadding(false);
  let counter = 0;
  let rest = Buffer.alloc(0);
  return (data: Buffer) => {
    const out = Buffer.allocUnsafe(data.length);
    const fromRest = Math.min(rest.length, data.length);
    for (let i = 0; i < fromRest; i += 1) out[i] = data[i] ^ rest[i];
    rest = rest.subarray(fromRest);
    const remaining = data.length - fromRest;
    if (remaining > 0) {
      const blocks = Math.ceil(remaining / 16);
      const counters = Buffer.alloc(blocks * 16);
      for (let block = 0; block < blocks; block += 1) {
        counter += 1;
        counters.writeUInt32LE(counter % 0x100000000, block * 16);
        counters.writeUInt32LE(Math.floor(counter / 0x100000000), block * 16 + 4);
      }
      const stream = ecb.update(counters);
      for (let i = 0; i < remaining; i += 1) out[fromRest + i] = data[fromRest + i] ^ stream[i];
      rest = stream.subarray(remaining);
    }
    return out;
  };
}

/** The AE-2 extra field: vendor version 2, vendor "AE", AES-256, stored data. */
function aesExtraField() {
  const extra = Buffer.alloc(11);
  extra.writeUInt16LE(0x9901, 0);
  extra.writeUInt16LE(7, 2);
  extra.writeUInt16LE(2, 4);
  extra.write('AE', 6, 'ascii');
  extra.writeUInt8(3, 8);
  extra.writeUInt16LE(0, 9);
  return extra;
}

interface CentralEntry { name: Buffer; extra: Buffer; flags: number; method: number; versionNeeded: number; crc: number; compressed: number; size: number; offset: number; time: number; date: number }

function localHeader(entry: Omit<CentralEntry, 'offset'>) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(entry.versionNeeded, 4);
  header.writeUInt16LE(entry.flags, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(entry.extra.length, 28);
  return Buffer.concat([header, entry.name, entry.extra]);
}

function centralHeader(entry: CentralEntry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 63, 4);
  header.writeUInt16LE(entry.versionNeeded, 6);
  header.writeUInt16LE(entry.flags, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(entry.extra.length, 30);
  // Regular file, rw-------.
  header.writeUInt32LE((0o100600 << 16) >>> 0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name, entry.extra]);
}

type Progress = ((processed: number, total: number) => unknown | Promise<unknown>) | null;
type Cancel = (() => unknown | Promise<unknown>) | null;

/**
 * Writes the envelope of the archive at innerPath to outPath (created anew,
 * mode 0600), streaming. The inner archive is not read into memory.
 */
async function writeBackupEnvelope(innerPath: string, outPath: string, { password, backupUuid, onProgress = null, checkCancelled = null }: {
  password: string; backupUuid: string; onProgress?: Progress; checkCancelled?: Cancel;
}) {
  if (!COMMENT.test(`UniHub backup ${backupUuid}`)) throw new Error('Backup UUID is invalid.');
  const { size } = await fs.promises.stat(innerPath);
  if (size + OVERHEAD > ZIP32_MAX) throw new Error('Backup exceeds the ZIP32 archive size limit.');
  const now = dosDateTime(new Date());
  const readme = Buffer.from(README.replace(/\n/g, '\r\n'), 'utf8');
  const salt = crypto.randomBytes(SALT_LENGTH);
  const keys = await deriveKeys(password, salt);
  const encrypt = counterMode(keys.aes);
  const mac = crypto.createHmac('sha1', keys.mac);
  const out = fs.createWriteStream(outPath, { flags: 'wx', mode: 0o600 });
  let streamError: Error | null = null;
  out.on('error', error => { streamError = error; });
  let offset = 0;
  const write = (buffer: Buffer) => new Promise<void>((resolve, reject) => {
    if (streamError) { reject(streamError); return; }
    offset += buffer.length;
    out.write(buffer, error => (error ? reject(error) : resolve()));
  });
  try {
    const entries: CentralEntry[] = [];
    const readmeEntry = { name: Buffer.from(README_NAME), extra: Buffer.alloc(0), flags: 0x0800, method: 0, versionNeeded: 20,
      crc: crc32(readme), compressed: readme.length, size: readme.length, time: now.time, date: now.date };
    entries.push({ ...readmeEntry, offset });
    await write(localHeader(readmeEntry));
    await write(readme);
    // AE-2 stores no CRC: the HMAC protects the data.
    const innerEntry = { name: Buffer.from(INNER_NAME), extra: aesExtraField(), flags: 0x0801, method: AES_METHOD, versionNeeded: 51,
      crc: 0, compressed: size + OVERHEAD, size, time: now.time, date: now.date };
    entries.push({ ...innerEntry, offset });
    await write(localHeader(innerEntry));
    await write(salt);
    await write(Buffer.from(keys.verifier));
    let processed = 0;
    for await (const chunk of fs.createReadStream(innerPath)) {
      if (checkCancelled) await checkCancelled();
      const ciphertext = encrypt(chunk as Buffer);
      mac.update(ciphertext);
      await write(ciphertext);
      processed += (chunk as Buffer).length;
      if (onProgress) await onProgress(processed, size);
    }
    if (processed !== size) throw new Error('Backup archive changed while it was encrypted.');
    await write(mac.digest().subarray(0, MAC_LENGTH));
    const centralStart = offset;
    for (const entry of entries) await write(centralHeader(entry));
    const centralSize = offset - centralStart;
    const comment = Buffer.from(`UniHub backup ${backupUuid}`, 'utf8');
    if (offset + 22 + comment.length > ZIP32_MAX) throw new Error('Backup exceeds the ZIP32 archive size limit.');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(comment.length, 20);
    await write(end);
    await write(comment);
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    await fs.promises.rm(outPath, { force: true }).catch(() => {});
    throw error;
  }
}

interface EnvelopeInfo { backupUuid: string; dataStart: number; size: number }

async function readRange(handle: fs.promises.FileHandle, start: number, length: number) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
    if (!bytesRead) throw new Error('Encrypted backup ended unexpectedly.');
    read += bytesRead;
  }
  return buffer;
}

/**
 * The envelope's backup UUID and where its encrypted entry lies; null for a
 * file that is not one (an older container or an unencrypted ZIP). A file
 * whose comment names a UniHub backup but whose structure is not exactly the
 * envelope's is refused.
 */
async function readBackupEnvelope(filePath: string): Promise<EnvelopeInfo | null> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    if (fileSize < 22) return null;
    const tailSize = Math.min(fileSize, 22 + 0xffff);
    const tail = await readRange(handle, fileSize - tailSize, tailSize);
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) === 0x06054b50 && at + 22 + tail.readUInt16LE(at + 20) === tail.length) { eocd = at; break; }
    }
    if (eocd < 0) return null;
    const match = COMMENT.exec(tail.subarray(eocd + 22).toString('utf8'));
    if (!match) return null;
    const damaged = () => new Error('This encrypted backup is damaged or not one UniHub wrote.');
    const count = tail.readUInt16LE(eocd + 10);
    const centralSize = tail.readUInt32LE(eocd + 12);
    const centralStart = tail.readUInt32LE(eocd + 16);
    if (count !== 2 || centralStart + centralSize > fileSize - tailSize + eocd) throw damaged();
    const central = await readRange(handle, centralStart, centralSize);
    let at = 0;
    let inner: { offset: number; compressed: number; size: number } | null = null;
    const names = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== 0x02014b50) throw damaged();
      const flags = central.readUInt16LE(at + 8), method = central.readUInt16LE(at + 10);
      const compressed = central.readUInt32LE(at + 20), size = central.readUInt32LE(at + 24);
      const nameLength = central.readUInt16LE(at + 28), extraLength = central.readUInt16LE(at + 30), commentLength = central.readUInt16LE(at + 32);
      const offset = central.readUInt32LE(at + 42);
      const name = central.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      const extra = central.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
      at += 46 + nameLength + extraLength + commentLength;
      names.add(name);
      if (name === INNER_NAME) {
        const aes = extra.length === 11 && extra.readUInt16LE(0) === 0x9901 && extra.readUInt16LE(2) === 7 && extra.readUInt16LE(4) === 2
          && extra.toString('ascii', 6, 8) === 'AE' && extra.readUInt8(8) === 3 && extra.readUInt16LE(9) === 0;
        if (!(flags & 1) || method !== AES_METHOD || !aes || compressed !== size + OVERHEAD) throw damaged();
        inner = { offset, compressed, size };
      } else if (name !== README_NAME || (flags & 1)) {
        throw damaged();
      }
    }
    if (!inner || names.size !== 2 || at !== central.length) throw damaged();
    const local = await readRange(handle, inner.offset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== AES_METHOD) throw damaged();
    const localName = await readRange(handle, inner.offset + 30, local.readUInt16LE(26));
    if (localName.toString('utf8') !== INNER_NAME) throw damaged();
    const dataStart = inner.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (dataStart + inner.compressed > centralStart) throw damaged();
    return { backupUuid: match[1], dataStart, size: inner.size };
  } finally {
    await handle.close();
  }
}

/** Whether the password opens the envelope, by its verifier (a quick check; the HMAC is checked when it is opened). */
async function checkEnvelopePassword(filePath: string, password: string) {
  const info = await readBackupEnvelope(filePath);
  if (!info) return false;
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const head = await readRange(handle, info.dataStart, SALT_LENGTH + VERIFIER_LENGTH);
    const keys = await deriveKeys(password, head.subarray(0, SALT_LENGTH));
    return crypto.timingSafeEqual(Buffer.from(keys.verifier), head.subarray(SALT_LENGTH));
  } finally {
    await handle.close();
  }
}

/**
 * Decrypts the envelope's archive to outPath (created anew, mode 0600). A
 * wrong password or any changed byte (the HMAC) refuses it, and nothing is
 * left at outPath.
 */
async function openBackupEnvelope(filePath: string, outPath: string, password: string, { onProgress = null, checkCancelled = null }: { onProgress?: Progress; checkCancelled?: Cancel } = {}) {
  const info = await readBackupEnvelope(filePath);
  if (!info) throw new Error('Not an encrypted UniHub backup.');
  const handle = await fs.promises.open(filePath, 'r');
  let head: Buffer, mac: Buffer;
  try {
    head = await readRange(handle, info.dataStart, SALT_LENGTH + VERIFIER_LENGTH);
    mac = await readRange(handle, info.dataStart + SALT_LENGTH + VERIFIER_LENGTH + info.size, MAC_LENGTH);
  } finally {
    await handle.close();
  }
  const keys = await deriveKeys(password, head.subarray(0, SALT_LENGTH));
  if (!crypto.timingSafeEqual(Buffer.from(keys.verifier), head.subarray(SALT_LENGTH))) throw new Error(UNLOCK_FAILED);
  const decrypt = counterMode(keys.aes);
  const hmac = crypto.createHmac('sha1', keys.mac);
  const out = await fs.promises.open(outPath, 'wx', 0o600);
  try {
    let processed = 0;
    if (info.size > 0) {
      const start = info.dataStart + SALT_LENGTH + VERIFIER_LENGTH;
      for await (const chunk of fs.createReadStream(filePath, { start, end: start + info.size - 1 })) {
        if (checkCancelled) await checkCancelled();
        hmac.update(chunk as Buffer);
        await out.write(decrypt(chunk as Buffer));
        processed += (chunk as Buffer).length;
        if (onProgress) await onProgress(processed, info.size);
      }
    }
    if (processed !== info.size || !crypto.timingSafeEqual(hmac.digest().subarray(0, MAC_LENGTH), mac)) throw new Error(UNLOCK_FAILED);
    await out.close();
  } catch (error) {
    await out.close().catch(() => {});
    await fs.promises.rm(outPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** The key of the portable credentials inside an envelope's archive, from its password. */
function envelopeDataKey(password: string, backupUuid: string) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(password, 'utf8'), Buffer.from(`unihub-backup:${backupUuid}`, 'utf8'), 'unihub-portable-credentials', 32));
}

export {
  INNER_NAME as ENVELOPE_INNER_NAME,
  README_NAME as ENVELOPE_README_NAME,
  UNLOCK_FAILED,
  writeBackupEnvelope,
  readBackupEnvelope,
  checkEnvelopePassword,
  openBackupEnvelope,
  envelopeDataKey,
};
export type { EnvelopeInfo };
