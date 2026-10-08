import type { ApiError, ArchiveEnvelope } from '../types';
import packageJson = require('../../package.json');
const { version: appVersion } = packageJson;
import { readV1 } from './backup-formats/v1';
import { readV2 } from './backup-formats/v2';
import { readV3 } from './backup-formats/v3';
import { readV4 } from './backup-formats/v4';
import { RETIRED_TABLES, RETIRED_FILE_KINDS } from './backup-catalog';

const BACKUP_VERSION = 4;
const ZIP_BACKUP_FORMAT = 'unihub-restorable-backup';
const ZIP_BACKUP_FORMAT_VERSION = 1;
const BACKUP_METADATA_LIMITS = Object.freeze({
  'manifest.json': 16 * 1024 * 1024,
  'checksums.json': 64 * 1024 * 1024,
  'data/backup.json': 512 * 1024 * 1024,
});
const READERS = new Map<number, (backup: ArchiveEnvelope) => ArchiveEnvelope>([[1, readV1], [2, readV2], [3, readV3], [4, readV4]]);

function getBackupProducer() {
  return { name: 'UniHub', version: appVersion };
}

function versionError(message: string) {
  const error: ApiError = new Error(message);
  error.status = 400;
  error.code = 'BACKUP_VERSION_UNSUPPORTED';
  return error;
}

function validateBackupVersionFields(backup: Partial<ArchiveEnvelope> | null | undefined) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!READERS.has(backup?.version as number)) {
    errors.push(`Unsupported backup data version: ${String(backup?.version)}. This UniHub version reads versions 1, 2, 3 and 4; a newer backup may need a newer UniHub release.`);
  }
  // Inline legacy JSON has no ZIP-format fields. If either field is supplied,
  // require the complete known pair; never guess how an unknown archive works.
  if (backup?.format !== undefined || backup?.format_version !== undefined) {
    if (backup.format !== ZIP_BACKUP_FORMAT || backup.format_version !== ZIP_BACKUP_FORMAT_VERSION) {
      errors.push('Unsupported backup archive format or version.');
    }
  }
  if (backup?.version === 1 && backup!.data
      && ['mail_accounts', 'mail_folders', 'emails'].some(table => Object.hasOwn(backup!.data!, table))) {
    warnings.push('This older backup does not include provider-folder mappings. Local folders, email account identities and source folder names are retained; existing provider mappings are left unchanged.');
  }
  if ([1, 2].includes(backup?.version as number) && backup!.data
      && ['mail_accounts', 'mail_folders', 'emails'].some(table => Object.hasOwn(backup!.data!, table))) {
    warnings.push('This older backup may lack filing identities, Legacy state and folder recovery history. Missing fields use legacy defaults; provider reconciliation can run on the next successful sync.');
  }
  if ([1, 2, 3].includes(backup?.version as number) && backup!.data?.mail_accounts) warnings.push('This older backup has no durable provider-operation journal. Restored mail stays retained; provider writes remain paused until the account is explicitly reconnected and its identity revalidated.');
  return { errors, warnings };
}

function validateArchiveVersionFields(manifest: Partial<ArchiveEnvelope> | null | undefined, backup: ArchiveEnvelope) {
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

function normalizeBackupPayload(backup: ArchiveEnvelope): ArchiveEnvelope {
  const { errors } = validateBackupVersionFields(backup);
  if (errors.length) throw versionError(errors[0]);
  // Rows are cloned because credential preparation rewrites row fields. File
  // bytes stay file-backed; this does not duplicate a whole archive in memory.
  const normalized: ArchiveEnvelope = {
    ...backup,
    // Tables of removed modules (validation already warned) are never imported.
    data: Object.fromEntries(Object.entries(backup.data).filter(([table]) => !Object.hasOwn(RETIRED_TABLES, table)).map(([table, rows]) => [table,
      Array.isArray(rows) ? rows.map(row => ({ ...row })) : rows && typeof rows === 'object' ? { ...rows } : rows,
    ])),
    files: backup.files.filter(file => !RETIRED_FILE_KINDS.includes(file?.kind as string)).map(file => ({ ...file })),
  };
  let result = READERS.get(backup.version)!(normalized);
  if (backup.version < 3) result = readV3(result, { legacyDefaults: true });
  if (backup.version < 4) result = readV4(result);
  result.source_backup_version = backup.version;
  result.version = BACKUP_VERSION;
  // The original checksum was verified before migration. It describes the
  // original bytes, so cannot be reused after upgrading the in-memory shape.
  delete result.manifest_sha256;
  return result;
}

export {
  BACKUP_VERSION,
  ZIP_BACKUP_FORMAT,
  ZIP_BACKUP_FORMAT_VERSION,
  BACKUP_METADATA_LIMITS,
  getBackupProducer,
  validateBackupVersionFields,
  validateArchiveVersionFields,
  normalizeBackupPayload,
};
