const fs = require('node:fs/promises');
const path = require('node:path');
const { db } = require('../state');
const { withMailAccountLock } = require('./mail-account-lock');
const { isSectionRestoreActive } = require('./restore-locks');
const { isModuleEnabled } = require('./module-settings');
const { publishCalendarChanged } = require('./server-events');
const { addressConfirmed } = require('./mail-account-mode');

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const enabled = value => value === true || value === 1 || value === '1';
const unresolved = `(state IN ('executing', 'verifying', 'reconciling')
  OR (dispatched = TRUE AND status <> 'done' AND state NOT IN ('confirmed', 'rejected')))`;

// `disconnecting`: the preview for "Disconnect and delete", which disconnects
// first, so a still connected account does not block it.
async function purgePreview(userId, accountId, executor = db, { disconnecting = false } = {}) {
  const [[account]] = await executor.execute('SELECT id, is_active FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  if (!account) throw fail('Account not found', 404);
  const [[counts]] = await executor.execute(`SELECT COUNT(*) AS email_count,
    SUM(raw_storage_path IS NOT NULL) AS raw_count,
    SUM(filing_account_id IS NOT NULL AND filing_account_id <> mail_account_id) AS recovered_elsewhere
    FROM emails WHERE mail_account_id = ? AND user_id = ?`, [accountId, userId]);
  const [[attachments]] = await executor.execute(`SELECT COUNT(*) AS attachment_count FROM email_attachments a
    JOIN emails e ON e.id = a.email_id AND e.user_id = a.user_id WHERE e.mail_account_id = ? AND e.user_id = ?`, [accountId, userId]);
  const [[operations]] = await executor.execute(`SELECT COUNT(*) AS unresolved_operations FROM mail_writebacks
    WHERE mail_account_id = ? AND user_id = ? AND ${unresolved}`, [accountId, userId]);
  const [[calendar]] = await executor.execute(`SELECT COUNT(DISTINCT ca.id) AS calendar_accounts, COUNT(ev.id) AS calendar_events
    FROM calendar_accounts ca LEFT JOIN calendar_calendars cc ON cc.account_id = ca.id AND cc.user_id = ca.user_id
    LEFT JOIN calendar_events ev ON ev.calendar_id = cc.id AND ev.user_id = ca.user_id
    WHERE ca.mail_account_id = ? AND ca.user_id = ?`, [accountId, userId]);
  const calendarAccounts = Number(calendar.calendar_accounts) || 0;
  // Purging also removes the linked calendar: Calendar data changes only while
  // that module is on and no calendar restore is writing it.
  const calendarOff = calendarAccounts > 0 && !await isModuleEnabled(userId, 'calendar');
  const calendarRestoring = calendarAccounts > 0 && await isSectionRestoreActive(userId, 'calendar');
  const reason = enabled(account.is_active) && !disconnecting ? 'Disconnect this account before permanently removing its retained mail.'
    : calendarOff ? 'This account has a linked calendar and Calendar is turned off. Turn Calendar on to delete it with the account.'
    : calendarRestoring ? 'Calendar restore is in progress. Try again when it has finished.'
    : Number(counts.recovered_elsewhere) ? 'This account is the source of mail retained in another account.'
      : Number(operations.unresolved_operations) ? 'Provider changes have an unresolved outcome. Reconnect and reconcile them before purging.' : null;
  return { account_id: accountId, email_count: Number(counts.email_count), raw_count: Number(counts.raw_count) || 0,
    attachment_count: Number(attachments.attachment_count), unresolved_operations: Number(operations.unresolved_operations),
    calendar_accounts: calendarAccounts, calendar_events: Number(calendar.calendar_events) || 0,
    blocked: Boolean(reason), reason };
}

async function disconnectAccount(userId, accountId) {
  if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore is in progress');
  const [[owned]] = await db.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  if (!owned) throw fail('Account not found', 404);
  await require('./mail').stopMailAccountWork(accountId, 'Account disconnected');
  return withMailAccountLock(accountId, async () => {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const [[account]] = await connection.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
      if (!account) throw fail('Account not found', 404);
      if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore is in progress');
      await connection.execute(`UPDATE mail_accounts SET is_active = FALSE, encrypted_password = NULL,
        disconnected_at = UTC_TIMESTAMP(), sync_status = 'cancelled', delete_emails_on_server = FALSE,
        server_delete_enabled_at = NULL, server_delete_grace_until = NULL
        WHERE id = ? AND user_id = ?`, [accountId, userId]);
      await connection.execute(`UPDATE mail_server_messages SET delete_status = 'skipped', delete_error = 'Account disconnected'
        WHERE mail_account_id = ? AND user_id = ? AND delete_status IN ('pending', 'failed')`, [accountId, userId]);
      // Accepted intents and their uncertain attempts are preserved unchanged.
      // The inactive account is a durable scheduling/dispatch guard, not a purge.
      // Linked calendars are read before the commit, so stopping their work
      // afterwards needs no database and cannot fail.
      const [linkedCalendars] = await connection.execute('SELECT id FROM calendar_accounts WHERE user_id = ? AND mail_account_id = ?', [userId, accountId]);
      await connection.commit();
      // After the commit: a linked calendar's running sync or change stops now;
      // any that starts later finds the account disconnected.
      const { stopCalendarAccountWork } = require('./calendar-sync');
      for (const row of linkedCalendars) stopCalendarAccountWork(row.id);
      return { message: 'Account disconnected. Retained mail and operation history are still available.', disconnected: true, retained_mail: true };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  });
}

async function removeUnreferencedRaw(storagePaths, executor = db) {
  const root = path.resolve(process.env.MAIL_RAW_STORAGE_ROOT || '/app/uploads/mail-raw');
  let deletedFiles = 0, failedFiles = 0;
  for (const stored of new Set(storagePaths.filter(Boolean))) {
    const resolved = path.resolve(stored);
    if (!resolved.startsWith(root + path.sep)) { failedFiles++; continue; }
    try {
      const [[used]] = await executor.execute('SELECT id FROM emails WHERE raw_storage_path = ? LIMIT 1', [stored]);
      if (used) continue;
      // realpath prevents a database path under the root escaping via a symlink.
      const real = await fs.realpath(resolved);
      const realRoot = await fs.realpath(root);
      if (!real.startsWith(realRoot + path.sep)) { failedFiles++; continue; }
      await fs.unlink(resolved);
      deletedFiles++;
    } catch (error) { if (error.code !== 'ENOENT') failedFiles++; }
  }
  return { deletedFiles, failedFiles };
}

// The typed account address is checked here, not only by the dialog.
async function assertPurgeConfirmed(userId, accountId, confirmation) {
  const [[owned]] = await db.execute('SELECT id, email_address FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  if (!owned) throw fail('Account not found', 404);
  if (!addressConfirmed(owned, confirmation)) throw fail('Type the account email address to confirm permanent deletion.', 400);
}

async function purgeAccount(userId, accountId, confirmation) {
  await assertPurgeConfirmed(userId, accountId, confirmation);
  if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore is in progress');
  const initialPreview = await purgePreview(userId, accountId);
  if (initialPreview.blocked) throw fail(initialPreview.reason);
  await require('./mail').stopMailAccountWork(accountId, 'Account purging');
  return withMailAccountLock(accountId, async () => {
    const connection = await db.getConnection();
    let attachments = [], rawPaths = [], preview, linkedCalendars = [];
    try {
      await connection.beginTransaction();
      const [[account]] = await connection.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
      if (!account) throw fail('Account not found', 404);
      // Admission locks item rows. Acquire them before the final unresolved-effect
      // check, preventing a concurrently accepted command from escaping the gate.
      const [messages] = await connection.execute('SELECT id, raw_storage_path FROM emails WHERE mail_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
      [linkedCalendars] = await connection.execute('SELECT id FROM calendar_accounts WHERE mail_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
      preview = await purgePreview(userId, accountId, connection);
      if (preview.blocked) throw fail(preview.reason);
      if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore is in progress');
      [attachments] = await connection.execute(`SELECT a.storage_path FROM email_attachments a
        JOIN emails e ON e.id = a.email_id AND e.user_id = a.user_id WHERE e.mail_account_id = ? AND e.user_id = ?`, [accountId, userId]);
      rawPaths = messages.map(row => row.raw_storage_path);
      await connection.execute('DELETE FROM mail_engine_quarantine WHERE mail_account_id = ? AND user_id = ?', [accountId, userId]);
      // The linked calendar goes in the same transaction: either the account is
      // gone with all its local data, or nothing changed and purge can be retried.
      if (linkedCalendars.length) {
        const placeholders = linkedCalendars.map(() => '?').join(', ');
        const [calendars] = await connection.execute(`SELECT id FROM calendar_calendars WHERE user_id = ? AND account_id IN (${placeholders})`,
          [userId, ...linkedCalendars.map(row => row.id)]);
        await require('./calendar-sync').deleteCalendarsWithEvents(connection, userId, calendars.map(row => row.id));
        await connection.execute('DELETE FROM calendar_accounts WHERE mail_account_id = ? AND user_id = ?', [accountId, userId]);
      }
      await connection.execute('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
    for (const row of linkedCalendars) publishCalendarChanged(userId, row.id, 'sync');
    const safeAttachments = [];
    for (const stored of new Set(attachments.map(row => row.storage_path).filter(Boolean))) {
      const [[used]] = await db.execute('SELECT id FROM email_attachments WHERE storage_path = ? LIMIT 1', [stored]);
      if (!used) safeAttachments.push(stored);
    }
    const files = await require('./mail').deleteStoredAttachmentFiles(safeAttachments);
    const raw = await removeUnreferencedRaw(rawPaths);
    return { message: 'Disconnected account and its retained local mail and linked calendar permanently removed. Provider mail and events were not changed.', purged: true,
      email_count: preview.email_count, deletedAttachmentFiles: files.deletedFiles, failedAttachmentFiles: files.failedFiles,
      deletedRawFiles: raw.deletedFiles, failedRawFiles: raw.failedFiles };
  });
}

// One step for "Disconnect and delete": nothing changes when the purge is
// already blocked; a purge refused after the disconnect (an operation became
// unresolved meanwhile) leaves the account disconnected with its mail kept.
async function disconnectAndPurgeAccount(userId, accountId, confirmation) {
  await assertPurgeConfirmed(userId, accountId, confirmation);
  if (await isSectionRestoreActive(userId, 'mail')) throw fail('Mail restore is in progress');
  const preview = await purgePreview(userId, accountId, db, { disconnecting: true });
  if (preview.blocked) throw fail(preview.reason);
  await disconnectAccount(userId, accountId);
  try { return await purgeAccount(userId, accountId, confirmation); }
  catch (error) {
    throw Object.assign(error, { message: `The account was disconnected and its local mail kept: ${error.message}`, disconnected: true });
  }
}

module.exports = { purgePreview, disconnectAccount, purgeAccount, disconnectAndPurgeAccount, removeUnreferencedRaw };
