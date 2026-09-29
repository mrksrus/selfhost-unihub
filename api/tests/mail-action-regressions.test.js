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

test('busy HTTP actions and retry reject without entering a transaction or later applying', { timeout: 2000 }, async t => {
  let release, transactions = 0, calls = 0;
  const blocker = withMailAccountLock('busy', () => new Promise(resolve => { release = resolve; }));
  await tick();
  t.after(() => release());
  installDb(t, { execute: async (sql, args) => {
    calls++;
    assert(args.includes('owner'));
    if (sql.includes('FROM mail_writebacks')) return [[{ mail_account_id: 'busy' }]];
    return [[{ mail_account_id: 'busy' }]];
  }, getConnection: async () => { transactions++; throw new Error('Must not start a transaction'); } });
  for (const [route, url, body] of [
    ['PUT /api/mail/emails/:id/read', '/api/mail/emails/e/read', { is_read: false }],
    ['PUT /api/mail/emails/:id/star', '/api/mail/emails/e/star', { is_starred: true }],
    ['POST /api/mail/emails/bulk-update', '/api/mail/emails/bulk-update', { email_ids: ['e'], is_read: false, is_starred: false }],
    ['POST /api/mail/emails/bulk-delete', '/api/mail/emails/bulk-delete', { email_ids: ['e'] }],
  ]) {
    // Finishes while the simulated sync is still blocked, not after release.
    const result = await routes[route](request(url), 'owner', body);
    assert.equal(result.status, 409);
    assert.match(result.error, /busy.*Nothing was changed.*retry/);
  }
  await assert.rejects(retryWriteback('owner', 'operation'), { status: 409, code: 'MAIL_ACCOUNT_BUSY' });
  const before = calls;
  release(); await blocker; await tick();
  assert.equal(transactions, 0);
  assert.equal(calls, before, 'Rejected requests must not leave deferred callbacks');
});

test('multi-account busy rejection releases earlier locks and applies none of the batch', { timeout: 2000 }, async t => {
  let release;
  const blocker = withMailAccountLock('b', () => new Promise(resolve => { release = resolve; }));
  await tick(); t.after(() => release());
  installDb(t, { execute: async () => [[{ mail_account_id: 'b' }, { mail_account_id: 'a' }]],
    getConnection: async () => assert.fail('Batch must be all-or-nothing') });
  await assert.rejects(mutateMessages('owner', ['one', 'two'], { read: 0 }), { code: 'MAIL_ACCOUNT_BUSY' });
  assert.equal(await withMailAccountLock('a', async () => 'free', { wait: false }), 'free');
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
