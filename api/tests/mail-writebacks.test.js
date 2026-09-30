const test = require('node:test');
const assert = require('node:assert/strict');
const { queueChanges, remoteEligible } = require('../src/services/mail-writebacks');
test('Download, drafts, Legacy and retained missing mail remain local', async () => {
  const email = { id: 'e', user_id: 'u', mail_account_id: 'a', filing_account_id: 'a', sync_mode: 'sync', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9 };
  for (const override of [{ sync_mode: 'download' }, { is_draft: 1 }, { is_legacy: 1 }, { remote_missing: 1 }, { filing_account_id: 'other' }]) {
    const calls = [], row = { ...email, ...override };
    assert.equal(remoteEligible(row), false);
    assert.equal((await queueChanges({ execute: async (...args) => { calls.push(args); return [[]]; } }, 'u', [row], { read: true })).size, 0);
    assert.equal(calls.length, 1); assert.match(calls[0][0], /UPDATE emails SET is_read/);
  }
});
test('queue records explicit new intent, normalizes boolean and does not mark local mail read prematurely', async () => {
  const queries = [], db = { execute: async (sql, args) => { queries.push({ sql, args });
    return sql.includes('SELECT id FROM mail_accounts WHERE id') || sql.includes('SELECT id FROM mail_writebacks WHERE id')
      ? [[{ id: 'account' }]] : [[]]; } };
  await queueChanges(db, 'owner', [{ id: 'email', mail_account_id: 'account', sync_mode: 'sync', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, is_read: 0 }], { read: true });
  assert(queries.some(q => q.sql.includes('INSERT INTO mail_engine_jobs')), 'work is durable in admission transaction');
  const insert = queries.find(q => q.sql.includes('INSERT INTO'));
  assert.equal(insert.args[5], '1'); assert.equal(insert.args[6], '0'); assert.equal(insert.args[1], 'owner');
  assert(!queries.some(q => q.sql.includes('UPDATE emails')));
});
