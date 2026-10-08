import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';

interface Step {
  up: (connection: PoolConnection) => Promise<unknown>;
  verify: (connection: PoolConnection) => Promise<unknown>;
}
interface Migration extends Step {
  id: number;
  name: string;
}
// Creates a new database in one step in place of the first steps of its
// history, which databases created earlier recorded one by one.
interface Baseline extends Step {
  history: readonly { id: number; name: string }[];
}

const NO_BASELINE: Baseline = { history: [], up: async () => {}, verify: async () => {} };

// Append numbered steps. DDL commits implicitly: up() must detect work already
// done after a crash, and verify() must reject an incomplete result. Never
// reuse an ID or change a completed step's meaning.
async function runMigrations(pool: Pick<Pool, 'getConnection'>, migrations: readonly Migration[], baseline: Baseline = NO_BASELINE) {
  const history = [...baseline.history, ...migrations];
  let previous = 0;
  for (const step of history) {
    if (!Number.isSafeInteger(step.id) || step.id <= previous || !step.name) {
      throw new Error('Database migrations require increasing IDs, names, up and verify');
    }
    previous = step.id;
  }
  for (const step of [baseline, ...migrations]) {
    if (typeof step.up !== 'function' || typeof step.verify !== 'function') {
      throw new Error('Database migrations require increasing IDs, names, up and verify');
    }
  }
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [[lock]] = await connection.execute<(RowDataPacket & { acquired: number | string | null })[]>("SELECT GET_LOCK(SHA2(CONCAT('unihub-upgrades:', DATABASE()), 256), 60) AS acquired");
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire database upgrade lock');
    locked = true;
    await connection.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT UNSIGNED PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const [completed] = await connection.execute<(RowDataPacket & { id: number; name: string })[]>('SELECT id, name FROM schema_migrations ORDER BY id');
    for (let index = 0; index < completed.length; index++) {
      if (completed[index].id !== history[index]?.id || completed[index].name !== history[index]?.name) {
        throw new Error('Database upgrade history is unknown or out of order; use a compatible server release');
      }
    }
    if (completed.length < baseline.history.length) {
      if (completed.length) {
        throw new Error('The first setup of this database by an earlier release did not finish; start UniHub 0.18.2 once to finish it, or start with an empty database');
      }
      try {
        await baseline.up(connection);
        await baseline.verify(connection);
        await connection.execute(`INSERT INTO schema_migrations (id, name) VALUES ${baseline.history.map(() => '(?, ?)').join(', ')}`,
          baseline.history.flatMap(step => [step.id, step.name]));
      } catch (error) {
        throw new Error(`Database setup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    for (const migration of migrations.slice(Math.max(0, completed.length - baseline.history.length))) {
      try {
        await migration.up(connection);
        await migration.verify(connection);
        await connection.execute('INSERT INTO schema_migrations (id, name) VALUES (?, ?)', [migration.id, migration.name]);
      } catch (error) {
        throw new Error(`Database upgrade ${migration.id} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
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

export { runMigrations };
export type { Baseline, Migration };
