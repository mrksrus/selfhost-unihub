// Append numbered steps. MySQL DDL commits implicitly: up() must detect work
// already done after a crash, and verify() must reject an incomplete result.
// Never reuse an ID or change a completed step's meaning.
async function runMigrations(pool, migrations) {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.id) || migration.id <= previous || !migration.name ||
        typeof migration.up !== 'function' || typeof migration.verify !== 'function') {
      throw new Error('Database migrations require increasing IDs, names, up and verify');
    }
    previous = migration.id;
  }
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [[lock]] = await connection.execute("SELECT GET_LOCK(SHA2(CONCAT('unihub-upgrades:', DATABASE()), 256), 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire database upgrade lock');
    locked = true;
    await connection.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT UNSIGNED PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const [completed] = await connection.execute('SELECT id, name FROM schema_migrations ORDER BY id');
    for (let index = 0; index < completed.length; index++) {
      if (completed[index].id !== migrations[index]?.id || completed[index].name !== migrations[index]?.name) {
        throw new Error('Database upgrade history is unknown or out of order; use a compatible server release');
      }
    }
    for (const migration of migrations.slice(completed.length)) {
      try {
        await migration.up(connection);
        await migration.verify(connection);
        await connection.execute('INSERT INTO schema_migrations (id, name) VALUES (?, ?)', [migration.id, migration.name]);
      } catch (error) {
        throw new Error(`Database upgrade ${migration.id} (${migration.name}) failed: ${error.message}`, { cause: error });
      }
    }
  } finally {
    try {
      if (locked) await connection.execute("SELECT RELEASE_LOCK(SHA2(CONCAT('unihub-upgrades:', DATABASE()), 256))");
    } finally {
      connection.release();
    }
  }
}

module.exports = { runMigrations };
