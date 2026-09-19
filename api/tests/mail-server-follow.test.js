const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { identity, planServerFollow, followMailServer } = require('../src/services/mail-server-follow');
const { withMailAccountLock } = require('../src/services/mail-account-lock');
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
const local = (id, folder = 'INBOX', uid = 1, extra = {}) => ({ id, source_folder: folder, imap_uid: uid, imap_uidvalidity: 100, raw_sha256: hash('same raw'), is_draft: 0, import_complete: 1, ...extra });
const remote = (folderName = 'INBOX', uid = 1, extra = {}) => ({ folderName, dbFolderName: folderName.toLowerCase(), uid, validity: 100, key: identity(folderName, 100, uid), flags: [], rawHash: hash('same raw'), ...extra });

test('exact UID tuple follows flags; source evidence survives verified cross-folder move', () => {
  const row = local('a');
  const snapshot = remote('Filed', 20);
  const plan = planServerFollow([row], [snapshot]);
  assert.equal(plan.updates[0].local.id, 'a');
  assert.equal(plan.updates[0].remote.folderName, 'Filed');
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.imports, []);
  assert.equal(row.source_folder, 'INBOX');
  assert.equal(row.imap_uid, 1);
});

test('duplicate byte-identical absent copies are ambiguous and retained unchanged', () => {
  const plan = planServerFollow([local('a'), local('b', 'Older', 2)], [remote('Filed', 20)]);
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.imports.length, 0);
});

test('multiple new labels cannot masquerade as one verified move', () => {
  const plan = planServerFollow([local('a')], [remote('Label A', 20), remote('Label B', 30)]);
  assert.equal(plan.ambiguous.length, 2);
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.updates.length, 0);
});

test('a still-present original means a second identical server copy is imported independently', () => {
  const plan = planServerFollow([local('a')], [remote(), remote('Copy', 20)]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.imports.length, 1);
});

test('Message-ID and To alone never match; reused UIDs require raw identity proof', () => {
  const old = local('a', 'INBOX', 1, { message_id: 'same-id', to_addresses: ['same@example.com'] });
  const changed = remote('INBOX', 1, { validity: 200, key: identity('INBOX', 200, 1), rawHash: hash('different raw'), message_id: 'same-id', to_addresses: ['same@example.com'] });
  const plan = planServerFollow([old], [changed]);
  assert.equal(plan.imports.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.missing[0].id, 'a');
});

test('current identity follows subsequent moves while local-only rows and drafts stay local', () => {
  const rows = [local('a', 'INBOX', 1, { remote_folder: 'Filed', remote_uid: 20, remote_uidvalidity: 100 }),
    local('draft', 'INBOX', 2, { is_draft: 1 }), local('local', null, null)];
  const plan = planServerFollow(rows, [remote('Filed', 20)]);
  assert.equal(plan.updates[0].local.id, 'a');
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.missing.length, 0);
});

function fakeServer({ rows = [local('a')], boxes = { INBOX: [{ uid: 1, flags: ['\\Seen', '\\Flagged'], raw: 'same raw' }] }, changeList = false, failFetch = false, signal = null, onSearch = null } = {}) {
  const writes = [], imports = [], searches = [];
  let current;
  const connection = {
    openBox: async (name, readOnly) => { assert.equal(readOnly, true); current = name; },
    search: async (criteria, options) => {
      searches.push({ criteria, options });
      if (onSearch) onSearch(criteria);
      const items = boxes[current] || [];
      if (criteria[0] === 'ALL') return items.map(item => ({ attributes: { uid: item.uid, flags: item.flags } }));
      if (failFetch) return [];
      return items.filter(item => item.uid === criteria[0][1]).map(item => ({ attributes: { uid: item.uid, flags: item.flags }, raw: item.raw }));
    },
  };
  const db = { execute: async (sql, args) => {
    if (sql.includes('SELECT id')) return [rows];
    writes.push({ sql, args }); return [{ affectedRows: 1 }];
  } };
  return { writes, imports, searches, run: () => followMailServer({ db, connection, account: { id: 'account', user_id: 'owner' },
    folders: Object.keys(boxes).map(folderName => ({ folderName, dbFolderName: folderName.toLowerCase() })),
    listFolders: async () => changeList ? ['different folder'] : Object.keys(boxes), getUidValidity: () => 100,
    buildRaw: item => item.raw, signal,
    importMessage: async (item, raw) => { imports.push({ item, raw }); return { emailId: 'new', isNew: true }; },
  }) };
}

test('metadata-only recurring pass follows read/unread and flagged while retaining missing content', async () => {
  const fake = fakeServer({ rows: [local('a'), local('missing', 'INBOX', 2)], boxes: { INBOX: [{ uid: 1, flags: [], raw: 'same raw' }] } });
  const result = await fake.run();
  assert.equal(result.remoteMissing, 1);
  assert.equal(fake.imports.length, 0);
  assert.equal(fake.searches.length, 2);
  assert.equal(fake.writes[0].args[3], 0);
  assert.equal(fake.writes[0].args[4], 0);
  assert.match(fake.writes[1].sql, /remote_missing = TRUE/);
  for (const write of fake.writes) {
    assert.doesNotMatch(write.sql, /DELETE|SET source_folder|SET imap_uid/);
    assert.ok(write.args.includes('owner'));
    assert.ok(write.args.includes('account'));
  }
});

test('a complete empty mailbox marks absent messages while preserving local-only copies', async () => {
  const fake = fakeServer({ rows: [local('a'), local('local', null, null)], boxes: { INBOX: [] } });
  const result = await fake.run();
  assert.equal(result.remoteMissing, 1);
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.writes[0].args[0], 'a');
});

test('verified moves update current identity and destination without replacing original source', async () => {
  const fake = fakeServer({ boxes: { Filed: [{ uid: 20, flags: ['\\Seen', '\\Flagged'], raw: 'same raw' }] } });
  const result = await fake.run();
  assert.equal(result.updated, 1);
  assert.equal(result.newEmails, 0);
  assert.equal(fake.writes[0].args[0], 'Filed');
  assert.equal(fake.writes[0].args[3], 1);
  assert.equal(fake.writes[0].args[4], 1);
  assert.equal(fake.writes[0].args[5], 'filed');
  assert.doesNotMatch(fake.writes[0].sql, /SET source_folder|source_folder =/);
});

test('failed body fetch and changed LIST never mark anything missing or move messages', async () => {
  for (const option of [{ failFetch: true }, { changeList: true }]) {
    const fake = fakeServer({ ...option, boxes: { Filed: [{ uid: 20, flags: [], raw: 'same raw' }] } });
    await assert.rejects(fake.run(), /retry required/);
    assert.deepEqual(fake.writes, []);
  }
});

test('cancellation stops a scan before mutation; retry can complete the same work', async () => {
  const controller = new AbortController();
  const fake = fakeServer({ signal: controller.signal, onSearch: () => controller.abort() });
  await assert.rejects(fake.run(), { code: 'MAIL_SYNC_CANCELLED' });
  assert.deepEqual(fake.writes, []);
  const retry = fakeServer();
  assert.equal((await retry.run()).success, true);
});

test('completed imports are recognized by source tuple after interruption before current-field update', () => {
  const row = local('new', 'Filed', 20, { remote_folder: null, remote_uid: null });
  const plan = planServerFollow([row], [remote('Filed', 20)]);
  assert.equal(plan.imports.length, 0);
  assert.equal(plan.updates[0].local.id, 'new');
});

test('account lock serializes settings after remote operation and recovers after failures', async () => {
  const events = [];
  let unlock;
  const held = new Promise(resolve => { unlock = resolve; });
  const deleting = withMailAccountLock('account', async () => { events.push('delete starts'); await held; events.push('delete ends'); });
  const setting = withMailAccountLock('account', async () => { events.push('sync committed'); throw new Error('synthetic failure'); });
  const independent = withMailAccountLock('other', async () => events.push('other account'));
  await independent;
  assert.deepEqual(events, ['delete starts', 'other account']);
  unlock();
  await deleting;
  await assert.rejects(setting, /synthetic failure/);
  await withMailAccountLock('account', async () => events.push('retry'));
  assert.deepEqual(events.slice(2), ['delete ends', 'sync committed', 'retry']);
});
