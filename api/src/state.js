let currentDb = null;

const db = new Proxy({}, {
  get(_target, prop) {
    if (!currentDb) {
      throw new Error('Database pool has not been initialized');
    }
    const value = currentDb[prop];
    return typeof value === 'function' ? value.bind(currentDb) : value;
  },
});

function setDb(nextDb) {
  currentDb = nextDb;
}

function getDb() {
  return currentDb;
}

module.exports = {
  db,
  setDb,
  getDb,
};
