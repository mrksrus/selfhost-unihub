import type { RowDataPacket } from 'mysql2/promise';
// Piped into an installation by scripts/recovery-fresh-install.mts. Reports,
// for one user, what only the server can see: rows per recovery table (from
// the installation's own catalog), stored files, references, credentials and
// background state. Read-only; prints JSON without any secret.
//
// mirror: per table, the rows a user backup leaves out by data class (F2:
// Sync-mode mail with a provider copy and its files and evidence, events of
// CalDAV and ICS calendars with their children), by the installation's own
// class rules (backup-classes.ts), with "Include downloaded mail" on. Empty
// on releases before data schema 7, which export every row.
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));
const apiRoot = process.env.UNIHUB_API_ROOT!;
const mysql = require(require.resolve('mysql2/promise', { paths: [apiRoot] })) as typeof import('mysql2/promise');
const catalog = require(path.join(apiRoot, 'src/services/backup-catalog')) as typeof import('../../src/services/backup-catalog');
const { decrypt } = require(path.join(apiRoot, 'src/security/encryption')) as typeof import('../../src/security/encryption');
type Classes = typeof import('../../src/services/backup-classes');
const classes: Classes | null = fs.existsSync(path.join(apiRoot, 'src/services/backup-classes.js')) ? require(path.join(apiRoot, 'src/services/backup-classes')) : null;

const userId = process.env.INSPECT_USER_ID!;
const expectedSecrets = JSON.parse(process.env.INSPECT_SECRETS || '{"mail":[],"calendar":null}') as { mail: string[]; calendar: string | null };
// The image's storage, or a local installation's own (scripts/fresh-installations.mts).
const UPLOADS = process.env.UNIHUB_UPLOADS_ROOT || '/app/uploads';
const FILE_ROOTS: Record<string, string> = { email_attachment: 'attachments', raw_email: 'mail-raw', recording: 'recordings', recording_bin: 'recordings' };
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  if (!/^[0-9a-f-]{36}$/.test(userId)) throw new Error('INSPECT_USER_ID is required');
  const db = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT), database: process.env.MYSQL_DATABASE,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, timezone: '+00:00' });
  const rows = async (sql: string, params: unknown[] = []) => (await db.query<RowDataPacket[]>(sql, params))[0];
  try {
    const columns = async (table: string) => (await rows('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table])).map(row => row.name as string);
    const owned = async (table: string) => {
      if ((await columns(table)).includes('user_id')) return rows(`SELECT * FROM \`${table}\` WHERE user_id = ?`, [userId]);
      // Tables without an owner column belong to the user through a mail account.
      return rows(`SELECT t.* FROM \`${table}\` t JOIN mail_accounts a ON a.id = t.mail_account_id WHERE a.user_id = ?`, [userId]);
    };
    const tables: Record<string, number> = {};
    const problems: string[] = [];
    const data: Record<string, RowDataPacket[]> = {};
    for (const [section, policy] of Object.entries(catalog.SECTION_POLICIES)) {
      for (const table of policy.tables) {
        if (table === 'user') continue;
        data[table] = await owned(table);
        // A table several sections share (the bin) counts each section's rows.
        const shared = catalog.TABLE_POLICIES[table]?.rowSection;
        tables[`${section}.${table}`] = shared ? data[table].filter(row => row[shared] === section).length : data[table].length;
      }
    }
    const mirror: Record<string, number> = {};
    // Ids of the stored-file rows a user backup leaves out (Sync-mode mail and its attachments).
    const mirrorFileRows = new Set<string>();
    if (classes) {
      const [downloadAccounts] = await db.query<RowDataPacket[]>("SELECT id FROM mail_accounts WHERE user_id = ? AND sync_mode <> 'sync'", [userId]);
      const kept = classes.keptEmailSql('ke', downloadAccounts.map(row => String(row.id)));
      const localEvent = `EXISTS (SELECT 1 FROM calendar_events ce WHERE ce.id = b.event_id AND ce.user_id = b.user_id AND ${classes.localEventSql('ce')})`;
      const keptEmail = { sql: `EXISTS (SELECT 1 FROM emails ke WHERE ke.id = b.email_id AND ke.user_id = b.user_id AND ${kept.sql})`, params: kept.params };
      const syncAccount = { sql: `NOT ${classes.syncAccountSql('b.mail_account_id')}`, params: [] as string[] };
      const keptRows: Record<string, { sql: string; params: string[] }> = {
        calendar_events: { sql: classes.localEventSql('b'), params: [] }, calendar_event_subtasks: { sql: localEvent, params: [] },
        calendar_event_attendees: { sql: localEvent, params: [] }, calendar_event_external_refs: { sql: 'FALSE', params: [] },
        emails: classes.keptEmailSql('b', downloadAccounts.map(row => String(row.id))),
        email_attachments: keptEmail, mail_email_scores: keptEmail, mail_folder_recovery_items: keptEmail,
        mail_remote_mailboxes: syncAccount, mail_remote_occurrences: syncAccount, mail_gmail_messages: syncAccount, mail_writebacks: syncAccount,
        mail_operation_attempts: syncAccount, mail_engine_quarantine: syncAccount,
      };
      for (const [section, policy] of Object.entries(catalog.SECTION_POLICIES)) {
        for (const table of policy.tables) {
          const rule = keptRows[table];
          if (!rule) continue;
          const owner = (await columns(table)).includes('user_id') ? 'b.user_id = ?' : 'EXISTS (SELECT 1 FROM mail_accounts oa WHERE oa.id = b.mail_account_id AND oa.user_id = ?)';
          const [[row]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${table}\` b WHERE ${owner} AND NOT (${rule.sql})`, [userId, ...rule.params]);
          mirror[`${section}.${table}`] = Number(row.n);
          if (table === 'emails' || table === 'email_attachments') {
            const [ids] = await db.query<RowDataPacket[]>(`SELECT b.id FROM \`${table}\` b WHERE ${owner} AND NOT (${rule.sql})`, [userId, ...rule.params]);
            for (const id of ids) mirrorFileRows.add(String(id.id));
          }
        }
      }
    }
    // Every reference of this user's rows resolves to a row this user owns.
    for (const [table, references] of Object.entries(catalog.REFERENCES)) {
      for (const row of data[table] || []) {
        for (const [column, parent] of Object.entries(references)) {
          if (row[column] == null) continue;
          if (!(data[parent] || []).some(candidate => candidate.id === row[column])) problems.push(`${table}.${column} points outside the user's ${parent}`);
        }
      }
    }
    const linkedEvents = data.calendar_events.filter(event => event.source_email_id);
    for (const event of linkedEvents) {
      if (!data.emails.some(email => email.id === event.source_email_id)) problems.push(`calendar_events.source_email_id of "${event.title}" does not name one of the user's emails`);
    }
    // Stored files: regular files, inside this user's directory, with the recorded bytes.
    const files: { kind: string; sha256: string; size: number; uid: number; mode: number; mirror: boolean }[] = [];
    for (const [kind, policy] of Object.entries(catalog.FILE_POLICIES)) {
      const bin = policy.table === 'bin_items';
      for (const row of (data[policy.table] || []).filter(item => !bin || item.item_type === 'recording')) {
        // A recording in the bin keeps its file under the bin's name, in the person's bin folder.
        const payload = bin ? (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) : null;
        const stored = (bin ? payload?.bin_path : row[policy.column]) as string | null;
        if (!stored) { problems.push(`${policy.table} row without ${policy.column}`); continue; }
        const directory = path.join(UPLOADS, FILE_ROOTS[kind], userId, ...(bin ? ['bin'] : [])) + path.sep;
        if (!path.resolve(stored).startsWith(directory)) { problems.push(`${kind} stored outside ${directory}: ${stored}`); continue; }
        let stat: import('node:fs').Stats;
        try { stat = fs.lstatSync(stored); } catch { problems.push(`${kind} file missing: ${stored}`); continue; }
        if (!stat.isFile()) { problems.push(`${kind} is not a regular file: ${stored}`); continue; }
        if (!fs.realpathSync(stored).startsWith(directory)) problems.push(`${kind} resolves outside ${directory}`);
        const bytes = fs.readFileSync(stored);
        if (kind === 'raw_email' && hash(bytes) !== row.raw_sha256) problems.push(`raw email bytes differ from raw_sha256: ${stored}`);
        if (kind !== 'raw_email' && Number(bin ? payload?.recording?.size_bytes : row.size_bytes) !== bytes.length) problems.push(`${kind} size differs from size_bytes: ${stored}`);
        files.push({ kind, sha256: hash(bytes), size: bytes.length, uid: stat.uid, mode: stat.mode & 0o777, mirror: mirrorFileRows.has(String(row.id)) });
      }
    }
    // Content-addressed files (contact photos): each named file once, inside
    // the user's directory, with the bytes its name promises.
    const CONTENT_ROOTS: Record<string, string> = { contact_photo: 'contact-photos' };
    for (const [kind, policy] of Object.entries(catalog.CONTENT_FILE_POLICIES)) {
      const names = new Set((data[policy.table] || []).flatMap(row => policy.columns.map(column => String(row[column]))));
      const directory = path.join(UPLOADS, CONTENT_ROOTS[kind], userId) + path.sep;
      for (const name of names) {
        const stored = path.join(directory, `${name}.jpg`);
        let stat: import('node:fs').Stats;
        try { stat = fs.lstatSync(stored); } catch { problems.push(`${kind} file missing: ${stored}`); continue; }
        if (!stat.isFile()) { problems.push(`${kind} is not a regular file: ${stored}`); continue; }
        if (!fs.realpathSync(stored).startsWith(directory)) problems.push(`${kind} resolves outside ${directory}`);
        const bytes = fs.readFileSync(stored);
        if (hash(bytes) !== name) problems.push(`${kind} bytes differ from their name: ${stored}`);
        files.push({ kind, sha256: hash(bytes), size: bytes.length, uid: stat.uid, mode: stat.mode & 0o777, mirror: false });
      }
    }
    const leftovers = ['backups/restores', 'backups/imports'].flatMap(dir => {
      const root = path.join(UPLOADS, dir);
      return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory()).map(entry => path.join(entry.parentPath, entry.name)) : [];
    });
    const credentials = {
      mail: data.mail_accounts.map(account => ({ email_address: account.email_address, ciphertext_sha256: account.encrypted_password ? hash(account.encrypted_password) : null,
        matches: decrypt(account.encrypted_password) === expectedSecrets.mail[Number(/fresh-mail-(\d+)@/.exec(account.email_address)?.[1])],
        is_active: account.is_active, delete_emails_on_server: account.delete_emails_on_server, sync_mode: account.sync_mode })),
      calendar: data.calendar_accounts.map(account => ({ ciphertext_sha256: account.encrypted_password ? hash(account.encrypted_password) : null,
        matches: expectedSecrets.calendar != null && decrypt(account.encrypted_password) === expectedSecrets.calendar, is_active: account.is_active })),
    };
    const writebacks = data.mail_writebacks.map(row => ({ status: row.status, state: row.state, is_current: row.is_current, dispatched: row.dispatched }));
    const jobs = await rows('SELECT state, lease_owner, lease_until FROM mail_engine_jobs WHERE user_id = ?', [userId]);
    const [{ sessions }] = await rows('SELECT COUNT(*) AS sessions FROM sessions WHERE user_id = ?', [userId]);
    const [{ legacy }] = await rows('SELECT COUNT(*) AS legacy FROM tetris_scores WHERE user_id = ?', [userId]);
    console.log(JSON.stringify({ tables, mirror, problems, files, leftovers, credentials, writebacks, sessions: Number(sessions), legacyScores: Number(legacy),
      activeJobs: jobs.filter(job => ['queued', 'running'].includes(job.state) || job.lease_owner != null).length,
      sourceEmailLinks: linkedEvents.length, uploadsOwner: fs.statSync(UPLOADS).uid }));
  } finally { await db.end(); }
}
main().catch((error: Error) => { console.error(error.stack || error.message); process.exit(1); });
