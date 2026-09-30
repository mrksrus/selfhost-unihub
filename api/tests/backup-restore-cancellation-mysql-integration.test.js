const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.ENCRYPTION_KEY ||= 'cancellation-test-encryption-key';
process.env.BACKUP_MASTER_KEY ||= 'cancellation-test-backup-master-key';
const { setDb } = require('../src/state');
const { cancelRestoreJob } = require('../src/services/backup-restore-jobs');

test('MySQL cancellation cannot overwrite a restore that commits while the request is waiting', {
  skip: !process.env.MYSQL_TEST_HOST,
  timeout: 30000,
}, async (t) => {
  const database = process.env.MYSQL_TEST_DATABASE || 'unihub_test';
  assert.match(database, /_test$/, 'Only use a disposable test database');
  const pool = require('mysql2/promise').createPool({
    host: process.env.MYSQL_TEST_HOST,
    port: Number(process.env.MYSQL_TEST_PORT || 3306),
    database,
    user: process.env.MYSQL_TEST_USER || 'unihub_test',
    password: process.env.MYSQL_TEST_PASSWORD || 'test-db-password',
    connectionLimit: 3,
  });
  let ownsTable = false;
  t.after(async () => {
    try {
      if (ownsTable) await pool.execute('DROP TABLE backup_restore_jobs');
    } finally { setDb(null); await pool.end(); }
  });
  const [existing] = await pool.query('SHOW TABLES');
  assert.equal(existing.length, 0, 'Refusing to change a nonempty database');
  await pool.execute(`CREATE TABLE backup_restore_jobs (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL,
    status VARCHAR(32) NOT NULL, phase VARCHAR(32) NOT NULL,
    progress INT NOT NULL DEFAULT 0, cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMP NULL
  ) ENGINE=InnoDB`);
  ownsTable = true;
  setDb(pool);
  const userId = crypto.randomUUID();
  async function add(status, phase = status) {
    const id = crypto.randomUUID();
    await pool.execute('INSERT INTO backup_restore_jobs (id, user_id, status, phase) VALUES (?, ?, ?, ?)', [id, userId, status, phase]);
    return id;
  }
  for (const status of ['uploaded', 'queued', 'validating', 'running']) {
    const id = await add(status);
    const result = await cancelRestoreJob(userId, id);
    const immediate = ['uploaded', 'queued'].includes(status);
    assert.equal(result.job.status, immediate ? 'cancelled' : 'cancelling');
    assert.equal(result.job.phase, result.job.status);
    assert.equal(result.job.cancel_requested, true);
    assert.equal(Boolean(result.job.completed_at), immediate);
    assert.equal(result.job.progress, immediate ? 100 : 0);
  }
  const committing = await add('running', 'commit');
  assert.equal((await cancelRestoreJob(userId, committing)).status, 409);
  assert.equal((await cancelRestoreJob(crypto.randomUUID(), committing)).status, 404);
  const jobId = await add('running', 'restoring');
  const connection = await pool.getConnection();
  let requested;
  const cancellationRequested = new Promise(resolve => { requested = resolve; });
  setDb({
    execute(sql, params) {
      const pending = pool.execute(sql, params);
      if (sql.startsWith('UPDATE backup_restore_jobs')) requested();
      return pending;
    },
  });
  try {
    await connection.beginTransaction();
    await connection.execute("UPDATE backup_restore_jobs SET status = 'completed', phase = 'completed', progress = 100, completed_at = UTC_TIMESTAMP() WHERE id = ?", [jobId]);
    // The cancellation write must use the row's latest state after this lock
    // releases, even though the committed state was still 'running' at dispatch.
    const cancelled = cancelRestoreJob(userId, jobId);
    await cancellationRequested;
    await connection.commit();
    assert.equal((await cancelled).status, 409);
    const [[row]] = await pool.execute('SELECT * FROM backup_restore_jobs WHERE id = ?', [jobId]);
    assert.equal(row.status, 'completed');
    assert.equal(row.phase, 'completed');
    assert.equal(row.cancel_requested, 0);
    const [interrupted] = await pool.execute("SELECT id FROM backup_restore_jobs WHERE id = ? AND status IN ('validating', 'running', 'cancelling')", [jobId]);
    assert.deepEqual(interrupted, [], 'Startup recovery must not select and remove committed restore files');
  } finally {
    await connection.rollback();
    connection.release();
    setDb(pool);
  }
});
