const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailSyncScheduler } = require('../src/services/mail-sync-scheduler');
const { followMailServer } = require('../src/services/mail-server-follow');
const { queueChanges, processPending, startWritebacks, drainWritebacks, runDueWritebacks } = require('../src/services/mail-writebacks');
const { getDb, setDb } = require('../src/state');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('bounded FIFO sync jobs isolate accounts, expose real failure and cancel queued work', async () => {
  const releases = new Map(), calls = [];
  const scheduler = createMailSyncScheduler((id, signal, background, report) => {
    calls.push(id);
    report({ phase: 'inventory', processed: 2, total: 10 });
    return new Promise(resolve => releases.set(id, resolve));
  }, { concurrency: 2 });
  const a = scheduler.enqueue('user-a');
  const b = scheduler.enqueue('user-b');
  const c = scheduler.enqueue('user-c');
  assert.equal(scheduler.enqueue('user-a').alreadyRunning, true);
  assert.equal(scheduler.state('user-c').state, 'queued');
  await tick();
  assert.deepEqual(calls, ['user-a', 'user-b']);
  assert.equal(scheduler.state('user-b').processed, 2);
  assert.equal(scheduler.cancel('user-c'), true);
  assert.equal((await c.promise).cancelled, true);
  releases.get('user-a')({ success: false, error: 'Auth rejected' });
  assert.equal((await a.promise).success, false);
  assert.equal(scheduler.state('user-a').error, 'Auth rejected');
  assert.equal(scheduler.state('user-a').state, 'error');
  const d = scheduler.enqueue('user-d');
  await tick();
  assert.deepEqual(calls, ['user-a', 'user-b', 'user-d']);
  releases.get('user-b')({ success: true });
  releases.get('user-d')({ success: true });
  await Promise.all([b.promise, d.promise]);
  assert.equal(scheduler.state('user-b').state, 'idle');
  assert.equal(scheduler.ids().length, 0);
});

test('HTTP sync acknowledgement is prompt and status never includes another owner', async t => {
  const routePath = require.resolve('../src/routes/mail');
  const servicePath = require.resolve('../src/services/mail');
  const oldRoute = require.cache[routePath], oldService = require.cache[servicePath], oldDb = getDb();
  t.after(() => { setDb(oldDb); if (oldRoute) require.cache[routePath] = oldRoute; else delete require.cache[routePath];
    if (oldService) require.cache[servicePath] = oldService; else delete require.cache[servicePath]; });
  delete require.cache[routePath];
  const jobs = new Map(), cancellations = [];
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: {
    scheduleMailAccountSync: id => {
      if (jobs.has(id)) return { started: false, alreadyRunning: true, promise: jobs.get(id) };
      const never = new Promise(() => {}); jobs.set(id, never);
      return { started: true, alreadyRunning: false, promise: never };
    },
    cancelMailAccountSync: id => { cancellations.push(id); return jobs.delete(id); },
    getMailSyncState: id => ({ account_id: id, state: 'queued', phase: null, processed: 0, total: null,
      started_at: null, updated_at: new Date().toISOString(), error: null }),
  } };
  setDb({ execute: async (sql, params) => {
    if (sql.includes('FROM mail_accounts')) {
      if (sql.includes('WHERE id = ? AND user_id = ?')) {
        const owned = params[1] === 'alice' ? 'alice-mail' : 'bob-mail';
        return [params[0] === owned ? [{ id: owned, is_active: 1, sync_status: 'idle' }] : []];
      }
      const owned = params[0] === 'alice' ? [{ id: 'alice-mail', sync_status: 'idle' }] : [{ id: 'bob-mail', sync_status: 'idle' }];
      return [params.length > 1 ? owned.filter(row => row.id === params[1]) : owned];
    }
    assert.fail(sql);
  } });
  const routes = require('../src/routes/mail');
  const req = url => ({ url });
  assert.equal((await routes['POST /api/mail/sync'](req('/api/mail/sync'), 'alice', { account_id: 'bob-mail' })).status, 404);
  const accepted = await routes['POST /api/mail/sync'](req('/api/mail/sync'), 'alice', { account_id: 'alice-mail' });
  assert.deepEqual([accepted.status, accepted.started, accepted.alreadyRunning], [202, true, false]);
  const again = await routes['POST /api/mail/sync'](req('/api/mail/sync'), 'alice', { account_id: 'alice-mail' });
  assert.deepEqual([again.status, again.started, again.alreadyRunning], [200, false, true]);
  const status = await routes['GET /api/mail/sync/status'](req('/api/mail/sync/status'), 'alice');
  assert.deepEqual(status.accounts.map(row => row.account_id), ['alice-mail']);
  assert.equal((await routes['GET /api/mail/sync/status'](req('/api/mail/sync/status?account_id=bob-mail'), 'alice')).status, 404);
  const cancel = routes['POST /api/mail/sync/cancel'];
  assert.equal((await cancel(req('/api/mail/sync/cancel'), null, { account_id: 'alice-mail' })).status, 401);
  assert.equal((await cancel(req('/api/mail/sync/cancel'), 'alice', {})).status, 400);
  assert.equal((await cancel(req('/api/mail/sync/cancel'), 'alice', { account_id: 'bob-mail' })).status, 404);
  assert.deepEqual(cancellations, [], 'foreign or invalid cancellation never reaches the scheduler');
  const cancelled = await cancel(req('/api/mail/sync/cancel'), 'alice', { account_id: 'alice-mail' });
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.cancellationRequested, true);
  assert.deepEqual(cancellations, ['alice-mail']);
  assert.equal((await cancel(req('/api/mail/sync/cancel'), 'alice', { account_id: 'alice-mail' })).cancellationRequested, false);
});

test('opposite intent accepted after dispatch uses prior target, not stale stored flag', async () => {
  const email = { id: 'email', mail_account_id: 'account', sync_mode: 'sync', remote_folder: 'INBOX',
    remote_uid: 1, remote_uidvalidity: 9, is_read: 0 };
  const previous = { status: 'pending', dispatched: 1, target_value: '1', remote_folder: 'INBOX', remote_uid: 1, remote_uidvalidity: 9 };
  const statements = [];
  const connection = { execute: async (sql, args) => {
    statements.push({ sql, args });
    return sql.includes('SELECT * FROM mail_writebacks') ? [[previous]] : [{ affectedRows: 1 }];
  } };
  await queueChanges(connection, 'owner', [email], { read: 0 });
  const insert = statements.find(item => item.sql.includes('INSERT INTO mail_writebacks'));
  assert.equal(insert.args[5], '0');
  assert.equal(insert.args[6], '1');
  assert.match(statements.find(item => item.sql.includes('DELETE FROM mail_writebacks')).sql, /email_id = \? AND action = \?/);
});

test('stale flag completion cannot erase a newer opposite request', async t => {
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const account = { id: 'account', user_id: 'owner' };
  const email = { id: 'email', user_id: 'owner', mail_account_id: 'account', sync_mode: 'sync',
    remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, is_read: 0, is_active: 1 };
  let op = { id: 'old', user_id: 'owner', mail_account_id: 'account', email_id: 'email', action: 'read',
    target_value: '1', base_value: '0', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9,
    status: 'pending', attempts: 0, dispatched: 0 };
  let releaseWrite, dispatched;
  const dispatchReached = new Promise(resolve => { dispatched = resolve; });
  const flags = new Set();
  const db = { execute: async (sql, args = []) => {
    if (sql.includes('FROM backup_restore_jobs') || sql.includes('FROM user_settings')) return [[]];
    if (sql.includes('SELECT * FROM mail_writebacks WHERE mail_account_id')) return [op?.status === 'pending' ? [{ ...op }] : []];
    if (sql.includes('SELECT * FROM mail_writebacks WHERE email_id')) return [[op]];
    if (sql.includes('SELECT e.*, a.sync_mode')) return [[{ ...email }]];
    if (sql.includes('UPDATE mail_writebacks SET attempts')) { op.attempts++; return [{ affectedRows: 1 }]; }
    if (sql.includes('UPDATE mail_writebacks SET dispatched')) {
      if (op?.id !== args[1]) return [{ affectedRows: 0 }];
      op.dispatched = 1; op.dispatch_modseq = args[0]; dispatched(); return [{ affectedRows: 1 }];
    }
    if (sql.includes('UPDATE mail_writebacks SET status')) {
      if (op?.id === args[2]) { op.status = args[0]; return [{ affectedRows: 1 }]; }
      return [{ affectedRows: 0 }];
    }
    if (sql.includes('UPDATE emails SET is_read')) { email.is_read = args[0]; return [{ affectedRows: 1 }]; }
    if (sql.includes('DELETE FROM mail_writebacks WHERE email_id')) { op = null; return [{ affectedRows: 1 }]; }
    if (sql.includes('INSERT INTO mail_writebacks')) {
      op = { id: args[0], user_id: args[1], mail_account_id: args[2], email_id: args[3], action: args[4],
        target_value: args[5], base_value: args[6], target_folder: args[7], remote_folder: args[8],
        remote_uid: args[9], remote_uidvalidity: args[10], status: 'pending', attempts: 0, dispatched: 0 };
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('DELETE FROM mail_writebacks WHERE mail_account_id')) return [{ affectedRows: 0 }];
    assert.fail(sql);
  } };
  setDb(db);
  const connection = { openBox: async () => ({ uidvalidity: 9 }),
    search: async () => [{ attributes: { uid: 12, flags: [...flags], modseq: flags.size ? '101' : '100' } }],
    imap: { _box: {}, serverSupports: c => c === 'CONDSTORE',
      addFlagsSince: (_uid, _flag, _modseq, cb) => { releaseWrite = () => { flags.add('\\Seen'); cb(null); }; },
      delFlagsSince: (_uid, _flag, _modseq, cb) => { flags.delete('\\Seen'); cb(null); } } };
  const first = processPending(account, connection);
  await dispatchReached;
  await queueChanges(db, 'owner', [email], { read: 0 });
  assert.equal(op.base_value, '1');
  assert.equal(op.target_value, '0');
  const newId = op.id;
  releaseWrite();
  await first;
  assert.equal(op.id, newId);
  assert.equal(op.status, 'pending');
  assert.equal(email.is_read, 1);
  await processPending(account, connection);
  assert.equal(email.is_read, 0);
  assert.equal(op.status, 'done');
});

test('startup/due pass discovers pending writebacks independently of sync', async t => {
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const calls = [];
  setDb({ execute: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT DISTINCT w.mail_account_id')) return [[{ mail_account_id: 'due-account' }]];
    if (sql.includes('SELECT * FROM mail_accounts')) return [[]]; // account removed before dispatch
    assert.fail(sql);
  } });
  assert.equal(await runDueWritebacks(), 1);
  await tick();
  assert(calls.some(item => item.sql.includes('available_at <= UTC_TIMESTAMP()')));
  assert(calls.some(item => item.sql.includes('SELECT * FROM mail_accounts')),
    'a due pass starts an account worker even with no manual request or sync');
});

test('direct writeback intake is bounded and sync waiters do not consume provider slots', async t => {
  const oldDb = getDb(); t.after(() => setDb(oldDb));
  const mail = require('../src/services/mail');
  const imaps = require('imap-simple');
  let syncing = true;
  const connects = [], rejects = [];
  t.mock.method(mail, 'isMailAccountSyncRunning', id => syncing && id === 'syncing');
  t.mock.method(mail, 'buildImapConnectionConfig', async () => ({ imap: {} }));
  t.mock.method(imaps, 'connect', async () => {
    connects.push(1);
    return new Promise((_resolve, reject) => rejects.push(reject));
  });
  setDb({ execute: async (sql, params) => {
    if (sql.includes('FROM backup_restore_jobs') || sql.includes('FROM user_settings')) return [[]];
    if (sql.includes('SELECT * FROM mail_accounts')) return [[{ id: params[0], user_id: 'owner', sync_mode: 'sync', is_active: 1 }]];
    if (sql.includes('UPDATE mail_writebacks')) return [{ affectedRows: 0 }];
    assert.fail(sql);
  } });
  const jobs = [startWritebacks('syncing')];
  for (const id of ['one', 'two', 'three', 'four', 'five', 'six']) jobs.push(startWritebacks(id));
  await tick();
  assert.equal(connects.length, 4, 'directly accepted actions obey global connection cap');
  assert.equal(startWritebacks('five'), jobs[5], 'one queued job per account');
  rejects.shift()(new Error('synthetic connection failure'));
  await tick(); await tick();
  assert.equal(connects.length, 5, 'free slot goes to unrelated account, not blocked sync waiter');
  syncing = false;
  drainWritebacks();
  while (rejects.length) { rejects.shift()(new Error('synthetic connection failure')); await tick(); }
  await Promise.all(jobs);
  assert.equal(connects.length, 7);
});

test('new mail is durably imported before a later changing inventory blocks location metadata', async () => {
  const imports = [], writes = [];
  let selected = 'INBOX';
  const connection = { openBox: async name => { selected = name; return { uidvalidity: 9 }; },
    search: async (criteria) => criteria[0] === 'ALL'
      ? [{ attributes: { uid: 31, flags: [] } }]
      : [{ attributes: { uid: 31 }, raw: 'From: new@example.test\r\n\r\nnew body' }] };
  const db = { execute: async (sql, args) => {
    if (sql.includes('SELECT id')) return [[]];
    writes.push({ sql, args }); return [{ affectedRows: 1 }];
  } };
  await assert.rejects(followMailServer({ db, connection, account: { id: 'a', user_id: 'u' },
    folders: [{ folderName: 'INBOX', dbFolderName: 'inbox' }], listFolders: async () => ['INBOX', 'just-arrived'],
    getUidValidity: () => 9, buildRaw: item => item.raw,
    importMessage: async (remote, raw) => { imports.push({ remote, raw }); return { emailId: 'saved', isNew: true }; },
  }), /Folder inventory changed/);
  assert.equal(imports.length, 1, 'verified body is retained even though a new folder arrived');
  assert.equal(writes.length, 0, 'no absence or location metadata used the unstable snapshot');
});

test('an arrival during SELECT/SEARCH still imports verified UIDs but defers absence', async () => {
  const imports = [], writes = [];
  const connection = { openBox: async () => ({ uidvalidity: 9, messages: { total: 1 } }),
    search: async criteria => criteria[0] === 'ALL'
      ? [{ attributes: { uid: 1, flags: [] } }, { attributes: { uid: 2, flags: [] } }]
      : [{ attributes: { uid: criteria[0][1] }, raw: `From: x@example.test\r\n\r\nbody-${criteria[0][1]}` }] };
  const db = { execute: async (sql, args) => {
    if (sql.includes('SELECT id')) return [[]];
    writes.push({ sql, args }); return [{ affectedRows: 1 }];
  } };
  await assert.rejects(followMailServer({ db, connection, account: { id: 'a', user_id: 'u' },
    folders: [{ folderName: 'INBOX', dbFolderName: 'inbox' }], listFolders: async () => ['INBOX'],
    getUidValidity: () => 9, buildRaw: item => item.raw,
    importMessage: async (remote) => { imports.push(remote.uid); return { emailId: `saved-${remote.uid}`, isNew: true }; },
  }), /Incomplete message inventory/);
  assert.deepEqual(imports, [1, 2]);
  assert.equal(writes.length, 0);
});

test('a checkpointed move restarts the snapshot after retaining safe imports', async () => {
  const imports = [], writes = [];
  const connection = { openBox: async () => ({ uidvalidity: 9 }), search: async criteria =>
    criteria[0] === 'ALL' ? [{ attributes: { uid: 1, flags: [] } }]
      : [{ attributes: { uid: 1 }, raw: 'From: x@example.test\r\n\r\nfirst' }] };
  const db = { execute: async sql => sql.includes('SELECT id') ? [[]] : (writes.push(sql), [{ affectedRows: 1 }]) };
  await assert.rejects(followMailServer({ db, connection, account: { id: 'a', user_id: 'u' },
    folders: [{ folderName: 'INBOX', dbFolderName: 'inbox' }], listFolders: async () => ['INBOX'],
    getUidValidity: () => 9, buildRaw: item => item.raw,
    importMessage: async remote => { imports.push(remote.uid); return { emailId: 'saved', isNew: true }; },
    checkpoint: async () => true,
  }), { code: 'MAIL_SYNC_RESTART' });
  assert.deepEqual(imports, [1]);
  assert.deepEqual(writes, []);
});

test('checkpoint reads fresh flags and reuses staged raw body without repeat fetch', async () => {
  const seen = [], imports = [], writes = [], stages = [];
  let selected, flag = false;
  const connection = { openBox: async name => { selected = name; return { uidvalidity: 9 }; },
    search: async (criteria, opts) => {
      if (criteria[0] === 'ALL') return [{ attributes: { uid: 1, flags: flag ? ['\\Seen'] : [] } }];
      seen.push({ selected, criteria });
      return [{ attributes: { uid: 1 }, raw: 'From: a@example.test\r\n\r\nbody' }];
    } };
  const db = { execute: async (sql, args) => {
    if (sql.includes('SELECT id')) return [[]];
    writes.push({ sql, args }); return [{ affectedRows: 1 }];
  } };
  const result = await followMailServer({ db, connection, account: { id: 'a', user_id: 'u' },
    folders: [{ folderName: 'INBOX', dbFolderName: 'inbox' }], listFolders: async () => ['INBOX'],
    getUidValidity: () => 9, buildRaw: item => item.raw,
    importMessage: async (remote, raw) => { imports.push(raw); return { emailId: 'new', isNew: true }; },
    checkpoint: async () => { flag = true; }, progress: status => stages.push(status.phase),
  });
  assert.equal(result.newEmails, 1);
  assert.equal(seen.length, 1, 'unknown body fetched once for hash and import');
  assert.equal(imports.length, 1);
  assert.equal(writes[0].args[3], 1, 'confirmed read state follows fresh metadata after checkpoint');
  assert(stages.includes('inventory') && stages.includes('importing'));
});
