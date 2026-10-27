import { readFileSync } from 'node:fs';
import { apiRequire, stack } from './env.ts';

// Read-only look at this instance's own database, for facts the screen does not
// show (what was stored, which notification was queued). Tests change data only
// through the app.
const mysql = apiRequire('mysql2/promise');

export async function dbRead<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('dbRead runs SELECT statements only');
  const password = /^APP_PW=(.*)$/m.exec(readFileSync(stack.dbEnvFile, 'utf8'))?.[1];
  const db = await mysql.createConnection({ host: '127.0.0.1', port: stack.dbPort, user: 'unihub', password,
    database: 'unihub_dev', timezone: 'Z' });
  try {
    await db.query('SET SESSION TRANSACTION READ ONLY');
    const [rows] = await db.execute(sql, params);
    return rows as T[];
  } finally {
    await db.end();
  }
}
