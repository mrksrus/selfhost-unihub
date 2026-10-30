import type { FixtureValue } from './helpers/test-types.cts';
import type { RowDataPacket } from 'mysql2/promise';
// Requires an initially empty, disposable MariaDB database ending in _test.
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');
const { withTestDatabase, startTestApi } = require('./helpers/test-database.cts') as import('./helpers/test-database.cts').TestDatabaseHelpers;

// Contact import (preview, decisions, durable commit) and export through the
// real request handler and MariaDB, as the page reaches them: a raw file
// upload, polling, two people, the module switch, a running restore, an
// interrupted commit that resumes, expiry, and re-importing an export (26-08).
test('contacts import and export: preview before writing, decisions, idempotent commit, export and re-import, owner scope, gates and expiry', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-contact-imports-'));
  const previous = { imports: process.env.CONTACT_IMPORTS_ROOT, spool: process.env.UPLOAD_SPOOL_ROOT };
  process.env.CONTACT_IMPORTS_ROOT = path.join(scratch, 'imports');
  process.env.UPLOAD_SPOOL_ROOT = path.join(scratch, 'spool');
  t.after(() => {
    for (const [key, value] of [['CONTACT_IMPORTS_ROOT', previous.imports], ['UPLOAD_SPOOL_ROOT', previous.spool]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const { sweepContactImports } = require('../dist/src/services/contacts-import') as typeof import('../src/services/contacts-import');
  const password = 'synthetic-transfer-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const name of ['owner', 'stranger']) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name]);
  }

  // A client that can send raw bodies and read raw answers (the shared one speaks JSON only).
  async function signIn(name: string) {
    const cookies = new Map<string, string>();
    let csrf = '';
    async function send(method: string, url: string, body?: Buffer | unknown, contentType?: string) {
      const raw = Buffer.isBuffer(body);
      const response = await fetch(`${api.origin}${url}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': contentType || (raw ? 'application/octet-stream' : 'application/json') }),
          ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
          ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
        },
        body: body === undefined ? undefined : raw ? new Uint8Array(body as Buffer) : JSON.stringify(body),
      });
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const at = pair.indexOf('=');
        if (pair.slice(at + 1)) cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const type = response.headers.get('content-type') || '';
      const json = type.includes('application/json') && bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
      if (typeof json?.csrfToken === 'string') csrf = json.csrfToken;
      return { status: response.status, json, bytes, headers: response.headers };
    }
    const reply = await send('POST', '/api/auth/signin', { email: `${name}@example.test`, password });
    assert.equal(reply.status, 200);
    async function call(method: string, url: string, body?: Buffer | unknown, status = 200, contentType?: string): Promise<FixtureValue> {
      const answer = await send(method, url, body, contentType);
      assert.equal(answer.status, status, `${method} ${url}: ${answer.bytes.toString('utf8').slice(0, 400)}`);
      return answer.json;
    }
    return { send, call };
  }
  const owner = await signIn('owner');
  const stranger = await signIn('stranger');
  const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'contacts', name));
  const count = async (userId: string) => Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?', [userId]))[0][0].n);
  const waitFor = async (id: string, client = owner) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const status = await client.call('GET', `/api/contacts/imports/${id}`);
      if (['committed', 'failed', 'expired'].includes(status.state)) return status;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('import did not finish');
  };
  const stagedFiles = () => { try { return fs.readdirSync(path.join(process.env.CONTACT_IMPORTS_ROOT!, users.owner)); } catch { return []; } };

  // ── An existing contact the file overlaps with ──
  const existing = (await owner.call('POST', '/api/contacts', {
    name: { given: 'Jürgen', family: 'Müller' }, job_title: 'Engineer', emails: [{ value: 'juergen@example.com', label: 'work' }], phones: ['+49 30 1111'],
  })).contact;

  // ── Step 1: the preview writes nothing ──
  const summary = await owner.call('POST', '/api/contacts/imports', fixture('vcard40.vcf'), 200, 'text/vcard');
  assert.equal(summary.format, 'vcard4');
  assert.deepEqual(summary.counts, { cards: 2, new: 1, present: 0, duplicates: 1 });
  const [duplicate, fresh] = summary.groups;
  assert.deepEqual([duplicate.match, duplicate.confidence, duplicate.existing_ids, duplicate.default_decision], ['duplicate', 'high', [existing.id], 'merge']);
  assert.deepEqual(duplicate.reasons, [{ kind: 'email', detail: 'juergen@example.com' }]);
  assert.deepEqual(duplicate.conflicts.sort(), ['job_title', 'name'], 'an empty single value is filled, a different one is a conflict');
  assert.equal(duplicate.summaries[0].job_title, 'Chemist', 'the card summary for "Review conflicts"');
  assert.deepEqual([fresh.match, fresh.default_decision, fresh.summaries], ['new', 'add', undefined]);
  assert.deepEqual(summary.sample_names, ['Dr. Jürgen Müller', 'Example Organisation']);
  assert.ok(Date.parse(summary.expires_at) > Date.now() + 23 * 3600 * 1000);
  assert.equal(await count(users.owner), 1, 'nothing written before the commit');
  assert.deepEqual(stagedFiles(), [`${summary.id}.json`]);

  // ── Another person cannot see or commit it ──
  assert.equal((await stranger.call('GET', `/api/contacts/imports/${summary.id}`, undefined, 404)).code, 'IMPORT_NOT_FOUND');
  assert.equal((await stranger.call('POST', `/api/contacts/imports/${summary.id}/commit`, { decisions: [] }, 404)).code, 'IMPORT_NOT_FOUND');
  assert.equal((await owner.call('POST', `/api/contacts/imports/${summary.id}/commit`, { decisions: [{ group_id: 'g99', decision: 'add' }] }, 400)).code, 'INVALID_IMPORT_DECISIONS');

  // ── Step 2: commit the defaults; committing again changes nothing ──
  const started = await owner.call('POST', `/api/contacts/imports/${summary.id}/commit`, { decisions: summary.groups.map((group: FixtureValue) => ({ group_id: group.id, decision: group.default_decision })) });
  assert.ok(['committing', 'committed'].includes(started.state));
  const done = await waitFor(summary.id);
  assert.deepEqual([done.state, done.progress, done.result.added, done.result.merged, done.result.skipped, done.error], ['committed', 1, 1, 1, 0, null]);
  assert.deepEqual(done.result.kept_conflicts.map((item: FixtureValue) => item.field).sort(), ['job_title', 'name']);
  assert.deepEqual(stagedFiles(), [], 'the staged file is removed after the commit');
  const again = await owner.call('POST', `/api/contacts/imports/${summary.id}/commit`, { decisions: [{ group_id: 'g1', decision: 'add' }] });
  assert.equal(again.state, 'committed');
  assert.equal(await count(users.owner), 2, 'commit twice = once');
  const merged = (await owner.call('GET', `/api/contacts/${existing.id}`)).contact;
  assert.equal(merged.job_title, 'Engineer', "UniHub's single value is kept");
  assert.ok(merged.emails.length === 2 && merged.phones.length === 5, 'every value of the card is added');
  assert.ok(merged.properties.some((property: FixtureValue) => property.name === 'X-FOO'), 'kept properties come along');
  const [[alias]] = await pool.query<RowDataPacket[]>('SELECT contact_id FROM contact_uid_aliases WHERE user_id = ? AND uid = ?', [users.owner, 'urn:uuid:6f1d2a3c-0000-4000-8000-000000000001']);
  assert.equal(alias.contact_id, existing.id, 'the card UID finds the contact next time');

  // ── Export: all formats, a selection, owner scope ──
  const vcard = await owner.send('GET', '/api/contacts/export?format=vcard4');
  assert.equal(vcard.status, 200);
  assert.match(vcard.headers.get('content-type')!, /^text\/vcard/);
  assert.match(vcard.headers.get('content-disposition')!, /filename="?contacts\.vcf/);
  assert.equal(vcard.bytes.toString('utf8').match(/BEGIN:VCARD/g)!.length, 2);
  for (const [format, type] of [['vcard3', /^text\/vcard/], ['google-csv', /^text\/csv/], ['outlook-csv', /^text\/csv/]] as const) {
    const answer = await owner.send('GET', `/api/contacts/export?format=${format}`);
    assert.equal(answer.status, 200, format);
    assert.match(answer.headers.get('content-type')!, type);
  }
  assert.equal((await owner.call('GET', '/api/contacts/export?format=pdf', undefined, 400)).code, 'INVALID_EXPORT_FORMAT');
  const strangerContact = (await stranger.call('POST', '/api/contacts', { name: { given: 'Stranger' }, emails: ['stranger.contact@example.test'] })).contact;
  const selection = await owner.send('POST', '/api/contacts/export', { ids: [existing.id, strangerContact.id], format: 'vcard3' });
  assert.equal(selection.status, 200);
  const selected = selection.bytes.toString('utf8');
  assert.equal(selected.match(/BEGIN:VCARD/g)!.length, 1);
  assert.doesNotMatch(selected, /Stranger/, "another person's id is left out");
  assert.equal((await stranger.call('POST', '/api/contacts/export', { ids: [existing.id], format: 'vcard4' }, 404)).code, 'NO_CONTACTS');

  // ── Re-importing the export adds nothing (26-08) ──
  const reimport = await owner.call('POST', '/api/contacts/imports', vcard.bytes, 200, 'text/vcard');
  assert.deepEqual(reimport.counts, { cards: 2, new: 0, present: 2, duplicates: 0 });
  assert.deepEqual(reimport.groups.map((group: FixtureValue) => [group.match, group.default_decision]), [['identical', 'skip'], ['identical', 'skip']]);
  await owner.call('POST', `/api/contacts/imports/${reimport.id}/commit`, { decisions: [] });
  const reimported = await waitFor(reimport.id);
  assert.deepEqual([reimported.result.added, reimported.result.merged, reimported.result.skipped], [0, 0, 2]);
  assert.equal(await count(users.owner), 2);
  // Merging an identical card changes nothing either.
  const remerge = await owner.call('POST', '/api/contacts/imports', vcard.bytes, 200, 'text/vcard');
  await owner.call('POST', `/api/contacts/imports/${remerge.id}/commit`, { decisions: remerge.groups.map((group: FixtureValue) => ({ group_id: group.id, decision: 'merge' })) });
  assert.equal((await waitFor(remerge.id)).state, 'committed');
  const unchanged = (await owner.call('GET', `/api/contacts/${existing.id}`)).contact;
  assert.deepEqual([unchanged.emails, unchanged.phones, unchanged.kept_properties], [merged.emails, merged.phones, merged.kept_properties]);

  // ── CSV imports go the same way ──
  const google = await owner.call('POST', '/api/contacts/imports', fixture('google.csv'), 200, 'text/csv');
  assert.deepEqual([google.format, google.counts.cards], ['google-csv', 2]);
  await owner.call('POST', `/api/contacts/imports/${google.id}/commit`, {});
  assert.equal((await waitFor(google.id)).result.added, 2);
  const zoe = (await owner.call('GET', '/api/contacts?q=zoe%40example.com')).contacts[0];
  assert.deepEqual([zoe.is_favorite, zoe.categories, zoe.emails[0].preferred], [true, ['Friends'], true]);

  // ── Refusals at the door ──
  assert.equal((await owner.call('POST', '/api/contacts/imports', Buffer.from('%PDF-1.7 synthetic'), 400)).code, 'IMPORT_UNSUPPORTED');
  assert.equal((await owner.call('POST', '/api/contacts/imports', Buffer.from('BEGIN:VCARD\r\nVERSION:4.0\r\nX-ONLY:x\r\nEND:VCARD\r\n'), 400)).code, 'IMPORT_EMPTY');
  await owner.call('PUT', '/api/modules', { modules: { contacts: { enabled: false } } });
  assert.equal((await owner.call('POST', '/api/contacts/imports', fixture('google.csv'), 403)).code, 'MODULE_DISABLED');
  assert.equal((await owner.call('GET', '/api/contacts/export', undefined, 403)).code, 'MODULE_DISABLED');
  await owner.call('PUT', '/api/modules', { modules: { contacts: { enabled: true } } });
  const restoreId = crypto.randomUUID();
  await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '[\"contacts\"]')", [restoreId, users.owner]);
  assert.equal((await owner.call('POST', '/api/contacts/imports', fixture('google.csv'), 409)).code, 'RESTORE_IN_PROGRESS');
  await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);

  // ── A restore that starts after the commit was accepted stops it before the next chunk ──
  const later = await owner.call('POST', '/api/contacts/imports', fixture('outlook-en.csv'), 200, 'text/csv');
  await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '[\"contacts\"]')", [restoreId, users.owner]);
  await pool.execute("UPDATE contact_imports SET status = 'committing', result = ? WHERE id = ?",
    [JSON.stringify({ decisions: { g1: 'add' }, next: 0, added: 0, merged: 0, skipped: 0, kept_conflicts: [], warnings: [] }), later.id]);
  const stopped = await waitFor(later.id);
  assert.deepEqual([stopped.state, stopped.error.code, stopped.result.added], ['failed', 'RESTORE_IN_PROGRESS', 0]);
  await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);
  await owner.call('POST', `/api/contacts/imports/${later.id}/commit`, {});
  assert.deepEqual([(await waitFor(later.id)).state, (await waitFor(later.id)).result.added], ['committed', 1], 'committing again resumes');

  // ── An interrupted chunk is rolled back whole and resumes without duplicates ──
  const cards = Array.from({ length: 450 }, (_, at) => `BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Bulk ${at}\r\nN:Card${at};Bulk;;;\r\nEMAIL:bulk${at}@example.test\r\nEND:VCARD\r\n`).join('');
  const bulk = await owner.call('POST', '/api/contacts/imports', Buffer.from(cards), 200, 'text/vcard');
  assert.equal(bulk.counts.new, 450);
  const before = await count(users.owner);
  await pool.query("CREATE TRIGGER contact_import_test_fail BEFORE INSERT ON contacts FOR EACH ROW BEGIN IF NEW.last_name = 'Card300' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic failure'; END IF; END");
  try {
    await owner.call('POST', `/api/contacts/imports/${bulk.id}/commit`, {});
    const failed = await waitFor(bulk.id);
    assert.deepEqual([failed.state, failed.error.code, failed.result.added], ['failed', 'IMPORT_FAILED', 200], 'the first chunk stays, the failing one rolled back whole');
    assert.equal(await count(users.owner), before + 200);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS contact_import_test_fail');
  }
  await owner.call('POST', `/api/contacts/imports/${bulk.id}/commit`, {});
  const resumed = await waitFor(bulk.id);
  assert.deepEqual([resumed.state, resumed.result.added], ['committed', 450]);
  assert.equal(await count(users.owner), before + 450);
  const [[distinct]] = await pool.query<RowDataPacket[]>("SELECT COUNT(DISTINCT last_name) AS n, COUNT(*) AS total FROM contacts WHERE user_id = ? AND first_name = 'Bulk'", [users.owner]);
  assert.deepEqual([Number(distinct.n), Number(distinct.total)], [450, 450], 'every card exactly once');

  // ── A merge target deleted after the preview: the card is added ──
  const target = (await owner.call('POST', '/api/contacts', { name: { given: 'Gone', family: 'Soon' }, emails: ['gone@example.test'] })).contact;
  const gone = await owner.call('POST', '/api/contacts/imports', Buffer.from('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Gone Soon\r\nN:Soon;Gone;;;\r\nEMAIL:gone@example.test\r\nTEL:+1 555 0177\r\nEND:VCARD\r\n'), 200);
  assert.equal(gone.groups[0].default_decision, 'merge');
  await owner.call('DELETE', `/api/contacts/${target.id}`);
  await owner.call('POST', `/api/contacts/imports/${gone.id}/commit`, {});
  const goneDone = await waitFor(gone.id);
  assert.deepEqual([goneDone.result.added, goneDone.result.warnings.map((warning: FixtureValue) => warning.code)], [1, ['MERGE_TARGET_GONE']]);

  // ── Expiry: an old staged import is refused, then swept with its file ──
  const stale = await owner.call('POST', '/api/contacts/imports', fixture('google-old.csv'), 200);
  await pool.execute('UPDATE contact_imports SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?', [stale.id]);
  assert.equal((await owner.call('GET', `/api/contacts/imports/${stale.id}`)).state, 'expired');
  assert.equal((await owner.call('POST', `/api/contacts/imports/${stale.id}/commit`, {}, 410)).code, 'IMPORT_EXPIRED');
  assert.ok(stagedFiles().includes(`${stale.id}.json`));
  const orphan = path.join(process.env.CONTACT_IMPORTS_ROOT!, users.owner, `${crypto.randomUUID()}.json`);
  fs.writeFileSync(orphan, '{}');
  fs.utimesSync(orphan, new Date(Date.now() - 48 * 3600 * 1000), new Date(Date.now() - 48 * 3600 * 1000));
  const swept = await sweepContactImports();
  assert.ok(swept.expired >= 1 && swept.orphans === 1);
  assert.ok(!stagedFiles().includes(`${stale.id}.json`) && !fs.existsSync(orphan));
  await owner.call('GET', `/api/contacts/imports/${stale.id}`, undefined, 404);
  const [[left]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM contact_imports WHERE status = 'staged' AND expires_at < UTC_TIMESTAMP()");
  assert.equal(Number(left.n), 0);
});
