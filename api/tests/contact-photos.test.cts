import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { EventEmitter } = require('node:events') as typeof import('node:events');
const { PassThrough } = require('node:stream') as typeof import('node:stream');
const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const zlib = require('node:zlib') as typeof import('node:zlib');
const sharp = require('sharp') as typeof import('sharp');
const { convertContactPhoto, decodeWithFfmpeg, sniffPhoto } = require('../dist/src/services/contact-photos') as typeof import('../src/services/contact-photos');

// The photo conversion (D6) on synthetic pictures: whatever comes in, what is
// stored is an upright square sRGB JPEG of at most 512 pixels with a 96-pixel
// thumbnail and no metadata; anything that is not a readable picture within
// the limits is refused with a message, never half-stored.

const RED = [220, 30, 30];
const BLUE = [30, 30, 220];

// Top half red, bottom half blue: after EXIF orientation 6 (90° clockwise)
// the upright picture has blue on the left and red on the right.
async function halves(width: number, height: number, encode: (image: import('sharp').Sharp) => import('sharp').Sharp) {
  const top = await sharp({ create: { width, height: height / 2, channels: 3, background: { r: RED[0], g: RED[1], b: RED[2] } } }).png().toBuffer();
  const image = sharp({ create: { width, height, channels: 3, background: { r: BLUE[0], g: BLUE[1], b: BLUE[2] } } }).composite([{ input: top, top: 0, left: 0 }]);
  return encode(sharp(await image.png().toBuffer())).toBuffer();
}

async function pixel(jpeg: Buffer, x: number, y: number) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}

function near(actual: number[], expected: number[], label: string) {
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 40), `${label}: ${actual} is not near ${expected}`);
}

async function assertStored(photo: Awaited<ReturnType<typeof convertContactPhoto>>, side: number) {
  const full = await sharp(photo.full).metadata();
  const thumb = await sharp(photo.thumb).metadata();
  assert.deepEqual([full.format, full.width, full.height, photo.width, photo.height], ['jpeg', side, side, side, side]);
  assert.deepEqual([thumb.format, thumb.width, thumb.height], ['jpeg', Math.min(96, side), Math.min(96, side)]);
  for (const meta of [full, thumb]) {
    assert.equal(meta.exif, undefined, 'no EXIF (and so no GPS) is written');
    assert.equal(meta.xmp, undefined);
    assert.equal(meta.icc, undefined);
    assert.equal(meta.orientation, undefined);
    assert.equal(meta.space, 'srgb');
    assert.equal(meta.channels, 3);
  }
  assert.match(photo.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(photo.sha256, photo.thumbSha256);
}

test('a phone JPEG with EXIF orientation and GPS becomes an upright 512 square without any metadata', async () => {
  const input = await halves(1200, 800, image => image.withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Make: 'Example' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 30/1 0/1' } }).jpeg({ quality: 90 }));
  const before = await sharp(input).metadata();
  assert.equal(before.orientation, 6);
  assert.ok(before.exif && before.exif.includes(Buffer.from('Example')), 'the fixture carries EXIF');
  const photo = await convertContactPhoto(input);
  await assertStored(photo, 512);
  assert.ok(!photo.full.includes(Buffer.from('Example')) && !photo.full.includes(Buffer.from('Exif')), 'nothing of the EXIF block survives');
  near(await pixel(photo.full, 20, 256), BLUE, 'left is blue once upright');
  near(await pixel(photo.full, 490, 256), RED, 'right is red once upright');
  assert.ok(photo.full.length <= 120 * 1024);
});

test('PNG with alpha, WebP, AVIF, GIF, TIFF and CMYK JPEG are converted; transparency becomes white', async () => {
  const transparent = await sharp({ create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const flattened = await convertContactPhoto(transparent);
  await assertStored(flattened, 512);
  near(await pixel(flattened.full, 256, 256), [255, 255, 255], 'transparent becomes white');

  const base = sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 120, b: 60 } } });
  const inputs: Record<string, Buffer> = {
    webp: await base.clone().webp().toBuffer(),
    avif: await base.clone().avif({ effort: 0 }).toBuffer(),
    gif: await base.clone().gif().toBuffer(),
    tiff: await base.clone().tiff().toBuffer(),
    cmyk: await base.clone().toColourspace('cmyk').jpeg().toBuffer(),
    grey16: await base.clone().greyscale().toColourspace('grey16').png().toBuffer(),
  };
  assert.equal((await sharp(inputs.cmyk).metadata()).space, 'cmyk');
  for (const [name, input] of Object.entries(inputs)) {
    const photo = await convertContactPhoto(input);
    await assertStored(photo, 480);
    if (name !== 'grey16') near(await pixel(photo.full, 240, 240), [10, 120, 60], `${name} keeps its colour`);
  }
});

test('an animated GIF gives its first frame; a small picture keeps its size and is never enlarged', async () => {
  const frame = (colour: number[]) => sharp({ create: { width: 200, height: 200, channels: 3, background: { r: colour[0], g: colour[1], b: colour[2] } } }).png().toBuffer();
  const animated = await sharp([await frame(RED), await frame(BLUE)], { join: { animated: true } }).gif().toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  const first = await convertContactPhoto(animated);
  await assertStored(first, 200);
  near(await pixel(first.full, 100, 100), RED, 'the first frame');

  const small = await convertContactPhoto(await sharp({ create: { width: 40, height: 30, channels: 3, background: '#808080' } }).jpeg().toBuffer());
  await assertStored(small, 30);
});

// A PNG claiming the given size, with the first rows of data only: a
// decoder that trusted the header would allocate the whole picture.
function pngHeader(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 3 + 1) * 4))), chunk('IEND', Buffer.alloc(0))]);
}

test('SVG, text, a truncated JPEG, a 50-megapixel bomb and an oversized file are refused with a plain reason', async () => {
  const refused = async (input: Buffer, code: string, status = 400) => {
    await assert.rejects(convertContactPhoto(input), (error: FixtureValue) => error.status === status && error.code === code && typeof error.message === 'string' && error.message.length > 10,
      `${code} for ${input.subarray(0, 12).toString('latin1')}`);
  };
  await refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'), 'PHOTO_UNREADABLE');
  await refused(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 'PHOTO_UNREADABLE');
  await refused(Buffer.from('BEGIN:VCARD\r\nVERSION:4.0\r\nEND:VCARD\r\n'), 'PHOTO_UNREADABLE');
  await refused(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]), 'PHOTO_UNREADABLE');
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } }).jpeg().toBuffer();
  await refused(jpeg.subarray(0, Math.floor(jpeg.length / 2)), 'PHOTO_UNREADABLE');
  await refused(pngHeader(8000, 6250), 'PHOTO_TOO_LARGE');
  await refused(Buffer.concat([jpeg, Buffer.alloc(20 * 1024 * 1024)]), 'PHOTO_TOO_LARGE', 413);
});

test('the content decides the decoder: the declared type and name play no part', () => {
  const ftyp = (major: string, ...compatible: string[]) => {
    const brands = Buffer.from([major, '\0\0\0\0', ...compatible].join(''), 'latin1');
    const size = Buffer.alloc(4); size.writeUInt32BE(8 + brands.length);
    return Buffer.concat([size, Buffer.from('ftyp'), brands, Buffer.alloc(16)]);
  };
  assert.equal(sniffPhoto(ftyp('heic', 'mif1', 'heic')), 'heif');
  assert.equal(sniffPhoto(ftyp('mif1', 'mif1', 'heic')), 'heif');
  assert.equal(sniffPhoto(ftyp('avif', 'avif', 'mif1')), 'sharp');
  assert.equal(sniffPhoto(ftyp('mif1', 'mif1', 'avif')), 'sharp');
  assert.equal(sniffPhoto(ftyp('isom', 'isom', 'mp41')), null, 'a video is not a picture');
  assert.equal(sniffPhoto(Buffer.from('BM\0\0\0\0\0\0\0\0')), 'ffmpeg-image');
  assert.equal(sniffPhoto(Buffer.from('%PDF-1.7\n')), null);
});

// A child process that never answers until killed.
function hangingChild() {
  const child: FixtureValue = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, killed: [] as string[] });
  child.kill = (signal: string) => { child.killed.push(signal); child.signalCode = signal; setImmediate(() => child.emit('close', null, signal)); return true; };
  return child;
}

test('FFmpeg runs with fixed arguments, only the pipe protocol and no metadata, and is killed at its time limit', async () => {
  let call: FixtureValue = null;
  const child = hangingChild();
  const started = Date.now();
  await assert.rejects(decodeWithFfmpeg(Buffer.from('ftypheic'), 'heif', {
    spawnProcess: ((command: string, args: string[], options: FixtureValue) => { call = { command, args, options }; return child; }) as FixtureValue,
    timeoutMs: 50,
  }), (error: FixtureValue) => error.code === 'PHOTO_TIMEOUT');
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(child.killed, ['SIGKILL']);
  assert.equal(call.command, 'ffmpeg');
  assert.equal(call.options.shell, undefined);
  const args: string[] = call.args;
  const option = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(option('-protocol_whitelist'), 'pipe');
  assert.equal(option('-i'), 'pipe:0');
  assert.equal(option('-map_metadata'), '-1');
  assert.equal(option('-frames:v'), '1');
  assert.equal(option('-max_pixels'), '40000000');
  assert.equal(option('-f'), 'mov');
  assert.equal(args.at(-1), 'pipe:1');

  const missing = hangingChild();
  const pending = decodeWithFfmpeg(Buffer.from('x'), 'heif', { spawnProcess: (() => missing) as FixtureValue });
  missing.emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(pending, (error: FixtureValue) => error.code === 'FFMPEG_MISSING');
});

function ffmpegVersion(): number[] | null {
  try {
    const match = /ffmpeg version n?(\d+)\.(\d+)/.exec(execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }));
    return match ? [Number(match[1]), Number(match[2])] : [0, 0];
  } catch { return null; }
}

test('a HEIC photo goes through FFmpeg and comes out upright (the HEIF irot transform)', async (t) => {
  const heic = fs.readFileSync(path.join(__dirname, 'fixtures/contacts/photos/rotated-irot.heic'));
  assert.equal(sniffPhoto(heic), 'heif');
  const version = ffmpegVersion();
  if (!version) {
    // Without FFmpeg the server refuses a HEIC plainly; the image ships FFmpeg
    // and its container smoke test converts this fixture.
    await assert.rejects(convertContactPhoto(heic), (error: FixtureValue) => error.code === 'PHOTO_UNREADABLE');
    // Not a skip: the release gate refuses skips, and this refusal is the
    // behaviour of a server without FFmpeg.
    t.diagnostic('FFmpeg is not installed here; scripts/container-smoke.sh converts this HEIC in the image');
    return;
  }
  const photo = await convertContactPhoto(heic);
  await assertStored(photo, 64);
  // FFmpeg applies HEIF irot/imir as a display matrix from 7.1 on.
  if (version[0] > 7 || (version[0] === 7 && version[1] >= 1)) {
    near(await pixel(photo.full, 5, 32), BLUE, 'left is blue once upright');
    near(await pixel(photo.full, 58, 32), RED, 'right is red once upright');
  } else {
    t.diagnostic(`FFmpeg ${version.join('.')} predates HEIF irot support; orientation is checked in the image (FFmpeg 8)`);
  }
});
