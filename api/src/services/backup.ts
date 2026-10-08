// Facade for backup export, validation and restore. The code lives in the
// backup-* modules below; callers keep using require('./backup').
import imported1 = require('./backup-format');
const { BACKUP_VERSION, ZIP_BACKUP_FORMAT, ZIP_BACKUP_FORMAT_VERSION } = imported1;
import common = require('./backup-common');
import exporter = require('./backup-export');
import validation = require('./backup-validate');
import restoreMapping = require('./backup-restore-mapping');
import zipReader = require('./backup-zip-reader');
import importer = require('./backup-import');

export = {
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
