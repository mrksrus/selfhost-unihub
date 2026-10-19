import type { FixtureValue, RouteTable } from './helpers/test-types.cts';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { setDb, getDb } = require('../dist/src/state') as typeof import('../src/state');
const routes = require('../dist/src/routes/contacts') as RouteTable<typeof import('../src/routes/contacts')>;
const mailRoutes = require('../dist/src/routes/mail-messages') as RouteTable<typeof import('../src/routes/mail-messages')>;

const req = (url: string, params: Record<string, string> = {}) => ({ url, headers: { host: 'localhost' }, params }) as FixtureValue;

test('contact create and update refuse fields that do not fit their columns before any SQL runs', async (t) => {
  const previous = getDb(); t.after(() => setDb(previous));
  const calls: FixtureValue[] = [];
  setDb({ async execute(sql: string, params: FixtureValue) { calls.push({ sql, params }); return /^UPDATE/.test(sql) ? [{ affectedRows: 1 }] : [[{ id: 'c1' }]]; } } as FixtureValue);

  const tooLong = await routes['POST /api/contacts'](req('/api/contacts'), 'u1', { first_name: 'A'.repeat(101) });
  assert.equal(tooLong.status, 400); assert.match(tooLong.error!, /First name is too long/);
  const notText = await routes['POST /api/contacts'](req('/api/contacts'), 'u1', { first_name: 5 } as FixtureValue);
  assert.equal(notText.status, 400); assert.match(notText.error!, /First name must be text/);
  const longPhone = await routes['PUT /api/contacts/:id'](req('/api/contacts/c1', { id: 'c1' }), 'u1', { first_name: 'Ann', phone: '1'.repeat(51) });
  assert.equal(longPhone.status, 400); assert.match(longPhone.error!, /Phone is too long/);
  const blank = await routes['POST /api/contacts'](req('/api/contacts'), 'u1', { first_name: '   ' });
  assert.equal(blank.status, 400); assert.equal(blank.error, 'First name is required');
  assert.equal(calls.length, 0, 'refused input never reaches the database');

  // An imported card without a name has an empty first name; editing it still saves.
  const unnamed = await routes['PUT /api/contacts/:id'](req('/api/contacts/c1', { id: 'c1' }), 'u1', { first_name: '', phone: '+1 555 0100' });
  assert.equal(unnamed.status, undefined);
  assert.match(calls[0].sql, /UPDATE contacts/);
  assert.equal(calls[0].params[0], '');
  calls.length = 0;

  // Boundary values are trimmed and stored; empty optional fields become NULL.
  const ok = await routes['POST /api/contacts'](req('/api/contacts'), 'u1', { first_name: ` ${'B'.repeat(100)} `, last_name: '', email: ' ann@example.com ', notes: 'x'.repeat(65535) });
  assert.equal(ok.status, undefined);
  assert.match(calls[0].sql, /INSERT INTO contacts/);
  assert.equal(calls[0].params[2], 'B'.repeat(100));
  assert.equal(calls[0].params[3], null);
  assert.equal(calls[0].params[4], 'ann@example.com');

  // An email field holds what was typed (a phone or vCard may carry "ann at work"): stored, not refused.
  const loose = await routes['POST /api/contacts'](req('/api/contacts'), 'u1', { first_name: 'Ann', email2: 'ann at work' });
  assert.equal(loose.status, undefined);
  const inserts = calls.filter(call => /INSERT INTO contacts/.test(call.sql));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[1].params[5], 'ann at work');
});

test('updating a contact that belongs to another user answers 404 and changes nothing', async (t) => {
  const previous = getDb(); t.after(() => setDb(previous));
  const rows = [
    { id: 'c-own', user_id: 'u1', first_name: 'Mine' },
    { id: 'c-other', user_id: 'u2', first_name: 'Theirs' },
  ];
  setDb({ async execute(sql: string, params: FixtureValue[]) {
    if (sql.startsWith('UPDATE contacts SET first_name')) {
      const [id, userId] = params.slice(-2);
      const row = rows.find(r => r.id === id && r.user_id === userId);
      if (row) row.first_name = params[0];
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (sql.startsWith('SELECT * FROM contacts WHERE id = ? AND user_id = ?')) return [rows.filter(r => r.id === params[0] && r.user_id === params[1])];
    throw new Error(`unexpected SQL: ${sql}`);
  } } as FixtureValue);

  const foreign = await routes['PUT /api/contacts/:id'](req('/api/contacts/c-other', { id: 'c-other' }), 'u1', { first_name: 'Taken' });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.contact, undefined);
  assert.equal(rows[1].first_name, 'Theirs');

  const own = await routes['PUT /api/contacts/:id'](req('/api/contacts/c-own?x=1', { id: 'c-own' }), 'u1', { first_name: 'Renamed' });
  assert.equal(own.status, undefined);
  assert.equal(own.contact!.first_name, 'Renamed');
});

test('vCard import stores a card with an over-long ORG and NOTE bounded instead of reporting an error', async (t) => {
  const previous = getDb(); t.after(() => setDb(previous));
  const inserts: FixtureValue[] = [];
  setDb({ async execute(sql: string, params: FixtureValue[]) {
    if (sql.startsWith('SELECT email')) return [[]];
    if (sql.startsWith('INSERT INTO contacts')) {
      // The disposable database would answer "Data too long"; the fake refuses the same way.
      if (params[10] !== null && params[10].length > 255) throw Object.assign(new Error('Data too long for column company'), { code: 'ER_DATA_TOO_LONG' });
      inserts.push(params); return [{ affectedRows: 1 }];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  } } as FixtureValue);
  const vcf = ['BEGIN:VCARD', 'VERSION:3.0', 'N:Example;Olga;;;', 'EMAIL:olga@example.com', `ORG:${'O'.repeat(300)}`, `NOTE:${'n'.repeat(70000)}`, 'END:VCARD'].join('\r\n');
  const result = await routes['POST /api/contacts/import'](req('/api/contacts/import'), 'u1', { vcf_data: vcf });
  assert.equal(result.status, undefined);
  assert.equal(result.imported, 1);
  assert.equal(result.errors, undefined);
  assert.equal(inserts[0][10].length, 255);
  assert.equal(Buffer.byteLength(inserts[0][12]), 65535);
  assert.equal(inserts[0][4], 'olga@example.com');
});

test('merge-duplicates writes each group inside its own transaction and reports the counts', async (t) => {
  const previous = getDb(); t.after(() => setDb(previous));
  const contacts = [
    { id: 'a1', first_name: 'Ann', email: 'ann@example.com', created_at: '2024-01-01' },
    { id: 'a2', first_name: 'Ann', email: 'ANN@example.com', phone: '+1 555 0100', created_at: '2024-02-01' },
    { id: 'b1', first_name: 'Bo', phone: '555-0199', created_at: '2024-01-01' },
    { id: 'b2', first_name: 'Bo', phone: '5550199', created_at: '2024-03-01' },
    { id: 'solo', first_name: 'Cy', email: 'cy@example.com' },
  ];
  const log: string[] = [];
  const cx = {
    async beginTransaction() { log.push('begin'); },
    async commit() { log.push('commit'); },
    async rollback() { log.push('rollback'); },
    release() { log.push('release'); },
    async execute(sql: string, params: FixtureValue[]) {
      if (sql.includes('UPDATE contacts')) { log.push(`update ${params[params.length - 2]}`); return [{ affectedRows: 1 }]; }
      if (sql.includes('DELETE FROM contacts')) { log.push(`delete ${params.slice(1).join(',')}`); assert.equal(params[0], 'u1'); return [{ affectedRows: params.length - 1 }]; }
      throw new Error(`unexpected SQL in transaction: ${sql}`);
    },
  };
  setDb({
    async execute(sql: string, params: FixtureValue[]) {
      assert.match(sql, /FROM contacts\s+WHERE user_id = \?/); assert.deepEqual(params, ['u1']);
      log.push('list'); return [contacts];
    },
    async getConnection() { log.push('get'); return cx; },
  } as FixtureValue);

  const result = await routes['POST /api/contacts/merge-duplicates'](req('/api/contacts/merge-duplicates'), 'u1');
  assert.deepEqual({ merged: result.merged, removed: result.removed, groups: result.groups }, { merged: 2, removed: 2, groups: 2 });
  assert.match(result.message!, /Merged 2 duplicate group\(s\), removed 2/);
  // a2 is kept for being more complete, b1 for being older; each group's UPDATE and DELETE sit between one BEGIN and one COMMIT.
  assert.deepEqual(log, ['list',
    'get', 'begin', 'update a2', 'delete a1', 'commit', 'release',
    'get', 'begin', 'update b1', 'delete b2', 'commit', 'release']);
});

test('a literal % or _ in a search term matches itself in contacts and mail search', async (t) => {
  const previous = getDb(); t.after(() => setDb(previous));
  const calls: FixtureValue[] = [];
  setDb({ async execute(sql: string, params: FixtureValue) { calls.push({ sql, params }); return [[]]; } } as FixtureValue);
  await routes['GET /api/contacts'](req('/api/contacts?q=100%25+a%5Cb_c'), 'u1');
  assert.ok(calls[0].params.slice(1).every((value: FixtureValue) => value === '%100\\% a\\\\b\\_c%'));
  calls.length = 0;
  await mailRoutes['GET /api/mail/emails'](req('/api/mail/emails?search=50%25+OFF&include_count=false'), 'u1');
  const list = calls.find(call => /FROM emails/.test(call.sql));
  assert.ok(list, 'mail list query ran');
  assert.ok(list.params.includes('%50\\% off%'), JSON.stringify(list.params));
});
