import type { Pool } from 'mysql2/promise';

let currentDb: Pool | null = null;

const db = new Proxy({} as Pool, {
  get(_target, prop) {
    if (!currentDb) {
      throw new Error('Database pool has not been initialized');
    }
    const value: unknown = Reflect.get(currentDb, prop);
    return typeof value === 'function' ? value.bind(currentDb) : value;
  },
});

function setDb(nextDb: Pool | null) {
  currentDb = nextDb;
}

function getDb() {
  return currentDb;
}

export {
  db,
  setDb,
  getDb,
};
