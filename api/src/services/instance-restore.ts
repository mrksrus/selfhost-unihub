import type { Connection, ExecuteValues, RowDataPacket } from 'mysql2/promise';
import type { DatabaseConfig } from '../types';

import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import mysql from 'mysql2/promise';
import { LATEST_MIGRATION_ID } from './database';
import { fileRoots, spawnClient, INSTANCE_BACKUP_ROOTS } from './instance-backup';
import { readInstanceBackupHeader, scanInstanceBackup, type FileSink } from './instance-backup-format';

// Restores an instance backup (instance-backup.ts) into an empty
// installation: the restore command (src/instance-restore.ts) runs it in the
// image, never the web. Two passes over the file:
//  1. read and check everything with the key, writing nothing
//  2. refuse a database with tables or file roots with files; then load the
//     dump with the mariadb client and write the files as they are read
// A failure in pass 2 drops the tables and removes the files it wrote (both
// were empty before), so the installation is empty again for another try.
// Then what belongs to the old installation's running life is cleared: its
// sessions, download tickets, login challenges, worker leases and restores
// whose archive stayed behind. Users, their data, policies, the activity log
// and the push identity stay; the app's own start resumes interrupted jobs
// and runs the migrations of a backup from an older release.

interface RestoreOptions {
  file: string;
  key: Buffer;
  database: DatabaseConfig;
  /** Only pass 1. */
  verifyOnly?: boolean;
  /** Owner of the written files when run as root in the image (UNIHUB_API_UID/GID). */
  owner?: { uid: number; gid: number } | null;
  print?: (line: string) => void;
}

const terminalRestoreStates = ['completed', 'failed', 'cancelled', 'expired'];

async function connect(database: DatabaseConfig): Promise<Connection> {
  return mysql.createConnection({ ...database, timezone: '+00:00', multipleStatements: false });
}

async function tableNames(connection: Connection) {
  const [rows] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  return rows.map(row => String(row.name));
}

/** Whether a root holds a file (or anything but directories). */
async function holdsFiles(dir: string): Promise<boolean> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) return true;
    if (await holdsFiles(path.join(dir, entry.name))) return true;
  }
  return false;
}

/** Removes what is inside a root, never the root itself (it may be a mount). */
async function emptyRoot(dir: string) {
  const entries = await fs.promises.readdir(dir).catch(() => [] as string[]);
  for (const name of entries) await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
}

async function chownTree(dir: string, owner: { uid: number; gid: number }) {
  if (!fs.existsSync(dir)) return;
  await fs.promises.lchown(dir, owner.uid, owner.gid);
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await chownTree(target, owner);
    else await fs.promises.lchown(target, owner.uid, owner.gid);
  }
}

const inside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

async function clearInstallationState(connection: Connection, run: { id: string; fileName: string; size: number; sha256: string }) {
  const statements: [string, ExecuteValues[]][] = [
    ['DELETE FROM sessions', []],
    ['DELETE FROM file_tickets', []],
    ['DELETE FROM two_factor_challenges', []],
    ['UPDATE mail_engine_accounts SET lease_owner = NULL, lease_until = NULL', []],
    ['UPDATE mail_engine_jobs SET lease_owner = NULL, lease_until = NULL', []],
    // Uploaded and staged restore archives are not in an instance backup.
    [`UPDATE backup_restore_jobs SET status = 'failed', phase = 'failed', archive_path = NULL, completed_at = UTC_TIMESTAMP(),
      error = 'This restore was interrupted by a restore of the whole installation; its archive was not part of that backup.'
      WHERE status NOT IN (${terminalRestoreStates.map(() => '?').join(', ')})`, terminalRestoreStates],
    // The run that wrote this backup was still running when its dump was taken.
    [`UPDATE instance_backups SET status = 'succeeded', file_name = ?, size_bytes = ?, sha256 = ?, finished_at = UTC_TIMESTAMP()
      WHERE id = ? AND status = 'running'`, [run.fileName, run.size, run.sha256, run.id]],
    ["UPDATE instance_backups SET status = 'failed', error = 'The server stopped during the backup.', finished_at = UTC_TIMESTAMP() WHERE status = 'running'", []],
  ];
  for (const [sql, values] of statements) await connection.execute(sql, values);
}

async function restoreInstanceBackup({ file, key, database, verifyOnly = false, owner = null, print = () => {} }: RestoreOptions) {
  const header = await readInstanceBackupHeader(file);
  print(`Backup ${header.backup_id} of ${header.created_at}, UniHub ${header.app_version} (upgrade step ${header.migration_id}), key ${header.key_fingerprint}.`);
  if (header.migration_id > LATEST_MIGRATION_ID) {
    throw new Error(`This backup comes from a newer UniHub (upgrade step ${header.migration_id}; this one knows ${LATEST_MIGRATION_ID}). Restore it with that release or a later one.`);
  }

  print('Checking the whole file with the key...');
  const checked = await scanInstanceBackup(file, key, INSTANCE_BACKUP_ROOTS);
  const { manifest } = checked;
  const tableCount = Object.keys(manifest.database.tables).length;
  print(`Checked: the database (${tableCount} tables, ${manifest.database.bytes} bytes of SQL) and ${manifest.files.count} files (${manifest.files.bytes} bytes).`);
  if (checked.changed.size) print(`${checked.changed.size} files changed while they were copied; they are left out.`);
  if (verifyOnly) return { verified: true as const, restored: false, manifest, tables: null };

  const roots = fileRoots();
  const connection = await connect(database);
  let wrote = false;
  try {
    if ((await tableNames(connection)).length) throw new Error(`The database ${database.database} is not empty. Restore into a new, empty database.`);
    for (const root of roots) {
      if (await holdsFiles(root.dir)) throw new Error(`${root.dir} holds files. Restore into an installation with empty storage.`);
    }

    print('Restoring the database and the files...');
    wrote = true;
    const realRoots = new Map<string, string>();
    const rootDir = (name: string) => roots.find(root => root.name === name)!.dir;
    let load: ReturnType<typeof spawnClient> | null = null;
    const startLoad = () => {
      load ??= spawnClient('mariadb', ['--binary-mode', '--default-character-set=utf8mb4', database.database], database, 'pipe');
      return load;
    };
    const finishLoad = async () => {
      const client = startLoad();
      client.child.stdin!.end();
      await client.exited;
    };
    await scanInstanceBackup(file, key, INSTANCE_BACKUP_ROOTS, {
      skip: checked.changed,
      onDatabase: async buffer => {
        const { child, exited } = startLoad();
        if (!child.stdin!.write(buffer)) await Promise.race([once(child.stdin!, 'drain'), exited]);
      },
      onDatabaseEnd: finishLoad,
      onFile: async ({ root, path: relative }): Promise<FileSink> => {
        const base = rootDir(root);
        if (!realRoots.has(root)) {
          await fs.promises.mkdir(base, { recursive: true });
          realRoots.set(root, await fs.promises.realpath(base));
        }
        const target = path.join(base, ...relative.split('/'));
        await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
        // A directory the restore did not create cannot redirect a file outside its root.
        const parent = await fs.promises.realpath(path.dirname(target));
        if (parent !== realRoots.get(root) && !inside(parent, realRoots.get(root)!)) throw new Error(`A file of the backup would land outside ${base}.`);
        const handle = await fs.promises.open(target, 'wx', 0o640);
        return {
          write: async buffer => { let offset = 0; while (offset < buffer.length) offset += (await handle.write(buffer, offset)).bytesWritten; },
          end: () => handle.close(),
        };
      },
    });
    if (checked.header.backup_id !== manifest.backup_id) throw new Error('The file changed between the check and the restore.');

    await clearInstallationState(connection, { id: header.backup_id, fileName: path.basename(file), size: (await fs.promises.stat(file)).size, sha256: checked.sha256 });
    if (owner) for (const root of roots) await chownTree(root.dir, owner);

    const tables: Record<string, number> = {};
    for (const name of await tableNames(connection)) {
      const [[row]] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${connection.escapeId(name)}`);
      tables[name] = Number(row.count);
    }
    const missing = Object.keys(manifest.database.tables).filter(name => !(name in tables));
    if (missing.length) throw new Error(`The restored database lacks ${missing.length} tables of the backup (${missing.slice(0, 5).join(', ')}).`);
    print(`Restored ${Object.keys(tables).length} tables and ${manifest.files.count - checked.changed.size} files.`);
    return { verified: true as const, restored: true, manifest, tables };
  } catch (error) {
    if (wrote) {
      print('The restore failed; removing what it wrote...');
      await connection.query('SET FOREIGN_KEY_CHECKS = 0').catch(() => {});
      for (const name of await tableNames(connection).catch(() => [] as string[])) await connection.query(`DROP TABLE IF EXISTS ${connection.escapeId(name)}`).catch(() => {});
      for (const root of roots) await emptyRoot(root.dir).catch(() => {});
    }
    throw error;
  } finally {
    await connection.end().catch(() => {});
  }
}

export { restoreInstanceBackup };
export type { RestoreOptions };
