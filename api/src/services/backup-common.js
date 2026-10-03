const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MAIL_RAW_STORAGE_ROOT } = require('./mail');
const { RECORDINGS_ROOT } = require('./recordings');
const { BACKUP_METADATA_LIMITS } = require('./backup-format');
const { SECTION_POLICIES } = require('./backup-catalog');

const ATTACHMENTS_ROOT = '/app/uploads/attachments';

const BACKUP_FILE_ROOTS = Object.freeze({ email_attachment: ATTACHMENTS_ROOT, raw_email: MAIL_RAW_STORAGE_ROOT, recording: RECORDINGS_ROOT });

const BACKUP_CONFLICT_MODES = new Set(['keep_existing', 'replace', 'keep_both']);

const BACKUP_CALENDAR_MODES = new Set(['merge_same_name', 'copy']);

const BACKUP_CREDENTIAL_MODES = new Set(['keep_existing', 'restore']);

const BACKUP_IMPORT_SECTION_TABLES = Object.fromEntries(Object.entries(SECTION_POLICIES).map(([section, policy]) => [section, new Set(policy.tables)]));

const BACKUP_IMPORT_SECTION_FILE_KINDS = Object.fromEntries(Object.entries(SECTION_POLICIES).map(([section, policy]) => [section, new Set(policy.fileKinds)]));

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function sha256File(filePath, checkCancelled = null) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    if (checkCancelled) await checkCancelled();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function isFileRangeSource(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.filePath === 'string'
    && Number.isSafeInteger(value.start)
    && Number.isSafeInteger(value.size)
    && value.start >= 0
    && value.size >= 0
  );
}

function createFileRangeStream(source) {
  if (!isFileRangeSource(source)) {
    throw new Error('Invalid backup file source.');
  }
  if (source.size === 0) return null;
  return fs.createReadStream(source.filePath, {
    start: source.start,
    end: source.start + source.size - 1,
  });
}

async function sha256FileSource(source) {
  if (Buffer.isBuffer(source)) return sha256Buffer(source);
  if (!isFileRangeSource(source)) throw new Error('Invalid backup file source.');
  const hash = crypto.createHash('sha256');
  const stream = createFileRangeStream(source);
  if (!stream) return hash.digest('hex');
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeSerializeDate(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeMysqlDateTime(value, fallback = null) {
  const candidate = value === undefined || value === null || value === '' ? fallback : value;
  if (candidate === undefined || candidate === null || candidate === '') return null;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 19);
    }
  }
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (number) => String(number).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join('-') + ' ' + [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join(':');
}

function normalizeRows(rows) {
  return (rows || []).map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, safeSerializeDate(value)])
  ));
}

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeConflictMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return BACKUP_CONFLICT_MODES.has(normalized) ? normalized : 'keep_existing';
}

function normalizeCalendarMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return BACKUP_CALENDAR_MODES.has(normalized) ? normalized : 'merge_same_name';
}

function normalizeCredentialMode(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return BACKUP_CREDENTIAL_MODES.has(normalized) ? normalized : 'keep_existing';
}

function isPathUnderRoot(filePath, rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedPath = path.resolve(filePath || '');
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
}

function sanitizeArchivePathPart(value) {
  return String(value || 'file')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 160) || 'file';
}

function legacyZipWriterPath(value) {
  return String(value || 'file')
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .map(part => part.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120) || 'item')
    .join('/')
    .slice(0, 220);
}

function getBackupArchivePath(file) {
  const safeId = sanitizeArchivePathPart(file.id || crypto.randomUUID());
  const safeName = sanitizeArchivePathPart(file.filename || safeId);
  if (file.kind === 'raw_email') return `files/mail-raw/${safeId}-${safeName}`;
  if (file.kind === 'email_attachment') return `files/mail-attachments/${safeId}-${safeName}`;
  if (file.kind === 'recording') return `files/recordings/${safeId}-${safeName}`;
  return `files/other/${safeId}-${safeName}`;
}

function getBackupRowCounts(backup) {
  const data = backup?.data || {};
  const counts = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) counts[key] = value.length;
    else if (value && typeof value === 'object') counts[key] = 1;
  }
  return counts;
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertBackupMetadataSize(name, size) {
  const limit = BACKUP_METADATA_LIMITS[name];
  if (!limit || size > limit) {
    const error = new Error(`Backup metadata ${name} exceeds the restore limit; export smaller sections.`);
    error.status = 413;
    throw error;
  }
}

module.exports = {
  ATTACHMENTS_ROOT,
  BACKUP_FILE_ROOTS,
  BACKUP_IMPORT_SECTION_TABLES,
  BACKUP_IMPORT_SECTION_FILE_KINDS,
  sha256Buffer,
  sha256File,
  isFileRangeSource,
  createFileRangeStream,
  sha256FileSource,
  canonicalJson,
  normalizeMysqlDateTime,
  normalizeRows,
  normalizeIdentifier,
  normalizeConflictMode,
  normalizeCalendarMode,
  normalizeCredentialMode,
  isPathUnderRoot,
  sanitizeArchivePathPart,
  legacyZipWriterPath,
  getBackupArchivePath,
  getBackupRowCounts,
  jsonBuffer,
  assertBackupMetadataSize,
};
