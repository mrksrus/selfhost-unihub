import type { ResultSetHeader, RowDataPacket, ExecuteValues } from 'mysql2/promise';
import type { ApiError, SqlExecutor, StoredFlag } from '../types';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { BACKUP_UPLOAD_MAX_SIZE } from '../config';
import { db } from '../state';
import { buildBackupArchiveEntriesForUser, sha256File } from './backup';
import {
  generateRecoveryPassword,
  wrapEnvelopePasswordForServer,
  protectRecoveryPassword,
} from './backup-container';
import { envelopeDataKey, writeBackupEnvelope } from './backup-envelope';
import { portableZipPath } from './backup-readable';
import { ARCHIVE_LAYOUTS, ZIP_BACKUP_FORMAT_VERSION } from './backup-format';
import { controlPool } from './side-pools';
import { pruneArchiveKeyIfUnreferenced } from './backup-archive-keys';
import { resolvePolicy } from './settings';
import { conflict, notFound } from '../http/errors';
import { fileRemovalGate } from './file-removal-gate';
import { withTransaction } from './transactions';
import type { BackupContents } from '../contracts/backup';

type CheckCancelled = (() => Promise<unknown>) | null;
interface ZipEntry {
  name: string;
  filePath?: string;
  data?: Buffer | string;
  modifiedAt?: Date;
  cleanupAfterWrite?: boolean;
  expectedSize?: number;
  expectedSha256?: string;
}
interface PreparedEntry {
  name: string;
  filePath?: string;
  data?: Buffer;
  modifiedAt: Date;
  size: number;
  crc32: number;
  sha256?: string;
}
// encrypt is no option any more (0.28): every new backup is encrypted, also
// when an older client asks for one without.
interface ExportOptions { sections?: unknown; scope?: unknown; includeDownloadMail?: boolean; mailAccountId?: string | null }
interface ExportRow extends RowDataPacket {
  id: string;
  user_id: string;
  scope: string;
  status: string;
  phase?: string;
  progress?: number;
  cancel_requested?: StoredFlag;
  requested_sections?: unknown;
  mail_account_id?: string | null;
  file_path?: string | null;
  file_size?: number | null;
  file_sha256?: string | null;
  content_type?: string | null;
  encryption_enabled?: StoredFlag;
  include_download_mail?: StoredFlag;
  keep_until?: Date | string | null;
  contents?: unknown;
  backup_uuid?: string | null;
  recovery_password_available?: StoredFlag;
  recovery_password_revealed?: StoredFlag;
  server_unlock_available?: StoredFlag;
  error?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at?: Date | string | null;
  completed_at?: Date | string | null;
  downloaded_at?: Date | string | null;
}

const BACKUPS_ROOT = process.env.BACKUP_ARCHIVES_ROOT || '/app/uploads/backups';
const activeExportJobs = new Set();
const { SECTION_POLICIES, normalizeBackupRequest } = require('./backup-catalog') as typeof import('./backup-catalog');
const EXPORT_SECTIONS = new Set(Object.keys(SECTION_POLICIES));
const ZIP32_MAX_VALUE = 0xffffffff;
const ZIP32_MAX_ENTRIES = 0xfffe;
const ZIP32_MAX_FILENAME_BYTES = 0xffff;
let exportWorkerRunning = false;
let exportWorkerScheduled = false;
let exportWorkerNeedsRun = false;

class BackupJobCancelledError extends Error {
  constructor() {
    super('Backup cancelled');
    this.name = 'BackupJobCancelledError';
  }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Buffer(buffer: Buffer, crc = 0 ^ -1) {
  let next = crc;
  for (let i = 0; i < buffer.length; i += 1) {
    next = (next >>> 8) ^ crcTable[(next ^ buffer[i]) & 0xff];
  }
  return next;
}

async function inspectZipSource(filePath: string, checkCancelled: CheckCancelled = null) {
  const stream = fs.createReadStream(filePath);
  const hash = crypto.createHash('sha256');
  let size = 0;
  let crc = 0 ^ -1;
  for await (const chunk of stream) {
    if (checkCancelled) await checkCancelled();
    size += chunk.length;
    hash.update(chunk);
    crc = crc32Buffer(chunk, crc);
  }
  return { crc32: (crc ^ -1) >>> 0, sha256: hash.digest('hex'), size };
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function bufferFromUInt32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function getWritableStream(targetPath: string) {
  const stream = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
  let offset = 0;
  let streamError: Error | undefined;
  // The write callback rejects the operation; the event listener prevents a
  // disk error from becoming an unhandled event that terminates the API.
  stream.on('error', error => { streamError = error; });
  return {
    offset: () => offset,
    write(buffer: Buffer) {
      if (streamError) return Promise.reject(streamError);
      offset += buffer.length;
      return new Promise<void>((resolve, reject) => {
        stream.write(buffer, error => (error ? reject(error) : resolve()));
      });
    },
    async pipeFrom(entry: PreparedEntry & { filePath: string }, checkCancelled: CheckCancelled = null) {
      const { filePath } = entry;
      const readStream = fs.createReadStream(filePath);
      const hash = crypto.createHash('sha256');
      let size = 0;
      for await (const chunk of readStream) {
        if (checkCancelled) await checkCancelled();
        if (streamError) throw streamError;
        size += chunk.length;
        if (size > entry.size) throw new Error(`Backup source changed while archiving: ${entry.name}. Please retry the backup.`);
        hash.update(chunk);
        offset += chunk.length;
        await new Promise<void>((resolve, reject) => {
          stream.write(chunk, error => (error ? reject(error) : resolve()));
        });
      }
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) {
        throw new Error(`Backup source changed while archiving: ${entry.name}. Please retry the backup.`);
      }
    },
    close() {
      if (streamError) return Promise.reject(streamError);
      return new Promise<void>((resolve, reject) => {
        stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function prepareZipEntry(entry: ZipEntry, checkCancelled: CheckCancelled = null): Promise<PreparedEntry> {
  const name = portableZipPath(entry.name);
  const filePath = entry.filePath ? path.resolve(entry.filePath!) : null;
  if (filePath) {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error(`Backup source is not a regular file: ${name}`);
    if (!Number.isSafeInteger(stat.size) || stat.size > ZIP32_MAX_VALUE) {
      throw new Error(`Backup file ${name} exceeds the ZIP32 per-file size limit.`);
    }
    const integrity = await inspectZipSource(filePath, checkCancelled);
    if (integrity.size !== stat.size
        || (entry.expectedSize !== undefined && entry.expectedSize !== integrity.size)
        || (entry.expectedSha256 !== undefined && entry.expectedSha256 !== integrity.sha256)) {
      throw new Error(`Backup source changed after collection: ${name}. Please retry the backup.`);
    }
    return {
      name,
      filePath,
      size: stat.size,
      crc32: integrity.crc32,
      sha256: integrity.sha256,
      modifiedAt: stat.mtime,
    };
  }
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
  if (data.length > ZIP32_MAX_VALUE) {
    throw new Error(`Backup entry ${name} exceeds the ZIP32 per-file size limit.`);
  }
  return {
    name,
    data,
    size: data.length,
    crc32: (crc32Buffer(data) ^ -1) >>> 0,
    modifiedAt: entry.modifiedAt || new Date(),
  };
}

async function writeZip(entries: ZipEntry[], targetPath: string, {
  checkCancelled = null,
  onProgress = null,
}: { checkCancelled?: CheckCancelled; onProgress?: ((phase: string, current: number, total: number) => Promise<unknown>) | null } = {}) {
  if (entries.length > ZIP32_MAX_ENTRIES) {
    throw new Error(`Backup contains ${entries.length} entries, exceeding the ZIP32 entry limit.`);
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const prepared = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (checkCancelled) await checkCancelled();
    const entry = entries[index];
    prepared.push(await prepareZipEntry(entry, checkCancelled));
    if (onProgress) await onProgress('prepare', index + 1, entries.length);
  }
  const writer = getWritableStream(targetPath);
  const centralDirectory = [];
  try {
    for (let index = 0; index < prepared.length; index += 1) {
      if (checkCancelled) await checkCancelled();
      const entry = prepared[index];
      const filename = Buffer.from(entry.name, 'utf8');
      if (filename.length > ZIP32_MAX_FILENAME_BYTES) {
        throw new Error(`Backup entry name ${entry.name} exceeds the ZIP32 filename limit.`);
      }
      const { dosTime, dosDate } = dosDateTime(entry.modifiedAt);
      const localOffset = writer.offset();
      if (localOffset > ZIP32_MAX_VALUE) {
        throw new Error('Backup exceeds the ZIP32 archive offset limit.');
      }
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(dosTime, 10);
      local.writeUInt16LE(dosDate, 12);
      local.writeUInt32LE(entry.crc32, 14);
      local.writeUInt32LE(entry.size, 18);
      local.writeUInt32LE(entry.size, 22);
      local.writeUInt16LE(filename.length, 26);
      local.writeUInt16LE(0, 28);
      await writer.write(local);
      await writer.write(filename);
      if (entry.filePath) await writer.pipeFrom(entry as PreparedEntry & { filePath: string }, checkCancelled);
      else await writer.write(entry.data!);
      if (writer.offset() > ZIP32_MAX_VALUE) {
        throw new Error('Backup exceeds the ZIP32 archive size limit.');
      }
      centralDirectory.push({ entry, filename, dosTime, dosDate, localOffset });
      if (onProgress) await onProgress('write', index + 1, prepared.length);
    }

    const centralStart = writer.offset();
    for (const item of centralDirectory) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(item.dosTime, 12);
      central.writeUInt16LE(item.dosDate, 14);
      central.writeUInt32LE(item.entry.crc32, 16);
      central.writeUInt32LE(item.entry.size, 20);
      central.writeUInt32LE(item.entry.size, 24);
      central.writeUInt16LE(item.filename.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(item.localOffset, 42);
      await writer.write(central);
      await writer.write(item.filename);
    }
    const centralSize = writer.offset() - centralStart;
    if (
      centralStart > ZIP32_MAX_VALUE
      || centralSize > ZIP32_MAX_VALUE
      || writer.offset() + 22 > ZIP32_MAX_VALUE
    ) {
      throw new Error('Backup exceeds the ZIP32 archive size or central-directory limit.');
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(centralDirectory.length, 8);
    end.writeUInt16LE(centralDirectory.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    await writer.write(end);
    await writer.close();
  } catch (error) {
    await writer.close().catch(() => {});
    await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
}

// Stored as requested: complete sections plus "accounts" for account settings.
const normalizeSections = (value: unknown) => normalizeBackupRequest(value).requested;

function parseRequestedSections(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeSections(value);
  if (Buffer.isBuffer(value)) return parseRequestedSections(value.toString('utf8'));
  if (value === null || value === undefined || value === '') return normalizeSections('full');
  if (typeof value !== 'string') return normalizeSections(value);

  const trimmed = value.trim();
  if (!trimmed) return normalizeSections('full');
  try {
    return normalizeSections(JSON.parse(trimmed));
  } catch (_error) {
    return normalizeSections(trimmed);
  }
}

async function collectExportEntries(userId: string, sections: unknown, options: Parameters<typeof buildBackupArchiveEntriesForUser>[2] = {}) {
  return buildBackupArchiveEntriesForUser(userId, sections, options);
}

// What a finished archive holds (schema 7 on); null before 0.28 or while it is made.
function parseContents(value: unknown): BackupContents | null {
  if (value == null) return null;
  try {
    const contents = (typeof value === 'string' ? JSON.parse(value) : value) as BackupContents;
    return contents && Array.isArray(contents.included) && Array.isArray(contents.left_out) && Array.isArray(contents.notes) ? contents : null;
  } catch { return null; }
}

function manifestContents(entries: readonly ZipEntry[]) {
  const manifest = entries.find(entry => entry.name === ARCHIVE_LAYOUTS[ZIP_BACKUP_FORMAT_VERSION].manifest);
  if (!manifest?.data) return null;
  return parseContents((JSON.parse(String(manifest.data)) as { contents?: unknown }).contents);
}

function serializeJob(row: ExportRow) {
  return {
    id: row.id,
    user_id: row.user_id,
    scope: row.scope,
    status: row.status,
    phase: row.phase || row.status,
    progress: Number(row.progress) || 0,
    cancel_requested: Boolean(row.cancel_requested),
    requested_sections: parseRequestedSections(row.requested_sections),
    mail_account_id: row.mail_account_id || null,
    file_size: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    file_sha256: row.file_sha256 || null,
    content_type: row.content_type || null,
    encryption_enabled: Boolean(row.encryption_enabled),
    backup_uuid: row.backup_uuid || null,
    keep_until: row.keep_until instanceof Date ? row.keep_until.toISOString() : (row.keep_until || null),
    contents: parseContents(row.contents),
    recovery_password_available: Boolean(row.recovery_password_available),
    recovery_password_revealed: Boolean(row.recovery_password_revealed),
    server_unlock_available: Boolean(row.server_unlock_available),
    error: row.error || null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    started_at: row.started_at instanceof Date ? row.started_at.toISOString() : (row.started_at || null),
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : (row.completed_at || null),
    downloaded_at: row.downloaded_at instanceof Date ? row.downloaded_at.toISOString() : (row.downloaded_at || null),
  };
}

async function updateJob(jobId: string, fields: Record<string, ExecuteValues>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.execute(
    `UPDATE data_export_jobs SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`,
    [...keys.map(key => fields[key]), jobId]
  );
}

async function checkExportCancelled(jobId: string, executor: SqlExecutor = db) {
  const [rows] = await executor.execute<ExportRow[]>(
    'SELECT cancel_requested, status FROM data_export_jobs WHERE id = ? LIMIT 1',
    [jobId]
  );
  if (!rows.length || rows[0].cancel_requested || rows[0].status === 'cancelling') {
    throw new BackupJobCancelledError();
  }
}

/**
 * Removes a job's archive once no ready job names it: after the rows are
 * committed, through the file removal gate, so an instance backup that is
 * copying files (and whose dump may name the archive) keeps it until its
 * copy ends; a removal queued for that time checks the rows again.
 */
async function removeUnpublishedArchive(file: string) {
  const remove = async () => {
    const [named] = await db.execute<RowDataPacket[]>(
      "SELECT id FROM data_export_jobs WHERE file_path = ? AND status = 'ready' LIMIT 1", [file]);
    if (!named.length) await fs.promises.rm(file, { force: true });
  };
  await fileRemovalGate.run(remove).catch(error => console.error('[BACKUP] Could not remove an unpublished archive:', error));
}

/**
 * Settles a job whose run failed or was cancelled, in one transaction on the
 * job's row. The locking read waits for a ready update still in flight (its
 * answer lost, its row lock held), so it sees that update once committed:
 * a ready row keeps its archive and key. Only a row still running is marked
 * failed or cancelled, and its key removed, in the same transaction. When
 * that cannot be settled now (the database is unreachable, the lock wait
 * ends), everything stays, the row too: the next start
 * (resumePendingDataExportJobs) queues the job again, and its run returns at
 * once if the row is ready or writes the archive afresh.
 */
async function settleFailedJob(jobId: string, backupUuid: string | null, fields: Record<string, ExecuteValues>): Promise<'ready' | 'settled' | 'unknown'> {
  try {
    return await withTransaction(async connection => {
      const [rows] = await connection.execute<ExportRow[]>('SELECT status FROM data_export_jobs WHERE id = ? FOR UPDATE', [jobId]);
      if (rows[0]?.status === 'ready') return 'ready' as const;
      if (rows.length) {
        const keys = Object.keys(fields);
        const [updated] = await connection.execute<ResultSetHeader>(
          `UPDATE data_export_jobs SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ? AND status IN ('running', 'cancelling')`,
          [...keys.map(key => fields[key]), jobId]);
        // Another state than this run's (not ours to settle): nothing changes.
        if (updated.affectedRows !== 1) return 'unknown' as const;
      }
      if (backupUuid) await connection.execute('DELETE FROM backup_archive_keys WHERE backup_uuid = ? AND export_job_id = ?', [backupUuid, jobId]);
      return 'settled' as const;
    });
  } catch (error) {
    console.error('[BACKUP] Could not record how an export job ended:', error);
    return 'unknown';
  }
}

async function runDataExportJob(jobId: string) {
  if (activeExportJobs.has(jobId)) return;
  activeExportJobs.add(jobId);
  let entries: ZipEntry[] = [];
  let temporaryZipPath = null;
  let finalPath = null;
  let backupUuid = null;
  try {
    const [rows] = await db.execute<ExportRow[]>('SELECT * FROM data_export_jobs WHERE id = ? LIMIT 1', [jobId]);
    const job = rows[0];
    if (!job || job.status === 'ready' || job.status === 'cancelled') return;
    if (job.cancel_requested) throw new BackupJobCancelledError();
    await updateJob(jobId!, {
      status: 'running',
      phase: 'collecting',
      progress: 5,
      error: null,
      started_at: job.started_at || new Date(),
    });
    const sections = parseRequestedSections(job.requested_sections);
    // A job an older release queued without encryption is encrypted as well.
    if (!job.encryption_enabled) await updateJob(jobId!, { encryption_enabled: 1 });
    // The archive is an encrypted ZIP (backup-envelope.ts) that opens with
    // the recovery password; the portable credentials inside are encrypted
    // with a key derived from the same password and the backup's UUID.
    backupUuid = crypto.randomUUID();
    const recoveryPassword = generateRecoveryPassword();
    const targetDir = path.join(BACKUPS_ROOT, String(job.user_id));
    entries = await collectExportEntries(job.user_id, sections, {
      mailAccountId: job.mail_account_id || null,
      includeDownloadMail: job.include_download_mail === undefined ? true : Boolean(job.include_download_mail),
      workDirectory: targetDir,
      portableCredentialKey: envelopeDataKey(recoveryPassword, backupUuid),
      backupUuid,
      // Runs while the snapshot read holds its connection, on which it would
      // not see a later cancellation: the control pool (side-pools.ts).
      checkCancelled: () => checkExportCancelled(jobId, controlPool()),
    });
    await checkExportCancelled(jobId);
    await updateJob(jobId!, { phase: 'archiving', progress: 35 });
    const contents = manifestContents(entries);
    temporaryZipPath = path.join(targetDir, `${job.id}.zip.partial`);
    finalPath = path.join(targetDir, `${job.id}.zip`);
    // Left by an earlier attempt of this job, which is not ready (checked
    // above): no committed row names either file, so no gate is needed.
    await fs.promises.rm(temporaryZipPath, { force: true }).catch(() => {});
    await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    await writeZip(entries, temporaryZipPath, {
      checkCancelled: () => checkExportCancelled(jobId),
      onProgress: async (phase, current, total) => {
        const base = phase === 'prepare' ? 35 : 45;
        const span = phase === 'prepare' ? 10 : 30;
        await updateJob(jobId!, {
          progress: Math.min(75, base + Math.round((current / Math.max(total, 1)) * span)),
        });
      },
    });
    await checkExportCancelled(jobId);
    {
      await updateJob(jobId!, { phase: 'encrypting', progress: 76 });
      await writeBackupEnvelope(temporaryZipPath, finalPath, {
        backupUuid,
        password: recoveryPassword,
        checkCancelled: () => checkExportCancelled(jobId),
        onProgress: async (processed, total) => {
          await updateJob(jobId!, {
            progress: 76 + Math.round((processed / Math.max(total, 1)) * 19),
          });
        },
      });
      await fs.promises.rm(temporaryZipPath, { force: true });
      temporaryZipPath = null;
      await db.execute(
        `INSERT INTO backup_archive_keys
           (backup_uuid, user_id, export_job_id, server_wrapped_key, recovery_password_ciphertext)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           user_id = VALUES(user_id),
           export_job_id = VALUES(export_job_id),
           server_wrapped_key = VALUES(server_wrapped_key),
           recovery_password_ciphertext = VALUES(recovery_password_ciphertext),
           recovery_password_revealed_at = NULL,
           expires_at = NULL`,
        [
          backupUuid,
          job.user_id,
          job.id,
          wrapEnvelopePasswordForServer(recoveryPassword, backupUuid),
          protectRecoveryPassword(recoveryPassword, backupUuid),
        ]
      );
    }
    const stat = await fs.promises.stat(finalPath);
    if (stat.size > BACKUP_UPLOAD_MAX_SIZE) {
      throw new Error('Backup exceeds the import upload limit. Export smaller sections so the downloaded archive can be restored.');
    }
    await updateJob(jobId!, {
      status: 'ready',
      phase: 'ready',
      progress: 100,
      file_path: finalPath,
      file_size: stat.size,
      file_sha256: await sha256File(finalPath),
      content_type: 'application/zip',
      backup_uuid: backupUuid,
      contents: contents ? JSON.stringify(contents) : null,
      completed_at: new Date(),
    });
  } catch (error) {
    // A .partial file no row names and the instance backup leaves out.
    if (temporaryZipPath) await fs.promises.rm(temporaryZipPath, { force: true }).catch(() => {});
    const cancelled = error instanceof BackupJobCancelledError;
    if (!cancelled) console.error('[BACKUP] Job failed:', error);
    const outcome = await settleFailedJob(jobId, backupUuid, cancelled
      ? { status: 'cancelled', phase: 'cancelled', progress: 100, error: null, completed_at: new Date() }
      : { status: 'failed', phase: 'failed', progress: 100, error: (error as ApiError).message || 'Backup failed', completed_at: new Date() });
    // Ready after all, or not settled: the archive and its key stay.
    if (outcome !== 'settled') return;
    // The rows first, then the archive.
    if (finalPath) await removeUnpublishedArchive(finalPath);
  } finally {
    await Promise.all(
      entries
        .filter(entry => entry.cleanupAfterWrite && entry.filePath)
        .map(entry => fs.promises.rm(path.resolve(entry.filePath!), { force: true }).catch(() => {}))
    );
    activeExportJobs.delete(jobId);
  }
}

// mailAccountId limits a mail-only export to one owned account (the backup
// offered before switching that account to Sync).
async function startDataExportJob(userId: string, { sections, scope, includeDownloadMail = true, mailAccountId = null }: ExportOptions = {}) {
  const normalizedSections = normalizeSections(sections || scope || 'full');
  if (mailAccountId !== null) {
    if (normalizedSections.length !== 1 || normalizedSections[0] !== 'mail') {
      throw Object.assign(new Error('An account backup contains only mail.'), { status: 400, code: 'BACKUP_SECTION_UNSUPPORTED' });
    }
    const [owned] = await db.execute<ExportRow[]>('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? LIMIT 1', [mailAccountId, userId]);
    if (!owned.length) throw Object.assign(new Error('Mail account not found'), { status: 404 });
  }
  const jobId = crypto.randomUUID();
  // The server keeps the backup at least until this date when a policy says
  // so (backup.server_retention_days, D36); nothing removes it then. NULL:
  // no minimum.
  const retentionDays = (await resolvePolicy(userId, 'backup.server_retention_days')).value;
  await db.execute(
    `INSERT INTO data_export_jobs
       (id, user_id, scope, status, phase, progress, requested_sections, encryption_enabled, include_download_mail, mail_account_id, keep_until)
     VALUES (?, ?, ?, 'queued', 'queued', 0, ?, TRUE, ?, ?, ${retentionDays === null ? 'NULL' : 'UTC_TIMESTAMP() + INTERVAL ? DAY'})`,
    [
      jobId,
      userId,
      [...EXPORT_SECTIONS].every(section => normalizedSections.includes(section)) && mailAccountId === null ? 'full' : 'partial',
      JSON.stringify(normalizedSections),
      includeDownloadMail ? 1 : 0,
      mailAccountId,
      ...(retentionDays === null ? [] : [retentionDays]),
    ]
  );
  scheduleDataExportWorker();
  const [rows] = await db.execute<ExportRow[]>('SELECT * FROM data_export_jobs WHERE id = ? AND user_id = ? LIMIT 1', [jobId, userId]);
  return serializeJob(rows[0]);
}

async function pumpDataExportJobs(runJob = runDataExportJob) {
  if (exportWorkerRunning) {
    exportWorkerNeedsRun = true;
    return;
  }
  exportWorkerRunning = true;
  try {
    while (true) {
      const [rows] = await db.execute<ExportRow[]>(
        `SELECT id FROM data_export_jobs
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`
      );
      if (!rows.length) break;
      await runJob(rows[0].id);
    }
  } finally {
    exportWorkerRunning = false;
    if (exportWorkerNeedsRun) {
      exportWorkerNeedsRun = false;
      scheduleDataExportWorker();
    }
  }
}

function scheduleDataExportWorker() {
  exportWorkerNeedsRun = true;
  if (exportWorkerRunning || exportWorkerScheduled) return;
  exportWorkerScheduled = true;
  setTimeout(() => {
    exportWorkerScheduled = false;
    exportWorkerNeedsRun = false;
    pumpDataExportJobs().catch((error) => console.error('[BACKUP] Export worker crashed:', error));
  }, 20);
}

async function resumePendingDataExportJobs({ schedule = true } = {}) {
  const [pendingRows] = await db.execute<ExportRow[]>(
    `SELECT COUNT(*) AS pending_jobs
     FROM data_export_jobs
     WHERE status IN ('queued', 'running', 'cancelling')`
  );
  await db.execute(
    `DELETE archive_keys
     FROM backup_archive_keys archive_keys
     INNER JOIN data_export_jobs jobs ON jobs.id = archive_keys.export_job_id
     WHERE jobs.status IN ('running', 'cancelling')`
  );
  await db.execute(
    `UPDATE data_export_jobs
     SET status = 'cancelled',
         phase = 'cancelled',
         progress = 100,
         error = NULL,
         completed_at = UTC_TIMESTAMP()
     WHERE status IN ('queued', 'running', 'cancelling')
       AND (cancel_requested = TRUE OR status = 'cancelling')`
  );
  await db.execute(
    `UPDATE data_export_jobs
     SET status = 'queued',
         phase = 'queued',
         progress = 0,
         error = NULL,
         cancel_requested = FALSE,
         completed_at = NULL
     WHERE status = 'running'`
  );
  if (schedule) scheduleDataExportWorker();
  return Number(pendingRows[0]?.pending_jobs) || 0;
}

async function listDataExportJobs(userId: string) {
  const [rows] = await db.execute<ExportRow[]>(
    `SELECT jobs.*,
            (archive_keys.recovery_password_ciphertext IS NOT NULL) AS recovery_password_available,
            (archive_keys.recovery_password_revealed_at IS NOT NULL) AS recovery_password_revealed,
            (archive_keys.server_wrapped_key IS NOT NULL) AS server_unlock_available
     FROM data_export_jobs jobs
     LEFT JOIN backup_archive_keys archive_keys ON archive_keys.export_job_id = jobs.id
     WHERE jobs.user_id = ?
     ORDER BY jobs.created_at DESC
     LIMIT 25`,
    [userId]
  );
  return (rows || []).map(serializeJob);
}

async function getDataExportJob(userId: string, jobId: string | null) {
  const [rows] = await db.execute<ExportRow[]>(
    `SELECT jobs.*,
            (archive_keys.recovery_password_ciphertext IS NOT NULL) AS recovery_password_available,
            (archive_keys.recovery_password_revealed_at IS NOT NULL) AS recovery_password_revealed,
            (archive_keys.server_wrapped_key IS NOT NULL) AS server_unlock_available
     FROM data_export_jobs jobs
     LEFT JOIN backup_archive_keys archive_keys ON archive_keys.export_job_id = jobs.id
     WHERE jobs.id = ? AND jobs.user_id = ?
     LIMIT 1`,
    [jobId, userId]
  );
  return rows[0] || null;
}

function isBackupPathUnderRoot(filePath: string | null | undefined) {
  const root = path.resolve(BACKUPS_ROOT);
  const resolved = path.resolve(filePath || '');
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

/**
 * The user's ready archive to send: the browser download and the
 * backup-archive ticket (file-tickets.ts) share these checks. An archive is
 * sent only after its recovery password was revealed, since without it the
 * file cannot be opened.
 */
async function backupArchiveFile(userId: string, jobId: string) {
  const job = await getDataExportJob(userId, jobId);
  if (!job) throw notFound('BACKUP_NOT_FOUND', 'Backup job not found');
  if (job.status !== 'ready' || !job.file_path) throw conflict('BACKUP_NOT_READY', 'Backup is not ready');
  if (job.encryption_enabled) {
    if (job.recovery_password_available) throw conflict('BACKUP_PASSWORD_UNSEEN', 'Reveal and save the recovery password before the first download');
    if (!job.recovery_password_revealed) {
      throw conflict('BACKUP_PASSWORD_MISSING', 'Recovery password metadata is missing. Create a new encrypted backup before downloading.');
    }
  }
  if (!isBackupPathUnderRoot(job.file_path)) throw new Error('Backup path is outside the backup storage');
  const filePath = path.resolve(job.file_path);
  const stat = await fs.promises.stat(filePath);
  // An encrypted ZIP since 0.28; the container of 0.27 keeps its extension.
  const container = filePath.endsWith('.unihub-backup');
  const extension = container ? 'unihub-backup' : 'zip';
  return {
    path: filePath,
    size: stat.size,
    contentType: job.content_type || (container ? 'application/vnd.unihub.backup' : 'application/zip'),
    filename: `unihub-backup-${new Date().toISOString().slice(0, 10)}-${jobId}.${extension}`,
  };
}

async function markBackupDownloaded(userId: string, jobId: string) {
  await db.execute('UPDATE data_export_jobs SET downloaded_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?', [jobId, userId]);
}

async function deleteDataExportJob(userId: string, jobId: string | null) {
  const job = await getDataExportJob(userId, jobId);
  if (!job) return { error: 'Backup job not found', status: 404 };
  if (['queued', 'running', 'cancelling'].includes(job.status)) {
    return { error: 'Stop the backup before deleting it', status: 409 };
  }
  const [activeRestore] = await db.execute<ExportRow[]>(
    `SELECT id FROM backup_restore_jobs
     WHERE source_export_job_id = ? AND user_id = ?
       AND status IN ('uploaded', 'validating', 'validated', 'queued', 'running', 'cancelling')
     LIMIT 1`,
    [jobId, userId]
  );
  if (activeRestore.length) {
    return { error: 'This backup is currently used by a restore job', status: 409 };
  }
  await db.execute(
    `UPDATE backup_restore_jobs
     SET source_export_job_id = NULL, archive_path = NULL
     WHERE source_export_job_id = ? AND user_id = ?`,
    [jobId, userId]
  );
  await db.execute('DELETE FROM data_export_jobs WHERE id = ? AND user_id = ?', [jobId, userId]);
  await pruneArchiveKeyIfUnreferenced(userId, job.backup_uuid);
  // The row first; the file then, after an instance backup's copy when one
  // runs (file-removal-gate.ts). Its name is the job's own, so nothing can
  // name it again.
  if (job.file_path && isBackupPathUnderRoot(job.file_path)) {
    const file = path.resolve(job.file_path);
    await fileRemovalGate.run(() => fs.promises.rm(file, { force: true }).catch(() => {}));
  }
  return { deleted: true };
}

async function cancelDataExportJob(userId: string, jobId: string | null) {
  const job = await getDataExportJob(userId, jobId);
  if (!job) return { error: 'Backup job not found', status: 404 };
  if (!['queued', 'running', 'cancelling'].includes(job.status)) {
    return { error: 'Backup job is not running', status: 409 };
  }
  if (job.status === 'queued') {
    await updateJob(jobId!, {
      cancel_requested: 1,
      status: 'cancelled',
      phase: 'cancelled',
      progress: 100,
      completed_at: new Date(),
    });
  } else {
    await updateJob(jobId!, {
      cancel_requested: 1,
      status: 'cancelling',
      phase: 'cancelling',
    });
  }
  return { job: serializeJob((await getDataExportJob(userId, jobId))!) };
}

export {
  BACKUPS_ROOT,
  EXPORT_SECTIONS,
  normalizeSections,
  parseRequestedSections,
  crc32Buffer,
  writeZip,
  ZIP32_MAX_VALUE,
  ZIP32_MAX_ENTRIES,
  ZIP32_MAX_FILENAME_BYTES,
  startDataExportJob,
  runDataExportJob,
  pumpDataExportJobs,
  scheduleDataExportWorker,
  resumePendingDataExportJobs,
  listDataExportJobs,
  getDataExportJob,
  deleteDataExportJob,
  cancelDataExportJob,
  isBackupPathUnderRoot,
  backupArchiveFile,
  markBackupDownloaded,
  serializeJob,
};
