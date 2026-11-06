import type { RowDataPacket } from 'mysql2/promise';
// Piped into an installation by scripts/upgrade-check.mts, before and after
// its upgrade, and run there with its configuration. Reports the database
// upgrade steps applied and the last one this installation's code knows, and
// whether its data inventory check (data-inventory.ts) passes on the live
// database. Read-only; prints JSON.
const path = (require('node:path') as typeof import('node:path'));
const apiRoot = process.env.UNIHUB_API_ROOT!;
const mysql = require(require.resolve('mysql2/promise', { paths: [apiRoot] })) as typeof import('mysql2/promise');

async function main() {
  const db = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, timezone: '+00:00' });
  try {
    const [steps] = await db.query<RowDataPacket[]>('SELECT id, name FROM schema_migrations ORDER BY id');
    const { LATEST_MIGRATION_ID } = require(path.join(apiRoot, 'src/services/database')) as typeof import('../../src/services/database');
    let inventory = 'passed';
    try {
      const { verifyDatabaseInventory } = require(path.join(apiRoot, 'src/services/data-inventory')) as typeof import('../../src/services/data-inventory');
      await verifyDatabaseInventory(db);
    } catch (error) { inventory = `failed: ${(error as Error).message}`; }
    console.log(JSON.stringify({ applied: steps.map(row => Number(row.id)), latestApplied: Math.max(0, ...steps.map(row => Number(row.id))), latestKnown: LATEST_MIGRATION_ID, inventory }));
  } finally { await db.end(); }
}
main().then(() => process.exit(0), (error: Error) => { console.error(error.stack || error.message); process.exit(1); });
