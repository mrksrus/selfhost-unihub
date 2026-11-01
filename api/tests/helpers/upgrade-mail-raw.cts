import type { RowDataPacket } from 'mysql2/promise';
// Piped into an installation by scripts/upgrade-check.mts (on every release in
// the window and the candidate) and run there with its configuration. Reports
// the original message of each of one person's emails as the server keeps it:
// its recorded format and hash, and the hash of the stored file itself, so a
// lost or changed original shows even when the database row survives.
// Read-only; prints JSON with hashes only.
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));
const apiRoot = process.env.UNIHUB_API_ROOT!;
const mysql = require(require.resolve('mysql2/promise', { paths: [apiRoot] })) as typeof import('mysql2/promise');
const UPLOADS = path.resolve(process.env.UNIHUB_UPLOADS_ROOT || '/app/uploads');

async function main() {
  const email = process.env.RAW_USER_EMAIL;
  if (!email) throw new Error('RAW_USER_EMAIL is required');
  const db = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, timezone: '+00:00' });
  try {
    const [rows] = await db.query<RowDataPacket[]>(`SELECT e.id, e.raw_storage_path, e.raw_sha256, e.raw_format, e.raw_verified, e.raw_bytes
      FROM emails e JOIN users u ON u.id = e.user_id WHERE u.email = ?`, [email]);
    const raw: Record<string, { format: string | null; verified: boolean; recorded: string | null; bytes: number | null; stored: string | null }> = {};
    for (const row of rows) {
      let stored: string | null = null;
      const file = row.raw_storage_path ? path.resolve(String(row.raw_storage_path)) : null;
      // Only a file inside the storage counts.
      if (file && file.startsWith(UPLOADS + path.sep)) {
        try { stored = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { stored = null; }
      }
      raw[String(row.id)] = { format: row.raw_format ?? null, verified: Number(row.raw_verified) === 1, recorded: row.raw_sha256 ?? null,
        bytes: row.raw_bytes == null ? null : Number(row.raw_bytes), stored };
    }
    console.log(JSON.stringify(raw));
  } finally { await db.end(); }
}
main().catch((error: Error) => { console.error(error.stack || error.message); process.exit(1); });
