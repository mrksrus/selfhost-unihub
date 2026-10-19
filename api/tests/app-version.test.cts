const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs') as typeof import('node:fs'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const { versionInfo } = require('../dist/src/services/app-version') as typeof import('../src/services/app-version');

function downloadsDir(t: import('node:test').TestContext, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-downloads-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const META = { versionName: '0.21.0', versionCode: 21000, size: 4, sha256: 'a'.repeat(64), signing: 'release' };

test('the version handshake offers the Android app the image carries', (t) => {
  const dir = downloadsDir(t, { 'unihub.apk': 'apk!', 'unihub-android.json': JSON.stringify(META) });
  const info = versionInfo(dir);
  assert.equal(info.app, 'unihub');
  assert.match(info.server, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(info.android, { url: '/downloads/unihub.apk', versionName: '0.21.0', versionCode: 21000, size: 4, sha256: 'a'.repeat(64) });
});

test('no Android offer when the image was built without the app or its metadata is unusable', (t) => {
  assert.equal(versionInfo(downloadsDir(t, {})).android, null);
  assert.equal(versionInfo(downloadsDir(t, { 'unihub-android.json': JSON.stringify(META) })).android, null);
  assert.equal(versionInfo(downloadsDir(t, { 'unihub.apk': 'apk!', 'unihub-android.json': '{"versionName":' })).android, null);
  assert.equal(versionInfo(downloadsDir(t, { 'unihub.apk': 'apk!', 'unihub-android.json': JSON.stringify({ ...META, sha256: 'nope' }) })).android, null);
  assert.equal(versionInfo(downloadsDir(t, { 'unihub.apk': 'apk!', 'unihub-android.json': JSON.stringify({ ...META, versionCode: 0 }) })).android, null);
  assert.equal(versionInfo(downloadsDir(t, { 'unihub.apk': 'apk!', 'unihub-android.json': JSON.stringify({ ...META, versionName: '' }) })).android, null);
});
