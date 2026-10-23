// Keep stored flags as the last confirmed provider state. Show an accepted
// pending action immediately, including after a page reload or a long sync.
const effectiveFlagSql = (action: 'read' | 'star', column: 'is_read' | 'is_starred') => `COALESCE((SELECT CAST(w.target_value AS UNSIGNED)
  FROM mail_writebacks w WHERE w.email_id = emails.id AND w.user_id = emails.user_id
    AND w.action = '${action}' AND w.status = 'pending' AND w.is_current = TRUE
    ORDER BY w.intent_revision DESC, w.created_at DESC, w.id DESC LIMIT 1), emails.${column})`;
const pendingFlagSql = (action: 'read' | 'star') => `EXISTS(SELECT 1 FROM mail_writebacks w WHERE w.email_id = emails.id
  AND w.user_id = emails.user_id AND w.action = '${action}' AND w.status = 'pending' AND w.is_current = TRUE)`;
const EFFECTIVE_READ_SQL = effectiveFlagSql('read', 'is_read');
const EFFECTIVE_STAR_SQL = effectiveFlagSql('star', 'is_starred');

// Provider membership is an occurrence property, not a single message folder.
// Generic copies keep separate email IDs; Gmail labels can share one ID.
const pendingMoveSql = `(SELECT w.target_folder FROM mail_writebacks w
  WHERE w.email_id = emails.id AND w.user_id = emails.user_id
    AND w.action = 'move' AND w.status = 'pending' AND w.is_current = TRUE
  ORDER BY w.intent_revision DESC, w.created_at DESC, w.id DESC LIMIT 1)`;
const localFilingSql = `(emails.is_legacy = TRUE OR COALESCE(emails.filing_account_id, emails.mail_account_id) <> emails.mail_account_id
  OR EXISTS(SELECT 1 FROM mail_accounts filing_source WHERE filing_source.id = emails.mail_account_id
    AND filing_source.user_id = emails.user_id AND filing_source.sync_mode <> 'sync'))`;
const membershipTables = `mail_remote_occurrences o
  JOIN mail_remote_mailboxes m ON m.id = o.mailbox_id AND m.user_id = o.user_id
    AND m.mail_account_id = o.mail_account_id AND m.state = 'active' AND m.uidvalidity = o.uidvalidity
  JOIN mail_folder_remote_boxes b ON b.mail_account_id = o.mail_account_id
    AND BINARY b.remote_name = BINARY m.remote_name
  JOIN mail_folders f ON f.id = b.folder_id AND f.user_id = o.user_id`;
const membershipWhere = `o.email_id = emails.id AND o.user_id = emails.user_id
  AND o.mail_account_id = emails.mail_account_id AND o.presence = 'present'`;
// Sync mode removes local copies the server no longer has once the account's
// policy is confirmed. Until then a missing copy is not guessed back into its
// old provider folder and appears only in All mail. On Gmail without a visible
// All Mail, missing mail may only be archived: it is kept and filed in
// 'archive' (mail-sync-policy.ts), which this view honours. Explicit
// Legacy/import/local filing and pre-migration messages not observed by the
// engine retain their local folders.
const fallbackFolderSql = `(CASE WHEN ${localFilingSql} OR (COALESCE(emails.remote_missing, FALSE) = FALSE
  AND NOT EXISTS(SELECT 1 FROM mail_remote_occurrences known WHERE known.email_id = emails.id
    AND known.user_id = emails.user_id AND known.mail_account_id = emails.mail_account_id))
  OR (COALESCE(emails.remote_missing, FALSE) = TRUE AND emails.folder = 'archive')
  THEN emails.folder ELSE NULL END)`;

// Takes three identical bound folder parameters. The latest accepted MOVE
// overrides old membership until its outcome is reconciled, never duplicates it.
const folderMembershipSql = `(CASE
  WHEN ${pendingMoveSql} IS NOT NULL THEN ${pendingMoveSql} = ?
  WHEN NOT ${localFilingSql} AND EXISTS(SELECT 1 FROM ${membershipTables} WHERE ${membershipWhere})
    THEN EXISTS(SELECT 1 FROM ${membershipTables} WHERE ${membershipWhere} AND f.slug = ?)
  ELSE ${fallbackFolderSql} = ? END)`;

// Snoozed messages are counted again when they come back (mail-snooze.ts).
const NOT_SNOOZED_EMAILS_SQL = '(emails.snoozed_until IS NULL OR emails.snoozed_until <= UTC_TIMESTAMP())';

// One row per message and folder it is shown in.
function folderViewRows(effectiveReadSql: string, accountId: string | null | undefined) {
  const hasAccount = accountId && accountId !== 'all';
  const filter = !hasAccount ? '' : accountId === 'legacy' ? ' AND emails.is_legacy = TRUE' :
    ' AND emails.is_legacy = FALSE AND COALESCE(emails.filing_account_id, emails.mail_account_id) = ?';
  return `SELECT DISTINCT emails.id,
      CASE WHEN emails.is_legacy THEN 'legacy' ELSE COALESCE(emails.filing_account_id, emails.mail_account_id) END AS mail_account_id,
      ${effectiveReadSql} AS view_is_read,
      COALESCE(${pendingMoveSql}, memberships.folder_slug, ${fallbackFolderSql}) AS folder
    FROM emails LEFT JOIN (
      SELECT DISTINCT o.email_id, o.user_id, o.mail_account_id, f.slug AS folder_slug
      FROM ${membershipTables} WHERE o.presence = 'present'
    ) memberships ON memberships.email_id = emails.id AND memberships.user_id = emails.user_id
      AND memberships.mail_account_id = emails.mail_account_id AND NOT ${localFilingSql}
    WHERE emails.user_id = ?${filter} AND ${NOT_SNOOZED_EMAILS_SQL}`;
}
function membershipCountQuery(effectiveReadSql: string, accountId: string | null | undefined, { onlyUnread = false, byAccount = false } = {}) {
  return `SELECT folder${byAccount ? ', mail_account_id' : ''}, COUNT(*) AS total_count,
    SUM(CASE WHEN view_is_read = 0 THEN 1 ELSE 0 END) AS unread_count FROM (
    ${folderViewRows(effectiveReadSql, accountId)}
  ) mail_view WHERE folder IS NOT NULL${onlyUnread ? ' AND view_is_read = 0' : ''} GROUP BY folder${byAccount ? ', mail_account_id' : ''}`;
}
const unreadMembershipQuery = (effectiveReadSql: string, accountId: string | null | undefined) => membershipCountQuery(effectiveReadSql, accountId, { onlyUnread: true, byAccount: true });
// Unread messages per account that appear in at least one folder; a message
// with several Gmail labels counts once. Takes one parameter: the user id.
const accountUnreadQuery = (effectiveReadSql: string) => `SELECT mail_account_id, COUNT(DISTINCT id) AS unread_count FROM (
    ${folderViewRows(effectiveReadSql, null)}
  ) mail_view WHERE folder IS NOT NULL AND view_is_read = 0 GROUP BY mail_account_id`;
export { folderMembershipSql, membershipCountQuery, unreadMembershipQuery, accountUnreadQuery, pendingMoveSql, pendingFlagSql, EFFECTIVE_READ_SQL, EFFECTIVE_STAR_SQL };
