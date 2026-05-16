const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('../state');
const { buildBackupArchiveEntriesForUser } = require('./backup');

const BACKUPS_ROOT = '/app/uploads/backups';
const activeExportJobs = new Set();
const EXPORT_SECTIONS = new Set(['contacts', 'calendar', 'todo', 'mail', 'recordings', 'settings']);

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

async function crc32File(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    let crc = 0 ^ -1;
    stream.on('data', chunk => {
      crc = crc32Buffer(chunk, crc);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve((crc ^ -1) >>> 0));
  });
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
    .map(part => part.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'item')
    .join('/')
    .slice(0, 220);
}

function bufferFromUInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function getWritableStream(targetPath) {
  const stream = fs.createWriteStream(targetPath, { flags: 'wx' });
  let offset = 0;
  return {
    offset: () => offset,
    write(buffer) {
      offset += buffer.length;
      return new Promise((resolve, reject) => {
        stream.write(buffer, error => (error ? reject(error) : resolve()));
      });
    },
    pipeFrom(filePath) {
      return new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(filePath);
        readStream.on('data', chunk => { offset += chunk.length; });
        readStream.on('error', reject);
        stream.on('error', reject);
        readStream.on('end', resolve);
        readStream.pipe(stream, { end: false });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        stream.end(error => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function prepareZipEntry(entry) {
  const name = sanitizeZipPath(entry.name);
  const filePath = entry.filePath ? path.resolve(entry.filePath) : null;
  if (filePath) {
    const stat = await fs.promises.stat(filePath);
    return {
      name,
      filePath,
      size: stat.size,
      crc32: await crc32File(filePath),
      modifiedAt: stat.mtime,
    };
  }
  const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8');
  return {
    name,
    data,
    size: data.length,
    crc32: (crc32Buffer(data) ^ -1) >>> 0,
    modifiedAt: entry.modifiedAt || new Date(),
  };
}

async function writeZip(entries, targetPath) {
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const prepared = [];
  for (const entry of entries) {
    prepared.push(await prepareZipEntry(entry));
  }
  const writer = getWritableStream(targetPath);
  const centralDirectory = [];
  try {
    for (const entry of prepared) {
      const filename = Buffer.from(entry.name, 'utf8');
      const { dosTime, dosDate } = dosDateTime(entry.modifiedAt);
      const localOffset = writer.offset();
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
      if (entry.filePath) await writer.pipeFrom(entry.filePath);
      else await writer.write(entry.data);
      centralDirectory.push({ entry, filename, dosTime, dosDate, localOffset });
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

async function collectExportEntries(userId, sections) {
  return buildBackupArchiveEntriesForUser(userId, sections);
}

function serializeJob(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    scope: row.scope,
    status: row.status,
    progress: Number(row.progress) || 0,
    requested_sections: parseRequestedSections(row.requested_sections),
    file_size: row.file_size === null || row.file_size === undefined ? null : Number(row.file_size),
    error: row.error || null,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
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

async function runDataExportJob(jobId) {
  if (activeExportJobs.has(jobId)) return;
  activeExportJobs.add(jobId);
  try {
    const [rows] = await db.execute('SELECT * FROM data_export_jobs WHERE id = ? LIMIT 1', [jobId]);
    const job = rows[0];
    if (!job || job.status === 'ready') return;
    await updateJob(jobId, { status: 'running', progress: 5, error: null });
    const sections = parseRequestedSections(job.requested_sections);
    const entries = await collectExportEntries(job.user_id, sections);
    await updateJob(jobId, { progress: 45 });
    const targetDir = path.join(BACKUPS_ROOT, String(job.user_id));
    const targetPath = path.join(targetDir, `${job.id}.zip`);
    await writeZip(entries, targetPath);
    const stat = await fs.promises.stat(targetPath);
    await updateJob(jobId, {
      status: 'ready',
      progress: 100,
      file_path: targetPath,
      file_size: stat.size,
      completed_at: new Date(),
    });
  } catch (error) {
    console.error('[BACKUP] Job failed:', error);
    await updateJob(jobId, {
      status: 'failed',
      progress: 100,
      error: error.message || 'Backup failed',
    }).catch(() => {});
  } finally {
    activeExportJobs.delete(jobId);
  }
}

async function startDataExportJob(userId, { sections, scope } = {}) {
  const normalizedSections = normalizeSections(sections || scope || 'full');
  const jobId = crypto.randomUUID();
  await db.execute(
    `INSERT INTO data_export_jobs (id, user_id, scope, status, progress, requested_sections)
     VALUES (?, ?, ?, 'queued', 0, ?)`,
    [
      jobId,
      userId,
      normalizedSections.length === EXPORT_SECTIONS.size ? 'full' : 'partial',
      JSON.stringify(normalizedSections),
    ]
  );
  setTimeout(() => {
    runDataExportJob(jobId).catch((error) => console.error('[BACKUP] Job runner crashed:', error));
  }, 20);
  const [rows] = await db.execute('SELECT * FROM data_export_jobs WHERE id = ? AND user_id = ? LIMIT 1', [jobId, userId]);
  return serializeJob(rows[0]);
}

async function resumePendingDataExportJobs() {
  const [rows] = await db.execute(
    `SELECT id FROM data_export_jobs
     WHERE status IN ('queued', 'running')
     ORDER BY created_at ASC
     LIMIT 25`
  );
  for (const row of rows || []) {
    setTimeout(() => {
      runDataExportJob(row.id).catch((error) => console.error('[BACKUP] Resumed job runner crashed:', error));
    }, 20);
  }
  return rows.length;
}

async function listDataExportJobs(userId) {
  const [rows] = await db.execute(
    'SELECT * FROM data_export_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 25',
    [userId]
  );
  return (rows || []).map(serializeJob);
}

async function getDataExportJob(userId, jobId) {
  const [rows] = await db.execute('SELECT * FROM data_export_jobs WHERE id = ? AND user_id = ? LIMIT 1', [jobId, userId]);
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
  if (job.file_path && isBackupPathUnderRoot(job.file_path)) {
    await fs.promises.rm(path.resolve(job.file_path), { force: true }).catch(() => {});
  }
  await db.execute('DELETE FROM data_export_jobs WHERE id = ? AND user_id = ?', [jobId, userId]);
  return { deleted: true };
}

module.exports = {
  BACKUPS_ROOT,
  EXPORT_SECTIONS,
  normalizeSections,
  parseRequestedSections,
  crc32Buffer,
  writeZip,
  startDataExportJob,
  runDataExportJob,
  resumePendingDataExportJobs,
  listDataExportJobs,
  getDataExportJob,
  deleteDataExportJob,
  isBackupPathUnderRoot,
  serializeJob,
};
