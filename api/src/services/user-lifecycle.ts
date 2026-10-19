import fs from 'node:fs/promises';
import path from 'node:path';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { db } from '../state';
import { conflict, notFound } from '../http/errors';
import { withTransaction } from './transactions';
import { getActiveRestoreSections } from './restore-locks';
import { attachmentsRoot, rawRoot, mailPathUnderRoot, ownedMailPath } from './mail-storage';
import { RECORDINGS_ROOT, deleteRecordingFiles } from './recordings';
import { BACKUPS_ROOT, isBackupPathUnderRoot } from './export-jobs';
import { realtime } from './realtime';
import { log } from '../log';
import { recordAudit } from './audit';
import type { AuthRequest } from '../types';

type DeleteActor = 'self' | 'admin';
interface DeleteUserResult { files: { removed: number; failed: number } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Removing a person's account, whether they ask (DELETE /api/settings/account)
// or an administrator does (DELETE /api/admin/users/:id). The routes keep their
// own checks (password, role, last admin); this owns the order that keeps the
// outcome recoverable: refuse while a restore writes for this person, stop the
// mail work that could still write files, delete the users row (every table
// cascades from it), then remove the files. A file that outlives its rows is a
// hygiene problem; a row whose file is gone would be data loss, so files go last.
async function deleteUser(userId: string, { actor, actorId = null, req = null }: { actor: DeleteActor; actorId?: string | null; req?: AuthRequest | null }): Promise<DeleteUserResult> {
  if ((await getActiveRestoreSections(userId)).size > 0) {
    throw conflict('RESTORE_IN_PROGRESS', 'Restore in progress. The account can be deleted when it has finished.');
  }

  const { stopMailAccountWork } = require('./mail') as typeof import('./mail');
  const [accounts] = await db.execute<(RowDataPacket & { id: string })[]>('SELECT id FROM mail_accounts WHERE user_id = ?', [userId]);
  for (const account of accounts) {
    await stopMailAccountWork(account.id, actor === 'admin' ? 'Account deleted by an administrator' : 'Account deleted');
  }

  // Collected before the rows go, checked against the configured roots like
  // the routes always did: the row proves ownership, the root check keeps a
  // stored path from reaching outside.
  const [[attachments], [rawEmails], [recordings], [exports]] = await Promise.all([
    db.execute<(RowDataPacket & { storage_path: string | null })[]>('SELECT storage_path FROM email_attachments WHERE user_id = ?', [userId]),
    db.execute<(RowDataPacket & { raw_storage_path: string | null })[]>('SELECT raw_storage_path FROM emails WHERE user_id = ? AND raw_storage_path IS NOT NULL', [userId]),
    db.execute<(RowDataPacket & { storage_path: string | null })[]>('SELECT storage_path FROM recordings WHERE user_id = ?', [userId]),
    db.execute<(RowDataPacket & { file_path: string | null })[]>('SELECT file_path FROM data_export_jobs WHERE user_id = ?', [userId]),
  ]);
  const files = new Set<string>();
  for (const row of attachments) {
    const file = mailPathUnderRoot('attachment', row.storage_path);
    if (file) files.add(file);
  }
  for (const row of rawEmails) {
    const file = ownedMailPath('raw', row.raw_storage_path, userId);
    if (file) files.add(file);
  }
  for (const row of exports) {
    if (row.file_path && isBackupPathUnderRoot(row.file_path)) files.add(path.resolve(row.file_path));
  }
  const recordingPaths = recordings.map(row => row.storage_path).filter((value): value is string => Boolean(value));

  const deleted = await withTransaction(async connection => {
    const [result] = await connection.execute<ResultSetHeader>('DELETE FROM users WHERE id = ?', [userId]);
    if (result.affectedRows > 0) {
      await recordAudit({ action: actor === 'admin' ? 'admin.user_deleted' : 'auth.account_deleted', actorId, targetUserId: userId, req }, connection);
    }
    return result.affectedRows > 0;
  });
  if (!deleted) throw notFound('USER_NOT_FOUND', 'User not found');

  const outcome = await removeUserFiles(userId, files, recordingPaths);
  realtime.closeUser(userId);
  return outcome;
}

// Never throws: the rows are gone, so a file that stays behind is reported in
// the log and shows in the admin storage overview as orphaned.
async function removeUserFiles(userId: string, files: Set<string>, recordingPaths: readonly string[]): Promise<DeleteUserResult> {
  let removed = 0;
  const failed: string[] = [];
  for (const file of files) {
    try {
      await fs.rm(file, { force: true });
      removed++;
    } catch (error) {
      failed.push(file);
      log.error('USERS', 'Could not remove a deleted user\'s file', error);
    }
  }
  for (const storagePath of recordingPaths) {
    await deleteRecordingFiles(storagePath);
    removed++;
  }
  // Each root keeps one directory per person (<root>/<userId>/...), so what no
  // row named any more (staged uploads, a file whose row was lost) goes with it.
  if (UUID.test(userId)) {
    const roots = [attachmentsRoot(), rawRoot(), RECORDINGS_ROOT, path.join(RECORDINGS_ROOT, '.tmp'), BACKUPS_ROOT];
    for (const directory of roots.map(root => path.join(root, userId))) {
      try {
        await fs.rm(directory, { recursive: true, force: true });
      } catch (error) {
        failed.push(directory);
        log.error('USERS', 'Could not remove a deleted user\'s directory', error);
      }
    }
  }
  if (failed.length) log.error('USERS', 'Files of a deleted user remain on disk', undefined, { user: userId, count: failed.length, files: failed.join(', ') });
  return { files: { removed, failed: failed.length } };
}

export type { DeleteActor, DeleteUserResult };
export { deleteUser };
