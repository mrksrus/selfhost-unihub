import type { FixtureValue } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');

process.env.ENCRYPTION_KEY ||= 'backup-account-policy-test-key';
const { encrypt } = require('../dist/src/security/encryption');
const { setDb, getDb } = require('../dist/src/state');
const { importBackupForUser } = require('../dist/src/services/backup');

test('restore applies connection policy before activating account settings', async (t) => {
  const previousDb = getDb();
  t.after(() => setDb(previousDb));
  const writes: FixtureValue[] = [];
  const storedAccounts = new Map();
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async execute(sql: string, params: FixtureValue[] = []) {
      assert.equal(params.length, (sql.match(/\?/g) || []).length);
      if (/^(INSERT|UPDATE)/.test(sql)) writes.push({ sql, params });
      const accountInsert = sql.match(/^INSERT INTO calendar_accounts \((.*?)\) VALUES/);
      if (accountInsert) {
        const columns = accountInsert[1].replaceAll('`', '').split(', ');
        const account = Object.fromEntries(columns.map((column: string, index: number) => [column, params[index]]));
        storedAccounts.set(account.id, account);
      }
      if (sql.startsWith('SELECT provider, discovery_url, base_url, provider_config FROM calendar_accounts')) {
        const account = storedAccounts.get(params[0]);
        return [account?.user_id === params[1] ? [account] : []];
      }
      return [[]];
    },
  };
  setDb({ execute: (...args: Parameters<typeof connection.execute>) => connection.execute(...args), getConnection: async () => connection });

  await t.test('private mail settings remain inactive even with usable restored credentials', async () => {
    writes.length = 0;
    const result = await importBackupForUser('owner', { app: 'unihub', version: 1, files: [], data: {
      mail_accounts: [{ id: 'mail', email_address: 'mail@example.test', imap_host: '127.0.0.1', smtp_host: '127.0.0.1', encrypted_password: encrypt('synthetic-password'), is_active: true }],
    } }, { mode: 'apply', credentials_mode: 'restore' });
    assert.equal(result.valid, true);
    assert.match(result.warnings.join(' '), /inactive/);
    const write = writes.find(item => item.sql.startsWith('INSERT INTO mail_accounts'));
    assert.ok(write.params[10], 'The credential exists, so inactivity comes from host policy');
    assert.equal(write.params[15], 0);
  });

  for (const [name, fields, active] of [
    ['private CalDAV host', { provider: 'caldav', discovery_url: 'https://127.0.0.1/calendar/' }, 0],
    ['HTTP CalDAV URL', { provider: 'caldav', discovery_url: 'http://8.8.8.8/calendar/' }, 0],
    ['cross-origin CalDAV base URL', { provider: 'caldav', discovery_url: 'https://8.8.8.8/discovery/', base_url: 'https://9.9.9.9/calendar/' }, 0],
    ['same-origin public CalDAV URLs', { provider: 'caldav', discovery_url: 'https://8.8.8.8/discovery/', base_url: 'https://8.8.8.8/calendar/' }, 1],
    ['legacy local account without an explicit provider', {}, 1],
  ] as const) {
    await t.test(name, async () => {
      writes.length = 0;
      const result = await importBackupForUser('owner', { app: 'unihub', version: 1, files: [], data: {
        calendar_accounts: [{ id: 'calendar-account', ...fields, encrypted_password: encrypt('synthetic-password'), is_active: true }],
      } }, { mode: 'apply', credentials_mode: 'restore' });
      assert.equal(result.valid, true);
      const account = [...storedAccounts.values()].at(-1);
      assert.equal(account.is_active, active);
      assert.equal(result.warnings.some((warning: FixtureValue) => warning.includes('inactive')), !active);
    });
  }

  await t.test('cross-origin calendar collection URLs disable the owning restored account', async () => {
    writes.length = 0;
    const result = await importBackupForUser('owner', { app: 'unihub', version: 1, files: [], data: {
      calendar_accounts: [{ id: 'calendar-account', provider: 'caldav', discovery_url: 'https://8.8.8.8/discovery/', base_url: 'https://8.8.8.8/calendar/', encrypted_password: encrypt('synthetic-password'), is_active: true }],
      calendar_calendars: [{ id: 'calendar', account_id: 'calendar-account', name: 'Calendar', external_id: 'https://9.9.9.9/collection/' }],
    } }, { mode: 'apply', credentials_mode: 'restore' });
    assert.equal(result.valid, true);
    assert.match(result.warnings.join(' '), /inactive.*different server origin/);
    const account = [...storedAccounts.values()].at(-1);
    const disabled = writes.find(item => item.sql.startsWith('UPDATE calendar_accounts SET is_active = FALSE'));
    assert.deepEqual(disabled.params, [account.id, 'owner']);
    assert.match(disabled.sql, /WHERE id = \? AND user_id = \?/);
  });
});
