import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { queueChanges, remoteEligible } = require('../dist/src/services/mail-writebacks') as typeof import('../src/services/mail-writebacks');
test('Download, drafts, Legacy and retained missing mail remain local', async () => {
  const email = { id: 'e', user_id: 'u', mail_account_id: 'a', filing_account_id: 'a', sync_mode: 'sync', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9 };
  for (const override of [{ sync_mode: 'download' }, { is_draft: 1 }, { is_legacy: 1 }, { remote_missing: 1 }, { filing_account_id: 'other' }]) {
    const calls: FixtureValue[] = [], row = { ...email, ...override };
    assert.equal(remoteEligible(row as FixtureValue), false);
    assert.equal((await queueChanges({ execute: (async (...args: FixtureValue[]) => { calls.push(args); return [[]]; }) } as FixtureValue, 'u', [(row as FixtureValue)], { read: true })).size, 0);
    assert.equal(calls.length, 1); assert.match(calls[0][0], /UPDATE emails SET is_read/);
  }
});
test('queue records explicit new intent, normalizes boolean and does not mark local mail read prematurely', async () => {
  const queries: FixtureValue[] = [], db = { execute: async (sql: string, args: FixtureValue) => { queries.push({ sql, args });
    return sql.includes('SELECT id FROM mail_accounts WHERE id') || sql.includes('SELECT id FROM mail_writebacks WHERE id')
      ? [[{ id: 'account' }]] : [[]]; } };
  await queueChanges(db as FixtureValue, 'owner', [({ id: 'email', mail_account_id: 'account', sync_mode: 'sync', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, is_read: 0 } as FixtureValue)], { read: true });
  assert(queries.some(q => q.sql.includes('INSERT INTO mail_engine_jobs')), 'work is durable in admission transaction');
  const insert = queries.find(q => q.sql.includes('INSERT INTO'));
  assert.equal(insert.args[5], '1'); assert.equal(insert.args[6], '0'); assert.equal(insert.args[1], 'owner');
  assert(!queries.some(q => q.sql.includes('UPDATE emails')));
});
test('Sync items without any provider link change locally; damaged links refuse the request with a count', async () => {
  const linked = { id: 'linked', mail_account_id: 'account', sync_mode: 'sync', remote_folder: 'INBOX', remote_uid: 12, remote_uidvalidity: 9, is_read: 0 };
  const unlinked = { id: 'unlinked', mail_account_id: 'account', sync_mode: 'sync', remote_folder: null, remote_uid: null, remote_uidvalidity: null, is_read: 0 };
  const run = async (emails: FixtureValue, changes: FixtureValue, occurrenceFor = new Set<FixtureValue>()) => {
    const queries: FixtureValue[] = [], db = { execute: async (sql: string, args: FixtureValue) => { queries.push({ sql, args });
      if (sql.includes('FROM mail_remote_occurrences')) return [occurrenceFor.has(args[2]) ? [{ id: 'o' }] : []];
      return sql.includes('SELECT id FROM mail_accounts WHERE id') || sql.includes('SELECT id FROM mail_writebacks WHERE id')
        ? [[{ id: 'account' }]] : [[]]; } };
    await queueChanges(db as FixtureValue, 'owner', emails, changes);
    return queries;
  };
  const sent = await run([unlinked], { star: true });
  assert.equal(sent.filter(q => q.sql.includes('UPDATE emails SET is_starred')).length, 1);
  assert(!sent.some(q => q.sql.includes('INSERT INTO')));
  const mixed = await run([linked, unlinked], { read: true });
  const updates = mixed.filter(q => q.sql.includes('UPDATE emails SET is_read'));
  assert.deepEqual(updates.map(q => q.args[1]), ['unlinked']);
  assert(mixed.some(q => q.sql.includes('INSERT INTO mail_writebacks') && q.args.includes('linked')));
  await assert.rejects(run([unlinked], { read: true }, new Set<FixtureValue>(['unlinked'])), /This message's link to the mail server is damaged/);
  const partial = { ...unlinked, id: 'partial', remote_folder: 'INBOX' };
  await assert.rejects(run([partial, { ...partial, id: 'partial2' }, linked], { read: true }), /^Error: 2 selected messages have a damaged link/);
});
