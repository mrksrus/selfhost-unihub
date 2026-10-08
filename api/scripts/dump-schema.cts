#!/usr/bin/env node
// Writes docker/mariadb/schema.sql from the app's own startup schema code,
// so the reference file can never drift from what installations actually run.
//
//   node scripts/dump-schema.cts            migrate an EMPTY database, write the file
//   node scripts/dump-schema.cts --check    same, but compare with the file (exit 2 on drift)
//   node scripts/dump-schema.cts --existing --check
//                                          run the startup upgrades on an existing
//                                          database (e.g. an old dump) and compare
//
// Uses the API database configuration (MYSQL_* or DATABASE_URL) plus the usual
// startup secrets. scripts/local-db.sh schema-dump sets all of these up.
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise';
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

const SCHEMA_FILE = path.resolve(__dirname, '../../docker/mariadb/schema.sql');
const HEADER = `-- UniHub MariaDB schema after all startup upgrades. GENERATED, do not edit.
-- Regenerate with: scripts/local-db.sh schema-dump (api/scripts/dump-schema.cts).
-- Schema changes are numbered migrations in api/src/services/database.js; the app
-- creates and upgrades its own schema on startup. This file is a reviewable
-- reference, and a database test fails when it differs from a freshly migrated database.
`;

// Deterministic across runs: sorted tables, no AUTO_INCREMENT counters.
function normalizeCreateTable(sql: string) {
  return sql.replace(/ AUTO_INCREMENT=\d+/g, '').trimEnd() + ';';
}

async function dumpSchema(connection: Pick<Connection, 'query'>) {
  const [rows] = await connection.query<RowDataPacket[]>(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"
  );
  const names = rows.map(row => row.name as string).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const tables = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unexpected table name: ${name}`);
    const [[row]] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${name}\``);
    tables.push(normalizeCreateTable(row['Create Table']));
  }
  return `${HEADER}\n${tables.join('\n\n')}\n`;
}

// Everything the API runs against the schema at startup (api/src/app.ts).
async function migrateCurrentSchema(): Promise<Pool> {
  const { initDatabase, ensurePerformanceIndexes } = require('../dist/src/services/database') as typeof import('../src/services/database');
  await initDatabase();
  await (require('../dist/src/services/notifications') as typeof import('../src/services/notifications')).ensureNotificationSchema();
  await ensurePerformanceIndexes();
  return (require('../dist/src/state') as typeof import('../src/state')).getDb()!;
}

// Line diff (LCS) for review output, each change labelled with its table.
// Schemas are about a thousand lines, so the quadratic table is fine.
function describeDifference(expected: string, actual: string) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let table = '';
  const note = (sign: string, line: string) => lines.push(`${sign} ${line}${line.startsWith('CREATE TABLE') ? '' : `    [${table}]`}`);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (a[i].startsWith('CREATE TABLE')) table = a[i].replace(/ \($/, '');
      i++; j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      note('+', b[j++]);
    } else {
      note('-', a[i++]);
    }
  }
  return lines.join('\n');
}

async function main(args: string[]) {
  const check = args.includes('--check');
  const existing = args.includes('--existing');
  const unknown = args.filter(arg => !['--check', '--existing'].includes(arg));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(' ')}`);
  const { getDatabaseConfig } = require('../dist/src/services/database-config') as typeof import('../src/services/database-config');
  const config = getDatabaseConfig();
  if (!config) throw new Error('Missing database configuration (MYSQL_* or DATABASE_URL)');
  if (!existing) {
    const connection = await mysql.createConnection(config);
    try {
      const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
      if (tables.length) throw new Error(`${config.database} is not empty; the schema dump needs an empty database`);
    } finally {
      await connection.end();
    }
  }
  const db = await migrateCurrentSchema();
  try {
    const actual = await dumpSchema(db);
    if (!check) {
      fs.writeFileSync(SCHEMA_FILE, actual);
      console.log(`dump-schema: wrote ${path.relative(process.cwd(), SCHEMA_FILE)}`);
      return;
    }
    const expected = fs.readFileSync(SCHEMA_FILE, 'utf8');
    if (expected === actual) {
      console.log('dump-schema: database matches docker/mariadb/schema.sql');
      return;
    }
    console.error('dump-schema: database differs from docker/mariadb/schema.sql (- file, + database):');
    console.error(describeDifference(expected, actual));
    process.exitCode = 2;
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: Error) => {
    console.error(`dump-schema: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { SCHEMA_FILE, dumpSchema, migrateCurrentSchema, normalizeCreateTable, describeDifference };
