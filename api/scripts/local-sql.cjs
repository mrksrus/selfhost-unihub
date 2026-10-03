#!/usr/bin/env node
// Minimal SQL runner for scripts/local-db.sh. The official minimal MySQL
// client needs libncurses.so.6, which some distributions (e.g. Arch) do not
// ship; the API's own mysql2 driver avoids that dependency.
//   node local-sql.cjs [--database name] [-e "SQL"]   (else SQL from stdin)
'use strict';
const mysql = require('mysql2/promise');

async function main() {
  const args = process.argv.slice(2);
  let database, sql;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--database') database = args[++i];
    else if (args[i] === '-e') sql = args[++i];
    else throw new Error(`Unknown argument ${args[i]}`);
  }
  if (sql == null) sql = require('node:fs').readFileSync(0, 'utf8');
  const connection = await mysql.createConnection({
    socketPath: process.env.LOCAL_MYSQL_SOCKET, user: process.env.LOCAL_MYSQL_USER || 'root',
    password: process.env.LOCAL_MYSQL_PASSWORD || undefined, database, multipleStatements: true,
  });
  try {
    const [result] = await connection.query(sql);
    const sets = Array.isArray(result) && result.some(Array.isArray) ? result.filter(Array.isArray) : [result];
    for (const rows of sets) if (Array.isArray(rows) && rows.length) console.table(rows);
  } finally { await connection.end(); }
}
main().catch(error => { console.error(`local-sql: ${error.code || ''} ${error.message}`); process.exit(1); });
