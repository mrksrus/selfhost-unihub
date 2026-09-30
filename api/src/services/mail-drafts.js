const { normalizeComposerAttachments, validateAttachmentTotals, stageAttachments, discardStagedAttachments, insertStagedAttachments } = require('./mail-attachments');

async function saveDraftMutation({ db, userId, emailId, isNew = false, body, mutate, deleteFiles }) {
  const changesAttachments = Array.isArray(body?.existing_attachment_ids) || body?.attachments !== undefined;
  const normalized = normalizeComposerAttachments(body?.attachments === undefined ? [] : body.attachments);
  const staged = await stageAttachments({ userId, emailId, attachments: normalized });
  let connection;
  let committed = false;
  let commitAttempted = false;
  let removable = [];
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    if (!isNew) {
      const [drafts] = await connection.execute('SELECT id FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE FOR UPDATE', [emailId, userId]);
      if (!drafts.length) throw Object.assign(new Error('Draft not found'), { status: 404 });
    }
    let kept = [];
    if (changesAttachments && !isNew) {
      const [existing] = await connection.execute('SELECT id, storage_path, filename, size_bytes FROM email_attachments WHERE email_id = ? AND user_id = ?', [emailId, userId]);
      const keepIds = new Set((body.existing_attachment_ids || []).map(String));
      kept = existing.filter(row => keepIds.has(String(row.id)));
      removable = existing.filter(row => !keepIds.has(String(row.id)));
    }
    if (changesAttachments) validateAttachmentTotals([...kept, ...staged]);
    await mutate(connection);
    if (changesAttachments) {
      if (removable.length) {
        await connection.execute(`DELETE FROM email_attachments WHERE id IN (${removable.map(() => '?').join(',')}) AND email_id = ? AND user_id = ?`,
          [...removable.map(row => row.id), emailId, userId]);
      }
      await insertStagedAttachments(connection, staged);
      await connection.execute('UPDATE emails SET has_attachments = ? WHERE id = ? AND user_id = ?', [kept.length + staged.length > 0 ? 1 : 0, emailId, userId]);
    }
    commitAttempted = true;
    await connection.commit();
    committed = true;
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection?.release();
    // Keep both old and staged files if COMMIT may have reached the server.
    if (!committed && !commitAttempted) await discardStagedAttachments(staged);
  }
  await deleteFiles(removable.map(row => row.storage_path));
}

module.exports = { saveDraftMutation };
