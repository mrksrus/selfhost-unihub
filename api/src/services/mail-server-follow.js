const crypto = require('crypto');

function checkCancelled(signal) {
  if (signal?.aborted) {
    const error = new Error('Mail sync cancelled; completed messages are retained.');
    error.code = 'MAIL_SYNC_CANCELLED';
    throw error;
  }
}
function identity(folder, validity, uid) {
  if (!folder || !Number.isSafeInteger(Number(validity)) || Number(validity) <= 0 || !Number.isSafeInteger(Number(uid)) || Number(uid) <= 0) return null;
  return JSON.stringify([folder, String(validity), String(uid)]);
}
function localIdentity(row) {
  return row.remote_folder != null
    ? identity(row.remote_folder, row.remote_uidvalidity, row.remote_uid)
    : identity(row.source_folder, row.imap_uidvalidity, row.imap_uid);
}
function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!value) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}
function rawHash(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }

// UIDVALIDITY is mandatory: a reused UID cannot prove identity after a reset.
// Byte-identical content proves a move only for one absent local copy and one
// new remote location. Multiple labels/copies remain independent or unresolved.
function planServerFollow(localRows, remoteRows) {
  const locals = localRows.filter(row => !Number(row.is_draft));
  const localLocations = groupBy(locals, localIdentity);
  const remoteLocations = groupBy(remoteRows, row => row.key);
  const absent = locals.filter(row => localIdentity(row) && !remoteLocations.has(localIdentity(row)));
  const localHashes = groupBy(absent, row => row.raw_sha256);
  const unknown = remoteRows.filter(row => !localLocations.has(row.key));
  const unknownHashes = groupBy(unknown, row => row.rawHash);
  const updates = [], imports = [], ambiguous = locals.filter(row => row.source_folder && row.imap_uid && !localIdentity(row)).map(row => ({ emailId: row.id, reason: 'unverified_source_identity' })), matched = new Set(), protectedIds = new Set();
  for (const remote of remoteRows) {
    const exact = localLocations.get(remote.key) || [];
    if (exact.length === 1) {
      updates.push({ local: exact[0], remote }); matched.add(exact[0].id); continue;
    }
    if (exact.length > 1) {
      exact.forEach(row => protectedIds.add(row.id));
      ambiguous.push({ folder: remote.folderName, reason: 'duplicate_local_identity' }); continue;
    }
    const candidates = localHashes.get(remote.rawHash) || [];
    if (candidates.length === 1 && unknownHashes.get(remote.rawHash)?.length === 1) {
      updates.push({ local: candidates[0], remote }); matched.add(candidates[0].id);
    } else if (candidates.length > 0) {
      candidates.forEach(row => protectedIds.add(row.id));
      ambiguous.push({ folder: remote.folderName, reason: 'ambiguous_identical_copies' });
    } else imports.push(remote);
  }
  return { updates, imports, ambiguous,
    missing: absent.filter(row => !matched.has(row.id) && !protectedIds.has(row.id)) };
}

async function readFolderInventory(connection, folder, getUidValidity, signal) {
  checkCancelled(signal);
  const box = await connection.openBox(folder.folderName, true);
  const validity = getUidValidity(connection);
  if (!Number.isSafeInteger(validity) || validity <= 0) throw new Error(`UIDVALIDITY unavailable for ${folder.folderName}`);
  const items = await connection.search(['ALL'], { bodies: [], markSeen: false });
  checkCancelled(signal);
  if (!Array.isArray(items)) throw new Error(`Incomplete message inventory for ${folder.folderName}`);
  const expectedCount = box?.messages?.total ?? connection?.imap?._box?.messages?.total;
  if (Number.isSafeInteger(expectedCount) && items.length !== expectedCount) throw new Error(`Incomplete message inventory for ${folder.folderName}; retry required`);
  const seen = new Set();
  return items.map(item => {
    const uid = item?.attributes?.uid;
    if (!Number.isSafeInteger(uid) || uid <= 0 || seen.has(uid) || !Array.isArray(item?.attributes?.flags)) {
      throw new Error(`Malformed message metadata for ${folder.folderName}`);
    }
    seen.add(uid);
    return { ...folder, uid, validity, flags: item.attributes.flags, key: identity(folder.folderName, validity, uid) };
  });
}
async function fetchRaw(connection, remote, buildRaw, getUidValidity, signal) {
  checkCancelled(signal);
  await connection.openBox(remote.folderName, true);
  if (getUidValidity(connection) !== remote.validity) throw new Error('UIDVALIDITY changed during message fetch');
  const messages = await connection.search([['UID', remote.uid]], { bodies: [''], markSeen: false, struct: true });
  checkCancelled(signal);
  if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.attributes?.uid !== remote.uid) throw new Error('Message disappeared during fetch; retry required');
  const raw = buildRaw(messages[0]);
  if (!raw || !raw.trim()) throw new Error('Empty remote message; retry required');
  return raw;
}

async function followMailServer({ db, connection, account, folders, listFolders, getUidValidity, buildRaw,
  importMessage, signal }) {
  const [localRows] = await db.execute(`SELECT id, source_folder, imap_uid, imap_uidvalidity,
    remote_folder, remote_uid, remote_uidvalidity, remote_missing, raw_sha256, raw_storage_path, is_draft, import_complete
    FROM emails WHERE user_id = ? AND mail_account_id = ?`, [account.user_id, account.id]);
  const localKeys = new Set(localRows.map(localIdentity).filter(Boolean));
  const remotes = [];
  for (const folder of folders) {
    const rows = await readFolderInventory(connection, folder, getUidValidity, signal);
    remotes.push(...rows);
    // Existing messages require metadata only. Unknown content is hashed one
    // message at a time; no mailbox-sized collection of raw bodies is retained.
    for (const remote of rows) {
      if (!localKeys.has(remote.key)) remote.rawHash = rawHash(await fetchRaw(connection, remote, buildRaw, getUidValidity, signal));
    }
  }
  // A successful LIST alone is insufficient. Recheck every folder's complete
  // UID inventory after fetching bodies; a changing/failed scan cannot mark mail
  // missing or relocate a copy using a snapshot that was already stale.
  const finalFolders = await listFolders();
  if (JSON.stringify([...finalFolders].sort()) !== JSON.stringify(folders.map(folder => folder.folderName).sort())) throw new Error('Folder inventory changed during sync; retry required');
  const finalRemotes = [];
  for (const folder of folders) finalRemotes.push(...await readFolderInventory(connection, folder, getUidValidity, signal));
  const firstKeys = remotes.map(row => row.key).sort();
  if (JSON.stringify(firstKeys) !== JSON.stringify(finalRemotes.map(row => row.key).sort())) throw new Error('Message inventory changed during sync; retry required');
  const latest = new Map(finalRemotes.map(row => [row.key, row.flags]));
  remotes.forEach(row => { row.flags = latest.get(row.key); });
  const plan = planServerFollow(localRows, remotes);
  let newEmails = 0;
  // Each completed import is durable and is recognized by its exact UID next
  // time. Only a completely successful pass applies absence markers.
  for (const { local, remote } of plan.updates) {
    if (Number(local.import_complete) !== 1) {
      const raw = await fetchRaw(connection, remote, buildRaw, getUidValidity, signal);
      await importMessage(remote, raw, local);
    }
  }
  for (const remote of plan.imports) {
    const raw = await fetchRaw(connection, remote, buildRaw, getUidValidity, signal);
    if (rawHash(raw) !== remote.rawHash) throw new Error('Message content changed during sync; retry required');
    const result = await importMessage(remote, raw);
    plan.updates.push({ local: { id: result.emailId }, remote });
    newEmails += result.isNew ? 1 : 0;
  }
  for (const { local, remote } of plan.updates) {
    checkCancelled(signal);
    await db.execute(`UPDATE emails SET remote_folder = ?, remote_uid = ?, remote_uidvalidity = ?,
      remote_missing = FALSE, is_read = ?, is_starred = ?, folder = ?, filing_account_id = ?, is_legacy = FALSE
      WHERE id = ? AND user_id = ? AND mail_account_id = ? AND is_draft = FALSE`,
    [remote.folderName, remote.uid, remote.validity, remote.flags.includes('\\Seen') ? 1 : 0,
      remote.flags.includes('\\Flagged') ? 1 : 0, remote.dbFolderName, account.id, local.id, account.user_id, account.id]);
  }
  for (const local of plan.missing) {
    checkCancelled(signal);
    await db.execute(`UPDATE emails SET remote_missing = TRUE WHERE id = ? AND user_id = ? AND mail_account_id = ? AND is_draft = FALSE`, [local.id, account.user_id, account.id]);
  }
  return { success: true, newEmails, totalFound: remotes.length, updated: plan.updates.length,
    remoteMissing: plan.missing.length, ambiguous: plan.ambiguous,
    message: `Server state followed; ${plan.missing.length} missing message(s) retained, ${plan.ambiguous.length} ambiguous location(s) left unchanged.` };
}
module.exports = { checkCancelled, identity, localIdentity, planServerFollow, readFolderInventory, fetchRaw, followMailServer };
