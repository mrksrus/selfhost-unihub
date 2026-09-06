const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chooseTargetId, writeOwnedRow, resolveOwnedReference, validateRestoreRows } = require('../src/services/backup-ownership');
const { validateBackupPayload, importBackupForUser } = require('../src/services/backup');

test('restore allocates fresh IDs unless deliberately matching a same-owner row', () => {
  for (const mode of ['keep_existing', 'replace', 'keep_both']) {
    const selected = chooseTargetId('foreign-id', null, mode);
    assert.match(selected, /^[a-f0-9-]{36}$/);
    assert.notEqual(selected, 'foreign-id');
  }
  assert.equal(chooseTargetId('old', 'owned', 'replace'), 'owned');
  assert.equal(chooseTargetId('old', 'owned', 'keep_existing'), 'owned');
  assert.notEqual(chooseTargetId('old', 'owned', 'keep_both'), 'owned');
  assert.equal(chooseTargetId('old', 'owned', 'keep_both', { canKeepBoth: false }), 'owned');
});

test('unexpected global ID collision fails without an unscoped update', async () => {
  const victim = { id: 'occupied', user_id: 'victim', first_name: 'Original' };
  const calls = [];
  const connection = { async execute(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT')) return [[]]; // Occupied ID is not owned by the importer.
    if (sql.startsWith('INSERT')) throw Object.assign(new Error('Duplicate primary key'), { code: 'ER_DUP_ENTRY' });
    throw new Error('Unexpected write');
  } };
  await assert.rejects(writeOwnedRow(connection, 'importer', 'contacts', ['id', 'user_id', 'first_name'], ['occupied', 'importer', 'Changed'], ['first_name']), /Duplicate primary key/);
  assert.ok(calls.every(call => !call.sql.includes('ON DUPLICATE') && !call.sql.startsWith('UPDATE')));
  assert.deepEqual(victim, { id: 'occupied', user_id: 'victim', first_name: 'Original' });
});

test('matched updates are constrained by both primary key and owner', async () => {
  const calls = [];
  const connection = { async execute(sql, params) { calls.push({ sql, params }); return sql.startsWith('SELECT') ? [[{ id: 'owned' }]] : [{ affectedRows: 1 }]; } };
  await writeOwnedRow(connection, 'importer', 'contacts', ['id', 'user_id', 'first_name'], ['owned', 'importer', 'Changed'], ['first_name']);
  assert.match(calls[1].sql, /WHERE `id` = \? AND user_id = \?$/);
  assert.deepEqual(calls[1].params, ['Changed', 'owned', 'importer']);
});

test('legacy parent fallbacks require ownership, while imported parents use their remapped IDs', async () => {
  const calls = [];
  const connection = { async execute(sql, params) { calls.push({ sql, params }); return [[]]; } };
  assert.equal(await resolveOwnedReference(connection, 'importer', 'emails', 'old', new Map([['old', 'new']])), 'new');
  assert.equal(calls.length, 0);
  await assert.rejects(resolveOwnedReference(connection, 'importer', 'emails', 'foreign', new Map()), /unavailable emails record/);
  assert.match(calls[0].sql, /id = \? AND user_id = \? FOR UPDATE/);
  assert.deepEqual(calls[0].params, ['foreign', 'importer']);
  await assert.rejects(resolveOwnedReference(connection, 'importer', 'emails', null, new Map()), /missing/);
  assert.equal(await resolveOwnedReference(connection, 'importer', 'calendar_calendars', null, new Map(), { nullable: true }), null);
});

test('ambiguous duplicate imported IDs are rejected before writing', () => {
  assert.match(validateRestoreRows({ contacts: [{ id: 'same' }, { id: 'same' }] }).join(' '), /duplicate ID/);
  assert.match(validateRestoreRows({ contacts: {} }).join(' '), /must be an array/);
});

function audioBackup(bytes) {
  return { app: 'unihub', version: 1, data: { recordings: [{ id: 'recording', content_type: 'audio/wav' }] }, files: [{ kind: 'recording', id: 'recording', archive_path: 'files/recording', sha256: crypto.createHash('sha256').update(bytes).digest('hex'), data_base64: bytes.toString('base64') }] };
}

test('restored recording validation rejects HTML and playlists despite trusted-looking MIME/checksums', () => {
  for (const content of ['<!doctype html><script>document.body.textContent="unexpected"</script>', '#EXTM3U\nhttps://example.test/remote.mp3']) {
    const result = validateBackupPayload(audioBackup(Buffer.from(content)));
    assert.equal(result.valid, false);
    assert.match(result.errors.join(' '), /not supported audio/);
  }
  const wav = Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ');
  assert.equal(validateBackupPayload(audioBackup(wav)).valid, true);
});

test('file-range recording validation reads the archive entry boundary, not an unrelated outer header', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-audio-range-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'archive.bin');
  const prefix = Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ');
  const html = Buffer.from('<html>not audio</html>');
  await fs.writeFile(filePath, Buffer.concat([prefix, html]));
  const backup = audioBackup(html);
  delete backup.files[0].data_base64;
  const result = await importBackupForUser('importer', backup, { fileSourcesByPath: new Map([['files/recording', { filePath, start: prefix.length, size: html.length }]]) });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /not supported audio/);
});
