import type { RowDataPacket } from 'mysql2/promise';
import type { FixtureValue } from './helpers/test-types.cts';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');

// An account backup's archive is named by its ready row, which an instance
// backup's dump can hold while its copy of the files runs. A failed job's
// cleanup removes the archive only after its rows and through the file
// removal gate, and never when the ready row may have been committed.
test('a failed export removes its archive through the removal gate, and keeps it when the ready row may be committed', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unihub-export-gate-'));
  const runtime = createBackupRuntime(directory, 'export-gate-synthetic-key', pool);
  t.after(async () => {
    await runtime('services/side-pools').endSidePools(pool);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const jobs = runtime('services/export-jobs');
  const { fileRemovalGate } = runtime('services/file-removal-gate');
  const state = runtime('state');

  const owner = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'export-owner@example.test', 'x')", [owner]);
  const queueJob = async () => {
    const jobId = crypto.randomUUID();
    await pool.execute(`INSERT INTO data_export_jobs (id, user_id, scope, status, requested_sections, encryption_enabled)
      VALUES (?, ?, 'full', 'queued', '["contacts"]', 1)`, [jobId, owner]);
    return jobId;
  };
  const archiveOf = (jobId: string) => path.join(directory, 'backups', owner, `${jobId}.zip`);
  const rowOf = async (jobId: string) => (await pool.query<RowDataPacket[]>('SELECT status, file_path FROM data_export_jobs WHERE id = ?', [jobId]))[0][0];
  const keysOf = async (jobId: string) => Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS count FROM backup_archive_keys WHERE export_job_id = ?', [jobId]))[0][0].count);

  // Statements of the job, on the pool and on its connections, run through
  // `fault`, which may run them, fail them or both.
  type Fault = (sql: string, values: unknown[], run: () => Promise<unknown>) => Promise<unknown>;
  async function runWith(jobId: string, fault: Fault) {
    const through = (target: FixtureValue): FixtureValue => new Proxy(target, { get: (object: FixtureValue, prop: string | symbol) => {
      const value = Reflect.get(object, prop);
      if (typeof value !== 'function') return value;
      if (prop === 'execute') return (sql: string, values: unknown[] = []) => fault(sql, values, () => value.call(object, sql, values));
      if (prop === 'getConnection') return async () => through(await value.call(object));
      return value.bind(object);
    } });
    state.setDb(through(pool));
    try {
      await jobs.runDataExportJob(jobId);
    } finally {
      state.setDb(pool);
    }
  }
  const isReadyUpdate = (sql: string, values: unknown[]) => sql.startsWith('UPDATE data_export_jobs SET status = ?') && values[0] === 'ready';
  const lost = () => Object.assign(new Error('synthetic: connection reset'), { code: 'ECONNRESET' });
  let reopen: (() => Promise<void>) | null = null;
  t.after(async () => { await reopen?.(); });

  await t.test('the ready row committed, its answer lost while an instance backup copies files: the archive stays', async () => {
    const jobId = await queueJob();
    await runWith(jobId, async (sql, values, run) => {
      if (!isReadyUpdate(sql, values)) return run();
      await run();
      // The instance backup's dump has the ready row; its copy now holds the gate.
      reopen = fileRemovalGate.close();
      throw lost();
    });
    assert.equal(fileRemovalGate.isClosed(), true);
    const row = await rowOf(jobId);
    assert.deepEqual([row.status, row.file_path], ['ready', archiveOf(jobId)]);
    assert.equal(fs.existsSync(archiveOf(jobId)), true, 'the archive the ready row names is there while the copy runs');
    assert.equal(await keysOf(jobId), 1, 'and its key');
    await reopen!();
    reopen = null;
    assert.equal(fs.existsSync(archiveOf(jobId)), true, 'nothing removes it after the copy');
    // A later run of the job (the next start's reconcile) leaves it as it is.
    await jobs.runDataExportJob(jobId);
    assert.equal((await rowOf(jobId)).status, 'ready');
    assert.equal(fs.existsSync(archiveOf(jobId)), true);
  });

  await t.test('whether the ready row committed cannot be told: everything stays until the next start reconciles it', async () => {
    const jobId = await queueJob();
    let checking = false;
    await runWith(jobId, async (sql, values, run) => {
      if (isReadyUpdate(sql, values)) { checking = true; throw lost(); }
      // The database is gone for the check of the outcome as well.
      if (checking) throw lost();
      return run();
    });
    assert.equal((await rowOf(jobId)).status, 'running', 'the row is left for the next start');
    assert.equal(fs.existsSync(archiveOf(jobId)), true, 'the archive is kept');
    assert.equal(await keysOf(jobId), 1, 'and its key');
    // The next start: the running job is queued again and written afresh.
    await jobs.resumePendingDataExportJobs({ schedule: false });
    await jobs.runDataExportJob(jobId);
    const row = await rowOf(jobId);
    assert.deepEqual([row.status, row.file_path], ['ready', archiveOf(jobId)]);
    assert.equal(fs.existsSync(archiveOf(jobId)), true);
    assert.equal(await keysOf(jobId), 1);
  });

  await t.test('a ready update still running when its answer is lost is waited for, and keeps the archive and its key', async () => {
    const jobId = await queueJob();
    // Another transaction holds the job's row, so the ready update waits at
    // the server after its client has given up on it.
    const holder = await pool.getConnection();
    let publication: Promise<unknown> | null = null;
    try {
      await runWith(jobId, async (sql, values, run) => {
        if (!isReadyUpdate(sql, values)) return run();
        await holder.beginTransaction();
        await holder.execute('SELECT id FROM data_export_jobs WHERE id = ? FOR UPDATE', [jobId]);
        publication = run();
        publication.catch(() => {});
        // Released while the job settles its failure: the ready update goes first.
        setTimeout(() => { holder.commit().catch(() => {}); }, 500);
        await new Promise(resolve => setTimeout(resolve, 100));
        throw lost();
      });
      await publication;
    } finally {
      await holder.rollback().catch(() => {});
      holder.release();
    }
    const row = await rowOf(jobId);
    assert.deepEqual([row.status, row.file_path], ['ready', archiveOf(jobId)], 'the ready update was committed and stands');
    assert.equal(await keysOf(jobId), 1, 'the ready archive keeps its unlock key');
    assert.equal(fs.existsSync(archiveOf(jobId)), true, 'and its file');
  });

  await t.test('a job that fails before its ready row is committed removes its archive, after an instance backup copy when one runs', async () => {
    const failKeys = async (sql: string, _values: unknown[], run: () => Promise<unknown>) => {
      if (sql.includes('INSERT INTO backup_archive_keys')) throw new Error('synthetic failure before the ready row');
      return run();
    };
    // No backup is copying: removed at once.
    const now = await queueJob();
    await runWith(now, failKeys);
    assert.equal((await rowOf(now)).status, 'failed');
    assert.equal(fs.existsSync(archiveOf(now)), false);
    assert.equal(await keysOf(now), 0);

    // A backup copies files: the archive waits for the copy, then goes.
    const during = await queueJob();
    reopen = fileRemovalGate.close();
    await runWith(during, failKeys);
    assert.equal((await rowOf(during)).status, 'failed', 'the row is recorded first');
    assert.equal(fs.existsSync(archiveOf(during)), true, 'kept while the copy runs');
    await reopen!();
    reopen = null;
    assert.equal(fs.existsSync(archiveOf(during)), false, 'removed when the copy ends');
  });
});
