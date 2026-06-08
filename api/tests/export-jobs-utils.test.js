const test = require('node:test');
const assert = require('node:assert/strict');
const {
  crc32Buffer,
  cancelDataExportJob,
  deleteDataExportJob,
  normalizeSections,
  parseRequestedSections,
  pumpDataExportJobs,
  resumePendingDataExportJobs,
  ZIP32_MAX_ENTRIES,
  ZIP32_MAX_FILENAME_BYTES,
  writeZip,
} = require('../src/services/export-jobs');
const { setDb } = require('../src/state');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('normalizeSections returns all sections for full export', () => {
  assert.deepEqual(normalizeSections('full'), ['contacts', 'calendar', 'todo', 'mail', 'recordings', 'settings']);
});

test('normalizeSections drops unknown and duplicate sections', () => {
  assert.deepEqual(normalizeSections(['mail', 'mail', 'unknown', 'recordings']), ['mail', 'recordings']);
});

test('parseRequestedSections accepts JSON arrays returned as strings', () => {
  assert.deepEqual(parseRequestedSections('["contacts","mail"]'), ['contacts', 'mail']);
});

test('parseRequestedSections accepts parsed JSON arrays from mysql', () => {
  assert.deepEqual(parseRequestedSections(['contacts', 'calendar', 'mail']), ['contacts', 'calendar', 'mail']);
});

test('parseRequestedSections accepts legacy comma-separated values', () => {
  assert.deepEqual(parseRequestedSections('contacts,calendar,mail'), ['contacts', 'calendar', 'mail']);
});

test('crc32Buffer matches known CRC32 value', () => {
  assert.equal((crc32Buffer(Buffer.from('hello')) ^ -1) >>> 0, 0x3610a686);
});

test('writeZip preserves long backup filenames including extensions', async () => {
  const { readZipEntries } = require('../src/services/backup');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-zip-name-'));
  const zipPath = path.join(dir, 'backup.zip');
  const longName = 'files/mail-attachments/0a6fbcc5-351e-47cf-92a4-7b7193dbd401-8d2608f7-8d3e-4078-912d-5ea7198aa2d8-0a6fbcc5-351e-47cf-92a4-7b7193dbd401-logo-gray.png';

  await writeZip([{ name: longName, data: 'image' }], zipPath);

  const entries = readZipEntries(await fs.readFile(zipPath));
  assert.equal(entries.has(longName), true);
});

test('writeZip streams file-backed entries into the archive', async () => {
  const { readZipEntries } = require('../src/services/backup');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-zip-file-'));
  const sourcePath = path.join(dir, 'source.eml');
  const zipPath = path.join(dir, 'backup.zip');
  const contents = Buffer.from('file-backed raw email', 'utf8');
  await fs.writeFile(sourcePath, contents);

  await writeZip([{
    name: 'files/mail-raw/email-1.eml',
    filePath: sourcePath,
  }], zipPath);

  const entries = readZipEntries(await fs.readFile(zipPath));
  assert.deepEqual(entries.get('files/mail-raw/email-1.eml'), contents);
});

test('writeZip rejects ZIP32 entry-count overflow before writing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-zip-limit-'));
  const zipPath = path.join(dir, 'backup.zip');
  const entries = new Array(ZIP32_MAX_ENTRIES + 1).fill({ name: 'entry', data: '' });

  await assert.rejects(
    writeZip(entries, zipPath),
    /ZIP32 entry limit/
  );
});

test('writeZip rejects entry names that cannot fit in a ZIP32 header', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-zip-name-limit-'));
  const zipPath = path.join(dir, 'backup.zip');

  await assert.rejects(
    writeZip([{ name: 'a'.repeat(ZIP32_MAX_FILENAME_BYTES + 1), data: '' }], zipPath),
    /ZIP32 filename limit/
  );
});

test('export worker drains more than 25 jobs sequentially', async (t) => {
  const pending = Array.from({ length: 30 }, (_, index) => ({ id: `job-${index}` }));
  let active = 0;
  let maxActive = 0;
  const completed = [];
  setDb({
    async execute(sql) {
      assert.match(sql, /WHERE status = 'queued'/);
      return [[pending.shift()].filter(Boolean)];
    },
  });
  t.after(() => setDb(null));

  await pumpDataExportJobs(async (jobId) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    completed.push(jobId);
    active -= 1;
  });

  assert.equal(completed.length, 30);
  assert.equal(maxActive, 1);
});

test('restart recovery reconciles every pending export without a row limit', async (t) => {
  const statements = [];
  setDb({
    async execute(sql) {
      statements.push(sql);
      if (sql.includes('COUNT(*) AS pending_jobs')) return [[{ pending_jobs: 31 }]];
      return [{ affectedRows: 0 }];
    },
  });
  t.after(() => setDb(null));

  const resumed = await resumePendingDataExportJobs({ schedule: false });

  assert.equal(resumed, 31);
  assert.equal(statements.some(sql => /LIMIT 25/.test(sql)), false);
  assert.equal(statements.some(sql => /SET status = 'cancelled'/.test(sql)), true);
  assert.equal(statements.some(sql => /SET status = 'queued'/.test(sql)), true);
});

test('queued export cancellation finalizes the job without running it', async (t) => {
  const job = {
    id: 'job-cancel',
    user_id: 42,
    scope: 'full',
    status: 'queued',
    phase: 'queued',
    progress: 0,
    cancel_requested: 0,
    requested_sections: '["contacts"]',
    encryption_enabled: 1,
    created_at: new Date(),
    updated_at: new Date(),
  };
  let updateCount = 0;
  setDb({
    async execute(sql, params) {
      if (sql.includes('SELECT jobs.*')) return [[{ ...job }]];
      if (sql.startsWith('UPDATE data_export_jobs SET')) {
        updateCount += 1;
        job.cancel_requested = params[0];
        job.status = params[1];
        job.phase = params[2];
        job.progress = params[3];
        job.completed_at = params[4];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  t.after(() => setDb(null));

  const result = await cancelDataExportJob(42, job.id);

  assert.equal(updateCount, 1);
  assert.equal(result.job.status, 'cancelled');
  assert.equal(result.job.cancel_requested, true);
  assert.equal(result.job.progress, 100);
});

test('deleting an export retains a key referenced by an uploaded restore archive', async (t) => {
  const job = {
    id: 'job-delete',
    user_id: 'user-1',
    scope: 'full',
    status: 'ready',
    phase: 'ready',
    progress: 100,
    cancel_requested: 0,
    requested_sections: '["settings"]',
    encryption_enabled: 1,
    backup_uuid: 'backup-shared',
    file_path: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  let exportDeleted = false;
  let restoreDetached = false;
  let keyDeleteCount = 0;
  setDb({
    async execute(sql) {
      if (sql.includes('SELECT jobs.*')) return [[{ ...job }]];
      if (sql.startsWith('UPDATE backup_restore_jobs')) {
        restoreDetached = true;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('source_export_job_id')) return [[]];
      if (sql.startsWith('DELETE FROM data_export_jobs')) {
        exportDeleted = true;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('FROM data_export_jobs')) {
        return [exportDeleted ? [] : [{ id: job.id }]];
      }
      if (sql.includes('FROM backup_restore_jobs')) {
        return [[{ id: 'uploaded-restore' }]];
      }
      if (sql.startsWith('DELETE FROM backup_archive_keys')) {
        keyDeleteCount += 1;
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  t.after(() => setDb(null));

  const result = await deleteDataExportJob(job.user_id, job.id);

  assert.deepEqual(result, { deleted: true });
  assert.equal(restoreDetached, true);
  assert.equal(exportDeleted, true);
  assert.equal(keyDeleteCount, 0);
});
