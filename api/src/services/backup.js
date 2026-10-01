// Facade for backup export, validation and restore. The code lives in the
// backup-* modules below; callers keep using require('./backup').
const { BACKUP_VERSION, ZIP_BACKUP_FORMAT, ZIP_BACKUP_FORMAT_VERSION } = require('./backup-format');
const common = require('./backup-common');
const exporter = require('./backup-export');
const validation = require('./backup-validate');
const restoreMapping = require('./backup-restore-mapping');
const zipReader = require('./backup-zip-reader');
const importer = require('./backup-import');

module.exports = {
  BACKUP_VERSION,
  ZIP_BACKUP_FORMAT,
  ZIP_BACKUP_FORMAT_VERSION,
  sha256Buffer: common.sha256Buffer,
  sha256File: common.sha256File,
  canonicalJson: common.canonicalJson,
  normalizeMysqlDateTime: common.normalizeMysqlDateTime,
  readBackupFileEntry: exporter.readBackupFileEntry,
  writeBackupJsonFile: exporter.writeBackupJsonFile,
  validateBackupPayload: validation.validateBackupPayload,
  countBackupRows: validation.countBackupRows,
  normalizeBackupImportSections: validation.normalizeBackupImportSections,
  scopeBackupForImport: validation.scopeBackupForImport,
  buildBackupForUser: exporter.buildBackupForUser,
  buildBackupArchiveEntriesForUser: exporter.buildBackupArchiveEntriesForUser,
  readZipEntries: zipReader.readZipEntries,
  readZipFileEntries: zipReader.readZipFileEntries,
  backupFromZipBuffer: zipReader.backupFromZipBuffer,
  backupFromZipFile: zipReader.backupFromZipFile,
  importBackupForUser: importer.importBackupForUser,
  importBackupZipBufferForUser: importer.importBackupZipBufferForUser,
  importBackupZipFileForUser: importer.importBackupZipFileForUser,
  prepareCredentialsForRestore: restoreMapping.prepareCredentialsForRestore,
  remapRestoredInlineAttachments: restoreMapping.remapRestoredInlineAttachments,
  restoreMailFolderRemoteBox: restoreMapping.restoreMailFolderRemoteBox,
  findExistingEmailForRestore: restoreMapping.findExistingEmailForRestore,
  assertBackupMetadataSize: common.assertBackupMetadataSize,
  assertBackupFilesComplete: exporter.assertBackupFilesComplete,
  findExistingAttachmentForRestore: restoreMapping.findExistingAttachmentForRestore,
  findExistingRecordingForRestore: restoreMapping.findExistingRecordingForRestore,
};
