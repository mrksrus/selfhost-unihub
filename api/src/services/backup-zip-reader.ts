import type { FileHandle } from 'node:fs/promises';
import type { ArchiveEnvelope, FileRangeSource } from '../types';

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { ZIP_BACKUP_FORMAT, BACKUP_METADATA_LIMITS, validateArchiveVersionFields } from './backup-format';
import {
  sha256Buffer,
  isFileRangeSource,
  createFileRangeStream,
  legacyZipWriterPath,
  assertBackupMetadataSize,
} from './backup-common';

interface Checksums { algorithm?: string; entries?: Record<string, string> }

function findEndOfCentralDirectory(buffer: Buffer) {
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntries(buffer: Buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('Backup file is not a valid ZIP archive.');
  }
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error('Backup file is not a valid ZIP archive.');
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, Buffer>();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Backup ZIP central directory is invalid.');
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    offset += 46 + fileNameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    if (compressionMethod !== 0) {
      throw new Error(`Unsupported ZIP compression for ${name}. UniHub backups must use stored entries.`);
    }
    if (compressedSize !== uncompressedSize) {
      throw new Error(`Invalid ZIP size metadata for ${name}.`);
    }
    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header for ${name}.`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) {
      throw new Error(`ZIP entry ${name} exceeds archive bounds.`);
    }
    entries.set(name, buffer.subarray(dataStart, dataEnd));
  }
  return entries;
}

function parseJsonZipEntry<T>(entries: ReadonlyMap<string, Buffer>, name: string): T | null {
  const buffer = entries.get(name);
  if (!buffer) return null;
  assertBackupMetadataSize(name, buffer.length);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`Backup ZIP contains invalid JSON at ${name}.`);
  }
}

function requireSchema3MetadataChecksum(backup: ArchiveEnvelope, checksums: Checksums | null) {
  if (backup.version < 3) return;
  if (checksums?.algorithm !== 'sha256'
    || typeof checksums?.entries?.['data/backup.json'] !== 'string'
    || !/^[a-f0-9]{64}$/.test(checksums.entries['data/backup.json'])) {
    throw new Error('Schema 3 backup requires valid SHA-256 metadata in checksums.json.');
  }
}

function backupFromZipBuffer(buffer: Buffer) {
  const entries = readZipEntries(buffer);
  const manifest = parseJsonZipEntry<ArchiveEnvelope>(entries, 'manifest.json');
  const checksums = parseJsonZipEntry<Checksums>(entries, 'checksums.json');
  const backup = parseJsonZipEntry<ArchiveEnvelope>(entries, 'data/backup.json');
  if (!manifest || !backup) {
    throw new Error('This ZIP is not a restorable UniHub backup. Create a new backup with the Backup buttons.');
  }
  if (manifest.app !== 'unihub' || backup.app !== 'unihub') {
    throw new Error('Backup app must be "unihub".');
  }
  if (manifest.format !== ZIP_BACKUP_FORMAT || backup.format !== ZIP_BACKUP_FORMAT) {
    throw new Error('This ZIP is not a restorable UniHub backup.');
  }
  validateArchiveVersionFields(manifest, backup);
  requireSchema3MetadataChecksum(backup, checksums);
  if (checksums?.entries?.['data/backup.json']) {
    const actualDataHash = sha256Buffer(entries.get('data/backup.json')!);
    if (actualDataHash !== checksums.entries['data/backup.json']) {
      throw new Error('Checksum mismatch for data/backup.json.');
    }
  }

  const fileBuffersByPath = new Map<string, Buffer>();
  for (const file of backup.files || []) {
    if (!file.archive_path) continue;
    let fileBuffer = entries.get(file.archive_path);
    if (!fileBuffer) {
      const legacyPath = legacyZipWriterPath(file.archive_path);
      if (legacyPath !== file.archive_path) {
        fileBuffer = entries.get(legacyPath);
      }
    }
    if (!fileBuffer) {
      throw new Error(`Backup file is missing ${file.archive_path}.`);
    }
    if (checksums?.entries?.[file.archive_path] && sha256Buffer(fileBuffer) !== checksums.entries[file.archive_path]) {
      throw new Error(`Checksum mismatch for ${file.archive_path}.`);
    }
    fileBuffersByPath.set(file.archive_path, fileBuffer);
  }
  return { backup, manifest, checksums, fileBuffersByPath };
}

async function readFileRange(fileHandle: FileHandle, start: number, size: number) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await fileHandle.read(buffer, offset, size - offset, start + offset);
    if (bytesRead === 0) throw new Error('Backup ZIP ended unexpectedly.');
    offset += bytesRead;
  }
  return buffer;
}

function isSafeZipEntryName(name: string) {
  if (!name || name.startsWith('/') || name.includes('\\')) return false;
  return name.split('/').every(part => part && part !== '.' && part !== '..');
}

async function readZipFileEntries(filePath: string) {
  const resolvedPath = path.resolve(filePath);
  const stat = await fs.promises.stat(resolvedPath);
  if (!stat.isFile() || stat.size < 22) {
    throw new Error('Backup file is not a valid ZIP archive.');
  }

  const fileHandle = await fs.promises.open(resolvedPath, 'r');
  try {
    const tailSize = Math.min(stat.size, 65557);
    const tailStart = stat.size - tailSize;
    const tail = await readFileRange(fileHandle, tailStart, tailSize);
    const relativeEocdOffset = findEndOfCentralDirectory(tail);
    if (relativeEocdOffset < 0) {
      throw new Error('Backup file is not a valid ZIP archive.');
    }

    const entryCount = tail.readUInt16LE(relativeEocdOffset + 10);
    const centralDirectorySize = tail.readUInt32LE(relativeEocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(relativeEocdOffset + 16);
    if (
      entryCount === 0xffff
      || centralDirectorySize === 0xffffffff
      || centralDirectoryOffset === 0xffffffff
    ) {
      throw new Error('ZIP64 backups are not supported by this UniHub backup version.');
    }
    if (
      centralDirectoryOffset + centralDirectorySize > stat.size
      || centralDirectoryOffset + centralDirectorySize > tailStart + relativeEocdOffset
    ) {
      throw new Error('Backup ZIP central directory is invalid.');
    }

    const centralDirectory = await readFileRange(
      fileHandle,
      centralDirectoryOffset,
      centralDirectorySize
    );
    const entries = new Map<string, FileRangeSource>();
    let offset = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (
        offset + 46 > centralDirectory.length
        || centralDirectory.readUInt32LE(offset) !== 0x02014b50
      ) {
        throw new Error('Backup ZIP central directory is invalid.');
      }
      const flags = centralDirectory.readUInt16LE(offset + 8);
      const compressionMethod = centralDirectory.readUInt16LE(offset + 10);
      const compressedSize = centralDirectory.readUInt32LE(offset + 20);
      const uncompressedSize = centralDirectory.readUInt32LE(offset + 24);
      const fileNameLength = centralDirectory.readUInt16LE(offset + 28);
      const extraLength = centralDirectory.readUInt16LE(offset + 30);
      const commentLength = centralDirectory.readUInt16LE(offset + 32);
      const localHeaderOffset = centralDirectory.readUInt32LE(offset + 42);
      const entryEnd = offset + 46 + fileNameLength + extraLength + commentLength;
      if (entryEnd > centralDirectory.length) {
        throw new Error('Backup ZIP central directory is invalid.');
      }
      const name = centralDirectory
        .subarray(offset + 46, offset + 46 + fileNameLength)
        .toString('utf8');
      offset = entryEnd;

      if (name.endsWith('/')) continue;
      if (!isSafeZipEntryName(name)) {
        throw new Error(`Backup ZIP contains an unsafe entry path: ${name || '(empty)'}.`);
      }
      if ((flags & 0x0001) !== 0) {
        throw new Error(`Encrypted ZIP entry ${name} is not supported.`);
      }
      if (compressionMethod !== 0) {
        throw new Error(`Unsupported ZIP compression for ${name}. UniHub backups must use stored entries.`);
      }
      if (compressedSize !== uncompressedSize) {
        throw new Error(`Invalid ZIP size metadata for ${name}.`);
      }
      if (entries.has(name)) {
        throw new Error(`Backup ZIP contains duplicate entry ${name}.`);
      }

      const localHeader = await readFileRange(fileHandle, localHeaderOffset, 30);
      if (localHeader.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local header for ${name}.`);
      }
      const localNameLength = localHeader.readUInt16LE(26);
      const localExtraLength = localHeader.readUInt16LE(28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      if (dataStart + compressedSize > centralDirectoryOffset) {
        throw new Error(`ZIP entry ${name} exceeds archive bounds.`);
      }
      entries.set(name, {
        filePath: resolvedPath,
        start: dataStart,
        size: compressedSize,
      });
    }
    if (offset !== centralDirectory.length) {
      throw new Error('Backup ZIP central directory is invalid.');
    }
    return entries;
  } finally {
    await fileHandle.close();
  }
}

async function readZipTextEntry(source: FileRangeSource | null | undefined, name: string, maxSize: number) {
  if (!source) return null;
  if (!isFileRangeSource(source) || source.size > maxSize) {
    throw new Error(`Backup ZIP entry ${name} is too large.`);
  }

  const decoder = new StringDecoder('utf8');
  const hash = crypto.createHash('sha256');
  let text = '';
  const stream = createFileRangeStream(source);
  if (stream) {
    await new Promise<void>((resolve, reject) => {
      stream.on('data', chunk => {
        hash.update(chunk as crypto.BinaryLike);
        text += decoder.write(chunk as Buffer);
      });
      stream.on('error', reject);
      stream.on('end', resolve);
    });
  }
  text += decoder.end();
  return { text, sha256: hash.digest('hex') };
}

async function parseJsonZipFileEntry<T>(entries: ReadonlyMap<string, FileRangeSource>, name: string, maxSize: number): Promise<{ value: T; sha256: string } | null> {
  const source = entries.get(name);
  if (!source) return null;
  const result = await readZipTextEntry(source, name, maxSize);
  try {
    return {
      value: JSON.parse(result!.text),
      sha256: result!.sha256,
    };
  } catch {
    throw new Error(`Backup ZIP contains invalid JSON at ${name}.`);
  }
}

async function backupFromZipFile(filePath: string) {
  const entries = await readZipFileEntries(filePath);
  const manifestEntry = await parseJsonZipFileEntry<ArchiveEnvelope>(entries, 'manifest.json', BACKUP_METADATA_LIMITS['manifest.json']);
  const checksumsEntry = await parseJsonZipFileEntry<Checksums>(entries, 'checksums.json', BACKUP_METADATA_LIMITS['checksums.json']);
  const backupEntry = await parseJsonZipFileEntry<ArchiveEnvelope>(entries, 'data/backup.json', BACKUP_METADATA_LIMITS['data/backup.json']);
  const manifest = manifestEntry?.value || null;
  const checksums = checksumsEntry?.value || null;
  const backup = backupEntry?.value || null;
  if (!manifest || !backup) {
    throw new Error('This ZIP is not a restorable UniHub backup. Create a new backup with the Backup buttons.');
  }
  if (manifest.app !== 'unihub' || backup.app !== 'unihub') {
    throw new Error('Backup app must be "unihub".');
  }
  if (manifest.format !== ZIP_BACKUP_FORMAT || backup.format !== ZIP_BACKUP_FORMAT) {
    throw new Error('This ZIP is not a restorable UniHub backup.');
  }
  validateArchiveVersionFields(manifest, backup);
  requireSchema3MetadataChecksum(backup, checksums);
  if (
    checksums?.entries?.['data/backup.json']
    && backupEntry!.sha256 !== checksums.entries['data/backup.json']
  ) {
    throw new Error('Checksum mismatch for data/backup.json.');
  }

  const fileSourcesByPath = new Map<string, FileRangeSource>();
  for (const file of backup.files || []) {
    if (!file.archive_path) continue;
    let source = entries.get(file.archive_path);
    if (!source) {
      const legacyPath = legacyZipWriterPath(file.archive_path);
      if (legacyPath !== file.archive_path) {
        source = entries.get(legacyPath);
      }
    }
    if (!source) {
      throw new Error(`Backup file is missing ${file.archive_path}.`);
    }
    if (
      checksums?.entries?.[file.archive_path]
      && checksums.entries[file.archive_path] !== file.sha256
    ) {
      throw new Error(`Checksum metadata mismatch for ${file.archive_path}.`);
    }
    if (
      file.size_bytes !== null
      && file.size_bytes !== undefined
      && Number(file.size_bytes) !== source.size
    ) {
      throw new Error(`Size mismatch for ${file.archive_path}.`);
    }
    fileSourcesByPath.set(file.archive_path, source);
  }
  return { backup, manifest, checksums, fileSourcesByPath };
}

export {
  readZipEntries,
  backupFromZipBuffer,
  readZipFileEntries,
  backupFromZipFile,
};
