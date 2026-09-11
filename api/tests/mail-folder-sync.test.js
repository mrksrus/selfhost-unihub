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

test('provider special-use attributes survive nesting and existing folder mappings win', () => {
  const { flattenImapBoxes } = require('../src/services/mail');
  const roles = new Map();
  const names = flattenImapBoxes({
    INBOX: { attribs: [], delimiter: '/' },
    '[Provider]': { attribs: ['\\Noselect'], delimiter: '/', children: {
      Gesendet: { attribs: ['\\Sent'] },
      Entwürfe: { attribs: ['\\Drafts'] },
      Spam: { attribs: ['\\Junk'] },
    } },
  }, '', roles);
  assert(!names.includes('[Provider]'));
  assert.equal(roles.get('[Provider]/Gesendet'), 'sent');
  assert.equal(roles.get('[Provider]/Entwürfe'), 'drafts');
  assert.equal(roles.get('[Provider]/Spam'), 'junk');
  const plan = pickImapSyncFolders(names, new Map([
    ['[Provider]/Gesendet', 'legacy_sent'], ['[Provider]/Entwürfe', 'drafts'], ['[Provider]/Spam', 'spam_2'],
  ]));
  assert(plan.some(item => item.folderName === '[Provider]/Gesendet' && item.dbFolderName === 'legacy_sent'));
  assert(plan.some(item => item.folderName === '[Provider]/Entwürfe' && item.dbFolderName === 'drafts'));
  assert(plan.some(item => item.folderName === '[Provider]/Spam' && item.dbFolderName === 'spam_2'));
});
