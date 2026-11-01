import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { InstanceBackupRun, InstanceBackupStatus } from '../contracts/instance-backup';
import type { InstanceBackupConfig } from '../config';
import type { DatabaseConfig, SqlExecutor } from '../types';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import packageJson = require('../../package.json');
import { db } from '../state';
import { INSTANCE_BACKUP, MAX_SECRET_FILE_BYTES, mayBeSecretGeneration, rememberSecretGeneration, secretGenerationNames } from '../config';
import { log } from '../log';
import { conflict } from '../http/errors';
import { getDatabaseConfig } from './database-config';
import { fileRemovalGate } from './file-removal-gate';
import { attachmentsRoot, rawRoot } from './mail-storage';
import { RECORDINGS_ROOT } from './recordings';
import { BACKUPS_ROOT } from './export-jobs';
import { photosRoot } from './contact-photos';
import { isWorkerOwner } from './worker-owner';
import {
  EncryptedWriter, TarWriter, InstanceBackupFormatError, INSTANCE_BACKUP_PART_BYTES, keyFingerprint, scanInstanceBackup,
  type IndexLine, type InstanceBackupManifest,
} from './instance-backup-format';

// The instance backup (D4, F10): a scheduled, encrypted copy of the whole
// installation, the database and the stored files, written by the worker
// owner to a mounted destination. Its configuration comes only from the
// environment (config.ts INSTANCE_BACKUP): the admin page shows it and can
// start a run, nothing more; the files are never offered for download.
//
// A run, one at a time:
//  1. closes the file removal gate (file-removal-gate.ts), so a file whose row
//     is deleted after the dump stays until the copy has ended
//  2. streams mariadb-dump (one consistent snapshot) and then the files into
//     the tar of instance-backup-format.ts, encrypted as it is written, to
//     <name>.uhib.partial; nothing goes through /tmp
//  3. reads the whole file back with the key and checks every hash; only then
//     renames it to <name>.uhib and records the run as succeeded
//  4. removes the oldest succeeded backups beyond the kept count
// A failed or interrupted run removes its partial file and is never counted.
// Not in the file: ENCRYPTION_KEY, BACKUP_MASTER_KEY, JWT_SECRET and the
// instance key (the admin keeps them in a password manager), uploads in
// progress, restore staging and spooled request bodies.

const LOG = 'INSTANCE BACKUP';
const EXTENSION = '.uhib';
const PARTIAL = '.partial';
// <UTC time>-<version>-<run id>: the run id makes each run's file its own.
const NAME_PATTERN = /^unihub-instance-\d{8}T\d{6}Z-[0-9A-Za-z.+-]{1,32}-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.uhib$/;
const MAX_RUN_MS = 12 * 60 * 60 * 1000;
const MIN_FREE_BYTES = 64 * 1024 * 1024;
const RUNS_SHOWN = 20;
const STDERR_BYTES = 4096;
const INDEX_FLUSH_BYTES = 1024 * 1024;
const LEFT_OUT = [
  'the keys: ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS, BACKUP_MASTER_KEY, JWT_SECRET and the instance backup key',
  'uploads in progress, restore staging, spooled request bodies and partial files',
];
const RESTORE_COMMAND = 'node /app/api/src/instance-restore.js --file <backup.uhib> --key-file <instance key file>';

class InstanceBackupError extends Error {}

// ── Configuration ─────────────────────────────────────────────────────

let config: InstanceBackupConfig = INSTANCE_BACKUP;

/** Replaces the configuration read at start (tests; the restore command). */
function useInstanceBackupConfig(next: InstanceBackupConfig) {
  config = next;
}

function enabled(settings = config): settings is InstanceBackupConfig & { dir: string; key: Buffer } {
  return !!settings.dir && !!settings.key && !settings.errors.length;
}

/** The stored-file roots, by the name they have in a backup (as user-lifecycle.ts lists them). */
function fileRoots() {
  return [
    { name: 'attachments', dir: path.resolve(attachmentsRoot()) },
    { name: 'mail-raw', dir: path.resolve(rawRoot()) },
    { name: 'recordings', dir: path.resolve(RECORDINGS_ROOT) },
    { name: 'contact-photos', dir: path.resolve(photosRoot()) },
    { name: 'backups', dir: path.resolve(BACKUPS_ROOT) },
  ];
}
const ROOT_NAMES = ['attachments', 'mail-raw', 'recordings', 'contact-photos', 'backups'];

// What a backup leaves out of a root: only the work in progress of the app's
// own writers, by the exact names they give it, which a restore must not
// bring back. A stored file keeps any name a person gave it (an attachment
// called report.tmp is data), so nothing else is matched by its ending.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TEMPORARY_FILES: Readonly<Record<string, { name: RegExp; depth?: number }>> = {
  // mail-engine/content.ts publishRaw: <user>/<email>-<uuid>.eml.part, renamed when written.
  'mail-raw': { name: new RegExp(`^${UUID}-${UUID}\\.eml\\.part$`, 'i'), depth: 2 },
  // recordings.ts conversion: <final>.<uuid>.tmp.mp3 beside the recording.
  recordings: { name: new RegExp(`\\.${UUID}\\.tmp\\.mp3$`, 'i') },
  // contact-photos.ts writes: <user>/.<name>.<uuid>.tmp.
  'contact-photos': { name: new RegExp(`^\\..+\\.${UUID}\\.tmp$`, 'i'), depth: 2 },
  // export-jobs.ts: <user>/<job>.zip.partial until the archive is complete.
  backups: { name: new RegExp(`^${UUID}\\.zip\\.partial$`, 'i'), depth: 2 },
};
// Directories that hold only work in progress: recording chunks being
// uploaded (recordings.ts), backup uploads being received (request-handler.ts
// imports) and uploaded restore archives with their work (backup-restore-jobs.ts).
// Files a finished account restore wrote stay in <root>/<user>/restores/<job>
// of the mail and recording roots and are data.
const TEMPORARY_DIRECTORIES: Readonly<Record<string, readonly string[]>> = {
  recordings: ['.tmp'],
  backups: ['imports', 'restores'],
};

function leftOut(root: string, segments: readonly string[], isDirectory: boolean) {
  const name = segments[segments.length - 1];
  if (isDirectory) return segments.length === 1 && (TEMPORARY_DIRECTORIES[root] ?? []).includes(name);
  const temporary = TEMPORARY_FILES[root];
  return !!temporary && (temporary.depth === undefined || temporary.depth === segments.length) && temporary.name.test(name);
}

const inside = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// A path and the path it really is (symbolic links resolved), for a check
// that an alias must not pass.
function bothPaths(target: string) {
  const resolved = path.resolve(target);
  try { return [...new Set([resolved, fs.realpathSync(resolved)])]; } catch { return [resolved]; }
}

function storedDataDirs() {
  return [...new Set(['/app/uploads', ...fileRoots().map(root => root.dir)].flatMap(bothPaths))];
}

/** The secret files the deployment names (every NAME_FILE that is set). */
function secretFiles(env: NodeJS.ProcessEnv = process.env) {
  return Object.entries(env).filter(([name, value]) => /_FILE$/.test(name) && !!value).map(([name, value]) => ({ name, path: value! }));
}

/**
 * Startup refusals the configuration alone cannot see: a destination inside
 * the stored data, and a secret file inside what the backup copies (the
 * backup must never carry a key, F10), also through a symbolic link.
 */
function instanceBackupSetupErrors(settings = config, env: NodeJS.ProcessEnv = process.env) {
  const errors: string[] = [];
  const data = storedDataDirs();
  if (settings.dir && bothPaths(settings.dir).some(dir => data.some(root => inside(dir, root) || inside(root, dir)))) {
    errors.push('INSTANCE_BACKUP_DIR must be its own volume or mount, outside /app/uploads and the stored files.');
  }
  for (const secret of secretFiles(env)) {
    if (bothPaths(secret.path).some(file => data.some(root => inside(file, root)))) {
      errors.push(`${secret.name} (${secret.path}) is inside the stored files, which backups copy; keep secret files outside /app/uploads.`);
    }
  }
  return errors;
}

// Deployment secrets a misplaced mount could put in a root: the configured
// secret files, recognised by their content, and Compose's .env files, a
// name no writer of the app gives a stored file.
const DEPLOYMENT_FILE = /^\.env(\..*)?$/;
//
// Content, not the file: every generation of a secret file the process has
// seen (config.ts) is remembered by size and hash, so a stored file with the
// same bytes (a hard link, a copy, a second mount) is left out, also after
// the secret has been rotated away. A run samples the configured files at its
// start and its end and remembers both. A configured file that cannot be read
// at the start refuses the run; one that changed by the end makes the run not
// count (its new bytes may have been copied before they were known), and the
// next run, which knows them, leaves them out. What this cannot see is a
// generation that came and went within one run (DATA_RECOVERY.md).
const secretLabel = (secret: { name: string; path: string }) => `${secret.name} (${secret.path})`;

/** The configured secret files as they are now: file and content, remembered as generations. */
function sampleSecretFiles(env: NodeJS.ProcessEnv = process.env) {
  const sampled = new Map<string, string>();
  const unreadable: string[] = [];
  for (const secret of secretFiles(env)) {
    let descriptor: number | null = null;
    try {
      // One descriptor for the check and the read, which stops one byte past
      // the bound: what is remembered is what was checked.
      descriptor = fs.openSync(secret.path, 'r');
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new Error('not a file');
      const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
        if (!read) break;
        length += read;
      }
      if (length > MAX_SECRET_FILE_BYTES) throw new Error('larger than a secret can be');
      const bytes = buffer.subarray(0, length);
      rememberSecretGeneration(secret.name, bytes);
      sampled.set(secretLabel(secret), `${stat.dev}:${stat.ino}:${bytes.length}:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
    } catch {
      unreadable.push(secretLabel(secret));
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
  }
  return { sampled, unreadable };
}

function sampleSecretsAtStart(env: NodeJS.ProcessEnv = process.env) {
  const { sampled, unreadable } = sampleSecretFiles(env);
  if (unreadable.length) {
    throw new InstanceBackupError(`The backup did not run: ${unreadable.join(', ')} cannot be checked now, so it cannot make sure a key stays out. Put the file back or restart without it.`);
  }
  return sampled;
}

/** The configured secret files that are another file or other bytes than at the run's start, or unreadable. */
function secretsChangedSince(start: ReadonlyMap<string, string>, env: NodeJS.ProcessEnv = process.env) {
  const { sampled } = sampleSecretFiles(env);
  return secretFiles(env).map(secretLabel).filter(label => sampled.get(label) !== start.get(label));
}

/** A run of a time-ordered id (UUID version 7): a later run has a larger id, also within one second. */
let lastIdMs = 0;
function timeOrderedId() {
  const ms = Math.max(Date.now(), lastIdMs + 1);
  lastIdMs = ms;
  const bytes = crypto.randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ── Runs ──────────────────────────────────────────────────────────────

interface RunRow extends RowDataPacket {
  id: string; trigger_kind: 'schedule' | 'manual'; actor_id: string | null; actor_email: string | null;
  status: 'running' | 'succeeded' | 'failed'; file_name: string | null; size_bytes: number | string | null; sha256: string | null;
  key_fingerprint: string | null; app_version: string; migration_id: number; error: string | null;
  started_at: Date | string; finished_at: Date | string | null; removed_at: Date | string | null; completion_seq: number | string | null;
}

const iso = (value: Date | string | null) => value === null ? null : new Date(value instanceof Date ? value : `${String(value).replace(' ', 'T')}Z`).toISOString();

function serializeRun(row: RunRow): InstanceBackupRun {
  return {
    id: row.id, trigger: row.trigger_kind, actor_email: row.actor_email ?? null, status: row.status, file_name: row.file_name,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes), app_version: row.app_version, error: row.error,
    started_at: iso(row.started_at)!, finished_at: iso(row.finished_at),
  };
}

async function readRun(id: string) {
  const [[row]] = await db.execute<RunRow[]>(`SELECT b.*, u.email AS actor_email FROM instance_backups b
    LEFT JOIN users u ON u.id = b.actor_id WHERE b.id = ?`, [id]);
  return row ?? null;
}

const timestamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const appVersion = () => String((packageJson as { version?: string }).version || '0.0.0').replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 32) || '0.0.0';

interface RunHooks {
  /** After the dump, before the files are copied (tests: a removal that must wait). */
  afterDump?: () => Promise<void>;
}

let current: { id: string; abort: AbortController; done: Promise<RunRow | null> } | null = null;

/**
 * Starts a run and answers its row (status running) without waiting for it;
 * `done` settles with the finished row. Refused while a run is going on.
 */
async function startInstanceBackup({ trigger, actorId = null, hooks = {} }: { trigger: 'schedule' | 'manual'; actorId?: string | null; hooks?: RunHooks }) {
  const settings = config;
  if (!enabled(settings)) throw conflict('INSTANCE_BACKUP_OFF', `The instance backup is off: set ${settings.missing.map(part => part === 'destination' ? 'INSTANCE_BACKUP_DIR' : 'INSTANCE_BACKUP_KEY or INSTANCE_BACKUP_KEY_FILE').join(' and ') || 'a valid configuration'} and restart.`);
  if (current) throw conflict('INSTANCE_BACKUP_RUNNING', 'An instance backup is already running.');
  const id = timeOrderedId();
  const abort = new AbortController();
  const slot = { id, abort, done: Promise.resolve<RunRow | null>(null) };
  current = slot;
  let row: RunRow;
  try {
    const [migration] = await db.execute<RowDataPacket[]>('SELECT COALESCE(MAX(id), 0) AS id FROM schema_migrations');
    // The database keeps one run at a time even if a second process tried.
    const [inserted] = await db.execute<ResultSetHeader>(`INSERT INTO instance_backups (id, trigger_kind, actor_id, status, app_version, migration_id, key_fingerprint, started_at)
      SELECT ?, ?, ?, 'running', ?, ?, ?, UTC_TIMESTAMP() FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM instance_backups WHERE status = 'running')`,
    [id, trigger, actorId, appVersion(), Number(migration[0]?.id) || 0, keyFingerprint(settings.key)]);
    if (!inserted.affectedRows) {
      if (current === slot) current = null;
      throw conflict('INSTANCE_BACKUP_RUNNING', 'An instance backup is already running.');
    }
    const read = await readRun(id);
    if (!read) throw new InstanceBackupError('The new run could not be read back.');
    row = read;
  } catch (error) {
    if (current === slot) {
      // The row may exist (an insert whose answer was lost, a failed read):
      // it is marked failed, or, if that fails too, the next worker owner's
      // start does (recoverInterruptedInstanceBackups). The slot is free again.
      await db.execute(`UPDATE instance_backups SET status = 'failed', error = ?, finished_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'running'`,
        ['The backup could not start; the server log has the details.', id])
        .catch(mark => log.error(LOG, 'Could not record a run that could not start', mark, { run: id }));
      current = null;
    }
    throw error;
  }
  slot.done = execute(row, settings, abort.signal, hooks).finally(() => { if (current === slot) current = null; });
  return { run: serializeRun(row), done: slot.done };
}

/** Runs a backup to its end (the schedule); answers the finished row. */
async function runInstanceBackup(options: { trigger: 'schedule' | 'manual'; actorId?: string | null; hooks?: RunHooks }) {
  return (await startInstanceBackup(options)).done;
}

/** Stops a running backup (shutdown, lost worker role); it is recorded as failed. */
function stopInstanceBackup() {
  current?.abort.abort(new InstanceBackupError('The backup stopped because the server stopped its background work.'));
}

function shownError(error: unknown) {
  if (error instanceof InstanceBackupError || error instanceof InstanceBackupFormatError) return error.message;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC') return 'The destination ran out of space.';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'The destination cannot be written by the API user.';
  if (code === 'ENOENT') return 'The destination disappeared during the backup.';
  return 'The backup failed; the server log has the details.';
}

async function execute(row: RunRow, settings: InstanceBackupConfig & { dir: string; key: Buffer }, signal: AbortSignal, hooks: RunHooks) {
  const startedAt = Date.now();
  const name = `unihub-instance-${timestamp(new Date(iso(row.started_at)!))}-${row.app_version}-${row.id}${EXTENSION}`;
  const finalPath = path.join(settings.dir, name);
  const partialPath = finalPath + PARTIAL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new InstanceBackupError('The backup took longer than 12 hours and was stopped.')), MAX_RUN_MS);
  timer.unref?.();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  log.info(LOG, 'Started', { run: row.id, trigger: row.trigger_kind });
  let published = false;
  try {
    await checkDestination(settings.dir);
    // The setup checks of the start, again: secret files can have moved since.
    const refused = instanceBackupSetupErrors(settings);
    if (refused.length) throw new InstanceBackupError(`The backup did not run: ${refused.join(' ')}`);
    const secrets = sampleSecretsAtStart();
    const { bytes, sha256, manifest } = await writeBackup(partialPath, row, settings, controller.signal, hooks);
    // Counted only once the whole file reads back with the key.
    const verified = await scanInstanceBackup(partialPath, settings.key, ROOT_NAMES, { signal: controller.signal });
    if (verified.sha256 !== sha256 || verified.header.backup_id !== row.id) throw new InstanceBackupError('The backup did not read back as written.');
    controller.signal.throwIfAborted();
    // A secret rotated during the run has bytes the copy did not know to leave
    // out, perhaps reachable under the stored files: the run does not count,
    // and its end sample has taught the next run those bytes.
    const moved = secretsChangedSince(secrets);
    if (moved.length) {
      throw new InstanceBackupError(`The backup did not count: ${moved.join(', ')} changed during the run, so the copy may hold the new key. The next run tries again.`);
    }
    await publish(partialPath, finalPath, name);
    published = true;
    await fs.promises.rm(partialPath, { force: true });
    await syncDirectory(settings.dir);
    // Succeeded and what retention removes, in one transaction: the run
    // counts together with the removal of the oldest beyond the kept count.
    const removing = await recordSuccess(row.id, { name, bytes, sha256, migrationId: manifest.migration_id }, settings);
    log.info(LOG, 'Succeeded', { run: row.id, bytes, files: manifest.files.count, seconds: Math.round((Date.now() - startedAt) / 1000) });
    await removeBackupFiles(settings.dir, removing);
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    log.error(LOG, 'Failed', reason, { run: row.id });
    await fs.promises.rm(partialPath, { force: true }).catch(cleanup => log.error(LOG, 'Could not remove a partial backup', cleanup, { run: row.id }));
    let failedRecorded = false;
    try {
      const [failed] = await db.execute<ResultSetHeader>(`UPDATE instance_backups SET status = 'failed', error = ?, finished_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'running'`,
        [shownError(reason), row.id]);
      failedRecorded = failed.affectedRows > 0;
    } catch (update) { log.error(LOG, 'Could not record a failed run', update, { run: row.id }); }
    // The file of a run that does not count goes too.
    if (published && failedRecorded) await fs.promises.rm(finalPath, { force: true }).catch(() => {});
  } finally {
    // However the run ends (succeeded, failed at any step, stopped), it
    // remembers the secret files as they are at its exit, after anything that
    // could still change them: bytes it may have copied stay out of the next.
    try { sampleSecretFiles(); } catch (sampling) { log.error(LOG, 'Could not read the secret files at the end of a run', sampling, { run: row.id }); }
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  return readRun(row.id).catch(() => null);
}

// Filesystems without hard links (some NAS shares, FUSE mounts, FAT) answer
// a link with one of these.
const NO_HARD_LINKS = new Set(['EOPNOTSUPP', 'EPERM', 'ENOSYS']);

/**
 * Gives the finished file its name. A link refuses a name already taken,
 * unlike a rename. Where the destination has no hard links, the name is
 * checked to be free and then renamed to: two steps, not one. The run id in
 * the name keeps other runs off it; a writer other than UniHub creating the
 * name between the two would have its file replaced, which is why the
 * destination is UniHub's alone (DATA_RECOVERY.md).
 */
async function publish(partialPath: string, finalPath: string, name: string) {
  const taken = () => new InstanceBackupError(`${name} already exists at INSTANCE_BACKUP_DIR; the backup does not replace it.`);
  try {
    await fs.promises.link(partialPath, finalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw taken();
    if (!code || !NO_HARD_LINKS.has(code)) throw error;
    const free = await fs.promises.lstat(finalPath).then(() => false, (missing: NodeJS.ErrnoException) => {
      if (missing.code === 'ENOENT') return true;
      throw missing;
    });
    if (!free) throw taken();
    await fs.promises.rename(partialPath, finalPath);
  }
}

async function checkDestination(dir: string) {
  const stat = await fs.promises.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw new InstanceBackupError('INSTANCE_BACKUP_DIR does not exist; is its volume mounted?');
  await fs.promises.access(dir, fs.constants.W_OK).catch(() => { throw new InstanceBackupError('INSTANCE_BACKUP_DIR cannot be written by the API user.'); });
  // A run needs about as much as the last one, or the database's size before the first.
  const [[last]] = await db.execute<RowDataPacket[]>("SELECT size_bytes FROM instance_backups WHERE status = 'succeeded' ORDER BY completion_seq DESC LIMIT 1");
  const [[size]] = await db.execute<RowDataPacket[]>('SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  const needed = Math.ceil(Math.max(Number(last?.size_bytes) || 0, Number(size?.bytes) || 0) * 1.1) + MIN_FREE_BYTES;
  const space = await fs.promises.statfs(dir);
  const free = Number(space.bavail) * Number(space.bsize);
  if (free < needed) throw new InstanceBackupError(`Not enough free space at INSTANCE_BACKUP_DIR: about ${Math.ceil(needed / 1048576)} MiB needed, ${Math.floor(free / 1048576)} MiB free.`);
}

async function syncDirectory(dir: string) {
  const handle = await fs.promises.open(dir, 'r').catch(() => null);
  await handle?.sync().catch(() => {});
  await handle?.close().catch(() => {});
}

// ── Writing ───────────────────────────────────────────────────────────

function mariadbBinary(name: string) {
  // The image has the client tools on PATH; a host run (tests, tools/e2e) names their directory.
  const dir = process.env.UNIHUB_MARIADB_BIN_DIR;
  return dir ? path.join(dir, name) : name;
}

// The client reads no option files and gets a bare environment: the
// password in MYSQL_PWD (readable like the API's own environment, never on
// argv or on disk), nothing of the API's other secrets.
function clientEnvironment(database: DatabaseConfig) {
  return { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', MYSQL_PWD: database.password };
}

/** Spawns a MariaDB client tool with the API's connection; transport as the API's (no TLS). */
function spawnClient(tool: 'mariadb-dump' | 'mariadb', args: string[], database: DatabaseConfig, stdin: 'ignore' | 'pipe') {
  const connection = ['--no-defaults', `--host=${database.host}`, `--port=${database.port}`, `--user=${database.user}`, '--skip-ssl'];
  const child = spawn(mariadbBinary(tool), [...connection, ...args], { stdio: [stdin, 'pipe', 'pipe'], env: clientEnvironment(database) });
  // A client that exits early closes its pipes; its exit reports why.
  child.stdin?.on('error', () => {});
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { if (stderr.length < STDERR_BYTES) stderr += chunk.toString('utf8').slice(0, STDERR_BYTES - stderr.length); });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? new InstanceBackupError(`${tool} was not found; the image includes it (UNIHUB_MARIADB_BIN_DIR names it elsewhere).`) : error));
    child.once('close', (code, signal) => {
      if (code === 0) return resolve();
      const detail = stderr.split('\n').map(line => line.trim()).filter(Boolean).pop()?.slice(0, 300);
      reject(new InstanceBackupError(`${tool} failed (${signal || `exit ${code}`})${detail ? `: ${detail}` : ''}`));
    });
  });
  exited.catch(() => {});
  return { child, exited };
}

const SNAPSHOT = 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY';

/**
 * Runs `work` in a transaction (`begin`) on a connection of its own. A
 * failed one is rolled back before the connection goes back to the pool; a
 * connection whose rollback fails may still be inside the transaction, so it
 * is closed instead of handed to the next user of the pool.
 */
async function inTransaction<T>(begin: string, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await db.getConnection();
  let result: T;
  try {
    await connection.query(begin);
    result = await work(connection);
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK').then(() => connection.release(), () => connection.destroy());
    throw error;
  }
  connection.release();
  return result;
}

async function tableCounts() {
  return inTransaction(SNAPSHOT, async connection => {
    const [tables] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const [[row]] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${connection.escapeId(name)}`);
      counts[name] = Number(row.count);
    }
    return counts;
  });
}

async function writeBackup(partialPath: string, row: RunRow, settings: { key: Buffer }, signal: AbortSignal, hooks: RunHooks) {
  const database = getDatabaseConfig();
  if (!database) throw new InstanceBackupError('The database configuration is missing.');
  const handle = await fs.promises.open(partialPath, 'wx', 0o600);
  let closed = false;
  const reopen = fileRemovalGate.close();
  try {
    const createdAt = iso(row.started_at)!;
    const { writer, header } = await EncryptedWriter.create(handle, settings.key, {
      backup_id: row.id, created_at: createdAt, app_version: row.app_version, migration_id: Number(row.migration_id),
    });
    const tar = new TarWriter(buffer => writer.write(buffer));

    // 1. The dump: one snapshot, in parts the tar can size.
    const tables = await tableCounts();
    const dump = spawnClient('mariadb-dump', ['--single-transaction', '--routines', '--triggers', '--hex-blob', '--default-character-set=utf8mb4', database.database], database, 'ignore');
    const kill = () => dump.child.kill('SIGTERM');
    signal.addEventListener('abort', kill, { once: true });
    const dbHash = crypto.createHash('sha256');
    let dbParts = 0, dbBytes = 0, part: Buffer[] = [], partBytes = 0;
    const flushPart = async () => {
      if (!partBytes) return;
      dbParts++;
      await tar.add(`db/${String(dbParts).padStart(6, '0')}.sql`, Buffer.concat(part, partBytes));
      part = []; partBytes = 0;
    };
    try {
      for await (const chunk of dump.child.stdout! as AsyncIterable<Buffer>) {
        signal.throwIfAborted();
        dbHash.update(chunk);
        dbBytes += chunk.length;
        for (let offset = 0; offset < chunk.length;) {
          const take = Math.min(chunk.length - offset, INSTANCE_BACKUP_PART_BYTES - partBytes);
          part.push(chunk.subarray(offset, offset + take));
          partBytes += take;
          offset += take;
          if (partBytes === INSTANCE_BACKUP_PART_BYTES) await flushPart();
        }
      }
      await dump.exited;
    } finally {
      signal.removeEventListener('abort', kill);
      if (dump.child.exitCode === null) dump.child.kill('SIGTERM');
    }
    signal.throwIfAborted();
    await flushPart();
    if (!dbParts) throw new InstanceBackupError('mariadb-dump wrote nothing.');
    await hooks.afterDump?.();

    // 2. The files, with their index.
    const indexHash = crypto.createHash('sha256');
    let indexParts = 0, index: string[] = [], indexBytes = 0, fileCount = 0, fileBytes = 0, changed = 0;
    const flushIndex = async () => {
      if (!index.length) return;
      const buffer = Buffer.from(index.join(''), 'utf8');
      indexParts++;
      indexHash.update(buffer);
      await tar.add(`index/${String(indexParts).padStart(6, '0')}.ndjson`, buffer);
      index = []; indexBytes = 0;
    };
    const roots = fileRoots();
    let secretsLeftOut = 0;
    const secretNames = new Set<string>();
    for (const root of roots) {
      for await (const relative of walk(root.name, root.dir, signal)) {
        if (DEPLOYMENT_FILE.test(path.basename(relative))) { secretsLeftOut++; continue; }
        const copied = await copyFile(tar, root, relative, signal);
        if (copied && 'secret' in copied) {
          secretsLeftOut++;
          for (const name of copied.secret) secretNames.add(name);
          continue;
        }
        if (!copied) continue;
        const line: IndexLine = { r: root.name, p: relative, s: copied.size, h: copied.sha256, ...(copied.changed ? { c: 1 as const } : {}) };
        const text = `${JSON.stringify(line)}\n`;
        index.push(text);
        indexBytes += Buffer.byteLength(text);
        fileCount++;
        fileBytes += copied.size;
        if (copied.changed) changed++;
        if (indexBytes >= INDEX_FLUSH_BYTES) await flushIndex();
      }
    }
    await flushIndex();
    await reopen();
    if (secretsLeftOut) log.warn(LOG, 'Left deployment secret files found among the stored files out of the backup', { run: row.id, files: secretsLeftOut, secrets: [...secretNames] });

    // 3. The manifest, then the end.
    const manifest: InstanceBackupManifest = {
      format: 'unihub-instance-backup-manifest', version: 1, backup_id: row.id, created_at: createdAt, app_version: header.app_version,
      migration_id: header.migration_id,
      database: { name: database.database, parts: dbParts, bytes: dbBytes, sha256: dbHash.digest('hex'), tables },
      files: { roots: roots.map(root => root.name), count: fileCount, bytes: fileBytes, changed, index_parts: indexParts, index_sha256: indexHash.digest('hex') },
      left_out: LEFT_OUT,
    };
    await tar.add('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
    await tar.finish();
    const sealed = await writer.end();
    await handle.sync();
    await handle.close();
    closed = true;
    return { ...sealed, manifest };
  } finally {
    await reopen();
    if (!closed) await handle.close().catch(() => {});
  }
}

/** The files of a root, as paths relative to it; symbolic links and other non-files are left out. */
async function* walk(rootName: string, rootDir: string, signal: AbortSignal): AsyncGenerator<string> {
  const pending: string[][] = [[]];
  while (pending.length) {
    signal.throwIfAborted();
    const segments = pending.pop()!;
    const entries = await fs.promises.readdir(path.join(rootDir, ...segments), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const entry of entries) {
      const next = [...segments, entry.name];
      if (entry.isDirectory()) { if (!leftOut(rootName, next, true)) pending.push(next); continue; }
      if (entry.isFile() && !leftOut(rootName, next, false)) yield next.join('/');
    }
  }
}

/**
 * Copies one file into the tar. Its size is taken when it is opened; a file
 * that changes while it is read (stored files are written once, so this is
 * rare) is kept at that size and marked, and a restore leaves it out. A file
 * removed before it is opened is not needed: its row went before the dump.
 */
type Copied = { size: number; sha256: string; changed: boolean } | { secret: string[] } | null;

async function copyFile(tar: TarWriter, root: { name: string; dir: string }, relative: string, signal: AbortSignal): Promise<Copied> {
  const handle = await fs.promises.open(path.join(root.dir, relative), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const before = await handle.stat();
    if (!before.isFile()) return null;
    const size = before.size;
    // A file the size of a secret generation is read and hashed before it is
    // copied (secrets are small, so this is cheap): the same bytes stay out.
    let prefetched: Buffer | null = null;
    if (mayBeSecretGeneration(size)) {
      const whole = Buffer.alloc(size);
      let at = 0;
      while (at < size) {
        const { bytesRead } = await handle.read(whole, at, size - at, at);
        if (!bytesRead) break;
        at += bytesRead;
      }
      const names = at === size ? secretGenerationNames(size, crypto.createHash('sha256').update(whole).digest('hex')) : null;
      if (names) return { secret: names };
      if (at === size) prefetched = whole;
    }
    const hash = crypto.createHash('sha256');
    await tar.begin(`files/${root.name}/${relative}`, size);
    let read = 0, changed = false;
    // A file read whole for its hash is copied from that read.
    if (prefetched) {
      hash.update(prefetched);
      await tar.data(prefetched);
      read = size;
    }
    const buffer = Buffer.allocUnsafe(read < size ? 1024 * 1024 : 0);
    while (read < size) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - read), read);
      if (!bytesRead) {
        // Shorter than when it was opened: fill up, so the tar stays whole.
        changed = true;
        const zeros = Buffer.alloc(size - read);
        hash.update(zeros);
        await tar.data(zeros);
        read = size;
        break;
      }
      const piece = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(piece);
      await tar.data(piece);
      read += bytesRead;
    }
    await tar.close(size);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) changed = true;
    const sha256 = hash.digest('hex');
    // Bytes that became a secret's while they were copied are in the file now: the run fails.
    const names = mayBeSecretGeneration(size) ? secretGenerationNames(size, sha256) : null;
    if (names) throw new InstanceBackupError(`The backup did not count: a stored file became the content of ${names.join(', ')} while it was copied. The next run tries again.`);
    return { size, sha256, changed };
  } finally { await handle.close().catch(() => {}); }
}

// ── Retention, recovery, schedule, status ─────────────────────────────

// Newest first in the order the runs counted: a number given in the success
// transaction, never a time, since a clock set back (or a restart after it)
// would otherwise put a new backup behind an old one.
const KEPT_ORDER = 'ORDER BY completion_seq DESC';

/**
 * Marks the oldest succeeded backups beyond the kept count removed, on
 * `connection` inside its transaction, and answers their file names (their
 * files are removed after the commit).
 */
async function markBeyondKept(connection: SqlExecutor, keep: number) {
  const [rows] = await connection.execute<RunRow[]>(`SELECT id, file_name FROM instance_backups WHERE status = 'succeeded' AND removed_at IS NULL
    ${KEPT_ORDER} FOR UPDATE`);
  const beyond = rows.slice(keep);
  for (const row of beyond) await connection.execute('UPDATE instance_backups SET removed_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
  return beyond.map(row => row.file_name).filter((name): name is string => !!name);
}

async function recordSuccess(id: string, file: { name: string; bytes: number; sha256: string; migrationId: number }, settings: { keep: number }) {
  return inTransaction('START TRANSACTION', async connection => {
    // One worker owner runs one backup at a time; the unique key refuses a number given twice.
    const [[next]] = await connection.execute<RowDataPacket[]>('SELECT COALESCE(MAX(completion_seq), 0) + 1 AS seq FROM instance_backups');
    await connection.execute(`UPDATE instance_backups SET status = 'succeeded', file_name = ?, size_bytes = ?, sha256 = ?, migration_id = ?, finished_at = UTC_TIMESTAMP(),
      completion_seq = ? WHERE id = ? AND status = 'running'`, [file.name, file.bytes, file.sha256, file.migrationId, next.seq, id]);
    return markBeyondKept(connection, settings.keep);
  });
}

async function removeBackupFiles(dir: string, names: readonly string[]) {
  let removed = 0;
  for (const name of names) {
    // A name this code did not write is never a path to remove.
    if (!NAME_PATTERN.test(name)) continue;
    await fs.promises.rm(path.join(dir, name), { force: true })
      .then(() => { removed++; }, error => log.error(LOG, 'Could not remove an old backup file; it stays as an orphan', error, { file: name }));
  }
  if (names.length) log.info(LOG, 'Removed backups beyond the kept count', { removed: names.length });
  return removed;
}

/** Removes the oldest succeeded backups beyond the kept count (a run does this as it succeeds). */
async function applyRetention(settings: { dir: string | null; keep: number } = config) {
  if (!settings.dir) return 0;
  const removing = await inTransaction('START TRANSACTION', connection => markBeyondKept(connection, settings.keep));
  await removeBackupFiles(settings.dir, removing);
  return removing.length;
}

/** At the worker owner's start: a run the last process left running failed, and its partial file goes. */
async function recoverInterruptedInstanceBackups() {
  const [result] = await db.execute<ResultSetHeader>(`UPDATE instance_backups SET status = 'failed', finished_at = UTC_TIMESTAMP(),
    error = 'The server stopped during the backup.' WHERE status = 'running'`);
  if (config.dir) {
    const names = await fs.promises.readdir(config.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (name.endsWith(EXTENSION + PARTIAL) && NAME_PATTERN.test(name.slice(0, -PARTIAL.length))) {
        await fs.promises.rm(path.join(config.dir, name), { force: true }).catch(error => log.error(LOG, 'Could not remove a partial backup', error));
      }
    }
  }
  if (result.affectedRows) log.warn(LOG, 'Recorded interrupted runs as failed', { runs: result.affectedRows });
  return result.affectedRows;
}

/** The latest scheduled moment at or before now. */
function latestSlot(now: Date, timeUtc: string) {
  const [hours, minutes] = timeUtc.split(':').map(Number);
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes));
  if (slot > now) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot;
}

function nextRun(now: Date, timeUtc: string) {
  const next = latestSlot(now, timeUtc);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** The schedule's tick (background-work.ts): one scheduled run per day, also when the server was down at the time. */
async function runDueInstanceBackup(now = new Date()) {
  if (!enabled() || current || !isWorkerOwner()) return null;
  const slot = latestSlot(now, config.timeUtc);
  const [[done]] = await db.execute<RowDataPacket[]>("SELECT 1 AS done FROM instance_backups WHERE trigger_kind = 'schedule' AND started_at >= ? LIMIT 1",
    [slot.toISOString().slice(0, 19).replace('T', ' ')]);
  if (done) return null;
  return runInstanceBackup({ trigger: 'schedule' }).catch(error => {
    if ((error as { code?: string }).code !== 'INSTANCE_BACKUP_RUNNING') throw error;
    return null;
  });
}

/**
 * One snapshot of the instance backup: every row read in one consistent
 * read, and running while this process still has a run going (until its
 * retention has removed the old files) or the database shows one.
 */
async function getInstanceBackupStatus(now = new Date()): Promise<InstanceBackupStatus> {
  const on = enabled();
  const active = current !== null;
  const { rows, success, kept, runningRows } = await inTransaction(SNAPSHOT, async connection => {
    const [runs] = await connection.execute<RunRow[]>(`SELECT b.*, u.email AS actor_email FROM instance_backups b LEFT JOIN users u ON u.id = b.actor_id
      ORDER BY b.started_at DESC, b.id DESC LIMIT ${RUNS_SHOWN}`);
    const [[latest]] = await connection.execute<RunRow[]>(`SELECT b.*, u.email AS actor_email FROM instance_backups b LEFT JOIN users u ON u.id = b.actor_id
      WHERE b.status = 'succeeded' ORDER BY b.completion_seq DESC LIMIT 1`);
    const [[keptRow]] = await connection.execute<RowDataPacket[]>(`SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM instance_backups
      WHERE status = 'succeeded' AND removed_at IS NULL`);
    const [[running]] = await connection.execute<RowDataPacket[]>("SELECT COUNT(*) AS count FROM instance_backups WHERE status = 'running'");
    return { rows: runs, success: latest as RunRow | undefined, kept: keptRow, runningRows: running };
  });
  return {
    enabled: on,
    missing: [...config.missing],
    destination: config.dir,
    key_fingerprint: on ? keyFingerprint(config.key!) : null,
    time_utc: config.timeUtc,
    keep: config.keep,
    next_run_at: on ? nextRun(now, config.timeUtc).toISOString() : null,
    last_run: rows[0] ? serializeRun(rows[0]) : null,
    last_success: success ? serializeRun(success) : null,
    kept: { count: Number(kept.count), bytes: Number(kept.bytes) },
    running: active || current !== null || Number(runningRows.count) > 0,
    runs: rows.map(serializeRun),
    restore_command: RESTORE_COMMAND,
  };
}

export {
  ROOT_NAMES as INSTANCE_BACKUP_ROOTS,
  RESTORE_COMMAND as INSTANCE_RESTORE_COMMAND,
  InstanceBackupError,
  fileRemovalGate,
  fileRoots,
  leftOut,
  useInstanceBackupConfig,
  instanceBackupSetupErrors,
  startInstanceBackup,
  runInstanceBackup,
  stopInstanceBackup,
  runDueInstanceBackup,
  recoverInterruptedInstanceBackups,
  applyRetention,
  getInstanceBackupStatus,
  latestSlot,
  nextRun,
  spawnClient,
};
