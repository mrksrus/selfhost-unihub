const { writeOwnedRow, resolveOwnedReference } = require('./backup-ownership');
const { folderAcceptsAccount, filingAccountId } = require('./mail-filing');
const { folderConnections } = require('./mail-folder-reconciliation');

function jsonArray(value, field) {
  let result = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { throw new Error(`Invalid backup ${field}`); }
  }
  if (!Array.isArray(result)) throw new Error(`Invalid backup ${field}`);
  return result;
}

async function restoreMailRecovery(connection, userId, data, {
  accountIds, folderIds, emailIds, ruleIds, writtenEmailIds, conflictMode, checkCancelled, normalizeDate, warnings,
}) {
  const account = (id, nullable = false) => resolveOwnedReference(connection, userId, 'mail_accounts', id, accountIds, { nullable });
  const historicalAccount = async (id, field) => {
    try { return await account(id, true); }
    catch (error) {
      if (!/references an unavailable mail_accounts record/.test(error.message)) throw error;
      warnings.push(`A recovery journal ${field} account no longer exists on the destination; its historical reference was cleared. The original archive retains the previous ID.`);
      return null;
    }
  };
  const sourceEmails = new Map((data.emails || []).map(row => [row.id, row]));
  for (const row of data.mail_folder_rule_overrides || []) {
    await checkCancelled();
    const ruleId = await resolveOwnedReference(connection, userId, 'mail_sender_rules', row.rule_id, ruleIds);
    const accountId = await account(row.mail_account_id);
    const [existing] = await connection.execute(
      'SELECT target_folder FROM mail_folder_rule_overrides WHERE rule_id = ? AND mail_account_id = ? FOR UPDATE', [ruleId, accountId]);
    if (existing.length && conflictMode !== 'replace') continue;
    if (existing.length) {
      await connection.execute('UPDATE mail_folder_rule_overrides SET target_folder = ? WHERE rule_id = ? AND mail_account_id = ?', [row.target_folder, ruleId, accountId]);
    } else {
      await connection.execute('INSERT INTO mail_folder_rule_overrides (rule_id, mail_account_id, target_folder) VALUES (?, ?, ?)', [ruleId, accountId, row.target_folder]);
    }
  }

  for (const row of data.mail_folder_recovery_items || []) {
    await checkCancelled();
    // A kept destination message keeps its own migration history as well.
    if (!writtenEmailIds.has(row.email_id)) continue;
    const emailId = await resolveOwnedReference(connection, userId, 'emails', row.email_id, emailIds);
    const sourceAccountId = await account(row.source_account_id);
    const expectedSourceAccountId = await account(sourceEmails.get(row.email_id)?.mail_account_id);
    if (sourceAccountId !== expectedSourceAccountId) throw new Error('Backup recovery journal does not match the email provider account');
    const originalAccountId = await historicalAccount(row.original_filing_account_id, 'original filing');
    const targetAccountId = await historicalAccount(row.target_account_id, 'target');
    await writeOwnedRow(connection, userId, 'mail_folder_recovery_items',
      ['email_id', 'user_id', 'source_account_id', 'original_folder', 'original_filing_account_id', 'target_folder', 'target_account_id', 'action', 'created_at'],
      [emailId, userId, sourceAccountId, row.original_folder, originalAccountId, row.target_folder, targetAccountId, row.action, normalizeDate(row.created_at, new Date())],
      ['source_account_id', 'original_folder', 'original_filing_account_id', 'target_folder', 'target_account_id', 'action', 'created_at']);
  }

  // Completion is restored last, in the same transaction as the translated data.
  // It prevents the next successful provider LIST from applying old moves again.
  for (const row of data.mail_folder_reconciliations || []) {
    await checkCancelled();
    const accountId = await account(row.mail_account_id);
    const [existing] = await connection.execute(
      'SELECT mail_account_id FROM mail_folder_reconciliations WHERE mail_account_id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
    if (existing.length && conflictMode !== 'replace') continue;
    const inventory = jsonArray(row.inventory, 'mail reconciliation inventory');
    const previousMappings = [];
    for (const mapping of jsonArray(row.previous_mappings, 'mail reconciliation previous mappings')) {
      const translated = { ...mapping, mail_account_id: await account(mapping.mail_account_id || row.mail_account_id) };
      // A removed historical folder is not a live relationship. Keep its archive
      // identifier explicitly as provenance, never as a destination record ID.
      if (folderIds.has(mapping.folder_id)) translated.folder_id = folderIds.get(mapping.folder_id);
      else {
        translated.archive_folder_id = mapping.archive_folder_id || mapping.folder_id;
        translated.folder_id = null;
      }
      previousMappings.push(translated);
    }
    await writeOwnedRow(connection, userId, 'mail_folder_reconciliations',
      ['mail_account_id', 'user_id', 'inventory', 'previous_mappings', 'completed_at'],
      [accountId, userId, JSON.stringify(inventory), JSON.stringify(previousMappings), normalizeDate(row.completed_at, new Date())],
      ['inventory', 'previous_mappings', 'completed_at']);
  }
}

async function validateRestoredMailDestinations(connection, userId, emailIds, checkCancelled) {
  if (!emailIds.length) return;
  const connections = await folderConnections(userId, connection);
  for (let offset = 0; offset < emailIds.length; offset += 500) {
    await checkCancelled();
    const batch = emailIds.slice(offset, offset + 500);
    const [rows] = await connection.execute(
      `SELECT e.id, e.folder, e.mail_account_id, e.filing_account_id, e.is_legacy,
        f.id AS folder_id, f.slug, f.mail_account_id AS folder_account_id, f.is_system
       FROM emails e LEFT JOIN mail_folders f ON f.user_id = e.user_id AND f.slug = e.folder
       WHERE e.user_id = ? AND e.id IN (${batch.map(() => '?').join(', ')})`, [userId, ...batch]);
    if (rows.length !== batch.length) throw new Error('Restored mail is unavailable for destination validation');
    for (const row of rows) {
      if (row.is_legacy) continue;
      const folder = row.folder_id ? { slug: row.slug, mail_account_id: row.folder_account_id, is_system: row.is_system } : null;
      if (!folderAcceptsAccount(folder, filingAccountId(row), connections)) {
        throw new Error(`Restored mail folder "${row.folder}" is not available in its filing account. Restore was rolled back; resolve the folder or reconciliation conflict before retrying.`);
      }
    }
  }
}

module.exports = { restoreMailRecovery, validateRestoredMailDestinations, jsonArray };
