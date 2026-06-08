const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../state');
const { buildBackupArchiveEntriesForUser, sha256File } = require('./backup');
const {
  encryptBackupFile,
  generateRecoveryPassword,
  wrapDataKeyForServer,
  protectRecoveryPassword,
} = require('./backup-container');
const { pruneArchiveKeyIfUnreferenced } = require('./backup-archive-keys');

const BACKUPS_ROOT = '/app/uploads/backups';
const activeExportJobs = new Set();
const EXPORT_SECTIONS = new Set(['contacts', 'calendar', 'todo', 'mail', 'recordings', 'settings']);
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

function crc32Buffer(buffer, crc = 0 ^ -1) {
  let next = crc;
  for (let i = 0; i < buffer.length; i += 1) {
    next = (next >>> 8) ^ crcTable[(next ^ buffer[i]) & 0xff];
  }
  return next;
}

async function crc32File(filePath, checkCancelled = null) {
  const stream = fs.createReadStream(filePath);
  let crc = 0 ^ -1;
  for await (const chunk of stream) {
    if (checkCancelled) await checkCancelled();
    crc = crc32Buffer(chunk, crc);
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function sanitizeZipPath(value) {
  return String(value || 'file')
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .map(part => part.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'item')
    .join('/');
}

function bufferFromUInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function getWritableStream(targetPath) {
  const stream = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 });
  let offset = 0;
  return {
    offset: () => offset,
    write(buffer) {
      offset += buffer.length;
      return new Promise((resolve, reject) => {
        stream.write(buffer, error => (error ? reject(error) : resolve()));
      });
    },
    async pipeFrom(filePath, checkCancelled = null) {
      const readStream = fs.createReadStream(filePath);
      for await (const chunk of readStream) {
        if (checkCancelled) await checkCancelled();
        offset += chunk.length;
        await new Promise((resolve, reject) => {
          stream.write(chunk, error => (error ? reject(error) : resolve()));
        });
      }
    },
    close() {
      return new Promise((resolve, reject) => {
        stream.end(error => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function prepareZipEntry(entry, checkCancelled = null) {
  const name = sanitizeZipPath(entry.name);
  const filePath = entry.filePath ? path.resolve(entry.filePath) : null;
  if (filePath) {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) throw new Error(`Backup source is not a regular file: ${name}`);
    if (!Number.isSafeInteger(stat.size) || stat.size > ZIP32_MAX_VALUE) {
      throw new Error(`Backup file ${name} exceeds the ZIP32 per-file size limit.`);
    }
    return {
      name,
      filePath,
      size: stat.size,
      crc32: await crc32File(filePath, checkCancelled),
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

async function writeZip(entries, targetPath, {
  checkCancelled = null,
  onProgress = null,
} = {}) {
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
      if (entry.filePath) await writer.pipeFrom(entry.filePath, checkCancelled);
      else await writer.write(entry.data);
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

function normalizeSections(sections) {
  if (!sections || sections === 'full') return Array.from(EXPORT_SECTIONS);
  const values = Array.isArray(sections) ? sections : String(sections).split(',');
  const normalized = values.map(value => String(value).trim().toLowerCase()).filter(value => EXPORT_SECTIONS.has(value));
  return normalized.length ? Array.from(new Set(normalized)) : Array.from(EXPORT_SECTIONS);
}

function parseRequestedSections(value) {
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

async function collectExportEntries(userId, sections, options = {}) {
  return buildBackupArchiveEntriesForUser(userId, sections, options);
}

function serializeJob(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    scope: row.scope,
    status: row.status,
    phase: row.phase || row.status,
    progress: Number(row.progress) || 0,
    cancel_requested: Boolean(row.cancel_requested),
    requested_sections: parseRequestedSections(row.requested_sections),
    file_size: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    file_sha256: row.file_sha256 || null,
    content_type: row.content_type || null,
    encryption_enabled: Boolean(row.encryption_enabled),
    backup_uuid: row.backup_uuid || null,
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

async function updateJob(jobId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await db.execute(
    `UPDATE data_export_jobs SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?`,
    [...keys.map(key => fields[key]), jobId]
  );
}

async function checkExportCancelled(jobId) {
  const [rows] = await db.execute(
    'SELECT cancel_requested, status FROM data_export_jobs WHERE id = ? LIMIT 1',
    [jobId]
  );
  if (!rows.length || rows[0].cancel_requested || rows[0].status === 'cancelling') {
    throw new BackupJobCancelledError();
  }
}

async function runDataExportJob(jobId) {
  if (activeExportJobs.has(jobId)) return;
  activeExportJobs.add(jobId);
  let entries = [];
  let temporaryZipPath = null;
  let finalPath = null;
  let backupUuid = null;
  try {
    const [rows] = await db.execute('SELECT * FROM data_export_jobs WHERE id = ? LIMIT 1', [jobId]);
    const job = rows[0];
    if (!job || job.status === 'ready' || job.status === 'cancelled') return;
    if (job.cancel_requested) throw new BackupJobCancelledError();
    await updateJob(jobId, {
      status: 'running',
      phase: 'collecting',
      progress: 5,
      error: null,
      started_at: job.started_at || new Date(),
    });
    const sections = parseRequestedSections(job.requested_sections);
    const encrypted = job.encryption_enabled === undefined ? true : Boolean(job.encryption_enabled);
    const dataKey = encrypted ? crypto.randomBytes(32) : null;
    const recoveryPassword = encrypted ? generateRecoveryPassword() : null;
    entries = await collectExportEntries(job.user_id, sections, {
      portableCredentialKey: dataKey,
      checkCancelled: () => checkExportCancelled(jobId),
    });
    await checkExportCancelled(jobId);
    await updateJob(jobId, { phase: 'archiving', progress: 35 });
    const targetDir = path.join(BACKUPS_ROOT, String(job.user_id));
    temporaryZipPath = path.join(targetDir, `${job.id}.zip.partial`);
    finalPath = path.join(targetDir, `${job.id}.${encrypted ? 'unihub-backup' : 'zip'}`);
    await fs.promises.rm(temporaryZipPath, { force: true }).catch(() => {});
    await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    await writeZip(entries, temporaryZipPath, {
      checkCancelled: () => checkExportCancelled(jobId),
      onProgress: async (phase, current, total) => {
        const base = phase === 'prepare' ? 35 : 45;
        const span = phase === 'prepare' ? 10 : 30;
        await updateJob(jobId, {
          progress: Math.min(75, base + Math.round((current / Math.max(total, 1)) * span)),
        });
      },
    });
    await checkExportCancelled(jobId);
    if (encrypted) {
      await updateJob(jobId, { phase: 'encrypting', progress: 76 });
      backupUuid = crypto.randomUUID();
      await encryptBackupFile(temporaryZipPath, finalPath, {
        backupUuid,
        dataKey,
        recoveryPassword,
        checkCancelled: () => checkExportCancelled(jobId),
        onProgress: async (processed, total) => {
          await updateJob(jobId, {
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
          wrapDataKeyForServer(dataKey, backupUuid),
          protectRecoveryPassword(recoveryPassword, backupUuid),
        ]
      );
    } else {
      await fs.promises.rename(temporaryZipPath, finalPath);
      temporaryZipPath = null;
    }
    const stat = await fs.promises.stat(finalPath);
    await updateJob(jobId, {
      status: 'ready',
      phase: 'ready',
      progress: 100,
      file_path: finalPath,
      file_size: stat.size,
      file_sha256: await sha256File(finalPath),
      content_type: encrypted ? 'application/vnd.unihub.backup' : 'application/zip',
      backup_uuid: backupUuid,
      completed_at: new Date(),
    });
  } catch (error) {
    if (temporaryZipPath) await fs.promises.rm(temporaryZipPath, { force: true }).catch(() => {});
    if (finalPath) await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    if (backupUuid) {
      await db.execute(
        'DELETE FROM backup_archive_keys WHERE backup_uuid = ? AND export_job_id = ?',
        [backupUuid, jobId]
      ).catch(() => {});
    }
    if (error instanceof BackupJobCancelledError) {
      await updateJob(jobId, {
        status: 'cancelled',
        phase: 'cancelled',
        progress: 100,
        error: null,
        completed_at: new Date(),
      }).catch(() => {});
      return;
    }
    console.error('[BACKUP] Job failed:', error);
    await updateJob(jobId, {
      status: 'failed',
      phase: 'failed',
      progress: 100,
      error: error.message || 'Backup failed',
      completed_at: new Date(),
    }).catch(() => {});
  } finally {
    await Promise.all(
      entries
        .filter(entry => entry.cleanupAfterWrite && entry.filePath)
        .map(entry => fs.promises.rm(path.resolve(entry.filePath), { force: true }).catch(() => {}))
    );
    activeExportJobs.delete(jobId);
  }
}

async function startDataExportJob(userId, { sections, scope, encrypt = true } = {}) {
  const normalizedSections = normalizeSections(sections || scope || 'full');
  const jobId = crypto.randomUUID();
  await db.execute(
    `INSERT INTO data_export_jobs
       (id, user_id, scope, status, phase, progress, requested_sections, encryption_enabled)
     VALUES (?, ?, ?, 'queued', 'queued', 0, ?, ?)`,
    [
      jobId,
      userId,
      normalizedSections.length === EXPORT_SECTIONS.size ? 'full' : 'partial',
      JSON.stringify(normalizedSections),
      encrypt === false ? 0 : 1,
    ]
  );
  scheduleDataExportWorker();
  const [rows] = await db.execute('SELECT * FROM data_export_jobs WHERE id = ? AND user_id = ? LIMIT 1', [jobId, userId]);
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
      const [rows] = await db.execute(
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
  const [pendingRows] = await db.execute(
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

async function listDataExportJobs(userId) {
  const [rows] = await db.execute(
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

async function getDataExportJob(userId, jobId) {
  const [rows] = await db.execute(
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

function isBackupPathUnderRoot(filePath) {
  const root = path.resolve(BACKUPS_ROOT);
  const resolved = path.resolve(filePath || '');
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

async function deleteDataExportJob(userId, jobId) {
  const job = await getDataExportJob(userId, jobId);
  if (!job) return { error: 'Backup job not found', status: 404 };
  if (['queued', 'running', 'cancelling'].includes(job.status)) {
    return { error: 'Stop the backup before deleting it', status: 409 };
  }
  const [activeRestore] = await db.execute(
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
  if (job.file_path && isBackupPathUnderRoot(job.file_path)) {
    await fs.promises.rm(path.resolve(job.file_path), { force: true }).catch(() => {});
  }
  await db.execute('DELETE FROM data_export_jobs WHERE id = ? AND user_id = ?', [jobId, userId]);
  await pruneArchiveKeyIfUnreferenced(userId, job.backup_uuid);
  return { deleted: true };
}

async function cancelDataExportJob(userId, jobId) {
  const job = await getDataExportJob(userId, jobId);
  if (!job) return { error: 'Backup job not found', status: 404 };
  if (!['queued', 'running', 'cancelling'].includes(job.status)) {
    return { error: 'Backup job is not running', status: 409 };
  }
  if (job.status === 'queued') {
    await updateJob(jobId, {
      cancel_requested: 1,
      status: 'cancelled',
      phase: 'cancelled',
      progress: 100,
      completed_at: new Date(),
    });
  } else {
    await updateJob(jobId, {
      cancel_requested: 1,
      status: 'cancelling',
      phase: 'cancelling',
    });
  }
  return { job: serializeJob(await getDataExportJob(userId, jobId)) };
}

module.exports = {
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
  serializeJob,
};
