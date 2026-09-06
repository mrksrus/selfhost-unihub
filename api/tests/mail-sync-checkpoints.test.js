const test = require('node:test');
const assert = require('node:assert/strict');
const { syncMailFolder } = require('../src/services/mail');
const { setDb, getDb } = require('../src/state');
const fs = require('node:fs');

function harness(t, { checkpoint, failUid, uidValidity = 100, incomplete = [], archivedUid = null } = {}) {
  const originalDb = getDb();
  const importPath = require.resolve('../src/services/mail-import');
  const originalImport = require.cache[importPath];
  const imported = new Map();
  const originalExists = fs.existsSync;
  const originalReadFile = fs.promises.readFile;
  const rawPath = '/app/uploads/mail-raw/u1/legacy.eml';
  if (archivedUid) {
    fs.existsSync = value => value === rawPath || originalExists(value);
    fs.promises.readFile = async (value, ...args) => value === rawPath
      ? `From: sender@example.test\r\nTo: receiver@example.test\r\nMessage-ID: <legacy@example.test>\r\nSubject: Archived\r\n\r\nRecovered from raw archive`
      : originalReadFile(value, ...args);
    t.after(() => { fs.existsSync = originalExists; fs.promises.readFile = originalReadFile; });
  }
  const searches = [];
  const persisted = [];
  let saved = checkpoint;
  let fail = failUid;
  const db = { async execute(sql, params) {
    if (sql.includes('SELECT uidvalidity, last_uid, initialized')) return [[saved].filter(Boolean)];
    if (sql.includes('INSERT INTO mail_sync_state')) { saved = { uidvalidity: params[2], last_uid: params[3], initialized: true }; return [{ affectedRows: 1 }]; }
    if (sql.includes('import_complete = FALSE')) return [incomplete.map(imap_uid => ({ imap_uid }))];
    if (sql.includes('SELECT imap_uid')) return [[...imported.keys()].map(imap_uid => ({ imap_uid }))];
    if (sql.includes('INSERT INTO mail_folders')) return [{ affectedRows: 1 }];
    if (sql.includes('FROM mail_folders')) return [[{ slug: 'inbox', is_system: true }]];
    if (sql.includes('FROM mail_sender_rules')) return [[]];
    if (sql.includes('FROM emails') && sql.includes('source_folder = ?') && params[2] === archivedUid) return [[{ id: 'legacy-email', message_id: '<legacy@example.test>', raw_storage_path: rawPath, import_complete: false }]];
    if (sql.includes('FROM emails')) return [[]];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const imap = { imap: { _box: { uidvalidity: uidValidity } }, async openBox() {}, async search(criteria, options) {
    searches.push(criteria);
    if (!options.bodies) return [1, 2, 3].map(uid => ({ attributes: { uid } }));
    const uid = criteria[0][1];
    if (uid === archivedUid) return [];
    return [{ attributes: { uid, flags: [] }, parts: [{ which: '', body:
      `From: sender@example.test\r\nTo: receiver@example.test\r\nMessage-ID: <${uid}@example.test>\r\nDate: Tue, 01 Jan 2019 10:00:00 +0000\r\nSubject: Old ${uid}\r\n\r\nOld body` }] }];
  } };
  require.cache[importPath] = { id: importPath, filename: importPath, loaded: true, exports: {
    async persistImportedMessage(args) {
      if (args.uid === fail) throw new Error('Injected storage failure');
      imported.set(args.uid, true); persisted.push(args);
      return { emailId: args.existingEmail?.id || `email-${args.uid}`, isNew: !args.existingEmail };
    },
  } };
  setDb(db);
  t.after(() => { setDb(originalDb); if (originalImport) require.cache[importPath] = originalImport; else delete require.cache[importPath]; });
  return { searches, persisted, get saved() { return saved; }, clearFailure() { fail = null; }, async sync() {
    return syncMailFolder(imap, { user_id: 'u1' }, 'a1', 'INBOX', 'inbox', '2026-09-01T00:00:00Z');
  } };
}

test('new folder scans historical UIDs despite recent account timestamp and suppresses baseline notifications', async (t) => {
  const h = harness(t);
  const result = await h.sync();
  assert.deepEqual(h.searches[0], ['ALL']);
  assert.equal(result.newEmails, 3);
  assert.equal(h.saved.last_uid, 3);
  assert.ok(h.persisted.every(row => row.suppressNotifications));
});

test('failed historical message retains checkpoint and retries without reimporting complete messages', async (t) => {
  const h = harness(t, { failUid: 2 });
  assert.equal((await h.sync()).failed, 1);
  assert.equal(h.saved, undefined);
  h.clearFailure();
  assert.equal((await h.sync()).newEmails, 1);
  assert.equal(h.saved.last_uid, 3);
  assert.deepEqual(h.persisted.map(row => row.uid), [1, 3, 2]);
});

test('UIDVALIDITY changes reset the folder baseline', async (t) => {
  const h = harness(t, { checkpoint: { initialized: true, uidvalidity: 99, last_uid: 500 } });
  await h.sync();
  assert.deepEqual(h.searches[0], ['ALL']);
  assert.equal(h.saved.last_uid, 3);
  assert.equal(h.saved.uidvalidity, 100);
  assert.ok(h.persisted.every(row => row.suppressNotifications));
});

test('incremental sync retries incomplete old UIDs below its checkpoint', async (t) => {
  const h = harness(t, { checkpoint: { initialized: true, uidvalidity: 100, last_uid: 2 }, incomplete: [1] });
  await h.sync();
  assert.deepEqual(h.searches[0], [['UID', '3:*']]);
  assert.deepEqual(h.persisted.map(row => row.uid), [1, 3]);
  assert.equal(h.saved.last_uid, 3);
});


test('incomplete messages missing on the provider recover from their guarded local raw archive', async (t) => {
  const h = harness(t, { checkpoint: { initialized: true, uidvalidity: 100, last_uid: 3 }, incomplete: [1], archivedUid: 1 });
  const result = await h.sync();
  assert.equal(result.failed, 0);
  assert.equal(result.newEmails, 0);
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].existingEmail.id, 'legacy-email');
  assert.match(h.persisted[0].fullEmail, /Recovered from raw archive/);
});
