// Facade for backup export, validation and restore. The code lives in the
// backup-* modules below; callers keep using require('./backup').
import { BACKUP_VERSION, ZIP_BACKUP_FORMAT, ZIP_BACKUP_FORMAT_VERSION } from './backup-format';
import * as common from './backup-common';
import * as exporter from './backup-export';
import * as validation from './backup-validate';
import * as restoreMapping from './backup-restore-mapping';
import * as zipReader from './backup-zip-reader';
import * as importer from './backup-import';

export const sha256Buffer = common.sha256Buffer;
export const sha256File = common.sha256File;
export const canonicalJson = common.canonicalJson;
export const normalizeMysqlDateTime = common.normalizeMysqlDateTime;
export const readBackupFileEntry = exporter.readBackupFileEntry;
export const writeBackupJsonFile = exporter.writeBackupJsonFile;
export const validateBackupPayload = validation.validateBackupPayload;
export const countBackupRows = validation.countBackupRows;
export const normalizeBackupImportSections = validation.normalizeBackupImportSections;
export const scopeBackupForImport = validation.scopeBackupForImport;
export const buildBackupForUser = exporter.buildBackupForUser;
export const buildBackupArchiveEntriesForUser = exporter.buildBackupArchiveEntriesForUser;
export const readZipEntries = zipReader.readZipEntries;
export const readZipFileEntries = zipReader.readZipFileEntries;
export const backupFromZipBuffer = zipReader.backupFromZipBuffer;
export const backupFromZipFile = zipReader.backupFromZipFile;
export const importBackupForUser = importer.importBackupForUser;
export const importBackupZipBufferForUser = importer.importBackupZipBufferForUser;
export const importBackupZipFileForUser = importer.importBackupZipFileForUser;
export const prepareCredentialsForRestore = restoreMapping.prepareCredentialsForRestore;
export const remapRestoredInlineAttachments = restoreMapping.remapRestoredInlineAttachments;
export const restoreMailFolderRemoteBox = restoreMapping.restoreMailFolderRemoteBox;
export const findExistingEmailForRestore = restoreMapping.findExistingEmailForRestore;
export const assertBackupMetadataSize = common.assertBackupMetadataSize;
export const assertBackupFilesComplete = exporter.assertBackupFilesComplete;
export const findExistingAttachmentForRestore = restoreMapping.findExistingAttachmentForRestore;
export const findExistingRecordingForRestore = restoreMapping.findExistingRecordingForRestore;
export {
  BACKUP_VERSION,
  ZIP_BACKUP_FORMAT,
  ZIP_BACKUP_FORMAT_VERSION,
};
