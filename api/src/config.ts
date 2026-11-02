import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// F10: every secret can be given as a file (NAME_FILE, for example a Docker
// or Compose secret under /run/secrets) or as the variable NAME. The file
// wins; setting both to different values is refused rather than guessed. One
// trailing line break is part of how files are written, not of the secret.
// Messages name the variable and the file, never a value.
const MAX_SECRET_FILE_BYTES = 64 * 1024;

class SecretConfigError extends Error {}

/** A secret file that is not a regular file, or larger than a secret can be. */
class SecretFileShapeError extends Error {
  constructor(readonly reason: 'not a file' | 'too large') { super(reason); }
}

/**
 * Reads a secret file through one descriptor: opened without blocking (a FIFO
 * or a device answers at once instead of hanging the process), refused unless
 * it is a regular file, and read to at most one byte past the bound, so what
 * is checked is what is read. System errors (ENOENT, EACCES) are thrown as they are.
 */
function readSecretFile(file: string): { bytes: Buffer; dev: number; ino: number } {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new SecretFileShapeError('not a file');
    const buffer = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length > MAX_SECRET_FILE_BYTES) throw new SecretFileShapeError('too large');
    return { bytes: Buffer.from(buffer.subarray(0, length)), dev: stat.dev, ino: stat.ino };
  } finally {
    fs.closeSync(descriptor);
  }
}

// Every generation of a secret file this process has seen, by size and
// SHA-256, never the bytes: what readSecret read and what each instance
// backup run finds at its start and end (instance-backup.ts). The backup
// leaves out a stored file of the same size and hash, so a copy or hard link
// of any of them among the stored files stays out of every later backup.
// Never pruned while the process lives. An empty file is no secret.
interface SecretGeneration { names: Set<string>; size: number; sha256: string }
const secretGenerations = new Map<string, SecretGeneration>();
const secretGenerationSizes = new Set<number>();

function rememberSecretGeneration(name: string, bytes: Buffer) {
  if (!bytes.length) return;
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const known = secretGenerations.get(`${bytes.length}:${sha256}`);
  if (known) known.names.add(name);
  else secretGenerations.set(`${bytes.length}:${sha256}`, { names: new Set([name]), size: bytes.length, sha256 });
  secretGenerationSizes.add(bytes.length);
}

/** Whether a stored file of `size` bytes could be a secret generation (then its hash decides). */
function mayBeSecretGeneration(size: number) {
  return secretGenerationSizes.has(size);
}

/** The settings whose secret files had these bytes, or null. */
function secretGenerationNames(size: number, sha256: string): string[] | null {
  const known = secretGenerations.get(`${size}:${sha256}`);
  return known ? [...known.names] : null;
}

function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (!file) return direct;
  let value: string;
  try {
    // Bounded and without blocking, like the instance backup's sample.
    const { bytes } = readSecretFile(file);
    value = bytes.toString('utf8').replace(/\r?\n$/, '');
    if (env === process.env) rememberSecretGeneration(`${name}_FILE`, bytes);
  } catch (error) {
    if (error instanceof SecretFileShapeError) {
      throw new SecretConfigError(error.reason === 'not a file' ? `${name}_FILE (${file}) is not a file.` : `${name}_FILE (${file}) is larger than a secret can be.`);
    }
    const code = (error as NodeJS.ErrnoException).code;
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    throw new SecretConfigError(code === 'ENOENT' ? `${name}_FILE (${file}) does not exist.`
      : code === 'EACCES' ? `${name}_FILE (${file}) cannot be read${uid === null ? '' : ` by uid ${uid}, which runs the API`}.`
        : code === 'EISDIR' ? `${name}_FILE (${file}) is not a file.`
          : `${name}_FILE (${file}) cannot be read (${code || 'error'}).`);
  }
  if (!value) throw new SecretConfigError(`${name}_FILE (${file}) is empty.`);
  if (direct && direct !== value) throw new SecretConfigError(`${name} and ${name}_FILE are both set and differ; set only one.`);
  return value;
}

// What startup refuses (assertConfiguration): collected here, because a
// module-level constant cannot throw without hiding every other problem.
const CONFIG_ERRORS: string[] = [];
function secret(name: string) {
  try {
    return readSecret(name);
  } catch (error) {
    CONFIG_ERRORS.push((error as Error).message);
    return undefined;
  }
}

const PORT = process.env.PORT || 4000;
// Unset (the image) listens on every interface of the container; a host run
// such as tools/e2e sets 127.0.0.1 so the API is reachable only through nginx.
const API_LISTEN_HOST = process.env.API_LISTEN_HOST || undefined;
const JWT_SECRET = secret('JWT_SECRET');
const ENCRYPTION_KEY = secret('ENCRYPTION_KEY');
// The key before the last change: stored values encrypted with it stay readable.
const ENCRYPTION_KEY_PREVIOUS = secret('ENCRYPTION_KEY_PREVIOUS') || '';
// Installations without their own backup key seal user backups with
// ENCRYPTION_KEY, as before 0.28. The instance backup key never falls back.
const BACKUP_MASTER_KEY_SET = secret('BACKUP_MASTER_KEY') || '';
const BACKUP_MASTER_KEY = BACKUP_MASTER_KEY_SET || ENCRYPTION_KEY;
const BOOTSTRAP_ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
const BOOTSTRAP_ADMIN_PASSWORD = secret('BOOTSTRAP_ADMIN_PASSWORD') || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const TRUST_PROXY_HEADERS = process.env.TRUST_PROXY_HEADERS === 'true';
const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXY_CIDRS || '127.0.0.1/32,::1/128')
  .split(',').map(value => value.trim()).filter(Boolean);
const TRUSTED_MAIL_HOSTS = (process.env.TRUSTED_MAIL_HOSTS || '')
  .split(',')
  .map(host => host.trim().toLowerCase())
  .filter(Boolean);
const CALENDAR_MULTI_ENABLED = process.env.CALENDAR_MULTI_ENABLED !== 'false';
const AUTH_COOKIE_NAME = 'auth-token';
// Secure cookies need HTTPS; local HTTP development starts the API without
// NODE_ENV=production. The image sets it (Dockerfile).
const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const MIN_PASSWORD_LENGTH = 12;
const BACKUP_UPLOAD_MAX_SIZE = 3900 * 1024 * 1024;
// A 25 MiB attachment payload expands to roughly 33.4 MiB when base64 encoded.
// Leave room for JSON metadata and the message body as well.
const MAIL_COMPOSE_REQUEST_MAX_SIZE = 40 * 1024 * 1024;

// ── Instance backup (D4, services/instance-backup.ts) ─────────────────
// Configured only here, from the environment: a compromised admin session
// cannot redirect backups or read the key. Without a destination and a key
// the instance backup is off and the server runs normally; the server never
// makes a key up.
// D35, waiting for the maintainer: the default time of the daily run (UTC)
// and how many backups are kept. INSTANCE_BACKUP_TIME and _KEEP override them.
const INSTANCE_BACKUP_DEFAULT_TIME_UTC = '03:30';
const INSTANCE_BACKUP_DEFAULT_KEEP = 14;
const INSTANCE_BACKUP_MIN_KEY_BYTES = 32;
const INSTANCE_BACKUP_MAX_KEEP = 1000;

interface InstanceBackupConfig {
  /** Absolute destination directory; null when INSTANCE_BACKUP_DIR is unset. */
  dir: string | null;
  /** The decoded key; null when neither INSTANCE_BACKUP_KEY nor its file is set. */
  key: Buffer | null;
  /** "HH:MM", UTC. */
  timeUtc: string;
  keep: number;
  /** What an enabled backup lacks. */
  missing: ('destination' | 'key')[];
  /** Refused settings: startup stops on them. */
  errors: string[];
}

// The spellings a key is accepted in, in the order a key text is read:
// hex, then base64, whose decoder takes the base64url letters as well (and
// so a text mixing both). decodeKeyText and keyReadings share this one rule.
const KEY_SPELLINGS: readonly { pattern: RegExp; encoding: BufferEncoding }[] = [
  { pattern: /^(?:[0-9a-f]{2})+$/i, encoding: 'hex' },
  { pattern: /^[A-Za-z0-9+/_-]+={0,2}$/, encoding: 'base64' },
];

function spelledKeys(text: string): Buffer[] {
  return KEY_SPELLINGS.filter(spelling => spelling.pattern.test(text)).map(spelling => Buffer.from(text, spelling.encoding));
}

/**
 * Every way a secret's text can be taken as key bytes: the text itself (as
 * given and trimmed) and each accepted spelling it is valid for. A key is
 * another secret when any reading of one is a reading of the other.
 */
function keyReadings(value: string): Buffer[] {
  const readings: Buffer[] = [];
  for (const text of new Set([value, value.trim()])) {
    if (!text) continue;
    readings.push(Buffer.from(text, 'utf8'), ...spelledKeys(text));
  }
  return readings.filter(reading => reading.length);
}

/** 32 random bytes or more, written as hex or base64 (base64url too). */
function decodeKeyText(value: string): Buffer | null {
  return spelledKeys(value.trim())[0] ?? null;
}

function parseInstanceBackupConfig(env: NodeJS.ProcessEnv = process.env, others: Record<string, string | undefined> | null = null): InstanceBackupConfig {
  const errors: string[] = [];
  const dirText = (env.INSTANCE_BACKUP_DIR || '').trim();
  let dir: string | null = null;
  if (dirText) {
    if (!path.isAbsolute(dirText)) errors.push('INSTANCE_BACKUP_DIR must be an absolute path.');
    else dir = path.resolve(dirText);
  }
  let keyText: string | undefined;
  try { keyText = readSecret('INSTANCE_BACKUP_KEY', env); } catch (error) { errors.push((error as Error).message); }
  let key: Buffer | null = null;
  if (keyText) {
    const decoded = decodeKeyText(keyText);
    if (!decoded || decoded.length < INSTANCE_BACKUP_MIN_KEY_BYTES) {
      errors.push(`INSTANCE_BACKUP_KEY must be at least ${INSTANCE_BACKUP_MIN_KEY_BYTES} random bytes written as hex or base64 (for example: openssl rand -base64 48).`);
    } else {
      // F10: the instance key protects a copy of everything; one leaked
      // secret must not open both the installation and its backups.
      // A key written another way is the same key: base64(ENCRYPTION_KEY),
      // or a hex secret's base64 reading written as hex. Every reading of the
      // instance key is compared with every reading of each other secret.
      const mine = [decoded, ...keyReadings(keyText)];
      const sameKey = (other: string) => keyReadings(other).some(theirs => mine.some(reading => reading.equals(theirs)));
      const reused = Object.entries(others ?? {
        JWT_SECRET, ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS, BACKUP_MASTER_KEY: BACKUP_MASTER_KEY_SET,
      }).filter(([, other]) => other && sameKey(other)).map(([name]) => name);
      if (reused.length) errors.push(`INSTANCE_BACKUP_KEY must be its own key, not the value of ${reused.join(' or ')}.`);
      else key = decoded;
    }
  }
  const timeUtc = (env.INSTANCE_BACKUP_TIME || '').trim() || INSTANCE_BACKUP_DEFAULT_TIME_UTC;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeUtc)) errors.push('INSTANCE_BACKUP_TIME must be HH:MM (24-hour, UTC).');
  const keepText = (env.INSTANCE_BACKUP_KEEP || '').trim();
  let keep = keepText ? Number(keepText) : INSTANCE_BACKUP_DEFAULT_KEEP;
  if (!/^\d+$/.test(keepText || '0') || !Number.isSafeInteger(keep) || keep < 1 || keep > INSTANCE_BACKUP_MAX_KEEP) {
    errors.push(`INSTANCE_BACKUP_KEEP must be a whole number from 1 to ${INSTANCE_BACKUP_MAX_KEEP}.`);
    keep = INSTANCE_BACKUP_DEFAULT_KEEP;
  }
  const missing: InstanceBackupConfig['missing'] = [];
  if (!dirText) missing.push('destination');
  if (!keyText) missing.push('key');
  return { dir, key, timeUtc, keep, missing, errors };
}

const INSTANCE_BACKUP = parseInstanceBackupConfig();

/** Throws one error naming every refused setting; nothing when the configuration is usable. */
function assertConfiguration(extra: readonly string[] = []) {
  const problems = [...CONFIG_ERRORS, ...INSTANCE_BACKUP.errors, ...extra];
  if (problems.length) throw new Error(`Configuration refused:\n- ${problems.join('\n- ')}`);
}

export {
  PORT,
  API_LISTEN_HOST,
  JWT_SECRET,
  ENCRYPTION_KEY,
  ENCRYPTION_KEY_PREVIOUS,
  BACKUP_MASTER_KEY,
  BOOTSTRAP_ADMIN_EMAIL,
  BOOTSTRAP_ADMIN_PASSWORD,
  ALLOWED_ORIGINS,
  TRUST_PROXY_HEADERS,
  TRUSTED_PROXY_CIDRS,
  TRUSTED_MAIL_HOSTS,
  CALENDAR_MULTI_ENABLED,
  AUTH_COOKIE_NAME,
  COOKIE_SECURE,
  MIN_PASSWORD_LENGTH,
  BACKUP_UPLOAD_MAX_SIZE,
  MAIL_COMPOSE_REQUEST_MAX_SIZE,
  INSTANCE_BACKUP_DEFAULT_TIME_UTC,
  INSTANCE_BACKUP_DEFAULT_KEEP,
  INSTANCE_BACKUP,
  SecretConfigError,
  MAX_SECRET_FILE_BYTES,
  readSecretFile,
  readSecret,
  rememberSecretGeneration,
  mayBeSecretGeneration,
  secretGenerationNames,
  keyReadings,
  decodeKeyText,
  parseInstanceBackupConfig,
  assertConfiguration,
};
export type { InstanceBackupConfig };
