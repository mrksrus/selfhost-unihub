// How the instance backup drill (scripts/instance-backup-drill.mts) compares
// what belongs to the installation itself before the backup and after the
// restore. api/tests/helpers/instance-drill-state.cts reports every table the
// installation's data inventory declares as owned by the installation or an
// organisation, row by row with a hash of each column. Every such table needs
// a rule here; a newly declared one fails the drill until it gets one. A rule
// names the only changes the restore or the restored installation's start may
// make (docs/DATA_RECOVERY.md#after-an-instance-restore); everything else
// must come back as it was, and nothing may be added unless the rule names it.

/** A reported row: its primary key, a hash of each column and a few plain values the rules read. */
export interface ReportedRow { key: string; columns: Record<string, string>; plain: Record<string, string | null> }
export interface ReportedTable { owner: string; rows: ReportedRow[] }
export type InstallationReport = Record<string, ReportedTable>;

/** The backup's file, and when the restore command that restored it started and ended. */
interface Context { backupFile: string; restore: { from: Date; to: Date } }
interface Rule {
  /** Why the table comes back this way. */
  reason: string;
  /** A column of a source row that may read differently after the restore. */
  mayChange?: (column: string, source: ReportedRow, restored: ReportedRow, context: Context) => boolean;
  /** A row only the destination has that is expected there. */
  mayAdd?: (row: ReportedRow, context: Context) => boolean;
  /** The restore deletes every row of the table: none of the source's may remain. */
  cleared?: boolean;
  /** The table holds rows only while something is going on: neither side may have any. */
  empty?: boolean;
}

export const INSTALLATION_RULES: Readonly<Record<string, Rule>> = Object.freeze({
  // The restore and the app's start write no activity entry
  // (services/instance-restore.ts), so every entry must be the source's, in
  // full, and none may be added.
  audit_log: { reason: 'The activity log comes back entry by entry.' },
  system_settings: { reason: 'The installation settings come back.' },
  setting_policies: { reason: 'The administrator policies come back.' },
  // The drill restores with the image that made the backup, so no upgrade step runs.
  schema_migrations: { reason: 'The database upgrade history comes back; the same release adds no step.' },
  mail_engine_migration_progress: { reason: 'The progress of the mail upgrade comes back.' },
  instance_backups: {
    reason: 'The runs come back; the run that wrote this backup was still running in its dump, and the restore marks it succeeded with this file.',
    mayChange: (column, source, restored, { backupFile, restore }) => column === 'finished_at' && source.plain.file_name === backupFile
      && duringRestore(restored.plain.finished_at, restore),
  },
  notification_config: {
    reason: 'The push identity (key pair, subject, creation) comes back; the reminder scan cursors beside it move while a server runs.',
    mayChange: column => ['last_reminder_scan_at', 'reminder_revision', 'scanned_revision'].includes(column),
  },
  // The organisation (0.30): groups and memberships come back with their ids.
  org_groups: { reason: 'The groups come back.' },
  org_group_members: { reason: 'Every membership comes back with its role.' },
  login_attempts: { reason: 'Sign-in attempt budgets expire; the restore deletes them and the restored installation counts afresh.', cleared: true },
  // Shared address books (0.31): the books, who may reach them, the company
  // directory, and a book's contacts, photos and bin come back with their ids.
  address_books: { reason: 'The shared address books come back.' },
  grants: { reason: 'Every grant comes back with its principal and permission.' },
  directory_entries: { reason: 'The company directory comes back.' },
  ...Object.fromEntries(['contacts', 'contact_values', 'contact_properties', 'contact_photos', 'bin_items', 'photo files'].map(table =>
    [`${table} of books`, { reason: "A shared book's contacts, photos and bin come back as they were." }])),
  // Shared calendars: calendars no person owns with their events, points,
  // attendees and bin, every series, each person's view of and own
  // reminders on a calendar, and the offers of people's calendars.
  ...Object.fromEntries(['calendar_calendars', 'calendar_events', 'calendar_event_subtasks', 'calendar_event_attendees', 'bin_items'].map(table =>
    [`${table} of organisation calendars`, { reason: "A group's or the organisation's calendar comes back with its events, points, attendees and bin." }])),
  calendar_series: { reason: 'Repeating events come back with their rule and changed dates.' },
  calendar_views: { reason: "Each person's view of a calendar comes back." },
  calendar_reminders: { reason: "Each person's own reminders on a calendar they do not own come back." },
  'calendar offers': { reason: "A pending offer of a person's calendar comes back." },
  // Chat: every table comes back as stored, ciphertext as ciphertext. The
  // restore deletes the devices, which removes every chat device.
  chat_accounts: { reason: "Each person's history key comes back, still wrapped by the passphrase." },
  chat_devices: { reason: 'Chat devices come back removed: their devices are gone, so they enrol again.',
    mayChange: (column, _source, restored) => column === 'device_id' && restored.plain.device_id === null },
  chat_key_packages: { reason: 'Key packages come back; those of removed devices are never handed out.' },
  chat_conversations: { reason: 'Conversations come back with their current group and last seq.' },
  chat_members: { reason: "Each person's read and delivered marks come back." },
  chat_groups: { reason: 'Groups come back with their Welcome; the next message makes a new one.' },
  chat_group_devices: { reason: "A group's devices come back." },
  chat_messages: { reason: 'Messages come back as ciphertext, edits and deletions included.' },
  chat_archive: { reason: "Each person's archive copies come back sealed." },
  chat_attachments: { reason: "A chat file's row comes back with its message and uploader." },
  chat_calls: { reason: 'Calls come back with their outcome and their entry in the chat.' },
  chat_call_signals: { reason: "A call's signals are deleted when it ends, so an installation at rest has none.", empty: true },
  'chat files': { reason: 'Chat files come back as the ciphertext they were.' },
});

// A DATETIME in UTC (dateStrings), to the second, within the restore command's run.
function duringRestore(value: string | null | undefined, { from, to }: { from: Date; to: Date }) {
  if (!value || !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) return false;
  const at = Date.parse(`${value.replace(' ', 'T')}Z`);
  return at >= Math.floor(from.getTime() / 1000) * 1000 && at <= Math.ceil(to.getTime() / 1000) * 1000;
}

/** Why the restored installation differs from the source beyond the documented changes; empty when it does not. */
export function installationProblems(source: InstallationReport, target: InstallationReport, context: Context) {
  const problems: string[] = [];
  for (const table of [...new Set([...Object.keys(source), ...Object.keys(target)])].sort()) {
    const rule = INSTALLATION_RULES[table];
    if (!rule) { problems.push(`${table}: declared as ${(source[table] ?? target[table]).owner}-owned, but the drill neither compares it nor names an exception`); continue; }
    if (!source[table] || !target[table]) { problems.push(`${table}: not reported by the ${source[table] ? 'restored installation' : 'source'}`); continue; }
    if (rule.empty) { if (source[table].rows.length || target[table].rows.length) problems.push(`${table}: has rows, but holds none at rest`); continue; }
    const sourceRows = new Map(source[table].rows.map(row => [row.key, row]));
    const targetRows = new Map(target[table].rows.map(row => [row.key, row]));
    if (!sourceRows.size) problems.push(`${table}: the source has no rows to compare`);
    for (const [key, row] of sourceRows) {
      const restored = targetRows.get(key);
      if (!restored) { if (!rule.cleared) problems.push(`${table} ${key}: missing after the restore`); continue; }
      if (rule.cleared) { problems.push(`${table} ${key}: kept, but the restore clears the table`); continue; }
      for (const column of [...new Set([...Object.keys(row.columns), ...Object.keys(restored.columns)])].sort()) {
        if (row.columns[column] !== restored.columns[column] && !rule.mayChange?.(column, row, restored, context)) problems.push(`${table} ${key}: ${column} changed`);
      }
    }
    for (const [key, row] of targetRows) {
      if (!sourceRows.has(key) && !rule.mayAdd?.(row, context)) problems.push(`${table} ${key}: added by the restore (${JSON.stringify(row.plain)})`);
    }
  }
  for (const table of Object.keys(INSTALLATION_RULES)) {
    if (!source[table] && !target[table]) problems.push(`${table}: has a rule but is not reported as installation- or organisation-owned`);
  }
  return problems;
}
