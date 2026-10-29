import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const sharp = require('sharp') as typeof import('sharp');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Contact photos (D6) through the real request handler and MariaDB: the raw
// upload, conversion, content-addressed files, ETag revalidation, replace and
// delete, the owner scope against a second person, the module switch and a
// running restore, and the orphan sweep.
test('contact photos: upload, formats, refusals, ETag, replace, delete, owner scope, gates and sweep', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-photos-'));
  const saved = { photos: process.env.CONTACT_PHOTOS_ROOT, spool: process.env.UPLOAD_SPOOL_ROOT };
  process.env.CONTACT_PHOTOS_ROOT = path.join(scratch, 'contact-photos');
  process.env.UPLOAD_SPOOL_ROOT = path.join(scratch, 'spool');
  t.after(() => {
    for (const [name, value] of [['CONTACT_PHOTOS_ROOT', saved.photos], ['UPLOAD_SPOOL_ROOT', saved.spool]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const password = 'synthetic-photos-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const name of ['owner', 'stranger']) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name]);
  }
  async function signIn(name: string) {
    const client = api.client();
    const reply = await client.request('POST', '/api/auth/signin', { email: `${name}@example.test`, password });
    assert.equal(reply.status, 200, String(reply.body.error));
    return client;
  }
  type Client = Awaited<ReturnType<typeof signIn>>;
  async function call(client: Client, method: string, url: string, body?: unknown, status = 200, headers: Record<string, string> = {}) {
    const reply = await client.request(method, url, body, headers);
    assert.equal(reply.status, status, `${method} ${url}: ${JSON.stringify(reply.body).slice(0, 400)}`);
    return reply;
  }
  const owner = await signIn('owner');
  const stranger = await signIn('stranger');
  const create = async (client: Client, given: string) => (await call(client, 'POST', '/api/contacts', { name: { given }, emails: [`${given.toLowerCase()}@example.test`] })).body.contact as FixtureValue;
  const ann = await create(owner, 'Ann');
  const bea = await create(owner, 'Bea');
  const strangers = await create(stranger, 'Sam');
  const upload = (client: Client, id: string, bytes: Buffer, type: string, status = 200) => call(client, 'PUT', `/api/contacts/${id}/photo`, bytes, status, { 'content-type': type });
  const userDir = (name: string) => path.join(process.env.CONTACT_PHOTOS_ROOT!, users[name]);
  const files = (name: string) => { try { return fs.readdirSync(userDir(name)).sort(); } catch { return []; } };
  const stored = async (id: string) => (await pool.execute<RowDataPacket[]>('SELECT sha256, thumb_sha256, width, height, bytes, source FROM contact_photos WHERE contact_id = ?', [id]))[0][0];

  // ── A phone JPEG (EXIF orientation and GPS) becomes the contact photo ──
  const phoneJpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#2050c0' } })
    .withMetadata({ orientation: 6 }).withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 30/1 0/1' } }).jpeg().toBuffer();
  const first = (await upload(owner, ann.id, phoneJpeg, 'image/jpeg')).body.contact;
  assert.deepEqual([first.id, first.photo.width, first.photo.height, first.version], [ann.id, 512, 512, ann.version + 1]);
  assert.match(first.photo.etag, /^[0-9a-f]{64}$/);
  const firstRow = await stored(ann.id);
  assert.deepEqual([firstRow.sha256, firstRow.source], [first.photo.etag, 'upload']);
  assert.deepEqual(files('owner'), [`${firstRow.sha256}.jpg`, `${firstRow.thumb_sha256}.jpg`].sort(), 'only the converted files are kept, never the original');
  for (const name of files('owner')) assert.equal(fs.statSync(path.join(userDir('owner'), name)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_SPOOL_ROOT!), [], 'the spooled upload is gone');
  const listed = (await call(owner, 'GET', '/api/contacts')).body.contacts as FixtureValue[];
  assert.deepEqual(listed.find(contact => contact.id === ann.id).photo, first.photo, 'the list carries the photo identity');

  // ── Reading it: private, revalidated, with the sha as ETag; v= is only an address ──
  const full = await call(owner, 'GET', `/api/contacts/${ann.id}/photo?size=full&v=${first.photo.etag}`);
  assert.equal(full.headers['content-type'], 'image/jpeg');
  assert.equal(full.headers.etag, `"${first.photo.etag}"`);
  assert.equal(full.headers['cache-control'], 'private, no-cache');
  assert.equal(crypto.createHash('sha256').update(full.bytes).digest('hex'), first.photo.etag);
  const fullMeta = await sharp(full.bytes).metadata();
  assert.deepEqual([fullMeta.width, fullMeta.height, fullMeta.exif], [512, 512, undefined], 'no EXIF and so no GPS');
  const thumb = await call(owner, 'GET', `/api/contacts/${ann.id}/photo?size=thumb`);
  assert.deepEqual([(await sharp(thumb.bytes).metadata()).width, thumb.headers.etag], [96, `"${firstRow.thumb_sha256}"`]);
  assert.deepEqual((await call(owner, 'GET', `/api/contacts/${ann.id}/photo`)).bytes, full.bytes, 'full is the default');
  const revalidated = await call(owner, 'GET', `/api/contacts/${ann.id}/photo?size=full`, undefined, 304, { 'if-none-match': `"${first.photo.etag}"` });
  assert.equal(revalidated.bytes.length, 0);
  await call(owner, 'GET', `/api/contacts/${ann.id}/photo?size=full`, undefined, 200, { 'if-none-match': `"${firstRow.thumb_sha256}"` });
  await call(owner, 'GET', `/api/contacts/${ann.id}/photo?size=huge`, undefined, 400);
  await call(owner, 'GET', `/api/contacts/${bea.id}/photo`, undefined, 404);

  // ── PNG, WebP and HEIC uploads; the declared type plays no part ──
  const png = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const pngContact = (await upload(owner, bea.id, png, 'application/octet-stream')).body.contact;
  assert.deepEqual([pngContact.photo.width, pngContact.photo.height], [300, 300]);
  const webp = await sharp({ create: { width: 700, height: 500, channels: 3, background: '#40a040' } }).webp().toBuffer();
  const webpContact = (await upload(owner, bea.id, webp, 'image/jpeg')).body.contact;
  assert.deepEqual([webpContact.photo.width, webpContact.version], [500, pngContact.version + 1]);
  const heic = fs.readFileSync(path.join(__dirname, 'fixtures/contacts/photos/rotated-irot.heic'));
  const ffmpeg = (() => { try { require('node:child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (ffmpeg) {
    const heicContact = (await upload(owner, bea.id, heic, 'image/heic')).body.contact;
    assert.deepEqual([heicContact.photo.width, heicContact.photo.height], [64, 64]);
  } else {
    // The image ships FFmpeg (scripts/container-smoke.sh converts this file there).
    assert.equal((await upload(owner, bea.id, heic, 'image/heic', 400)).body.code, 'PHOTO_UNREADABLE');
    t.diagnostic('FFmpeg is not installed here: HEIC was checked as a plain refusal; the container smoke test converts it');
  }
  const beaBefore = (await call(owner, 'GET', `/api/contacts/${bea.id}`)).body.contact;

  // ── Refusals leave the photo, the version and the files as they were ──
  const filesBefore = files('owner');
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).jpeg().toBuffer();
  for (const [bytes, code] of [
    [crypto.randomBytes(4096), 'PHOTO_UNREADABLE'],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'PHOTO_UNREADABLE'],
    [jpeg.subarray(0, jpeg.length >> 1), 'PHOTO_UNREADABLE'],
  ] as const) {
    assert.equal((await upload(owner, bea.id, bytes, 'image/jpeg', 400)).body.code, code);
  }
  await upload(owner, bea.id, Buffer.alloc(20 * 1024 * 1024 + 1, 0xff), 'image/jpeg', 413);
  assert.equal((await call(owner, 'PUT', `/api/contacts/${bea.id}/photo`, Buffer.alloc(0), 400, { 'content-type': 'image/jpeg' })).body.code, 'UPLOAD_EMPTY');
  const beaAfter = (await call(owner, 'GET', `/api/contacts/${bea.id}`)).body.contact;
  assert.deepEqual([beaAfter.photo, beaAfter.version], [beaBefore.photo, beaBefore.version]);
  assert.deepEqual(files('owner'), filesBefore);

  // ── Another person: no read, write or delete of the owner's photo, no use of their files ──
  for (const [method, url] of [['GET', `/api/contacts/${ann.id}/photo`], ['GET', `/api/contacts/${ann.id}/photo?size=thumb`], ['DELETE', `/api/contacts/${ann.id}/photo`]]) {
    assert.equal((await call(stranger, method, url, undefined, 404)).body.code, method === 'GET' ? 'PHOTO_NOT_FOUND' : 'CONTACT_NOT_FOUND');
  }
  assert.equal((await upload(stranger, ann.id, png, 'image/png', 404)).body.code, 'CONTACT_NOT_FOUND');
  assert.deepEqual((await stored(ann.id)).sha256, first.photo.etag);
  // The same picture for the stranger's own contact is stored in the stranger's directory.
  const own = (await upload(stranger, strangers.id, phoneJpeg, 'image/jpeg')).body.contact;
  assert.equal(own.photo.etag, first.photo.etag);
  assert.deepEqual(files('stranger'), files('owner').filter(name => [`${firstRow.sha256}.jpg`, `${firstRow.thumb_sha256}.jpg`].includes(name)));
  await call(stranger, 'DELETE', `/api/contacts/${strangers.id}/photo`);
  assert.deepEqual(files('stranger'), []);
  assert.ok(files('owner').includes(`${firstRow.sha256}.jpg`), 'removing the stranger\'s copy leaves the owner\'s file');

  // ── Gates: the module switch and a running contacts restore ──
  await call(owner, 'PUT', '/api/modules', { modules: { contacts: { enabled: false } } });
  assert.equal((await call(owner, 'GET', `/api/contacts/${ann.id}/photo`, undefined, 403)).body.code, 'MODULE_DISABLED');
  assert.equal((await upload(owner, ann.id, png, 'image/png', 403)).body.code, 'MODULE_DISABLED');
  assert.equal((await call(owner, 'DELETE', `/api/contacts/${ann.id}/photo`, undefined, 403)).body.code, 'MODULE_DISABLED');
  await call(owner, 'PUT', '/api/modules', { modules: { contacts: { enabled: true } } });
  const restoreId = crypto.randomUUID();
  await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '[\"contacts\"]')", [restoreId, users.owner]);
  assert.equal((await upload(owner, ann.id, png, 'image/png', 409)).body.code, 'RESTORE_IN_PROGRESS');
  assert.equal((await call(owner, 'DELETE', `/api/contacts/${ann.id}/photo`, undefined, 409)).body.code, 'RESTORE_IN_PROGRESS');
  await call(owner, 'GET', `/api/contacts/${ann.id}/photo`);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_SPOOL_ROOT!), []);
  assert.equal((await stored(ann.id)).sha256, first.photo.etag);

  // ── The sweep skips a user under restore, then removes only unreferenced old files ──
  const { sweepContactPhotos } = require('../dist/src/services/contact-photos') as typeof import('../src/services/contact-photos');
  const orphan = path.join(userDir('owner'), `${'a'.repeat(64)}.jpg`);
  const leftover = path.join(userDir('owner'), `.${'b'.repeat(64)}.jpg.tmp`);
  const fresh = path.join(userDir('owner'), `${'c'.repeat(64)}.jpg`);
  for (const target of [orphan, leftover, fresh]) fs.writeFileSync(target, 'synthetic');
  const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  for (const target of [orphan, leftover, ...files('owner').filter(name => name.endsWith('.jpg') && !name.startsWith('c')).map(name => path.join(userDir('owner'), name))]) fs.utimesSync(target, old, old);
  assert.equal(await sweepContactPhotos(), 0, 'a user under restore is left alone');
  await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);
  assert.equal(await sweepContactPhotos(), 2);
  assert.equal(fs.existsSync(orphan) || fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(fresh), true, 'a file younger than an hour may belong to an upload not yet committed');
  fs.rmSync(fresh);
  for (const row of [await stored(ann.id), await stored(bea.id)]) {
    assert.ok(fs.existsSync(path.join(userDir('owner'), `${row.sha256}.jpg`)) && fs.existsSync(path.join(userDir('owner'), `${row.thumb_sha256}.jpg`)));
  }

  // ── Replace and delete: shared pictures stay while any contact uses them ──
  const shared = (await upload(owner, bea.id, phoneJpeg, 'image/jpeg')).body.contact;
  assert.equal(shared.photo.etag, first.photo.etag, 'the same picture converts to the same file');
  const replaced = (await upload(owner, ann.id, png, 'image/png')).body.contact;
  assert.notEqual(replaced.photo.etag, first.photo.etag);
  assert.ok(files('owner').includes(`${first.photo.etag}.jpg`), 'Bea still uses the old picture of Ann');
  const removed = (await call(owner, 'DELETE', `/api/contacts/${bea.id}/photo`)).body.contact;
  assert.deepEqual([removed.photo, removed.version], [null, shared.version + 1]);
  assert.equal(files('owner').includes(`${first.photo.etag}.jpg`), false, 'no contact uses it any more');
  assert.equal(files('owner').includes(`${firstRow.thumb_sha256}.jpg`), false);
  await call(owner, 'GET', `/api/contacts/${bea.id}/photo`, undefined, 404);
  await call(owner, 'DELETE', `/api/contacts/${bea.id}/photo`);
  const annRow = await stored(ann.id);
  assert.deepEqual(files('owner'), [`${annRow.sha256}.jpg`, `${annRow.thumb_sha256}.jpg`].sort());

  // ── A deleted contact's photo row goes with it; the sweep removes its files ──
  await call(owner, 'DELETE', `/api/contacts/${ann.id}`);
  assert.equal(await stored(ann.id), undefined);
  for (const name of files('owner')) fs.utimesSync(path.join(userDir('owner'), name), old, old);
  assert.equal(await sweepContactPhotos(), 2);
  assert.deepEqual(files('owner'), []);
  await upload(owner, ann.id, png, 'image/png', 404);
});
