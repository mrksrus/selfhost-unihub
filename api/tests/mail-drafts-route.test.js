const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function setRequireStub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

async function createDraftRouteHarness(t, options = {}) {
  const routePath = require.resolve('../src/routes/mail');
  const mailServicePath = require.resolve('../src/services/mail');
  const statePath = require.resolve('../src/state');
  const encryptionPath = require.resolve('../src/security/encryption');
  const caldavPath = require.resolve('../src/services/caldav');
  const originalRoute = require.cache[routePath];
  const originalMailService = require.cache[mailServicePath];
  const originalState = require.cache[statePath];
  const originalEncryption = require.cache[encryptionPath];
  const originalCaldav = require.cache[caldavPath];
  const originalUploadRoot = process.env.MAIL_ATTACHMENT_UPLOAD_ROOT;
  const uploadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-drafts-'));

  const state = {
    accounts: new Map([
      ['account-1', {
        id: 'account-1',
        user_id: 'user-1',
        email_address: 'sender@example.test',
        display_name: 'Sender',
      }],
    ]),
    emails: new Map(),
    attachments: new Map(),
  };

  const db = {
    async execute(sql, params = []) {
      if (sql.includes('SELECT id, user_id, email_address, display_name FROM mail_accounts')) {
        const account = state.accounts.get(params[0]);
        return [[account && account.user_id === params[1] ? account : null].filter(Boolean)];
      }

      if (sql.includes('INSERT INTO emails')) {
        const [
          id,
          userId,
          accountId,
          messageId,
          subject,
          fromAddress,
          fromName,
          toAddresses,
          bodyText,
          bodyHtml,
          folder,
        ] = params;
        state.emails.set(id, {
          id,
          user_id: userId,
          mail_account_id: accountId,
          message_id: messageId,
          subject,
          from_address: fromAddress,
          from_name: fromName,
          to_addresses: toAddresses,
          body_text: bodyText,
          body_html: bodyHtml,
          folder,
          is_read: 1,
          is_starred: 0,
          is_draft: 1,
          has_attachments: 0,
          received_at: new Date(),
        });
        return [{ affectedRows: 1 }];
      }

      if (sql.includes('SELECT * FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE')) {
        const email = state.emails.get(params[0]);
        return [[email && email.user_id === params[1] && email.is_draft ? email : null].filter(Boolean)];
      }

      if (sql.includes('INSERT INTO email_attachments')) {
        const [id, emailId, userId, filename, contentType, sizeBytes, storagePath, contentId] = params;
        state.attachments.set(id, {
          id,
          email_id: emailId,
          user_id: userId,
          filename,
          content_type: contentType,
          size_bytes: sizeBytes,
          storage_path: storagePath,
          content_id: contentId,
        });
        return [{ affectedRows: 1 }];
      }

      if (sql.includes('SELECT id, filename, content_type, size_bytes FROM email_attachments')) {
        return [[...state.attachments.values()]
          .filter(attachment => attachment.email_id === params[0] && attachment.user_id === params[1])
          .map(({ id, filename, content_type, size_bytes }) => ({ id, filename, content_type, size_bytes }))];
      }

      if (sql.includes('SELECT id, storage_path FROM email_attachments')) {
        return [[...state.attachments.values()]
          .filter(attachment => attachment.email_id === params[0] && attachment.user_id === params[1])
          .map(({ id, storage_path }) => ({ id, storage_path }))];
      }

      if (sql.includes('SELECT storage_path FROM email_attachments')) {
        return [[...state.attachments.values()]
          .filter(attachment => attachment.email_id === params[0] && attachment.user_id === params[1])
          .map(({ storage_path }) => ({ storage_path }))];
      }

      if (sql.includes('SELECT filename, content_type, storage_path FROM email_attachments')) {
        return [[...state.attachments.values()]
          .filter(attachment => attachment.email_id === params[0] && attachment.user_id === params[1])
          .map(({ filename, content_type, storage_path }) => ({ filename, content_type, storage_path }))];
      }

      if (sql.includes('SELECT COUNT(*) AS total FROM email_attachments')) {
        const total = [...state.attachments.values()].filter(attachment => attachment.email_id === params[0] && attachment.user_id === params[1]).length;
        return [[{ total }]];
      }

      if (sql.includes('UPDATE emails SET has_attachments')) {
        const email = state.emails.get(params[1]);
        if (email) email.has_attachments = params[0] ? 1 : 0;
        return [{ affectedRows: email ? 1 : 0 }];
      }

      if (sql.includes('UPDATE emails SET') && sql.includes('is_draft = TRUE')) {
        const draftId = params[params.length - 2];
        const email = state.emails.get(draftId);
        if (!email) return [{ affectedRows: 0 }];
        let index = 0;
        if (sql.includes('folder = ?')) email.folder = params[index++];
        if (sql.includes('mail_account_id = ?')) {
          email.mail_account_id = params[index++];
          email.from_address = params[index++];
          email.from_name = params[index++];
        }
        if (sql.includes('to_addresses = ?')) email.to_addresses = params[index++];
        if (sql.includes('subject = ?')) email.subject = params[index++];
        if (sql.includes('body_text = ?')) {
          email.body_text = params[index++];
          email.body_html = params[index++];
        }
        email.received_at = new Date();
        email.is_draft = 1;
        email.is_read = 1;
        return [{ affectedRows: 1 }];
      }

      if (sql.includes('DELETE FROM email_attachments WHERE id IN')) {
        const ids = params.slice(0, -2);
        for (const id of ids) state.attachments.delete(id);
        return [{ affectedRows: ids.length }];
      }

      if (sql.includes('DELETE FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE')) {
        const draftId = params[0];
        state.emails.delete(draftId);
        for (const [id, attachment] of state.attachments.entries()) {
          if (attachment.email_id === draftId) state.attachments.delete(id);
        }
        return [{ affectedRows: 1 }];
      }

      return [[]];
    },
  };

  t.after(async () => {
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
    if (originalMailService) require.cache[mailServicePath] = originalMailService;
    else delete require.cache[mailServicePath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalEncryption) require.cache[encryptionPath] = originalEncryption;
    else delete require.cache[encryptionPath];
    if (originalCaldav) require.cache[caldavPath] = originalCaldav;
    else delete require.cache[caldavPath];
    if (originalUploadRoot === undefined) delete process.env.MAIL_ATTACHMENT_UPLOAD_ROOT;
    else process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = originalUploadRoot;
    await fs.rm(uploadRoot, { recursive: true, force: true });
  });

  delete require.cache[routePath];
  process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = uploadRoot;
  setRequireStub(statePath, { db });
  setRequireStub(encryptionPath, { encrypt: value => `encrypted:${value}` });
  setRequireStub(caldavPath, { createCalDavAccountForMail: async () => ({ success: true }) });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    MAIL_SENDER_RULE_MATCH_TYPES: new Set(['domain', 'email']),
    SYSTEM_MAIL_FOLDER_SET: new Set(['inbox', 'sent', 'drafts']),
    normalizeMailSenderRuleInput: () => ({ matchType: 'domain', matchValue: 'example.test' }),
    normalizeMailFolderSlug: value => String(value || '').trim().toLowerCase(),
    normalizeMailFolderDisplayName: value => String(value || '').trim(),
    loadMailFoldersForUser: async () => [],
    mailFolderExists: async () => true,
    toBooleanFlag: value => value === true || value === 1 || value === '1',
    loadActiveMailSenderRules: async () => [],
    resolveMailSenderTargetFolder: async () => ({ folder: 'inbox' }),
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value, fallback = 'all') => value || fallback,
    seedMailServerDeletionQueueForAccount: async () => {},
    buildMailHostTrustResult: async () => ({}),
    validateMailHostPolicy: async () => ({ accepted: true, mailHostTrust: { blocked: false, requiresConfirmation: false } }),
    testImapConnection: async () => ({ success: true }),
    syncMailAccount: async () => ({ success: true }),
    isAnyMailAccountSyncRunning: () => false,
    getRunningMailSyncAccountIds: () => [],
    getRunningMailServerDeleteAccountIds: () => [],
    sendEmail: options.sendEmail || (async () => ({ success: true, messageId: '<sent@example.test>' })),
    deleteStoredAttachmentFiles: async (paths) => {
      let deletedFiles = 0;
      for (const item of paths || []) {
        if (!item) continue;
        await fs.rm(item, { force: true });
        deletedFiles += 1;
      }
      return { deletedFiles, failedFiles: 0 };
    },
  });

  return { routes: require('../src/routes/mail'), state, uploadRoot };
}

test('draft routes create, update, and delete draft attachments', async (t) => {
  const { routes, state } = await createDraftRouteHarness(t);
  const attachmentA = Buffer.from('first attachment').toString('base64');
  const attachmentB = Buffer.from('second attachment').toString('base64');

  const created = await routes['POST /api/mail/drafts'](
    { url: '/api/mail/drafts', headers: { host: 'localhost' } },
    'user-1',
    {
      account_id: 'account-1',
      to: 'reader@example.test',
      subject: 'Draft',
      body: '<p>Hello</p>',
      isHtml: true,
      attachments: [{ filename: 'first.txt', contentType: 'text/plain', dataBase64: attachmentA }],
    }
  );

  assert.equal(created.draft.folder, 'drafts');
  assert.equal(created.draft.is_draft, true);
  assert.equal(created.draft.attachments.length, 1);
  const firstAttachmentPath = [...state.attachments.values()][0].storage_path;
  await assert.doesNotReject(() => fs.stat(firstAttachmentPath));

  const updated = await routes['PUT /api/mail/drafts/:id'](
    { url: `/api/mail/drafts/${created.draft.id}`, headers: { host: 'localhost' } },
    'user-1',
    {
      subject: 'Updated',
      body: '<p>Updated</p>',
      existing_attachment_ids: [],
      attachments: [{ filename: 'second.txt', contentType: 'text/plain', dataBase64: attachmentB }],
    }
  );

  assert.equal(updated.draft.subject, 'Updated');
  assert.equal(updated.draft.attachments.length, 1);
  assert.equal(updated.draft.attachments[0].filename, 'second.txt');
  await assert.rejects(() => fs.stat(firstAttachmentPath));

  const secondAttachmentPath = [...state.attachments.values()][0].storage_path;
  const deleted = await routes['DELETE /api/mail/drafts/:id'](
    { url: `/api/mail/drafts/${created.draft.id}`, headers: { host: 'localhost' } },
    'user-1'
  );

  assert.equal(deleted.deleted, true);
  assert.equal(state.emails.has(created.draft.id), false);
  await assert.rejects(() => fs.stat(secondAttachmentPath));
});

test('send draft sends stored content and removes the local draft', async (t) => {
  let sentPayload = null;
  const { routes, state } = await createDraftRouteHarness(t, {
    sendEmail: async (accountId, payload) => {
      sentPayload = { accountId, payload };
      return { success: true, messageId: '<sent@example.test>' };
    },
  });

  const created = await routes['POST /api/mail/drafts'](
    { url: '/api/mail/drafts', headers: { host: 'localhost' } },
    'user-1',
    {
      account_id: 'account-1',
      to: 'reader@example.test',
      subject: 'Ready',
      body: '<p>Send me</p>',
      isHtml: true,
    }
  );

  const sent = await routes['POST /api/mail/drafts/:id/send'](
    { url: `/api/mail/drafts/${created.draft.id}/send`, headers: { host: 'localhost' } },
    'user-1'
  );

  assert.equal(sent.success, true);
  assert.equal(sentPayload.accountId, 'account-1');
  assert.equal(sentPayload.payload.to, 'reader@example.test');
  assert.equal(sentPayload.payload.subject, 'Ready');
  assert.equal(sentPayload.payload.body, '<p>Send me</p>');
  assert.equal(state.emails.has(created.draft.id), false);
});
