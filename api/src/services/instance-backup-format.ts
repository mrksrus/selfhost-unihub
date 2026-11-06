import crypto from 'node:crypto';
import fs from 'node:fs';

// The file format of the instance backup (instance-backup.ts writes it,
// instance-restore.ts reads it). One stream, nothing staged on disk:
//
//   "UNIHUBIB1" | u32 header length | header JSON
//   frames: u32 (ciphertext length | FINAL bit) | ciphertext | 16-byte GCM tag
//
// Each file has its own AES-256-GCM key, derived with HKDF from the instance
// key and a random salt in the header; the key's fingerprint in the header is
// its version (F10). A frame's nonce and additional data carry its index, the
// header's hash and whether it is the last frame, so frames cannot be
// reordered, a header cannot be swapped and a cut-off file is refused.
//
// The plaintext is a POSIX tar (ustar, PAX records for long names), in order:
//   db/000001.sql ...       mariadb-dump's output, in parts of PART_BYTES
//   files/<root>/<path>     the stored files, with index/000001.ndjson ...
//                           parts after them: one line per file with its
//                           size and SHA-256
//   manifest.json           versions, counts and the hashes of all the above
// Decrypted with the restore command's verification, it is an ordinary tar.

const MAGIC = Buffer.from('UNIHUBIB1', 'ascii');
const FORMAT = 'unihub-instance-backup';
const FORMAT_VERSION = 1;
const CHUNK_BYTES = 1024 * 1024;
const PART_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const FINAL = 0x80000000;
const TAG_BYTES = 16;
const BLOCK = 512;
const MAX_NAME_BYTES = 4096;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const HKDF_INFO = 'unihub instance backup v1';

interface InstanceBackupHeader {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  backup_id: string;
  created_at: string;
  app_version: string;
  migration_id: number;
  key_fingerprint: string;
  salt: string;
  nonce_prefix: string;
  chunk_size: number;
}

interface InstanceBackupManifest {
  format: 'unihub-instance-backup-manifest';
  version: 1;
  backup_id: string;
  created_at: string;
  app_version: string;
  migration_id: number;
  database: { name: string; parts: number; bytes: number; sha256: string; tables: Record<string, number> };
  files: { roots: string[]; count: number; bytes: number; changed: number; index_parts: number; index_sha256: string };
  left_out: string[];
}

interface IndexLine { r: string; p: string; s: number; h: string; c?: 1 }

class InstanceBackupFormatError extends Error {}

/** The key's version: 16 hex digits of a hash of it, safe to show. */
function keyFingerprint(key: Buffer) {
  return crypto.createHash('sha256').update('unihub instance backup key fingerprint v1\0').update(key).digest('hex').slice(0, 16);
}

function fileKey(key: Buffer, salt: Buffer) {
  return Buffer.from(crypto.hkdfSync('sha256', key, salt, HKDF_INFO, 32));
}

function frameNonce(prefix: Buffer, index: number) {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0, 0, 8);
  nonce.writeUInt32BE(index, 8);
  return nonce;
}

function frameAad(headerHash: Buffer, index: number, final: boolean) {
  const aad = Buffer.alloc(headerHash.length + 5);
  headerHash.copy(aad);
  aad.writeUInt32BE(index, headerHash.length);
  aad[headerHash.length + 4] = final ? 1 : 0;
  return aad;
}

// ── Encrypted container ──────────────────────────────────────────────

/** Writes the container to an open file: write() buffers into frames, end() seals the last one. */
class EncryptedWriter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private index = 0;
  private ended = false;
  private readonly hash = crypto.createHash('sha256');
  bytes = 0;

  private constructor(private readonly handle: fs.promises.FileHandle, private readonly key: Buffer,
    private readonly noncePrefix: Buffer, private readonly headerHash: Buffer) {}

  static async create(handle: fs.promises.FileHandle, instanceKey: Buffer, fields: Omit<InstanceBackupHeader, 'format' | 'version' | 'key_fingerprint' | 'salt' | 'nonce_prefix' | 'chunk_size'>) {
    const salt = crypto.randomBytes(32), noncePrefix = crypto.randomBytes(8);
    const header: InstanceBackupHeader = { format: FORMAT, version: FORMAT_VERSION, ...fields, key_fingerprint: keyFingerprint(instanceKey),
      salt: salt.toString('base64'), nonce_prefix: noncePrefix.toString('base64'), chunk_size: CHUNK_BYTES };
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    const writer = new EncryptedWriter(handle, fileKey(instanceKey, salt), noncePrefix, crypto.createHash('sha256').update(headerBytes).digest());
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.length);
    await writer.raw(Buffer.concat([MAGIC, length, headerBytes]));
    return { writer, header };
  }

  private async raw(buffer: Buffer) {
    this.hash.update(buffer);
    this.bytes += buffer.length;
    let offset = 0;
    while (offset < buffer.length) offset += (await this.handle.write(buffer, offset)).bytesWritten;
  }

  private async seal(plaintext: Buffer, final: boolean) {
    if (this.index >= 0x7fffffff) throw new InstanceBackupFormatError('The backup has too many frames.');
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, frameNonce(this.noncePrefix, this.index));
    cipher.setAAD(frameAad(this.headerHash, this.index, final));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE((ciphertext.length | (final ? FINAL : 0)) >>> 0);
    await this.raw(Buffer.concat([length, ciphertext, cipher.getAuthTag()]));
    this.index++;
  }

  async write(buffer: Buffer) {
    if (this.ended) throw new Error('The backup was already sealed.');
    if (!buffer.length) return;
    this.pending.push(buffer);
    this.pendingBytes += buffer.length;
    if (this.pendingBytes < CHUNK_BYTES) return;
    let joined = Buffer.concat(this.pending, this.pendingBytes);
    while (joined.length >= CHUNK_BYTES) {
      await this.seal(joined.subarray(0, CHUNK_BYTES), false);
      joined = joined.subarray(CHUNK_BYTES);
    }
    this.pending = joined.length ? [Buffer.from(joined)] : [];
    this.pendingBytes = joined.length;
  }

  /** Seals the last frame; answers the file's size and SHA-256. */
  async end() {
    this.ended = true;
    await this.seal(Buffer.concat(this.pending, this.pendingBytes), true);
    this.pending = [];
    return { bytes: this.bytes, sha256: this.hash.digest('hex') };
  }
}

function parseHeader(bytes: Buffer): InstanceBackupHeader {
  let header: InstanceBackupHeader;
  try { header = JSON.parse(bytes.toString('utf8')); } catch { throw new InstanceBackupFormatError('The backup header is damaged.'); }
  if (header?.format !== FORMAT || header.version !== FORMAT_VERSION) throw new InstanceBackupFormatError('This file is not an instance backup this version can read.');
  if (typeof header.backup_id !== 'string' || typeof header.key_fingerprint !== 'string' || typeof header.salt !== 'string'
    || Buffer.from(header.nonce_prefix || '', 'base64').length !== 8 || header.chunk_size !== CHUNK_BYTES
    || typeof header.app_version !== 'string' || !Number.isSafeInteger(header.migration_id)) {
    throw new InstanceBackupFormatError('The backup header is damaged.');
  }
  return header;
}

/** Reads the header only (no key needed): which key and version made the file. */
async function readInstanceBackupHeader(filePath: string) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    return (await readHeaderFrom(handle)).header;
  } finally { await handle.close(); }
}

async function readExactly(handle: fs.promises.FileHandle, length: number, position: number) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (!bytesRead) throw new InstanceBackupFormatError('The backup file is cut off.');
    read += bytesRead;
  }
  return buffer;
}

async function readHeaderFrom(handle: fs.promises.FileHandle) {
  const prefix = await readExactly(handle, MAGIC.length + 4, 0).catch(() => { throw new InstanceBackupFormatError('This file is not an instance backup.'); });
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new InstanceBackupFormatError('This file is not an instance backup.');
  const length = prefix.readUInt32BE(MAGIC.length);
  if (!length || length > MAX_HEADER_BYTES) throw new InstanceBackupFormatError('The backup header is damaged.');
  const headerBytes = await readExactly(handle, length, prefix.length);
  return { header: parseHeader(headerBytes), headerBytes, offset: prefix.length + length, prefix };
}

/**
 * Opens a backup for reading with the instance key: the header, then the
 * plaintext in frames. A wrong key, a changed byte, frames out of order, a
 * missing last frame or bytes after it end the reading with an error.
 */
async function openEncrypted(filePath: string, instanceKey: Buffer, signal?: AbortSignal) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { header, headerBytes, offset, prefix } = await readHeaderFrom(handle);
    if (header.key_fingerprint !== keyFingerprint(instanceKey)) {
      throw new InstanceBackupFormatError(`This backup was made with another key (fingerprint ${header.key_fingerprint}; this key is ${keyFingerprint(instanceKey)}).`);
    }
    const hash = crypto.createHash('sha256').update(prefix).update(headerBytes);
    const key = fileKey(instanceKey, Buffer.from(header.salt, 'base64'));
    const noncePrefix = Buffer.from(header.nonce_prefix, 'base64');
    const headerHash = crypto.createHash('sha256').update(headerBytes).digest();
    const state = { sha256: '' };
    async function* frames(): AsyncGenerator<Buffer> {
      try {
        let position = offset, index = 0;
        const { size } = await handle.stat();
        for (;;) {
          // A stopped run or its deadline ends the reading at the next frame.
          signal?.throwIfAborted();
          const lengthBytes = await readExactly(handle, 4, position);
          const lengthField = lengthBytes.readUInt32BE(0);
          const final = (lengthField & FINAL) !== 0;
          const length = (lengthField & ~FINAL) >>> 0;
          if (length > CHUNK_BYTES + TAG_BYTES) throw new InstanceBackupFormatError('The backup is damaged.');
          const body = await readExactly(handle, length + TAG_BYTES, position + 4);
          hash.update(lengthBytes).update(body);
          position += 4 + length + TAG_BYTES;
          const decipher = crypto.createDecipheriv('aes-256-gcm', key, frameNonce(noncePrefix, index));
          decipher.setAAD(frameAad(headerHash, index, final));
          decipher.setAuthTag(body.subarray(length));
          let plaintext: Buffer;
          try {
            plaintext = Buffer.concat([decipher.update(body.subarray(0, length)), decipher.final()]);
          } catch {
            throw new InstanceBackupFormatError('The backup is damaged or was changed (a frame failed its check).');
          }
          index++;
          if (plaintext.length) yield plaintext;
          if (final) {
            if (position !== size) throw new InstanceBackupFormatError('The backup has unexpected data after its end.');
            state.sha256 = hash.digest('hex');
            return;
          }
        }
      } finally { await handle.close(); }
    }
    return { header, frames: frames(), state, close: () => handle.close().catch(() => {}) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

// ── Tar ──────────────────────────────────────────────────────────────

function octal(value: number, width: number) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return `${length}${body}`;
}

function headerBlock(name: string, size: number, type: '0' | 'x') {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(0o640, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(0, 12), 136, 'ascii');
  block.fill(' ', 148, 156);
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + ' ', 148, 'ascii');
  return block;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Writes tar entries to sink; an entry's size is known before its data. */
class TarWriter {
  constructor(private readonly sink: (buffer: Buffer) => Promise<void>) {}

  async begin(name: string, size: number) {
    const records: string[] = [];
    // ustar names are ASCII; anything else goes in a PAX record.
    const plain = Buffer.byteLength(name) <= 100 && /^[\x20-\x7e]+$/.test(name);
    if (!plain) records.push(paxRecord('path', name));
    if (size >= 8 ** 11) records.push(paxRecord('size', String(size)));
    if (records.length) {
      const pax = Buffer.from(records.join(''), 'utf8');
      await this.sink(Buffer.concat([headerBlock('PaxHeader', pax.length, 'x'), pax, padding(pax.length)]));
    }
    await this.sink(headerBlock(plain ? name : 'long-name', size >= 8 ** 11 ? 0 : size, '0'));
  }

  async data(buffer: Buffer) { await this.sink(buffer); }

  async close(size: number) { const pad = padding(size); if (pad.length) await this.sink(pad); }

  async add(name: string, buffer: Buffer) {
    await this.begin(name, buffer.length);
    await this.data(buffer);
    await this.close(buffer.length);
  }

  async finish() { await this.sink(Buffer.alloc(BLOCK * 2)); }
}

/** Pulls exact byte counts out of the decrypted frames. */
class ByteReader {
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(length: number) {
    while (this.bufferedBytes < length) {
      const next = await this.source.next();
      if (next.done) return false;
      this.buffered.push(next.value);
      this.bufferedBytes += next.value.length;
    }
    return true;
  }

  async read(length: number, limit = length): Promise<Buffer> {
    const want = Math.min(length, limit);
    if (!await this.fill(want)) throw new InstanceBackupFormatError('The backup ends in the middle of an entry.');
    const joined = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered, this.bufferedBytes);
    const out = joined.subarray(0, want);
    const rest = joined.subarray(want);
    this.buffered = rest.length ? [rest] : [];
    this.bufferedBytes = rest.length;
    return out;
  }

  async atEnd() { return !await this.fill(1); }
}

function parseOctal(field: Buffer) {
  const text = field.toString('ascii').replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]+$/.test(text)) throw new InstanceBackupFormatError('The backup has a damaged entry.');
  return parseInt(text, 8);
}

function checkHeader(block: Buffer) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  if (parseOctal(block.subarray(148, 156)) !== sum || block.toString('ascii', 257, 263) !== 'ustar\0') {
    throw new InstanceBackupFormatError('The backup has a damaged entry.');
  }
}

function cString(field: Buffer) {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

interface TarEntry { name: string; size: number }

/** Reads the next entry's header; null at the end of the archive. */
async function nextEntry(reader: ByteReader): Promise<TarEntry | null> {
  let pax: Record<string, string> = {};
  for (;;) {
    const block = await reader.read(BLOCK);
    if (block.every(byte => byte === 0)) {
      if (!(await reader.read(BLOCK)).every(byte => byte === 0)) throw new InstanceBackupFormatError('The backup has a damaged end.');
      if (!await reader.atEnd()) throw new InstanceBackupFormatError('The backup has data after its end.');
      return null;
    }
    checkHeader(block);
    const type = String.fromCharCode(block[156]);
    let size = parseOctal(block.subarray(124, 136));
    if (block[345] !== 0) throw new InstanceBackupFormatError('The backup has an entry this version does not write.');
    if (type === 'x') {
      if (size > MAX_NAME_BYTES * 2) throw new InstanceBackupFormatError('The backup has a damaged entry.');
      const text = (await reader.read(size)).toString('utf8');
      await reader.read(padding(size).length);
      pax = {};
      for (let rest = text; rest;) {
        const space = rest.indexOf(' ');
        const length = Number(rest.slice(0, space));
        if (space < 1 || !Number.isSafeInteger(length) || length <= space || length > rest.length) throw new InstanceBackupFormatError('The backup has a damaged entry.');
        const record = rest.slice(space + 1, length - 1);
        const equals = record.indexOf('=');
        pax[record.slice(0, equals)] = record.slice(equals + 1);
        rest = rest.slice(length);
      }
      continue;
    }
    if (type !== '0') throw new InstanceBackupFormatError('The backup has an entry this version does not write.');
    if (pax.size !== undefined) {
      if (!/^\d+$/.test(pax.size)) throw new InstanceBackupFormatError('The backup has a damaged entry.');
      size = Number(pax.size);
    }
    const name = pax.path ?? cString(block.subarray(0, 100));
    if (!name || Buffer.byteLength(name) > MAX_NAME_BYTES || !Number.isSafeInteger(size)) throw new InstanceBackupFormatError('The backup has a damaged entry.');
    return { name, size };
  }
}

/** Calls onData with the entry's bytes in pieces, then skips its padding. */
async function readBody(reader: ByteReader, size: number, onData: (buffer: Buffer) => Promise<void> | void, signal?: AbortSignal) {
  for (let left = size; left > 0;) {
    signal?.throwIfAborted();
    const piece = await reader.read(left, CHUNK_BYTES);
    left -= piece.length;
    await onData(piece);
  }
  const pad = padding(size).length;
  if (pad) await reader.read(pad);
}

// ── Reading a whole backup ───────────────────────────────────────────

const PART_NAME = /^(db|index)\/(\d{6})\.(sql|ndjson)$/;

function splitFileName(name: string, roots: ReadonlySet<string>) {
  const segments = name.split('/');
  if (segments[0] !== 'files' || segments.length < 3 || !roots.has(segments[1])) return null;
  const rest = segments.slice(2);
  // No empty, dot or dot-dot segment, no NUL or backslash.
  if (rest.some(segment => !segment || segment === '.' || segment === '..' || /[\0\\]/.test(segment))) return null;
  return { root: segments[1], path: rest.join('/') };
}

interface ScanHandlers {
  /** The SQL dump in order, piece by piece. */
  onDatabase?: (buffer: Buffer) => Promise<void> | void;
  /** Called when the dump has ended (before the first file). */
  onDatabaseEnd?: () => Promise<void> | void;
  /** A stored file: answer a sink for its bytes, or null to skip it. */
  onFile?: (file: { root: string; path: string; size: number }) => Promise<FileSink | null> | FileSink | null;
  /** Files copied while they changed; restore skips them. */
  skip?: ReadonlySet<string>;
  /** Ends the reading (with the signal's reason) at the next frame. */
  signal?: AbortSignal;
}
interface FileSink { write(buffer: Buffer): Promise<void> | void; end(): Promise<void> | void }

/**
 * Reads a backup from start to end and checks everything: the frames, the
 * tar, each part's and file's hash against the index and the manifest.
 * Handlers receive the content as it is read; a failure throws after they
 * saw part of it, so a caller that writes must be able to undo.
 */
async function scanInstanceBackup(filePath: string, instanceKey: Buffer, roots: readonly string[], handlers: ScanHandlers = {}) {
  handlers.signal?.throwIfAborted();
  const opened = await openEncrypted(filePath, instanceKey, handlers.signal);
  const reader = new ByteReader(opened.frames[Symbol.asyncIterator]());
  const rootSet = new Set(roots);
  const dbHash = crypto.createHash('sha256'), indexHash = crypto.createHash('sha256');
  let dbParts = 0, dbBytes = 0, indexParts = 0, fileCount = 0, fileBytes = 0, stage: 'db' | 'files' | 'end' = 'db';
  let pending: { root: string; path: string; size: number; sha256: string }[] = [];
  const changed = new Set<string>();
  let manifest: InstanceBackupManifest | null = null;
  try {
    const endDatabase = async () => { if (stage === 'db') { stage = 'files'; await handlers.onDatabaseEnd?.(); } };
    for (let entry = await nextEntry(reader); entry; entry = await nextEntry(reader)) {
      handlers.signal?.throwIfAborted();
      if (stage === 'end') throw new InstanceBackupFormatError('The backup has entries after its manifest.');
      const part = PART_NAME.exec(entry.name);
      if (part && part[1] === 'db') {
        if (stage !== 'db' || Number(part[2]) !== dbParts + 1 || part[3] !== 'sql' || entry.size > PART_BYTES) throw new InstanceBackupFormatError('The backup has its database parts out of order.');
        dbParts++;
        await readBody(reader, entry.size, async piece => { dbHash.update(piece); dbBytes += piece.length; await handlers.onDatabase?.(piece); }, handlers.signal);
        continue;
      }
      await endDatabase();
      if (part && part[1] === 'index') {
        if (Number(part[2]) !== indexParts + 1 || part[3] !== 'ndjson' || entry.size > PART_BYTES) throw new InstanceBackupFormatError('The backup has its index out of order.');
        indexParts++;
        const chunks: Buffer[] = [];
        await readBody(reader, entry.size, piece => { chunks.push(piece); indexHash.update(piece); }, handlers.signal);
        const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter(Boolean);
        for (const text of lines) {
          const line = JSON.parse(text) as IndexLine;
          const file = pending.shift();
          if (!file || line.r !== file.root || line.p !== file.path || line.s !== file.size || line.h !== file.sha256) {
            throw new InstanceBackupFormatError('A file in the backup does not match its index.');
          }
          if (line.c) changed.add(`${line.r}/${line.p}`);
        }
        continue;
      }
      if (entry.name === 'manifest.json') {
        if (entry.size > MAX_MANIFEST_BYTES) throw new InstanceBackupFormatError('The backup manifest is damaged.');
        const chunks: Buffer[] = [];
        await readBody(reader, entry.size, piece => { chunks.push(piece); }, handlers.signal);
        manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as InstanceBackupManifest;
        stage = 'end';
        continue;
      }
      const file = splitFileName(entry.name, rootSet);
      if (!file) throw new InstanceBackupFormatError('The backup has an entry with a name this version does not write.');
      const key = `${file.root}/${file.path}`;
      const sink = handlers.skip?.has(key) ? null : await handlers.onFile?.({ ...file, size: entry.size }) ?? null;
      const hash = crypto.createHash('sha256');
      await readBody(reader, entry.size, async piece => { hash.update(piece); await sink?.write(piece); }, handlers.signal);
      await sink?.end();
      fileCount++;
      fileBytes += entry.size;
      pending.push({ ...file, size: entry.size, sha256: hash.digest('hex') });
    }
    if (!manifest || manifest.format !== 'unihub-instance-backup-manifest' || manifest.version !== 1) throw new InstanceBackupFormatError('The backup has no manifest.');
    const header = opened.header;
    const db = manifest.database, files = manifest.files;
    if (manifest.backup_id !== header.backup_id || manifest.app_version !== header.app_version || manifest.migration_id !== header.migration_id
      || db?.parts !== dbParts || db.bytes !== dbBytes || db.sha256 !== dbHash.digest('hex')
      || files?.count !== fileCount || files.bytes !== fileBytes || files.index_parts !== indexParts || files.index_sha256 !== indexHash.digest('hex')
      || files.changed !== changed.size || pending.length) {
      throw new InstanceBackupFormatError('The backup does not match its manifest.');
    }
    if (!dbParts) throw new InstanceBackupFormatError('The backup holds no database.');
    pending = [];
    return { header, manifest, changed, sha256: opened.state.sha256 };
  } catch (error) {
    await opened.close();
    if (error instanceof SyntaxError) throw new InstanceBackupFormatError('The backup index or manifest is damaged.');
    throw error;
  }
}

export {
  MAGIC as INSTANCE_BACKUP_MAGIC,
  PART_BYTES as INSTANCE_BACKUP_PART_BYTES,
  CHUNK_BYTES as INSTANCE_BACKUP_CHUNK_BYTES,
  EncryptedWriter,
  TarWriter,
  InstanceBackupFormatError,
  keyFingerprint,
  readInstanceBackupHeader,
  scanInstanceBackup,
};
export type { InstanceBackupHeader, InstanceBackupManifest, IndexLine, FileSink };
