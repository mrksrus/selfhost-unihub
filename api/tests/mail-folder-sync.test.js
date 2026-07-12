const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickImapSyncFolders,
  ensureCustomImapFoldersForUser,
} = require('../src/services/mail');

test('mail sync includes standard and custom IMAP folders while ignoring provider namespaces', () => {
  const plan = pickImapSyncFolders([
    'INBOX',
    'Sent',
    'Drafts',
    'Projects/2026',
    '[Gmail]/All Mail',
  ], new Map([['Projects/2026', 'projects_2026']]));

  assert.deepEqual(plan, [
    { folderName: 'INBOX', dbFolderName: 'inbox' },
    { folderName: 'Sent', dbFolderName: 'sent' },
    { folderName: 'Drafts', dbFolderName: 'drafts' },
    { folderName: '[Gmail]/All Mail', dbFolderName: 'archive' },
    { folderName: 'Projects/2026', dbFolderName: 'projects_2026' },
  ]);
});

test('mail sync creates missing local custom folders on a newly connected IMAP account', async () => {
  const added = [];
  const connection = {
    imap: {
      addBox(name, callback) {
        added.push(name);
        callback(null);
      },
    },
  };
  const db = {
    execute: async () => [[
      { display_name: 'Receipts' },
      { display_name: 'Project Alpha' },
    ]],
  };

  const result = await ensureCustomImapFoldersForUser('user-1', connection, ['INBOX', 'Receipts'], db);

  assert.deepEqual(added, ['Project Alpha']);
  assert.deepEqual(result, { created: 1, failed: [] });
});
