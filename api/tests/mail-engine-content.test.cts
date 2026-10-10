import type { FixtureValue } from './helpers/test-types.cts';
import type {} from 'node:module';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const path = (require('node:path') as typeof import('node:path'));
const os = (require('node:os') as typeof import('node:os'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const { publishRaw, verifyArchive, eligibleForProviderErasure, fetchRawBounded } = require('../dist/src/services/mail-engine/content') as typeof import('../src/services/mail-engine/content');
const owner = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const item = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
async function root(t: import('node:test').TestContext) {
  const base = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-raw-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}
test('binary MIME octets are published immutable and verified by bytes and digest', async t => {
  const base = await root(t);
  const raw = Buffer.from([0, 0xff, 0x80, 0x0d, 0x0a, 0x0d, 0x0a, 1]);
  const stored = await publishRaw({ root: base, userId: owner, emailId: item, raw });
  assert.deepEqual(await fs.readFile(stored.rawStoragePath), raw);
  assert.equal(stored.rawSha256, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(await verifyArchive({ raw_storage_path: stored.rawStoragePath, raw_sha256: stored.rawSha256,
    raw_bytes: raw.length, raw_format: 'exact_octets', raw_verified: true }, { root: base }), true);
  assert.deepEqual((await fs.readdir(path.dirname(stored.rawStoragePath))).filter(name => name.endsWith('.part')), []);
  await fs.writeFile(stored.rawStoragePath, Buffer.from([0xff]));
  assert.equal(await verifyArchive({ raw_storage_path: stored.rawStoragePath, raw_sha256: stored.rawSha256,
    raw_bytes: raw.length, raw_format: 'exact_octets', raw_verified: true }, { root: base }), false);
});
test('legacy raw, missing epoch, wrong tuple or modified archive cannot authorize provider erasure', async t => {
  const base = await root(t);
  const archived = await publishRaw({ root: base, userId: owner, emailId: item, raw: Buffer.from([0xff, 0x00, 1]) });
  const row = { raw_storage_path: archived.rawStoragePath, raw_sha256: archived.rawSha256,
    raw_bytes: archived.rawBytes, raw_format: archived.rawFormat, raw_verified: true,
    import_complete: 1, source_folder: 'INBOX', imap_uid: 7, imap_uidvalidity: 40 };
  const input = { row, sourceFolder: 'INBOX', uid: 7, uidValidity: 40, selectedUidValidity: 40, root: base };
  assert.equal(await eligibleForProviderErasure(input), true);
  for (const override of [
    { uidValidity: null }, { selectedUidValidity: null }, { uid: 8 },
    { sourceFolder: 'Inbox/Other' }, { row: { ...row, raw_format: 'legacy_normalized' } },
    { row: { ...row, raw_verified: false } }, { row: { ...row, remote_missing: 1 } },
  ]) assert.equal(await eligibleForProviderErasure({ ...input, ...override }), false);
});
test('raw fetch refuses decoded text and aborts slow reads at deadline', async () => {
  const connection = { ended: false, close() { this.ended = true; } };
  const address = { folder: 'INBOX', uidvalidity: 40, uid: 7 };
  await assert.rejects(fetchRawBounded({ fetchRawMessage: async () => ({ raw: 'decoded' }) } as FixtureValue, connection as FixtureValue, address), /octets/);
  await assert.rejects(fetchRawBounded({ fetchRawMessage: async () => new Promise(() => {}) } as FixtureValue, connection as FixtureValue, address,
    { timeoutMs: 5 }), { code: 'MAIL_BODY_TIMEOUT' });
  assert.equal(connection.ended, true);
});
