import type {} from 'node:module';
// Run locally with Node, or pipe into a built container with UNIHUB_API_ROOT=/app/api
// and UNIHUB_SMOKE_HEIC_BASE64 (the synthetic fixture rotated-irot.heic). Proves
// in the image that sharp's native musl binary loads and that FFmpeg turns a
// HEIC with an irot transform into an upright picture.
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));
const apiRoot = process.env.UNIHUB_API_ROOT || path.resolve(__dirname, '../../dist');
const sharp = require(require.resolve('sharp', { paths: [apiRoot] })) as typeof import('sharp').default;
const { convertContactPhoto } = require(path.join(apiRoot, 'src/services/contact-photos')) as typeof import('../../src/services/contact-photos');

const RED = [220, 30, 30];
const BLUE = [30, 30, 220];

async function pixel(jpeg: Buffer, x: number, y: number) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}
function near(actual: number[], expected: number[], label: string) {
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 40), `${label}: ${actual} is not near ${expected}`);
}
async function stripped(jpeg: Buffer, side: number, label: string) {
  const meta = await sharp(jpeg).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.exif, meta.icc], ['jpeg', side, side, undefined, undefined], label);
}

async function main() {
  const libc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  console.log(`sharp ${sharp.versions.sharp} with libvips ${sharp.versions.vips} on ${libc ? `glibc ${libc}` : 'musl'} ${process.arch}`);

  const heic = process.env.UNIHUB_SMOKE_HEIC_BASE64
    ? Buffer.from(process.env.UNIHUB_SMOKE_HEIC_BASE64, 'base64')
    : fs.readFileSync(path.resolve(__dirname, '../fixtures/contacts/photos/rotated-irot.heic'));
  const fromHeic = await convertContactPhoto(heic);
  await stripped(fromHeic.full, 64, 'HEIC');
  near(await pixel(fromHeic.full, 5, 32), BLUE, 'HEIC: left is blue once upright');
  near(await pixel(fromHeic.full, 58, 32), RED, 'HEIC: right is red once upright');
  console.log('HEIC (irot) converted upright through FFmpeg');

  const avif = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 10, g: 120, b: 60 } } }).avif({ effort: 0 }).toBuffer();
  const fromAvif = await convertContactPhoto(avif);
  await stripped(fromAvif.full, 480, 'AVIF');
  near(await pixel(fromAvif.full, 240, 240), [10, 120, 60], 'AVIF keeps its colour');
  console.log('AVIF converted through the prebuilt libheif');

  const top = await sharp({ create: { width: 1200, height: 400, channels: 3, background: { r: RED[0], g: RED[1], b: RED[2] } } }).png().toBuffer();
  const halves = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: BLUE[0], g: BLUE[1], b: BLUE[2] } } })
    .composite([{ input: top, top: 0, left: 0 }]).png().toBuffer();
  const phone = await sharp(halves).withMetadata({ orientation: 6 }).withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 30/1 0/1' } }).jpeg().toBuffer();
  const fromPhone = await convertContactPhoto(phone);
  await stripped(fromPhone.full, 512, 'JPEG');
  near(await pixel(fromPhone.full, 20, 256), BLUE, 'JPEG: left is blue once upright');
  console.log('JPEG with EXIF orientation and GPS converted upright without metadata');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
