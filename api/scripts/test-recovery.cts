// Release gate: unlike ordinary unit runs, required database checks cannot skip.
import type { RowDataPacket } from 'mysql2/promise';
const { spawn } = require('node:child_process') as typeof import('node:child_process');
const path = require('node:path') as typeof import('node:path');
const fs = require('node:fs') as typeof import('node:fs');
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
const { MINIMUM_MARIADB, supportedServer } = require('../dist/src/services/database-version') as typeof import('../src/services/database-version');

async function main() {
  if (!process.env.MYSQL_TEST_HOST || !process.env.MYSQL_TEST_USER || !/^[a-zA-Z0-9_]+_test$/.test(process.env.MYSQL_TEST_DATABASE || '')) {
    throw new Error('Recovery gate requires MYSQL_TEST_HOST, MYSQL_TEST_USER and an empty MYSQL_TEST_DATABASE ending in _test. No tests ran.');
  }
  const connection = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE });
  try {
    const [[server]] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version');
    if (!supportedServer(server.version)) throw new Error(`Recovery gate requires MariaDB ${MINIMUM_MARIADB.join('.')} or later (found ${server.version}).`);
    const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
    if (tables.length) throw new Error('Recovery gate refuses a non-empty database. Use a disposable empty *_test schema.');
  } finally { await connection.end(); }
  const api = path.resolve(__dirname, '..');
  const tests = fs.readdirSync(path.join(api, 'tests')).filter(name => name.endsWith('.test.js') &&
    (process.argv.includes('--all') || name.startsWith('backup-') || ['data-inventory.test.js', 'database-migrations.test.js', 'database-startup-mysql-integration.test.js'].includes(name))).sort();
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', ...tests.map(name => 'tests/' + name)], {
    cwd: api, env: { ...process.env, MYSQL_TEST_SCHEMA_SMOKE: '1' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  let tail = '';
  child.stdout.on('data', (chunk: Buffer) => { process.stdout.write(chunk); tail = (tail + chunk.toString()).slice(-8192); });
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error('Recovery gate failed. Read the test failures above.');
  if (!/^# skipped 0$/m.test(tail)) throw new Error('Recovery gate incomplete: one or more required checks skipped, or test summary missing.');
  console.log('Recovery gate passed with no skipped checks.');
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
