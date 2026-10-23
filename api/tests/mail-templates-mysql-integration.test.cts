import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const { withTestDatabase } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

test('templates and signatures belong to their person and their account', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 120000,
}, async t => {
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'templates-bootstrap@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'synthetic-templates-bootstrap-password';
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const templates = require('../dist/src/services/mail-templates') as typeof import('../src/services/mail-templates');
  const signatures = require('../dist/src/services/mail-signature') as typeof import('../src/services/mail-signature');

  const owner = crypto.randomUUID(), stranger = crypto.randomUUID();
  await pool.execute("INSERT INTO users (id, email, password_hash) VALUES (?, 'tpl-owner@example.test', 'x'), (?, 'tpl-stranger@example.test', 'x')", [owner, stranger]);
  const ownAccount = crypto.randomUUID();
  await pool.execute(`INSERT INTO mail_accounts (id, user_id, email_address, provider, imap_host, smtp_host, encrypted_password)
    VALUES (?, ?, 'tpl-owner@example.test', 'custom', 'imap.example.test', 'smtp.example.test', 'x')`, [ownAccount, owner]);

  const created = await templates.createTemplate(owner, { name: '  Weekly   report ', subject: 'Report\r\nfor week', body_html: '<p>Numbers</p>', body_text: 'Numbers' });
  assert.equal(created.name, 'Weekly report');
  assert.equal(created.subject, 'Report for week', 'a subject is one line');
  await assert.rejects(templates.createTemplate(owner, { name: 'Weekly report' }), { status: 409 });
  await assert.rejects(templates.createTemplate(owner, { name: '' }), { status: 400 });
  await assert.rejects(templates.createTemplate(owner, { name: 'Huge', body_text: 'x'.repeat(templates.TEMPLATE_TEXT_LIMIT + 1) }), { status: 400 });

  // The stranger sees none of it and cannot change or delete it.
  assert.deepEqual(await templates.listTemplates(stranger), []);
  await assert.rejects(templates.updateTemplate(stranger, created.id, { name: 'Taken over' }), { status: 404 });
  await assert.rejects(templates.deleteTemplate(stranger, created.id), { status: 404 });
  assert.equal((await templates.getTemplate(owner, created.id)).name, 'Weekly report');
  // Names are per person: the stranger may use the same one.
  assert.equal((await templates.createTemplate(stranger, { name: 'Weekly report', body_text: 'Theirs' })).body_text, 'Theirs');

  const plain = await templates.updateTemplate(owner, created.id, { name: 'Weekly report', body_html: null, body_text: 'Plain numbers' });
  assert.deepEqual([plain.body_html, plain.body_text], [null, 'Plain numbers']);
  await templates.deleteTemplate(owner, created.id);
  assert.deepEqual(await templates.listTemplates(owner), []);

  // A signature is saved on the owner's account only; an empty text clears it.
  assert.deepEqual(await signatures.saveSignature(owner, ownAccount, { html: '<p>Ana <b>Example</b></p>', text: 'Ana Example\n' }),
    { id: ownAccount, signature_html: '<p>Ana <b>Example</b></p>', signature_text: 'Ana Example' });
  await assert.rejects(signatures.saveSignature(stranger, ownAccount, { html: '<p>Mine</p>', text: 'Mine' }), { status: 404 });
  await assert.rejects(signatures.saveSignature(owner, ownAccount, { html: 'x'.repeat(signatures.SIGNATURE_HTML_LIMIT + 1), text: 'x' }), { status: 400 });
  const [[stored]] = await pool.query<RowDataPacket[]>('SELECT signature_html, signature_text FROM mail_accounts WHERE id = ?', [ownAccount]);
  assert.deepEqual({ ...stored }, { signature_html: '<p>Ana <b>Example</b></p>', signature_text: 'Ana Example' });
  assert.deepEqual(await signatures.saveSignature(owner, ownAccount, { html: '<p><br></p>', text: '  ' }), { id: ownAccount, signature_html: null, signature_text: null });
});
