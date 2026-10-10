import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const { setDb } = require('../dist/src/state') as typeof import('../src/state');

async function fixture(t: import('node:test').TestContext, failure?: FixtureValue) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-backup-transaction-'));
  const recordingsPath = require.resolve('../dist/src/services/recordings');
  const backupPath = require.resolve('../dist/src/services/backup');
  const originalRecordings = require.cache[recordingsPath];
  const originalBackup = require.cache[backupPath];
  require.cache[recordingsPath] = { id: recordingsPath, filename: recordingsPath, loaded: true, exports: { RECORDINGS_ROOT: directory } } as NodeJS.Module;
  t.after(require('./helpers/backup-service-modules.cts').evictBackupServiceModules());
  const { importBackupForUser, buildBackupArchiveEntriesForUser } = require('../dist/src/services/backup') as typeof import('../src/services/backup');
  t.after(async () => {
    setDb(null);
    if (originalRecordings) require.cache[recordingsPath] = originalRecordings;
    else delete require.cache[recordingsPath];
    if (originalBackup) require.cache[backupPath] = originalBackup;
    else delete require.cache[backupPath];
    await fs.rm(directory, { recursive: true, force: true });
  });
  const calls: FixtureValue[] = [];
  const connection = {
    async execute(sql: string) { calls.push(sql); return [[]]; },
    async beginTransaction() { calls.push('begin'); },
    async rollback() { calls.push('rollback'); if (failure === 'commit') throw new Error('Connection lost'); },
    async commit() { calls.push('commit'); if (failure === 'commit') throw new Error('COMMIT response lost'); },
    release() { calls.push('release'); },
  };
  setDb({
    execute: async () => [[]],
    getConnection: (async () => {
      if (failure === 'acquire') throw new Error('Connection unavailable');
      return connection;
    }),
  } as FixtureValue);
  const audio = Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ');
  const backup = {
    app: 'unihub', version: 2,
    data: { recordings: [{ id: 'recording', title: 'Synthetic fixture', content_type: 'audio/wav' }] },
    files: [{ kind: 'recording', id: 'recording', filename: 'fixture.wav', sha256: crypto.createHash('sha256').update(audio).digest('hex'), data_base64: audio.toString('base64') }],
  };
  const run = () => importBackupForUser('test-user', backup, {
    mode: 'apply', sections: ['recordings'],
    beforeCommit: failure === 'before' ? async () => { throw new Error('Before-commit failure'); } : null,
  });
  const restoredFile = path.join(directory, 'test-user', 'recording-fixture.wav');
  return { run, restoredFile, calls, audio, directory, buildBackupArchiveEntriesForUser };
}

test('uncertain COMMIT preserves restored files and marks the error for reconciliation', async (t) => {
  const { run, restoredFile, calls, audio } = await fixture(t, 'commit');
  await assert.rejects(run(), error => (error as FixtureValue).message === 'COMMIT response lost' && (error as FixtureValue).backupCommitUncertain === true);
  assert.deepEqual(await fs.readFile(restoredFile), audio);
  assert.deepEqual(calls.slice(-3), ['commit', 'rollback', 'release']);
});

test('failure before COMMIT rolls back metadata and removes only staged restore files', async (t) => {
  const { run, restoredFile, calls } = await fixture(t, 'before');
  await assert.rejects(run(), error => (error as FixtureValue).message === 'Before-commit failure' && !(error as FixtureValue).backupCommitUncertain);
  await assert.rejects(fs.access(restoredFile), { code: 'ENOENT' });
  assert.deepEqual(calls.slice(-2), ['rollback', 'release']);
  assert.ok(!calls.includes('commit'));
});

test('database connection failure after file staging cleans the staged files', async (t) => {
  const { run, restoredFile } = await fixture(t, 'acquire');
  await assert.rejects(run(), /Connection unavailable/);
  await assert.rejects(fs.access(restoredFile), { code: 'ENOENT' });
});

test('new selected recording exports reject unsupported stored audio while other sections remain exportable', async (t) => {
  const { directory, buildBackupArchiveEntriesForUser } = await fixture(t);
  const sourcePath = path.join(directory, 'legacy-recording.bin');
  const original = Buffer.from('<html>old unsupported recording upload</html>');
  await fs.writeFile(sourcePath, original);
  const connection = {
    async query() { return [[]]; }, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string) {
      if (sql.includes('FROM users ')) return [[{ id: 'test-user', email: 'user@example.test' }]];
      if (sql.includes('FROM recordings ')) return [[{ id: 'legacy-recording', user_id: 'test-user', storage_path: sourcePath }]];
      return [[]];
    },
  };
  setDb({ getConnection: async () => connection } as FixtureValue);
  const contactEntries = await buildBackupArchiveEntriesForUser('test-user', ['contacts']);
  t.after(async () => {
    await Promise.all(contactEntries.filter((entry) => entry.cleanupAfterWrite).map((entry: FixtureValue) => fs.rm(entry.filePath, { force: true })));
  });
  assert.ok(contactEntries.some((entry) => entry.name === 'data/backup.json'));
  await assert.rejects(buildBackupArchiveEntriesForUser('test-user', ['recordings']), error => (error as FixtureValue).status === 409 && /stored audio is unsupported or unreadable/.test((error as FixtureValue).message));
  assert.deepEqual(await fs.readFile(sourcePath), original);
});
