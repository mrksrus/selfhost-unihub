import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const { writeZip } = require('../dist/src/services/export-jobs');
const { readZipEntries } = require('../dist/src/services/backup');
const hash = (bytes: FixtureValue) => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t: import('node:test').TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-export-integrity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.eml');
  const output = path.join(directory, 'backup.zip');
  const original = Buffer.from('original-message');
  await fs.writeFile(source, original);
  const entry = { name: 'files/mail-raw/message.eml', filePath: source, expectedSha256: hash(original), expectedSize: original.length };
  return { source, output, original, entry };
}

test('export verifies streamed file bytes against the collection checksum', async t => {
  const { output, original, entry } = await fixture(t);
  await writeZip([entry], output);
  assert.deepEqual(readZipEntries(await fs.readFile(output)).get(entry.name), original);
});

test('a changed file cannot produce a ready archive with stale checksums', async t => {
  const { source, output, original, entry } = await fixture(t);
  await fs.writeFile(source, Buffer.alloc(original.length, 'x'));
  await assert.rejects(writeZip([entry], output), /source changed after collection/);
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});

for (const [name, replacement] of [['same size', 'modified-message'], ['truncated', 'short'], ['growing', 'longer-than-original-message']] as const) {
  test(`file changing after ZIP preparation (${name}) fails and removes partial archive`, async t => {
    const { source, output, entry } = await fixture(t);
    await assert.rejects(writeZip([entry], output, { onProgress: async (phase: FixtureValue) => {
      if (phase === 'prepare') await fs.writeFile(source, replacement);
    } }), /source changed while archiving/);
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
  });
}

test('file disappearing after ZIP preparation fails and removes partial archive', async t => {
  const { source, output, entry } = await fixture(t);
  await assert.rejects(writeZip([entry], output, { onProgress: async (phase: FixtureValue) => {
    if (phase === 'prepare') await fs.unlink(source);
  } }), { code: 'ENOENT' });
  await assert.rejects(fs.access(output), { code: 'ENOENT' });
});
