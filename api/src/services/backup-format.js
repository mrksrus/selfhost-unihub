const { version: appVersion } = require('../../package.json');
const { readV1 } = require('./backup-formats/v1');
const { readV2 } = require('./backup-formats/v2');

const BACKUP_VERSION = 2;
const ZIP_BACKUP_FORMAT = 'unihub-restorable-backup';
const ZIP_BACKUP_FORMAT_VERSION = 1;
const BACKUP_METADATA_LIMITS = Object.freeze({
  'manifest.json': 16 * 1024 * 1024,
  'checksums.json': 64 * 1024 * 1024,
  'data/backup.json': 512 * 1024 * 1024,
});
const READERS = new Map([[1, readV1], [2, readV2]]);

function getBackupProducer() {
  return { name: 'UniHub', version: appVersion };
}

function versionError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = 'BACKUP_VERSION_UNSUPPORTED';
  return error;
}

function validateBackupVersionFields(backup) {
  const errors = [];
  const warnings = [];
  if (!READERS.has(backup?.version)) {
    errors.push(`Unsupported backup data version: ${String(backup?.version)}. This UniHub version reads versions 1 and 2; a newer backup may need a newer UniHub release.`);
  }
  // Inline legacy JSON has no ZIP-format fields. If either field is supplied,
  // require the complete known pair; never guess how an unknown archive works.
  if (backup?.format !== undefined || backup?.format_version !== undefined) {
    if (backup.format !== ZIP_BACKUP_FORMAT || backup.format_version !== ZIP_BACKUP_FORMAT_VERSION) {
      errors.push('Unsupported backup archive format or version.');
    }
  }
  if (backup?.version === 1 && backup.data
      && ['mail_accounts', 'mail_folders', 'emails'].some(table => Object.hasOwn(backup.data, table))) {
    warnings.push('This older backup does not include provider-folder mappings. Local folders, email account identities and source folder names are retained; existing provider mappings are left unchanged.');
  }
  return { errors, warnings };
}

function validateArchiveVersionFields(manifest, backup) {
  if (manifest?.app !== 'unihub' || backup?.app !== 'unihub') {
    throw versionError('Backup app must be "unihub".');
  }
  if (manifest.format !== ZIP_BACKUP_FORMAT || manifest.format_version !== ZIP_BACKUP_FORMAT_VERSION
      || backup.format !== ZIP_BACKUP_FORMAT || backup.format_version !== ZIP_BACKUP_FORMAT_VERSION) {
    throw versionError('Unsupported backup archive format or version.');
  }
  const { errors } = validateBackupVersionFields(backup);
  if (errors.length) throw versionError(errors[0]);
  if (manifest.version !== backup.version) {
    throw versionError('Backup version metadata is inconsistent between manifest.json and data/backup.json.');
  }
}

function normalizeBackupPayload(backup) {
  const { errors } = validateBackupVersionFields(backup);
  if (errors.length) throw versionError(errors[0]);
  // Rows are cloned because credential preparation rewrites row fields. File
  // bytes stay file-backed; this does not duplicate a whole archive in memory.
  const normalized = {
    ...backup,
    data: Object.fromEntries(Object.entries(backup.data).map(([table, rows]) => [table,
      Array.isArray(rows) ? rows.map(row => ({ ...row })) : rows && typeof rows === 'object' ? { ...rows } : rows,
    ])),
    files: backup.files.map(file => ({ ...file })),
  };
  const result = READERS.get(backup.version)(normalized);
  result.source_backup_version = backup.version;
  result.version = BACKUP_VERSION;
  // The original checksum was verified before migration. It describes the
  // original bytes, so cannot be reused after upgrading the in-memory shape.
  delete result.manifest_sha256;
  return result;
}

module.exports = {
  BACKUP_VERSION, ZIP_BACKUP_FORMAT, ZIP_BACKUP_FORMAT_VERSION, BACKUP_METADATA_LIMITS,
  getBackupProducer, validateBackupVersionFields, validateArchiveVersionFields, normalizeBackupPayload,
};
