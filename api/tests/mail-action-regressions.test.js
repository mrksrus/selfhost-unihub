const test = require('node:test');
const assert = require('node:assert/strict');
const { getDb, setDb } = require('../src/state');
const routes = require('../src/routes/mail');
const { withMailAccountLock } = require('../src/services/mail-account-lock');
const { mutateMessages, retryWriteback } = require('../src/services/mail-writebacks');
const request = url => ({ url, headers: { host: 'localhost' } });
function installDb(t, db) { const old = getDb(); setDb(db); t.after(() => setDb(old)); }
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const [read, star] of [[0, 0], [0, 1], [1, 0], [1, 1], ['0', '0'], ['0', '1'], ['1', '0'], ['1', '1']]) {
  test(`list/detail decode independent read=${JSON.stringify(read)} star=${JSON.stringify(star)}`, async t => {
    installDb(t, { execute: async (sql, args) => {
      assert(args.includes('owner'));
      if (sql.includes('COUNT(*)')) return [[{ total: 1 }]];
      if (sql.includes('FROM email_attachments')) return [[]];
      return [[{ id: 'email', user_id: 'owner', to_addresses: '[]', is_read: read, is_starred: star,
        effective_is_read: read, effective_is_starred: star, read_sync_pending: 0, star_sync_pending: 0 }]];
    } });
    const list = await routes['GET /api/mail/emails'](request('/api/mail/emails'), 'owner');
    const detail = await routes['GET /api/mail/emails/:id'](request('/api/mail/emails/email'), 'owner');
    for (const row of [list.emails[0], detail.email]) {
      assert.equal(row.is_read, Number(read) === 1);
      assert.equal(row.is_starred, Number(star) === 1);
      assert.equal(row.read_sync_pending, false);
      assert.equal(row.star_sync_pending, false);
    }
  });
}

test('HTTP flag acceptance commits while a provider lock is held, without waiting for IMAP', { timeout: 2000 }, async t => {
  let release, transactions = 0, committed = 0;
  const blocker = withMailAccountLock('busy', () => new Promise(resolve => { release = resolve; }));
  await tick(); t.after(() => release());
  installDb(t, { execute: async sql => {
    if (sql.includes('FROM backup_restore_jobs') || sql.includes('FROM user_settings')) return [[]];
    assert.fail(`Unexpected query ${sql}`);
  }, getConnection: async () => {
    transactions++;
    return { beginTransaction: async () => {}, commit: async () => { committed++; }, rollback: async () => {}, release: () => {},
      execute: async (sql, args) => {
        if (sql.includes('FROM emails e')) return [[{ id: 'e', user_id: 'owner', mail_account_id: 'busy', sync_mode: 'download' }]];
        if (sql.includes('UPDATE emails')) return [{ affectedRows: 1 }];
        assert.fail(`Unexpected query ${sql}`);
      } };
  } });
  const result = await routes['PUT /api/mail/emails/:id/star'](request('/api/mail/emails/e/star'), 'owner', { is_starred: true });
  assert.equal(result.sync_pending, false);
  assert.equal(transactions, 1);
  assert.equal(committed, 1);
  release(); await blocker;
});

test('bulk selection remains atomic across accounts when one id is unavailable', { timeout: 2000 }, async t => {
  let release, rolledBack = false, writes = 0;
  const blocker = withMailAccountLock('b', () => new Promise(resolve => { release = resolve; }));
  await tick(); t.after(() => release());
  installDb(t, { execute: async sql => {
    if (sql.includes('FROM backup_restore_jobs') || sql.includes('FROM user_settings')) return [[]];
    assert.fail(`Unexpected query ${sql}`);
  }, getConnection: async () => ({ beginTransaction: async () => {}, commit: async () => {}, rollback: async () => { rolledBack = true; }, release: () => {},
    execute: async sql => {
      if (sql.includes('FROM emails e')) return [[{ id: 'one', mail_account_id: 'a', sync_mode: 'download' }]];
      writes++; return [{ affectedRows: 1 }];
    } }) });
  await assert.rejects(mutateMessages('owner', ['one', 'two'], { read: 0 }), { status: 404 });
  assert.equal(rolledBack, true);
  assert.equal(writes, 0);
  release(); await blocker;
});

test('lock reservations reject concurrent actions but retain ordered worker serialization', async () => {
  const events = []; let release;
  const first = withMailAccountLock('serial', async () => {
    events.push('first'); await new Promise(resolve => { release = resolve; }); events.push('first-done');
  }, { wait: false });
  const rejected = withMailAccountLock('serial', () => assert.fail('Rejected callback ran'), { wait: false });
  const worker = withMailAccountLock('serial', () => events.push('worker'));
  await assert.rejects(rejected, { code: 'MAIL_ACCOUNT_BUSY' });
  assert.deepEqual(events, ['first']);
  release(); await Promise.all([first, worker]);
  assert.deepEqual(events, ['first', 'first-done', 'worker']);
  await assert.rejects(withMailAccountLock('serial', () => { throw new Error('rollback'); }, { wait: false }), /rollback/);
  assert.equal(await withMailAccountLock('serial', async () => 'free', { wait: false }), 'free');
});

test('retry cannot discover or reserve another owner’s account', async t => {
  installDb(t, { execute: async (sql, args) => {
    assert.match(sql, /id = \? AND user_id = \?/); assert.deepEqual(args, ['operation', 'stranger']); return [[]];
  } });
  await assert.rejects(retryWriteback('stranger', 'operation'), { status: 404 });
});
