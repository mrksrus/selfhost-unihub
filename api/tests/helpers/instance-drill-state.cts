import type { RowDataPacket } from 'mysql2/promise';
// Piped into an installation by scripts/instance-backup-drill.mts and run there
// with its configuration.
//   DRILL_MODE=seed DRILL_ADMIN_ID=<id>: installation rows a fresh one does
//     not have: a policy (backup.download_mail = always, locked), stored as an
//     administrator's policy is (setting_policies; the admin routes come with
//     stream C2), two earlier instance backup runs, and mail upgrade progress
//     other than the defaults a new database starts with (nothing reads it
//     once the upgrade is done).
//   DRILL_MODE=report: what belongs to the whole installation, not to one
//     person's recovery sections: every table the installation's data
//     inventory declares as owned by the installation or an organisation, row
//     by row (scripts/instance-drill-compare.mts compares them), the people,
//     each mail account's row, and what an instance restore resets
//     (docs/DATA_RECOVERY.md#after-an-instance-restore): sessions, tickets,
//     sign-in challenges, leases and provider work it must not replay.
//     Secrets and whole rows appear as hashes only.
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const apiRoot = process.env.UNIHUB_API_ROOT!;
const mysql = require(require.resolve('mysql2/promise', { paths: [apiRoot] })) as typeof import('mysql2/promise');
// The inventory of the release under test, as built into the installation.
const { TABLE_DECLARATIONS } = require(require('node:path').join(apiRoot, 'src/services/data-inventory.js')) as typeof import('../../src/services/data-inventory');

const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value, (_key, item) => Buffer.isBuffer(item) ? item.toString('base64') : item)).digest('hex');
// The columns an instance restore resets on a mail account (docs/DATA_RECOVERY.md#after-an-instance-restore).
// Plain values the comparison's rules read; none is a secret.
const PLAIN: Record<string, string[]> = { audit_log: ['action'], instance_backups: ['status', 'file_name'] };
const ACCOUNT_RESETS = ['is_active', 'delete_emails_on_server', 'server_delete_enabled_at', 'server_delete_grace_until', 'sync_policy_confirmed_at', 'updated_at'];

async function main() {
  const db = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, timezone: '+00:00', dateStrings: true });
  const rows = async (sql: string, params: unknown[] = []) => (await db.query<RowDataPacket[]>(sql, params))[0];
  const count = async (sql: string) => Number((await rows(sql))[0].n);
  try {
    if (process.env.DRILL_MODE === 'seed') {
      const admin = String(process.env.DRILL_ADMIN_ID || '');
      if (!/^[0-9a-f-]{36}$/.test(admin)) throw new Error('DRILL_ADMIN_ID is required');
      await db.execute(`INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked, updated_by)
        VALUES ('installation', '', 'policy.backup.download_mail', 'always', 1, ?)`, [admin]);
      // Earlier runs: one that failed, and a scheduled one whose file the retention removed.
      await db.execute(`INSERT INTO instance_backups (id, trigger_kind, actor_id, status, file_name, size_bytes, sha256, key_fingerprint, app_version, migration_id, error, started_at, finished_at, removed_at)
        SELECT UUID(), 'manual', ?, 'failed', NULL, NULL, NULL, 'drillearlier0001', '0.27.0', MAX(id), 'The destination was full.', '2026-01-02 03:30:00', '2026-01-02 03:31:00', NULL FROM schema_migrations
        UNION ALL SELECT UUID(), 'schedule', NULL, 'succeeded', 'unihub-instance-20260103T033000Z-0.27.0.uhib', 4096, REPEAT('a', 64), 'drillearlier0001', '0.27.0', MAX(id), NULL,
          '2026-01-03 03:30:00', '2026-01-03 03:32:00', '2026-01-10 03:33:00' FROM schema_migrations`, [admin]);
      await db.execute("UPDATE mail_engine_migration_progress SET last_id = '00000000-0000-4000-8000-00000000d211', processed = processed + 7");
      console.log(JSON.stringify({ seeded: ['setting_policies', 'instance_backups', 'mail_engine_migration_progress'] }));
      return;
    }
    if (process.env.DRILL_MODE !== 'report') throw new Error('DRILL_MODE is seed or report');
    const installation: Record<string, { owner: string; rows: { key: string; columns: Record<string, string>; plain: Record<string, string | null> }[] }> = {};
    for (const [table, declaration] of Object.entries(TABLE_DECLARATIONS).filter(([, declaration]) => declaration.owner !== 'user').sort()) {
      const key = (await rows(`SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
        ORDER BY SEQ_IN_INDEX`, [table])).map(row => String(row.COLUMN_NAME));
      if (!key.length) throw new Error(`${table} has no primary key to compare rows by`);
      installation[table] = { owner: declaration.owner, rows: (await rows(`SELECT * FROM \`${table}\` ORDER BY ${key.map(column => `\`${column}\``).join(', ')}`)).map(row => ({
        key: key.map(column => String(row[column])).join('/'),
        columns: Object.fromEntries(Object.entries(row).map(([column, value]) => [column, hash(value)])),
        plain: Object.fromEntries((PLAIN[table] || []).map(column => [column, row[column] == null ? null : String(row[column])])),
      })) };
    }
    const users = (await rows('SELECT * FROM users ORDER BY id')).map(row => ({ id: row.id, email: row.email, role: row.role, is_active: Number(row.is_active), row: hash(row) }));
    const mailAccounts = (await rows('SELECT * FROM mail_accounts ORDER BY id')).map(row => {
      const kept = Object.fromEntries(Object.entries(row).filter(([key]) => !ACCOUNT_RESETS.includes(key)));
      return { id: row.id, user_id: row.user_id, email_address: row.email_address, is_active: Number(row.is_active), delete_emails_on_server: Number(row.delete_emails_on_server),
        server_delete_enabled_at: row.server_delete_enabled_at ?? null, server_delete_grace_until: row.server_delete_grace_until ?? null,
        sync_policy_confirmed_at: row.sync_policy_confirmed_at ?? null, kept: hash(kept) };
    });
    console.log(JSON.stringify({
      users, mailAccounts, installation,
      policies: await rows('SELECT target_kind, target_id, setting_key, setting_value, locked FROM setting_policies ORDER BY target_kind, target_id, setting_key'),
      resets: {
        sessions: await count('SELECT COUNT(*) AS n FROM sessions'),
        fileTickets: await count('SELECT COUNT(*) AS n FROM file_tickets'),
        signInChallenges: await count('SELECT COUNT(*) AS n FROM two_factor_challenges'),
        leases: await count('SELECT (SELECT COUNT(*) FROM mail_engine_accounts WHERE lease_owner IS NOT NULL) + (SELECT COUNT(*) FROM mail_engine_jobs WHERE lease_owner IS NOT NULL) AS n'),
        runnableEngineJobs: await count("SELECT COUNT(*) AS n FROM mail_engine_jobs WHERE state IN ('queued', 'running', 'error')"),
        runnableWritebacks: await count("SELECT COUNT(*) AS n FROM mail_writebacks WHERE status = 'pending' OR is_current = TRUE"),
        calendarMoves: await count('SELECT COUNT(*) AS n FROM calendar_event_moves'),
        scheduledSends: await count("SELECT COUNT(*) AS n FROM mail_scheduled_sends WHERE status IN ('scheduled', 'sending')"),
        providerDeletions: await count("SELECT COUNT(*) AS n FROM mail_server_messages WHERE delete_status = 'pending'"),
      },
    }));
  } finally { await db.end(); }
}
main().catch((error: Error) => { console.error(error.stack || error.message); process.exit(1); });
