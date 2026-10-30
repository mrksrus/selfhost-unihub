import type { FixtureValue } from '../../../helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
// Maintenance only: pass an untouched `git archive v0.25.1 api package.json`
// extraction, built with its own `node scripts/build.cts`, as argument 1.
// Uses its real exporter and an empty disposable MariaDB test database.
const path = (require('node:path') as typeof import('node:path'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const mysql = require('mysql2/promise') as typeof import('mysql2/promise');

// Invented contacts in the fixed 3+3 shape: unicode, empty and blank slots,
// gaps, repeated values within one contact and a never-filled avatar_url.
const USER = '01250000-0000-4000-8000-000000000001';
const CONTACTS = [
  { id: '01250000-0000-4000-8000-000000000011', first_name: 'Zoë', last_name: 'Ünïcödé-Ølsen', email: 'shared@example.test', email2: 'shared@example.test', email3: 'zoë@example.test',
    phone: '+43 1 234 5678', phone2: null, phone3: '+43 1 234 5678', company: 'Beispiel GmbH', job_title: 'Leiterin Ärger', notes: 'Grüße 🎉\nمرحبا بالعالم\nSecond line',
    avatar_url: 'https://example.test/never-shown.png', is_favorite: 1, created_at: '2030-01-01 10:00:00', updated_at: '2030-01-02 10:00:00' },
  { id: '01250000-0000-4000-8000-000000000012', first_name: '李', last_name: '小龙', email: null, email2: '   ', email3: 'third@example.org',
    phone: '', phone2: '+86 10 1234 5678', phone3: null, company: null, job_title: null, notes: null, avatar_url: null, is_favorite: 0,
    created_at: '2030-01-03 10:00:00', updated_at: '2030-01-03 10:00:00' },
  { id: '01250000-0000-4000-8000-000000000013', first_name: 'Nur', last_name: null, email: null, email2: null, email3: null,
    phone: null, phone2: null, phone3: null, company: null, job_title: null, notes: '', avatar_url: null, is_favorite: 0,
    created_at: '2030-01-04 10:00:00', updated_at: '2030-01-04 10:00:00' },
  { id: '01250000-0000-4000-8000-000000000014', first_name: 'Full', last_name: 'Example', email: 'a@example.net', email2: 'B@Example.net', email3: 'c@example.net',
    phone: '+1 555 0100', phone2: '0664 555 0101', phone3: '(555) 0102', company: 'Example Ltd', job_title: 'Tester', notes: 'Three of each',
    avatar_url: null, is_favorite: 0, created_at: '2030-01-05 10:00:00', updated_at: '2030-01-05 10:00:00' },
];

(async () => {
  const source = path.resolve(process.argv[2], 'api');
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'v4-fixture-jwt-secret-not-used-anywhere-else', ENCRYPTION_KEY: 'v4-fixture-encryption-key-not-a-secret',
    BOOTSTRAP_ADMIN_EMAIL: 'v4-bootstrap@example.test', BOOTSTRAP_ADMIN_PASSWORD: 'v4-bootstrap-password-not-a-secret' });
  assert.match(String(process.env.MYSQL_TEST_DATABASE), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT), user: process.env.MYSQL_TEST_USER,
    password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE, timezone: 'Z' });
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES');
    assert.equal(tables.length, 0, 'Fixture generator needs an empty test database');
    require(path.join(source, 'dist/src/state')).setDb(pool);
    await require(path.join(source, 'dist/src/services/database')).ensureSchema();
    await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [USER, 'v4-fixture@example.test', 'not-a-real-password-hash', 'Schema four fixture']);
    for (const contact of CONTACTS) {
      const row = { ...contact, user_id: USER };
      await pool.execute<ResultSetHeader>(`INSERT INTO contacts (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row) as (string | number | null)[]);
    }
    const entries = await require(path.join(source, 'dist/src/services/backup')).buildBackupArchiveEntriesForUser(USER, 'contacts');
    assert.ok(Array.isArray(entries) && entries.length >= 3);
    const output = path.join(__dirname, 'plain.zip');
    await require(path.join(source, 'dist/src/services/export-jobs')).writeZip(entries, output);
    const sha = (bytes: FixtureValue) => crypto.createHash('sha256').update(bytes).digest('hex');
    const hashes: FixtureValue = {};
    for (const file of ['services/backup-export.ts', 'services/backup-format.ts', 'services/export-jobs.ts', 'services/backup-catalog.ts']) hashes[file] = sha(await fs.readFile(path.join(source, 'src', file)));
    await fs.writeFile(path.join(__dirname, 'expected.json'), JSON.stringify({ tag: 'v0.25.1', commit: '7be6f753ac50b5e8083224379a1aba4fc53d7396', version: 4, sha256: sha(await fs.readFile(output)),
      source_sha256: hashes, user: USER, contacts: CONTACTS }, null, 2) + '\n');
    console.log(output);
  } finally { await pool.end(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
