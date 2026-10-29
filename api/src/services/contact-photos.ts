// Contact photos (D6): the server turns any reasonable picture into one
// square JPEG of at most 512 pixels and a 96-pixel thumbnail; nobody crops or
// adjusts anything. Both are content-addressed files under
// <CONTACT_PHOTOS_ROOT>/<user_id>/<sha256>.jpg, referenced by contact_photos.
// The original bytes are never kept. sharp (libvips) decodes and encodes;
// HEIC/HEIF and the other formats sharp's prebuilt libvips cannot read go
// through the image's FFmpeg as a separate, bounded process.
//
// Order of a change: convert, write the new files (temporary name, then
// rename), commit the row, and only then delete files no row references any
// more. A failure before the commit leaves the old photo as it was; a lost
// commit outcome keeps every file. One in-process lock per user serializes
// these steps with each other and with the orphan sweep, so a delete never
// removes a file another upload of the same picture has just referenced.
import type { RowDataPacket } from 'mysql2/promise';
import type { SqlExecutor } from '../types';
import type { ContactPhoto } from '../contracts/contacts';
import type { Metadata, OutputInfo } from 'sharp';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { db } from '../state';
import { ApiError, badRequest, notFound } from '../http/errors';
import { log } from '../log';
import { withTransaction } from './transactions';
import { getActiveRestoreSections } from './restore-locks';

const PHOTO_SIZE = 512;
const THUMB_SIZE = 96;
// What an upload or an imported PHOTO may be before conversion.
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
// Decompression bombs: refused from the header, before pixels are decoded.
const MAX_INPUT_PIXELS = 40_000_000;
const CONVERT_TIMEOUT_MS = 10_000;
// The full photo steps down in quality when q82 is larger than this.
const FULL_TARGET_BYTES = 120 * 1024;
// FFmpeg hands sharp a PNG no larger than this box, enough for the crop.
const FFMPEG_BOX = 2048;
const FFMPEG_MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const FFMPEG_MAX_STDERR = 4096;
// Conversions at once in this process; the rest wait their turn.
const CONVERT_SLOTS = 2;
// The sweep leaves files younger than this: an upload may be between its
// rename and its commit.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

const UNREADABLE = 'This picture could not be read. JPEG, PNG, WebP, HEIC, AVIF and GIF work.';
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const USER_ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/;

sharp.concurrency(1);
sharp.cache(false);

type PhotoSize = 'full' | 'thumb';
type PhotoSource = 'upload' | 'import' | 'android' | 'merge' | 'restore';

interface ConvertedPhoto {
  full: Buffer;
  thumb: Buffer;
  sha256: string;
  thumbSha256: string;
  width: number;
  height: number;
}

interface PhotoRow extends RowDataPacket {
  contact_id: string;
  sha256: string;
  thumb_sha256: string;
  width: number;
  height: number;
}

function photosRoot() {
  return path.resolve(process.env.CONTACT_PHOTOS_ROOT || '/app/uploads/contact-photos');
}

// The one place a photo path is built: a user id and a sha are checked against
// their patterns, and the result must stay inside the root.
function photoPath(userId: string, sha: string) {
  if (!USER_ID_PATTERN.test(userId) || !SHA_PATTERN.test(sha)) throw new Error('Invalid contact photo reference');
  const root = photosRoot();
  const target = path.resolve(root, userId, `${sha}.jpg`);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Contact photo path outside its root');
  return target;
}

// A user directory that is a symlink (or anything but a directory) is refused,
// so a planted link cannot point writes or reads elsewhere.
async function userDirectory(userId: string, { create }: { create: boolean }) {
  const dir = path.dirname(photoPath(userId, '0'.repeat(64)));
  if (create) await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(dir).catch(() => null);
  if (!stat) return null;
  if (!stat.isDirectory()) throw new Error('Contact photo directory is not a directory');
  return dir;
}

// ── Conversion ─────────────────────────────────────────────────────────

const unreadable = () => badRequest('PHOTO_UNREADABLE', UNREADABLE);

type SniffedKind = 'sharp' | 'heif' | 'ffmpeg-image';

// Decides from the content alone, never from a name or a declared type. SVG
// and every other text format are refused here and never reach a decoder.
function sniff(bytes: Buffer): SniffedKind | null {
  const startsWith = (...values: number[]) => values.every((value, i) => bytes[i] === value);
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('latin1');
  if (startsWith(0xff, 0xd8, 0xff)) return 'sharp'; // JPEG
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'sharp'; // PNG
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'sharp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'sharp';
  if (startsWith(0x49, 0x49, 0x2a, 0x00) || startsWith(0x4d, 0x4d, 0x00, 0x2a)) return 'sharp'; // TIFF
  if (bytes.length >= 16 && ascii(4, 8) === 'ftyp') {
    const boxSize = bytes.readUInt32BE(0);
    const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : 16, 4096);
    const brands = new Set([ascii(8, 12)]);
    for (let offset = 16; offset + 4 <= end; offset += 4) brands.add(ascii(offset, offset + 4));
    // AVIF is decoded by sharp's libheif (AV1); HEVC-coded HEIF goes to FFmpeg.
    if (brands.has('avif') || brands.has('avis')) return 'sharp';
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].some(brand => brands.has(brand))) return 'heif';
    return null;
  }
  if (ascii(0, 2) === 'BM') return 'ffmpeg-image';
  if (startsWith(0x00, 0x00, 0x01, 0x00)) return 'ffmpeg-image'; // ICO
  if (startsWith(0xff, 0x0a) || startsWith(0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20)) return 'ffmpeg-image'; // JPEG XL
  return null;
}

// FFmpeg reads the picture from stdin and writes one PNG frame to stdout.
// Arguments are a fixed list (no shell, nothing from the request); only the
// pipe protocol is allowed, so a crafted file cannot reach the network or
// another file. Display-matrix rotation (HEIF irot/imir) is applied by
// FFmpeg's autorotate; metadata is dropped.
function decodeWithFfmpeg(input: Buffer, kind: 'heif' | 'ffmpeg-image', { spawnProcess = spawn, timeoutMs = CONVERT_TIMEOUT_MS } = {}): Promise<Buffer> {
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'pipe',
    '-threads', '2',
    '-max_pixels', String(MAX_INPUT_PIXELS),
    '-f', kind === 'heif' ? 'mov' : 'image2pipe',
    '-i', 'pipe:0',
    '-frames:v', '1', '-an', '-sn', '-dn',
    '-map_metadata', '-1',
    '-vf', `scale=w='min(iw,${FFMPEG_BOX})':h='min(ih,${FFMPEG_BOX})':force_original_aspect_ratio=decrease`,
    '-f', 'image2pipe', '-c:v', 'png', '-compression_level', '1',
    'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    const child = spawnProcess('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (error: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('FFmpeg timed out'), { code: 'PHOTO_TIMEOUT' })), timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > FFMPEG_MAX_OUTPUT_BYTES) { finish(new Error('FFmpeg output exceeds its limit')); return; }
      chunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => { if (stderr.length < FFMPEG_MAX_STDERR) stderr += chunk.toString('utf8').slice(0, FFMPEG_MAX_STDERR - stderr.length); });
    // FFmpeg may stop reading early (one frame); a broken pipe is not a failure by itself.
    child.stdin!.on('error', () => {});
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' ? Object.assign(new Error('FFmpeg is not installed'), { code: 'FFMPEG_MISSING' }) : error);
    });
    child.on('close', (code) => {
      if (code === 0 && outputBytes > 0) finish(null, Buffer.concat(chunks));
      else finish(new Error(stderr.trim() || `FFmpeg exited with code ${code}`));
    });
    child.stdin!.end(input);
  });
}

// Bounded concurrency: each conversion holds up to the input, a decoded frame
// and the encoder buffers, so only CONVERT_SLOTS run at once.
let activeConversions = 0;
const waiting: (() => void)[] = [];
async function withConversionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeConversions >= CONVERT_SLOTS) await new Promise<void>(resolve => waiting.push(resolve));
  activeConversions++;
  try { return await work(); } finally {
    activeConversions--;
    waiting.shift()?.();
  }
}

const SHARP_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif']);

async function encodeSquare(input: Buffer): Promise<ConvertedPhoto> {
  const options = { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true, pages: 1, page: 0 } as const;
  let metadata: Metadata;
  try { metadata = await sharp(input, options).metadata(); } catch (error) { throw classify(error); }
  if (!metadata.format || !SHARP_FORMATS.has(metadata.format) || !metadata.width || !metadata.height) throw unreadable();
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) throw tooManyPixels();
  // Square, never enlarged: a small picture keeps its own size.
  const side = Math.min(PHOTO_SIZE, metadata.width, metadata.height);
  let square: { data: Buffer; info: OutputInfo };
  try {
    square = await sharp(input, options)
      .rotate()
      .resize(side, side, { fit: 'cover', position: sharp.strategy.attention })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .removeAlpha()
      .timeout({ seconds: CONVERT_TIMEOUT_MS / 1000 })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) { throw classify(error); }
  const raw = { raw: { width: square.info.width, height: square.info.height, channels: square.info.channels as 3 } };
  const jpeg = (quality: number, size?: number) => {
    const image = sharp(square.data, raw);
    if (size) image.resize(size, size, { withoutEnlargement: true });
    // sharp writes no metadata unless asked: no EXIF, GPS, XMP or ICC.
    return image.jpeg({ quality, progressive: true, chromaSubsampling: '4:2:0' }).toBuffer();
  };
  let full = await jpeg(82);
  if (full.length > FULL_TARGET_BYTES) full = await jpeg(70);
  const thumb = await jpeg(80, THUMB_SIZE);
  return {
    full, thumb,
    sha256: crypto.createHash('sha256').update(full).digest('hex'),
    thumbSha256: crypto.createHash('sha256').update(thumb).digest('hex'),
    width: square.info.width, height: square.info.height,
  };
}

const tooManyPixels = () => badRequest('PHOTO_TOO_LARGE', `This picture is too large. Pictures of up to ${MAX_INPUT_PIXELS / 1_000_000} megapixels work.`);

function classify(error: unknown) {
  if (error instanceof ApiError) return error;
  const message = String((error as Error)?.message || '');
  if (/pixel limit/i.test(message)) return tooManyPixels();
  if (/timeout/i.test(message)) return badRequest('PHOTO_TIMEOUT', 'This picture took too long to convert. Try a smaller one.');
  return unreadable();
}

/**
 * Converts a picture (the bytes as uploaded or imported) to the stored square
 * JPEG and thumbnail. Throws a 400 ApiError for anything that is not a
 * readable picture within the limits; never keeps the input.
 */
async function convertContactPhoto(input: Buffer): Promise<ConvertedPhoto> {
  if (input.length > MAX_INPUT_BYTES) throw new ApiError(413, 'PHOTO_TOO_LARGE', `This picture is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB.`);
  const kind = sniff(input);
  if (!kind) throw unreadable();
  return withConversionSlot(async () => {
    if (kind === 'sharp') return encodeSquare(input);
    let decoded: Buffer;
    try {
      decoded = await decodeWithFfmpeg(input, kind);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'FFMPEG_MISSING') log.warn('contacts', 'A HEIC or other FFmpeg-decoded photo arrived but FFmpeg is not installed');
      if (code === 'PHOTO_TIMEOUT') throw classify(new Error('timeout'));
      throw unreadable();
    }
    return encodeSquare(decoded);
  });
}

async function readUpload(filePath: string) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_INPUT_BYTES) throw new ApiError(413, 'PHOTO_TOO_LARGE', `This picture is larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB.`);
  return fs.promises.readFile(filePath);
}

// ── Files and the per-user lock ────────────────────────────────────────

const userLocks = new Map<string, Promise<unknown>>();

/** Runs `work` alone among this user's photo file changes (single API process). */
async function withContactPhotoLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const previous = userLocks.get(userId) || Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(() => {}, () => {});
  userLocks.set(userId, settled);
  try { return await run; } finally {
    if (userLocks.get(userId) === settled) userLocks.delete(userId);
  }
}

async function writeFileAtomically(target: string, bytes: Buffer) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fs.promises.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // Also refreshes the modification time of an identical existing file,
    // which keeps the orphan sweep away from it until the row is committed.
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Writes a converted photo's files. Call inside withContactPhotoLock, before the row is committed. */
async function writePhotoFiles(userId: string, photo: ConvertedPhoto) {
  await userDirectory(userId, { create: true });
  await writeFileAtomically(photoPath(userId, photo.sha256), photo.full);
  await writeFileAtomically(photoPath(userId, photo.thumbSha256), photo.thumb);
}

// Whether any row of the user still names the file: a contact photo, or a bin
// item (merged-away contacts keep their photo until purged). file_refs is
// matched as text so its JSON shape may grow.
async function isReferenced(executor: SqlExecutor, userId: string, sha: string) {
  const [[photo]] = await executor.execute<RowDataPacket[]>(
    'SELECT 1 FROM contact_photos WHERE user_id = ? AND (sha256 = ? OR thumb_sha256 = ?) LIMIT 1', [userId, sha, sha]);
  if (photo) return true;
  const [[binned]] = await executor.execute<RowDataPacket[]>(
    'SELECT 1 FROM bin_items WHERE user_id = ? AND file_refs IS NOT NULL AND CAST(file_refs AS CHAR) LIKE ? LIMIT 1', [userId, `%${sha}%`]);
  return !!binned;
}

/**
 * Deletes the named files that no row references any more. Call inside
 * withContactPhotoLock, after the commit that dropped the references.
 */
async function releasePhotoFiles(userId: string, shas: readonly string[], executor: SqlExecutor = db) {
  for (const sha of new Set(shas)) {
    if (!SHA_PATTERN.test(sha) || await isReferenced(executor, userId, sha)) continue;
    await fs.promises.rm(photoPath(userId, sha), { force: true });
  }
}

// ── Rows ───────────────────────────────────────────────────────────────

async function lockOwnedContact(cx: SqlExecutor, userId: string, contactId: string) {
  const [[contact]] = await cx.execute<RowDataPacket[]>('SELECT id FROM contacts WHERE id = ? AND user_id = ? FOR UPDATE', [contactId, userId]);
  if (!contact) throw notFound('CONTACT_NOT_FOUND', 'Contact not found');
}

async function currentPhoto(cx: SqlExecutor, userId: string, contactId: string) {
  const [[row]] = await cx.execute<PhotoRow[]>(
    'SELECT contact_id, sha256, thumb_sha256, width, height FROM contact_photos WHERE contact_id = ? AND user_id = ?', [contactId, userId]);
  return row || null;
}

/**
 * Points the contact at a converted photo on `cx` (the caller's transaction,
 * which has written the files) and counts it as a change of the contact.
 * Returns the shas the previous photo used, for releasePhotoFiles after commit.
 */
async function attachContactPhoto(cx: SqlExecutor, userId: string, contactId: string, photo: ConvertedPhoto, source: PhotoSource): Promise<string[]> {
  await lockOwnedContact(cx, userId, contactId);
  const previous = await currentPhoto(cx, userId, contactId);
  await cx.execute(`INSERT INTO contact_photos (contact_id, user_id, sha256, width, height, bytes, thumb_sha256, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE sha256 = VALUES(sha256), width = VALUES(width), height = VALUES(height), bytes = VALUES(bytes),
      thumb_sha256 = VALUES(thumb_sha256), source = VALUES(source), created_at = CURRENT_TIMESTAMP`,
  [contactId, userId, photo.sha256, photo.width, photo.height, photo.full.length, photo.thumbSha256, source]);
  await cx.execute('UPDATE contacts SET version = version + 1 WHERE id = ? AND user_id = ?', [contactId, userId]);
  return previous ? [previous.sha256, previous.thumb_sha256] : [];
}

// ── Route operations ───────────────────────────────────────────────────

/** Converts and stores a photo for the user's contact, replacing any earlier one. */
async function setContactPhoto(userId: string, contactId: string, input: Buffer | { path: string }, source: PhotoSource = 'upload'): Promise<ContactPhoto> {
  // Refuse a stranger's or a missing contact before spending a conversion on it.
  const [[owned]] = await db.execute<RowDataPacket[]>('SELECT id FROM contacts WHERE id = ? AND user_id = ?', [contactId, userId]);
  if (!owned) throw notFound('CONTACT_NOT_FOUND', 'Contact not found');
  const photo = await convertContactPhoto(Buffer.isBuffer(input) ? input : await readUpload(input.path));
  return withContactPhotoLock(userId, async () => {
    await writePhotoFiles(userId, photo);
    let previous: string[];
    try {
      previous = await withTransaction(cx => attachContactPhoto(cx, userId, contactId, photo, source));
    } catch (error) {
      // A refusal (the contact is gone) rolled back for sure: its new files go
      // unless another row uses them. Any other failure may hide a commit, so
      // the files stay for the sweep to judge.
      if (error instanceof ApiError) await releasePhotoFiles(userId, [photo.sha256, photo.thumbSha256]).catch(() => {});
      throw error;
    }
    await releasePhotoFiles(userId, previous.filter(sha => sha !== photo.sha256 && sha !== photo.thumbSha256))
      .catch(error => log.warn('contacts', 'Old contact photo files stay until the sweep', {}, error));
    return { etag: photo.sha256, width: photo.width, height: photo.height };
  });
}

/** Removes the contact's photo; answers whether there was one. */
async function removeContactPhoto(userId: string, contactId: string): Promise<boolean> {
  return withContactPhotoLock(userId, async () => {
    const previous = await withTransaction(async cx => {
      await lockOwnedContact(cx, userId, contactId);
      const row = await currentPhoto(cx, userId, contactId);
      if (!row) return null;
      await cx.execute('DELETE FROM contact_photos WHERE contact_id = ? AND user_id = ?', [contactId, userId]);
      await cx.execute('UPDATE contacts SET version = version + 1 WHERE id = ? AND user_id = ?', [contactId, userId]);
      return [row.sha256, row.thumb_sha256];
    });
    if (!previous) return false;
    await releasePhotoFiles(userId, previous)
      .catch(error => log.warn('contacts', 'Removed contact photo files stay until the sweep', {}, error));
    return true;
  });
}

/** The stored file of the user's contact photo, or a 404. */
async function contactPhotoFile(userId: string, contactId: string, size: PhotoSize) {
  const row = await currentPhoto(db, userId, contactId);
  if (!row) throw notFound('PHOTO_NOT_FOUND', 'This contact has no photo');
  const sha = size === 'thumb' ? row.thumb_sha256 : row.sha256;
  const filePath = photoPath(userId, sha);
  const dir = await userDirectory(userId, { create: false });
  const stat = dir ? await fs.promises.lstat(filePath).catch(() => null) : null;
  if (!stat?.isFile()) {
    log.warn('contacts', 'A contact photo row names a missing file', { size });
    throw notFound('PHOTO_NOT_FOUND', 'This contact has no photo');
  }
  return { path: filePath, etag: sha, bytes: stat.size };
}

// ── Orphan sweep (worker owner, daily) ─────────────────────────────────

/**
 * Deletes photo files that no row references and that are older than an
 * hour, for every user without a running contacts restore. Returns the
 * number of files removed. Temporary files left by a crash are removed too.
 */
async function sweepContactPhotos({ now = Date.now(), executor = db as SqlExecutor } = {}) {
  const root = photosRoot();
  const users = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of users) {
    if (!entry.isDirectory() || !USER_ID_PATTERN.test(entry.name)) continue;
    const userId = entry.name;
    const restoring = await getActiveRestoreSections(userId).catch(() => new Set(['*']));
    if (restoring.has('contacts') || restoring.has('*')) continue;
    removed += await withContactPhotoLock(userId, async () => {
      let count = 0;
      const files = await fs.promises.readdir(path.join(root, userId), { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile()) continue;
        const target = path.join(root, userId, file.name);
        const stat = await fs.promises.lstat(target).catch(() => null);
        if (!stat || now - stat.mtimeMs < ORPHAN_MIN_AGE_MS) continue;
        if (file.name.endsWith('.tmp')) { await fs.promises.rm(target, { force: true }); count++; continue; }
        const sha = file.name.endsWith('.jpg') ? file.name.slice(0, -4) : '';
        if (!SHA_PATTERN.test(sha) || await isReferenced(executor, userId, sha)) continue;
        await fs.promises.rm(target, { force: true });
        count++;
      }
      return count;
    });
  }
  return removed;
}

export {
  convertContactPhoto,
  setContactPhoto,
  removeContactPhoto,
  contactPhotoFile,
  attachContactPhoto,
  writePhotoFiles,
  releasePhotoFiles,
  withContactPhotoLock,
  sweepContactPhotos,
  photoPath,
  photosRoot,
  sniff as sniffPhoto,
  decodeWithFfmpeg,
  MAX_INPUT_BYTES as CONTACT_PHOTO_MAX_BYTES,
  MAX_INPUT_PIXELS as CONTACT_PHOTO_MAX_PIXELS,
  PHOTO_SIZE as CONTACT_PHOTO_SIZE,
  THUMB_SIZE as CONTACT_PHOTO_THUMB_SIZE,
};
export type { ConvertedPhoto, PhotoSize, PhotoSource };
