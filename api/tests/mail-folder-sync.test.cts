import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

const {
  pickImapSyncFolders,
} = require('../dist/src/services/mail') as typeof import('../src/services/mail');

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

test('provider special-use attributes survive nesting and existing folder mappings win', () => {
  const { imapListToFolders } = require('../dist/src/services/mail') as typeof import('../src/services/mail');
  const roles = new Map();
  const entry = (path: FixtureValue, flags: FixtureValue) => ({ path, delimiter: '/', flags: new Set<FixtureValue>(flags) });
  // ImapFlow LIST entries; a name-based specialUse guess must not assign a role.
  const names = imapListToFolders([
    entry('INBOX', []),
    entry('[Provider]', ['\\Noselect']),
    entry('[Provider]/Gesendet', ['\\Sent']),
    entry('[Provider]/Entwürfe', ['\\Drafts']),
    entry('[Provider]/Spam', ['\\Junk']),
    ({ ...entry('Trash', []), specialUse: '\\Trash' } as FixtureValue),
  ], roles);
  assert(!roles.has('Trash'));
  assert(names.includes('Trash'));
  assert(!names.includes('[Provider]'));
  assert.equal(roles.get('[Provider]/Gesendet'), 'sent');
  assert.equal(roles.get('[Provider]/Entwürfe'), 'drafts');
  assert.equal(roles.get('[Provider]/Spam'), 'junk');
  const plan = pickImapSyncFolders(names, new Map([
    ['[Provider]/Gesendet', 'legacy_sent'], ['[Provider]/Entwürfe', 'drafts'], ['[Provider]/Spam', 'spam_2'],
  ]));
  assert(plan.some((item) => item.folderName === '[Provider]/Gesendet' && item.dbFolderName === 'legacy_sent'));
  assert(plan.some((item) => item.folderName === '[Provider]/Entwürfe' && item.dbFolderName === 'drafts'));
  assert(plan.some((item) => item.folderName === '[Provider]/Spam' && item.dbFolderName === 'spam_2'));
});
