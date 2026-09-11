const { db } = require('../state');
const PROTECTED_FOLDERS = new Set(['inbox', 'sent', 'drafts', 'trash']);
const FILING_ACCOUNT_SQL = 'COALESCE(filing_account_id, mail_account_id)';

function receivingAccount(toAddresses, accounts) {
  let addresses = toAddresses;
  if (Buffer.isBuffer(addresses)) addresses = addresses.toString('utf8');
  if (typeof addresses === 'string') {
    try { addresses = JSON.parse(addresses); } catch { return null; }
  }
  if (!Array.isArray(addresses)) return null;
  const recipients = new Set(addresses.map(value => String(typeof value === 'string' ? value : value?.address || '').trim().toLowerCase()));
  const matches = accounts.filter(account => recipients.has(String(account.email_address).trim().toLowerCase()));
  return matches.length === 1 ? matches[0].id : null;
}

async function prepareFolderReconciliation(connection = db) {
  // Pending custom mail is visible under Legacy even if a server is offline.
  // Do not touch an item the user has already resolved manually.
  await connection.execute(`UPDATE emails e JOIN mail_folders f ON f.user_id = e.user_id AND f.slug = e.folder
    SET e.is_legacy = TRUE
    WHERE f.mail_account_id IS NULL AND f.is_system = FALSE AND e.is_draft = FALSE
      AND e.folder NOT IN ('inbox', 'sent', 'drafts', 'trash')
      AND NOT EXISTS (SELECT 1 FROM mail_folder_reconciliations r WHERE r.mail_account_id = e.mail_account_id)
      AND NOT EXISTS (SELECT 1 FROM mail_folder_recovery_items i WHERE i.email_id = e.id)`);
  await connection.execute(`UPDATE emails e LEFT JOIN mail_folders f ON f.user_id = e.user_id AND f.slug = e.folder
    SET e.is_legacy = TRUE WHERE f.id IS NULL AND e.is_draft = FALSE
      AND e.folder NOT IN ('inbox', 'sent', 'drafts', 'trash')
      AND NOT EXISTS (SELECT 1 FROM mail_folder_recovery_items i WHERE i.email_id = e.id)`);
}

async function reconcileAccountFolders(userId, accountId, inventory, specialUses = new Map(), pool = db) {
  // Call only after a successful, complete LIST. Never accept the INBOX fallback.
  if (!Array.isArray(inventory) || !inventory.length) throw new Error('A complete nonempty server folder inventory is required');
  const remoteNames = new Set(inventory);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [owner] = await connection.execute('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ? FOR UPDATE', [accountId, userId]);
    if (!owner.length) throw new Error('Mail account ownership changed');
    const [done] = await connection.execute('SELECT mail_account_id FROM mail_folder_reconciliations WHERE mail_account_id = ?', [accountId]);
    if (done.length) {
      await connection.execute('UPDATE mail_folder_reconciliations SET inventory = ? WHERE mail_account_id = ?', [JSON.stringify(inventory), accountId]);
      await connection.commit(); return { skipped: true };
    }
    const [accounts] = await connection.execute('SELECT id, email_address FROM mail_accounts WHERE user_id = ?', [userId]);
    const [folders] = await connection.execute('SELECT * FROM mail_folders WHERE user_id = ? AND mail_account_id IS NULL ORDER BY id FOR UPDATE', [userId]);
    const [mappings] = await connection.execute(`SELECT b.*, f.slug FROM mail_folder_remote_boxes b
      JOIN mail_folders f ON f.id = b.folder_id WHERE b.mail_account_id = ? AND f.user_id = ?`, [accountId, userId]);
    const counts = { connected: 0, inbox: 0, legacy: 0 };
    for (const folder of folders) {
      if (PROTECTED_FOLDERS.has(folder.slug)) continue;
      const saved = mappings.find(mapping => mapping.folder_id === folder.id && remoteNames.has(mapping.remote_name));
      const semanticName = folder.is_system && [...specialUses].find(([name, role]) => role === folder.slug && remoteNames.has(name))?.[0];
      const remoteName = saved?.remote_name || (remoteNames.has(folder.display_name) ? folder.display_name : null) || semanticName;
      const alreadyLinked = remoteName && mappings.find(mapping => mapping.remote_name === remoteName);
      const destination = remoteName ? alreadyLinked?.slug || folder.slug : null;
      if (remoteName && !alreadyLinked) {
        await connection.execute(`INSERT INTO mail_folder_remote_boxes (folder_id, mail_account_id, remote_name)
          VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE remote_name = VALUES(remote_name)`, [folder.id, accountId, remoteName]);
      }
      // Snapshot old rules' effective destinations per account. Editing a rule
      // later removes its overrides; newly created rules are unaffected.
      if (!remoteName || destination !== folder.slug) {
        await connection.execute(`INSERT INTO mail_folder_rule_overrides (rule_id, mail_account_id, target_folder)
          SELECT id, ?, ? FROM mail_sender_rules WHERE user_id = ? AND target_folder = ?
            AND (mail_account_id IS NULL OR mail_account_id = ?)
          ON DUPLICATE KEY UPDATE target_folder = VALUES(target_folder)`,
        [accountId, destination || 'inbox', userId, folder.slug, accountId]);
      }
      let cursor = '';
      for (;;) {
        const [emails] = await connection.execute(`SELECT id, folder, filing_account_id, to_addresses FROM emails
          WHERE user_id = ? AND mail_account_id = ? AND folder = ? AND is_draft = FALSE AND id > ?
            AND NOT EXISTS (SELECT 1 FROM mail_folder_recovery_items i WHERE i.email_id = emails.id)
          ORDER BY id LIMIT 500 FOR UPDATE`, [userId, accountId, folder.slug, cursor]);
        if (!emails.length) break;
        cursor = emails[emails.length - 1].id;
        const groups = new Map();
        const journal = [];
        for (const email of emails) {
          const targetAccount = remoteName ? accountId : receivingAccount(email.to_addresses, accounts);
          const targetFolder = destination || (targetAccount ? 'inbox' : email.folder);
          const action = remoteName ? 'connected' : targetAccount ? 'inbox' : 'legacy';
          counts[action] += 1;
          journal.push([email.id, userId, accountId, email.folder, email.filing_account_id, targetFolder, targetAccount, action]);
          const key = JSON.stringify([targetFolder, targetAccount, action === 'legacy']);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(email.id);
        }
        await connection.execute(`INSERT INTO mail_folder_recovery_items
          (email_id, user_id, source_account_id, original_folder, original_filing_account_id, target_folder, target_account_id, action)
          VALUES ${journal.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(',')}`, journal.flat());
        for (const [key, ids] of groups) {
          const [targetFolder, targetAccount, legacy] = JSON.parse(key);
          await connection.execute(`UPDATE emails SET folder = ?, filing_account_id = ?, is_legacy = ?
            WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [targetFolder, targetAccount, legacy ? 1 : 0, userId, ...ids]);
        }
      }
    }
    await connection.execute(`INSERT INTO mail_folder_reconciliations (mail_account_id, user_id, inventory, previous_mappings)
      VALUES (?, ?, ?, ?)`, [accountId, userId, JSON.stringify(inventory), JSON.stringify(mappings)]);
    await connection.commit();
    return counts;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

async function folderConnections(userId, connection = db) {
  const [rows] = await connection.execute(`SELECT f.slug, b.mail_account_id FROM mail_folders f
    JOIN mail_folder_remote_boxes b ON b.folder_id = f.id
    JOIN mail_folder_reconciliations r ON r.mail_account_id = b.mail_account_id AND r.user_id = f.user_id
    WHERE f.user_id = ? AND JSON_CONTAINS(r.inventory, JSON_QUOTE(b.remote_name))`, [userId]);
  const links = new Map();
  for (const row of rows) {
    if (!links.has(row.slug)) links.set(row.slug, []);
    links.get(row.slug).push(row.mail_account_id);
  }
  return links;
}

module.exports = { receivingAccount, prepareFolderReconciliation, reconcileAccountFolders, folderConnections, FILING_ACCOUNT_SQL };
