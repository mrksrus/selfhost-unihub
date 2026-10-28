import type { FixtureValue, RouteTable } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));

function setRequireStub(modulePath: string, exports: FixtureValue) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  } as NodeJS.Module;
}

async function createDraftRouteHarness(t: import('node:test').TestContext, options: FixtureValue = {}) {
  const routePath = require.resolve('../dist/src/routes/mail');
  const mailServicePath = require.resolve('../dist/src/services/mail');
  const statePath = require.resolve('../dist/src/state');
  const encryptionPath = require.resolve('../dist/src/security/encryption');
  const caldavPath = require.resolve('../dist/src/services/caldav');
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
        is_active: 1,
        smtp_host: 'smtp.example.test',
        encrypted_password: 'vault-ciphertext',
      }],
    ]),
    emails: new Map(),
    attachments: new Map(),
  };

  const db = {
    async getConnection() {
      let snapshot: FixtureValue;
      return {
        execute: (...args: Parameters<typeof db.execute>) => db.execute(...args),
        async beginTransaction() { snapshot = structuredClone(state); },
        async commit() {},
        async rollback() { Object.assign(state, snapshot); },
        release() {},
      };
    },
    async execute(sql: string, params: FixtureValue[] = []) {
      if (options.failWhen?.(sql, params)) throw new Error('Injected database failure');
      if (sql.includes('SELECT id, user_id, email_address, display_name FROM mail_accounts')) {
        const account = state.accounts.get(params[0]);
        return [[account && account.user_id === params[1] ? account : null].filter(Boolean)];
      }

      if (sql.includes('SELECT * FROM mail_accounts WHERE id = ?')) return [[state.accounts.get(params[0])].filter(Boolean)];
      if (sql.includes('SELECT id FROM mail_accounts WHERE id = ? AND user_id = ?')) {
        const account = state.accounts.get(params[0]);
        return [[account && account.user_id === params[1] ? { id: account.id } : null].filter(Boolean)];
      }
      // The Sent copy written by the real sendEmail; mail-engine-send covers its contents.
      if (sql.includes('INSERT INTO emails') && !sql.includes('is_draft')) return [{ affectedRows: 1 }];

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
          ccAddresses,
          bccAddresses,
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
          cc_addresses: ccAddresses,
          bcc_addresses: bccAddresses,
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

      if (sql.includes('FROM emails WHERE id = ? AND user_id = ? AND is_draft = TRUE FOR UPDATE')) {
        const email = state.emails.get(params[0]);
        return [[email && email.user_id === params[1] && email.is_draft ? { id: email.id, mail_account_id: email.mail_account_id } : null].filter(Boolean)];
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

      // One attachment by id and owner (services/mail-attachments.ts, attachmentFileForUser).
      if (sql.includes('FROM email_attachments WHERE id = ? AND user_id = ?')) {
        const attachment = state.attachments.get(params[0]);
        return [[attachment && attachment.user_id === params[1] ? attachment : null].filter(Boolean)];
      }

      if (sql.includes('SELECT id, filename, content_type, size_bytes FROM email_attachments')) {
        return [[...state.attachments.values()]
          .filter(attachment => attachment.email_id === params[0] && attachment.user_id === params[1])
          .map(({ id, filename, content_type, size_bytes }) => ({ id, filename, content_type, size_bytes }))];
      }

      if (sql.includes('SELECT id, storage_path') && sql.includes('FROM email_attachments')) {
        return [[...state.attachments.values()]
          .filter(attachment => attachment.email_id === params[0] && attachment.user_id === params[1])
          .map(({ id, storage_path, filename, size_bytes }) => ({ id, storage_path, filename, size_bytes }))];
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
        if (sql.includes(' cc_addresses = ?')) email.cc_addresses = params[index++];
        if (sql.includes('bcc_addresses = ?')) email.bcc_addresses = params[index++];
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

  t.after(require('./helpers/mail-service-modules.cts').evictMailRouteModules());
  process.env.MAIL_ATTACHMENT_UPLOAD_ROOT = uploadRoot;
  setRequireStub(statePath, { db });
  setRequireStub(encryptionPath, { encrypt: (value: FixtureValue) => `encrypted:${value}`, decrypt: () => 'test-placeholder' });
  setRequireStub(caldavPath, { createCalDavAccountForMail: async () => ({ success: true }) });
  setRequireStub(mailServicePath, {
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    MAIL_SENDER_RULE_MATCH_TYPES: new Set<FixtureValue>(['domain', 'email']),
    SYSTEM_MAIL_FOLDER_SET: new Set<FixtureValue>(['inbox', 'sent', 'drafts']),
    normalizeMailSenderRuleInput: () => ({ matchType: 'domain', matchValue: 'example.test' }),
    normalizeMailFolderSlug: (value: FixtureValue) => String(value || '').trim().toLowerCase(),
    normalizeMailFolderDisplayName: (value: FixtureValue) => String(value || '').trim(),
    loadMailFoldersForUser: async () => [],
    mailFolderExists: async () => true,
    toBooleanFlag: (value: FixtureValue) => value === true || value === 1 || value === '1',
    loadActiveMailSenderRules: async () => [],
    resolveMailSenderTargetFolder: async () => ({ folder: 'inbox' }),
    ensureDefaultMailFoldersForUser: async () => {},
    normalizeSyncFetchLimit: (value: FixtureValue, fallback = 'all') => value || fallback,
    seedMailServerDeletionQueueForAccount: async () => {},
    buildMailHostTrustResult: async () => ({}),
    validateMailHostPolicy: async () => ({ accepted: true, mailHostTrust: { blocked: false, requiresConfirmation: false } }),
    testImapConnection: async () => ({ success: true }),
    syncMailAccount: async () => ({ success: true }),
    isAnyMailAccountSyncRunning: () => false,
    getRunningMailSyncAccountIds: () => [],
    getRunningMailServerDeleteAccountIds: () => [],
    sendEmail: options.sendEmail || (async () => ({ success: true, messageId: '<sent@example.test>' })),
    // No Idempotency-Key in these requests: the real sendOnce would send directly.
    sendOnce: async (_options: FixtureValue, send: () => Promise<FixtureValue>) => send(),
    // mail-send-once-mysql-integration covers the lookup; these drafts answer nothing.
    replyThreading: async () => null,
    deleteStoredAttachmentFiles: async (paths: FixtureValue) => {
      let deletedFiles = 0;
      for (const item of paths || []) {
        if (!item) continue;
        await fs.rm(item, { force: true });
        deletedFiles += 1;
      }
      return { deletedFiles, failedFiles: 0 };
    },
  });

  return { routes: (require('../dist/src/routes/mail') as RouteTable<typeof import('../src/routes/mail')>), state, uploadRoot };
}

test('draft routes create, update, and delete draft attachments', async (t) => {
  const { routes, state } = await createDraftRouteHarness(t);
  const attachmentA = Buffer.from('first attachment').toString('base64');
  const attachmentB = Buffer.from('second attachment').toString('base64');

  const created = await routes['POST /api/mail/drafts'](
    { url: '/api/mail/drafts', headers: { host: 'localhost' } } as FixtureValue,
    'user-1',
    {
      account_id: 'account-1',
      to: 'reader@example.test',
      subject: 'Draft',
      body: '<p>Hello</p>',
      isHtml: true,
      attachments: [{ filename: 'first.txt', contentType: 'text/plain', dataBase64: attachmentA, client_id: 'file-a' }],
    }
  );

  assert.equal((created.draft! as FixtureValue).folder, 'drafts');
  assert.equal(created.draft!.is_draft, true);
  assert.equal(created.draft!.attachments.length, 1);
  // The composer learns which stored attachment each of its files became.
  assert.deepEqual(created.uploaded, [{ client_id: 'file-a', id: created.draft!.attachments[0].id }]);
  const firstAttachmentPath = [...state.attachments.values()][0].storage_path;
  await assert.doesNotReject(() => fs.stat(firstAttachmentPath));

  const updated = await routes['PUT /api/mail/drafts/:id'](
    { url: `/api/mail/drafts/${(created.draft! as FixtureValue).id}`, headers: { host: 'localhost' } } as FixtureValue,
    'user-1',
    {
      subject: 'Updated',
      body: '<p>Updated</p>',
      existing_attachment_ids: [],
      attachments: [{ filename: 'second.txt', contentType: 'text/plain', dataBase64: attachmentB, client_id: 'file-b' }],
    }
  );

  assert.equal(updated.draft!.subject, 'Updated');
  assert.deepEqual(updated.uploaded, [{ client_id: 'file-b', id: updated.draft!.attachments[0].id }]);
  assert.equal(updated.draft!.attachments.length, 1);
  assert.equal(updated.draft!.attachments[0].filename, 'second.txt');
  await assert.rejects(() => fs.stat(firstAttachmentPath));

  const secondAttachmentPath = [...state.attachments.values()][0].storage_path;
  const deleted = await routes['DELETE /api/mail/drafts/:id'](
    { url: `/api/mail/drafts/${(created.draft! as FixtureValue).id}`, headers: { host: 'localhost' } } as FixtureValue,
    'user-1'
  );

  assert.equal(deleted.deleted, true);
  assert.equal(state.emails.has((created.draft! as FixtureValue).id), false);
  await assert.rejects(() => fs.stat(secondAttachmentPath));
});

test('send draft sends stored content and removes the local draft', async (t) => {
  let sentPayload: FixtureValue = null;
  const { routes, state } = await createDraftRouteHarness(t, {
    sendEmail: async ({ accountId }: { accountId: string }, payload: FixtureValue) => {
      sentPayload = { accountId, payload };
      return { success: true, messageId: '<sent@example.test>' };
    },
  });

  const created = await routes['POST /api/mail/drafts'](
    { url: '/api/mail/drafts', headers: { host: 'localhost' } } as FixtureValue,
    'user-1',
    {
      account_id: 'account-1',
      to: 'reader@example.test',
      cc: 'Copy <copy@example.test>',
      subject: 'Ready',
      body: '<p>Send me</p>',
      isHtml: true,
    }
  );
  assert.deepEqual(created.draft!.cc_addresses, ['Copy <copy@example.test>']);
  const updated = await routes['PUT /api/mail/drafts/:id'](
    { url: `/api/mail/drafts/${(created.draft! as FixtureValue).id}` } as FixtureValue, 'user-1', { bcc: 'hidden@example.test' });
  assert.deepEqual(updated.draft!.bcc_addresses, ['hidden@example.test']);

  const sent = await routes['POST /api/mail/drafts/:id/send'](
    { url: `/api/mail/drafts/${(created.draft! as FixtureValue).id}/send`, headers: { host: 'localhost' } } as FixtureValue,
    'user-1', {}
  );

  assert.equal(sent.success, true);
  assert.equal(sentPayload.accountId, 'account-1');
  assert.deepEqual(sentPayload.payload.to, ['reader@example.test']);
  assert.deepEqual(sentPayload.payload.cc, ['Copy <copy@example.test>']);
  assert.deepEqual(sentPayload.payload.bcc, ['hidden@example.test']);
  assert.equal(sentPayload.payload.subject, 'Ready');
  assert.equal(sentPayload.payload.body, '<p>Send me</p>');
  assert.equal(state.emails.has((created.draft! as FixtureValue).id), false);
});

// The real sendEmail with only the SMTP transport, DNS policy and module settings stubbed.
function loadRealSendEmail(t: import('node:test').TestContext) {
  const delivered: FixtureValue[] = [];
  const stubs: [string, FixtureValue][] = [
    [require.resolve('nodemailer'), { createTransport: () => ({ async sendMail(message: FixtureValue) {
      delivered.push(message); return { messageId: '<delivered@example.test>' }; } }) }],
    [require.resolve('../dist/src/security/outbound-network'), {
      resolveMailConnectionTarget: async () => ({ address: '127.0.0.1', hostname: 'smtp.example.test' }) }],
    [require.resolve('../dist/src/services/module-settings'), { isModuleEnabled: async () => true }],
  ];
  const sendPath = require.resolve('../dist/src/services/mail-send');
  const saved = [...stubs.map(([p]) => p), sendPath].map(p => [p, require.cache[p]] as const);
  for (const [p, exports] of stubs) setRequireStub(p, exports);
  delete require.cache[sendPath];
  t.after(() => { for (const [p, entry] of saved) { if (entry) require.cache[p] = entry; else delete require.cache[p]; } });
  const { sendEmail } = require(sendPath) as typeof import('../src/services/mail-send');
  return { sendEmail, delivered };
}

test('a quoted recipient name with a comma stays one address from draft to SMTP', async (t) => {
  let real: ReturnType<typeof loadRealSendEmail>;
  const { routes } = await createDraftRouteHarness(t, {
    sendEmail: (...args: Parameters<typeof real.sendEmail>) => real.sendEmail(...args),
  });
  real = loadRealSendEmail(t);

  const created = await routes['POST /api/mail/drafts']({ url: '/api/mail/drafts' } as FixtureValue, 'user-1', {
    account_id: 'account-1', to: 'reader@example.test', cc: '"Doe, Jane" <jane@example.test>', body: '<p>Hi</p>', isHtml: true,
  });
  assert.deepEqual(created.draft!.cc_addresses, ['"Doe, Jane" <jane@example.test>']);

  const draftId = (created.draft! as FixtureValue).id;
  const sent = await routes['POST /api/mail/drafts/:id/send']({ url: `/api/mail/drafts/${draftId}/send` } as FixtureValue, 'user-1', {});
  assert.equal(sent.success, true);
  assert.equal(real.delivered.length, 1);
  assert.deepEqual([real.delivered[0].to, real.delivered[0].cc, real.delivered[0].bcc], [['reader@example.test'], ['"Doe, Jane" <jane@example.test>'], undefined]);

  const multiline = await routes['PUT /api/mail/drafts/:id']({ url: `/api/mail/drafts/${draftId}` } as FixtureValue, 'user-1', {
    bcc: 'a@example.test\r\nX-Injected: yes',
  });
  assert.equal(multiline.status, 400);
});

test('a plain-text draft with an attachment is sent as text', async (t) => {
  let real: ReturnType<typeof loadRealSendEmail>;
  const { routes } = await createDraftRouteHarness(t, {
    sendEmail: (...args: Parameters<typeof real.sendEmail>) => real.sendEmail(...args),
  });
  real = loadRealSendEmail(t);

  const created = await routes['POST /api/mail/drafts']({ url: '/api/mail/drafts' } as FixtureValue, 'user-1', {
    account_id: 'account-1', to: 'reader@example.test', subject: 'Notes', body: 'line one\nif a < b\n', isHtml: false,
    attachments: [{ filename: 'notes.txt', contentType: 'text/plain', dataBase64: Buffer.from('attached').toString('base64') }],
  });
  const draftId = (created.draft! as FixtureValue).id;
  const sent = await routes['POST /api/mail/drafts/:id/send']({ url: `/api/mail/drafts/${draftId}/send` } as FixtureValue, 'user-1', {});
  assert.equal(sent.success, true);
  assert.equal(real.delivered.length, 1);
  assert.equal(real.delivered[0].text, 'line one\nif a < b\n');
  assert.equal(real.delivered[0].html, undefined);
  assert.equal(real.delivered[0].attachments.length, 1);
});

test('sending does not write recipients or subject to the server log', async (t) => {
  const util = (require('node:util') as typeof import('node:util'));
  let reject = false;
  const { routes } = await createDraftRouteHarness(t, {
    sendEmail: async () => {
      if (reject) throw Object.assign(new Error("Can't send mail - all recipients were rejected: 550 <reader@example.test>"), { code: 'EENVELOPE' });
      return { success: true, messageId: '<sent@example.test>' };
    },
  });
  const log = t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const output = () => [...log.mock.calls, ...error.mock.calls]
    .map(call => call.arguments.map((value: FixtureValue) => util.inspect(value, { depth: 5 })).join(' ')).join('\n');
  const body = { account_id: 'account-1', to: 'reader@example.test', subject: 'Private subject', body: '<p>Hi</p>', isHtml: true };

  const sent = await routes['POST /api/mail/send']({ url: '/api/mail/send' } as FixtureValue, 'user-1', body);
  assert.equal(sent.success, true);
  reject = true;
  const failed = await routes['POST /api/mail/send']({ url: '/api/mail/send' } as FixtureValue, 'user-1', body);
  assert.equal(failed.status, 500);

  const logged = output();
  assert.doesNotMatch(logged, /reader@example\.test/);
  assert.doesNotMatch(logged, /Private subject/);
  assert.match(logged, /EENVELOPE/);
});

test('invalid replacement leaves original draft and attachment intact', async (t) => {
  const { routes, state } = await createDraftRouteHarness(t);
  const created = await routes['POST /api/mail/drafts']({ url: '/api/mail/drafts' } as FixtureValue, 'user-1', {
    account_id: 'account-1', subject: 'Original', body: 'Original body',
    attachments: [{ filename: 'original.txt', dataBase64: Buffer.from('original').toString('base64') }],
  });
  const original = [...state.attachments.values()][0];
  const result = await routes['PUT /api/mail/drafts/:id']({ url: `/api/mail/drafts/${(created.draft! as FixtureValue).id}` } as FixtureValue, 'user-1', {
    subject: 'Must not persist', existing_attachment_ids: [], attachments: [{ filename: 'empty', dataBase64: '' }],
  });
  assert.equal(result.status, 400);
  assert.equal(state.emails.get((created.draft! as FixtureValue).id).subject, 'Original');
  assert.equal(state.attachments.size, 1);
  assert.equal(await fs.readFile(original.storage_path, 'utf8'), 'original');
});

test('database failure rolls back draft replacement and removes staged files', async (t) => {
  let fail = false;
  const { routes, state, uploadRoot } = await createDraftRouteHarness(t, {
    failWhen: (sql: string) => fail && sql.includes('INSERT INTO email_attachments'),
  });
  const created = await routes['POST /api/mail/drafts']({ url: '/api/mail/drafts' } as FixtureValue, 'user-1', {
    account_id: 'account-1', subject: 'Original', body: 'Original body',
    attachments: [{ filename: 'original.txt', dataBase64: Buffer.from('original').toString('base64') }],
  });
  const original = [...state.attachments.values()][0];
  const beforeFiles = await fs.readdir(path.join(uploadRoot, 'user-1'));
  fail = true;
  const result = await routes['PUT /api/mail/drafts/:id']({ url: `/api/mail/drafts/${(created.draft! as FixtureValue).id}` } as FixtureValue, 'user-1', {
    subject: 'Must roll back', existing_attachment_ids: [],
    attachments: [{ filename: 'replacement.txt', dataBase64: Buffer.from('replacement').toString('base64') }],
  });
  assert.equal(result.status, 500);
  assert.equal(state.emails.get((created.draft! as FixtureValue).id).subject, 'Original');
  assert.equal(state.attachments.size, 1);
  assert.equal(await fs.readFile(original.storage_path, 'utf8'), 'original');
  assert.deepEqual(await fs.readdir(path.join(uploadRoot, 'user-1')), beforeFiles);
});

test('invalid draft creation does not leave an orphan draft', async (t) => {
  const { routes, state } = await createDraftRouteHarness(t);
  const result = await routes['POST /api/mail/drafts']({ url: '/api/mail/drafts' } as FixtureValue, 'user-1', {
    account_id: 'account-1', subject: 'Invalid', attachments: 'invalid',
  });
  assert.equal(result.status, 400);
  assert.equal(state.emails.size, 0);
  assert.equal(state.attachments.size, 0);
});

test('attachments return an owner-checked stream descriptor without buffering file content', async (t) => {
  const { routes, state } = await createDraftRouteHarness(t);
  await routes['POST /api/mail/drafts']({ url: '/api/mail/drafts' } as FixtureValue, 'user-1', {
    account_id: 'account-1', body: 'With attachment',
    attachments: [{ filename: 'a.txt', dataBase64: Buffer.from('content').toString('base64') }],
  });
  const attachment = [...state.attachments.values()][0];
  const req = { url: `/api/mail/attachments/${attachment.id}?download=1` };
  const response = await (routes['GET /api/mail/attachments/:id'] as FixtureValue)(req, 'user-1');
  assert.equal(response.__streamPath, attachment.storage_path);
  assert.equal(response.__contentLength, 7);
  assert.equal(response.__raw, undefined);
  assert.equal((await (routes['GET /api/mail/attachments/:id'] as FixtureValue)(req, 'other-user')).status, 404);
  attachment.storage_path = '/etc/passwd';
  assert.equal((await (routes['GET /api/mail/attachments/:id'] as FixtureValue)(req, 'user-1')).status, 400);
});
