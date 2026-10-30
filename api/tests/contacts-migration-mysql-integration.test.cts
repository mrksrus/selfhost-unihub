import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Upgrade steps 22 and 23 on a database of 0.25 (step 21) holding the fixed
// 3+3 fields with the data real installations have: empty and whitespace
// slots, gaps, a value repeated in two slots, values at the column limits,
// emoji and right-to-left text, and enough contacts to cross the copy's
// batches. Every value must arrive at its position, verbatim, and nothing
// may be copied twice when step 22 runs again after an interruption.
test('upgrade 22 copies every 3+3 value into contact_values and upgrade 23 drops the fixed columns', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const pool = await withTestDatabase(t, { migrate: false });
  const { runMigrations } = require('../dist/src/services/database-migrations') as typeof import('../src/services/database-migrations');
  const { MIGRATIONS } = require('../dist/src/services/database') as typeof import('../src/services/database');
  const { BASELINE } = require('../dist/src/services/database-baseline') as typeof import('../src/services/database-baseline');
  const { valueKey, nameKey } = require('../dist/src/services/contact-keys') as typeof import('../src/services/contact-keys');
  await runMigrations(pool, MIGRATIONS.filter(step => step.id <= 21), BASELINE);

  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'owner@example.test', 'x'), (?, 'other@example.test', 'x')", [owner, other]);
  const long = (prefix: string, length: number) => prefix + 'x'.repeat(length - prefix.length);
  const cases: FixtureValue[] = [
    { first_name: 'Empty', email: null, email2: '', email3: '   ', phone: '\t', phone2: null, phone3: '' },
    { first_name: 'Gap', email: null, email2: 'second@example.test', email3: null, phone: null, phone2: null, phone3: '+49 30 123' },
    { first_name: 'Same', email: 'same@example.test', email2: 'same@example.test', email3: 'SAME@example.test', phone: '0171 1', phone2: '0171 1', phone3: null },
    { first_name: 'Padded', email: ' padded@example.test ', email2: null, email3: null, phone: ' +1 (555) 0100 ', phone2: null, phone3: null },
    { first_name: long('L', 100), last_name: long('M', 100), email: long('a', 242) + '@example.test', email2: long('b', 255), email3: long('c', 255), phone: '1'.repeat(50), phone2: '2'.repeat(50), phone3: '3'.repeat(50) },
    { first_name: 'Ünïcode 😀', last_name: 'עברית', email: 'emoji😀@example.test', email2: 'אימייל@example.test', email3: null, phone: '٠١٢٣ 123', phone2: null, phone3: null },
    { first_name: '', last_name: null, email: 'nameless@example.test', email2: null, email3: null, phone: null, phone2: null, phone3: null, avatar_url: 'https://example.test/never-filled.png' },
  ];
  const rows: FixtureValue[] = cases.map(item => ({ id: crypto.randomUUID(), user_id: owner, last_name: null, company: 'Example', ...item }));
  // Enough plain contacts to span several copy batches of 500, for two users.
  for (let index = 0; index < 2000; index++) {
    rows.push({ id: crypto.randomUUID(), user_id: index % 4 ? owner : other, first_name: `Person ${index}`, last_name: 'Müller',
      email: `p${index}@example.test`, email2: index % 3 ? null : `alt${index}@example.test`, email3: null,
      phone: index % 2 ? `+43 1 ${index}` : null, phone2: null, phone3: index % 5 ? null : `0${index}` });
  }
  const columns = ['id', 'user_id', 'first_name', 'last_name', 'company', 'email', 'email2', 'email3', 'phone', 'phone2', 'phone3', 'avatar_url'];
  for (let start = 0; start < rows.length; start += 250) {
    await pool.query(`INSERT INTO contacts (${columns.join(', ')}) VALUES ?`, [rows.slice(start, start + 250).map(row => columns.map(column => row[column] ?? null))]);
  }
  const expected = (row: FixtureValue, kind: 'email' | 'phone') => [1, 2, 3].map(slot => row[`${kind}${slot === 1 ? '' : slot}`])
    .filter(value => typeof value === 'string' && value.trim() !== '');

  // An interrupted step 22: the DDL and copy ran, the step was not recorded.
  const step22 = MIGRATIONS.find(step => step.id === 22)!;
  const connection = await pool.getConnection();
  try { await step22.up(connection); } finally { connection.release(); }
  await runMigrations(pool, MIGRATIONS, BASELINE);

  const [history] = await pool.query<RowDataPacket[]>('SELECT id, name FROM schema_migrations WHERE id BETWEEN 22 AND 23 ORDER BY id');
  assert.deepEqual(history.map(row => [row.id, row.name]), [[22, 'contacts-vcard-model'], [23, 'contacts-drop-legacy-columns']]);
  const [fields] = await pool.query<RowDataPacket[]>('SHOW COLUMNS FROM contacts');
  for (const column of ['email', 'email2', 'email3', 'phone', 'phone2', 'phone3', 'avatar_url']) assert.ok(!fields.some(field => field.Field === column), `${column} dropped`);

  const [contacts] = await pool.query<RowDataPacket[]>('SELECT id, user_id, first_name, last_name, uid, uid_hash, version, name_key FROM contacts');
  assert.equal(contacts.length, rows.length);
  const [values] = await pool.query<RowDataPacket[]>('SELECT contact_id, user_id, kind, position, label, custom_label, is_preferred, value, value_key FROM contact_values ORDER BY contact_id, kind, position');
  const byContact = new Map<string, RowDataPacket[]>();
  for (const value of values) byContact.set(value.contact_id, [...(byContact.get(value.contact_id) || []), value]);
  let total = 0;
  for (const row of rows) {
    const stored = contacts.find(contact => contact.id === row.id)!;
    assert.equal(stored.uid, `urn:uuid:${row.id}`);
    assert.equal(stored.uid_hash, crypto.createHash('sha256').update(stored.uid).digest('hex'));
    assert.equal(stored.version, 1);
    assert.equal(stored.name_key, nameKey({ given: row.first_name, family: row.last_name }));
    const copied = byContact.get(row.id) || [];
    for (const kind of ['email', 'phone'] as const) {
      const want = expected(row, kind);
      const got = copied.filter(value => value.kind === kind);
      assert.deepEqual(got.map(value => [value.position, value.value, value.value_key, value.label, value.custom_label, value.is_preferred, value.user_id]),
        want.map((value, position) => [position, value, valueKey(kind, value), '', null, 0, row.user_id]), `${row.first_name} ${kind}`);
      total += want.length;
    }
  }
  assert.equal(values.length, total, 'nothing copied twice after the interrupted run');
  assert.equal(total, rows.reduce((sum, row) => sum + expected(row, 'email').length + expected(row, 'phone').length, 0));
  // The keys the store computes: a repeated slot stays two rows with one key.
  const same = byContact.get(rows[2].id)!;
  assert.deepEqual(same.filter(value => value.kind === 'email').map(value => value.value_key), ['same@example.test', 'same@example.test', 'same@example.test']);
  assert.equal(byContact.get(rows[3].id)!.find(value => value.kind === 'phone')!.value_key, '+15550100');
  assert.equal(contacts.find(contact => contact.id === rows[7 + 1].id)!.name_key, '1 muller person', 'sorted tokens, accents folded');

  // Startup on the upgraded database does nothing more.
  await runMigrations(pool, MIGRATIONS, BASELINE);
  assert.equal((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contact_values'))[0][0].n, total);
  await (require('../dist/src/services/data-inventory') as typeof import('../src/services/data-inventory')).verifyDatabaseInventory(pool);
});
