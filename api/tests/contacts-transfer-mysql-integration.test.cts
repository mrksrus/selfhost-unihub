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

// A client that can send raw bodies and read raw answers (the shared one speaks JSON only).
async function rawSession(origin: string, email: string, password: string) {
  const cookies = new Map<string, string>();
  let csrf = '';
  async function send(method: string, url: string, body?: Buffer | unknown, contentType?: string) {
    const raw = Buffer.isBuffer(body);
    const response = await fetch(`${origin}${url}`, {
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
  const reply = await send('POST', '/api/auth/signin', { email, password });
  assert.equal(reply.status, 200);
  async function call(method: string, url: string, body?: Buffer | unknown, status = 200, contentType?: string): Promise<FixtureValue> {
    const answer = await send(method, url, body, contentType);
    assert.equal(answer.status, status, `${method} ${url}: ${answer.bytes.toString('utf8').slice(0, 400)}`);
    return answer.json;
  }
  return { send, call };
}

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

  const signIn = (name: string) => rawSession(api.origin, `${name}@example.test`, password);
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
  // The name parts the contact lacks (prefix, middle, suffix, display name) fill in; a different title is a conflict.
  assert.deepEqual(duplicate.conflicts, ['job_title'], 'an empty single value is filled, a different one is a conflict');
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
  assert.deepEqual(done.result.kept_conflicts.map((item: FixtureValue) => item.field), ['job_title']);
  assert.deepEqual(stagedFiles(), [], 'the staged file is removed after the commit');
  const again = await owner.call('POST', `/api/contacts/imports/${summary.id}/commit`, { decisions: [{ group_id: 'g1', decision: 'add' }] });
  assert.equal(again.state, 'committed');
  assert.equal(await count(users.owner), 2, 'commit twice = once');
  const merged = (await owner.call('GET', `/api/contacts/${existing.id}`)).contact;
  assert.equal(merged.job_title, 'Engineer', "UniHub's single value is kept");
  assert.deepEqual([merged.name.given, merged.name.family, merged.name.prefix, merged.name.display], ['Jürgen', 'Müller', 'Dr.', 'Dr. Jürgen Müller'], 'missing name parts are filled');
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

// The seams between import, photos, merges and the background sweeps: an
// inline photo becomes the stored photo and is exported again; an import's
// merge is a merge like any other (the card in the bin, undoable); the photo
// sweep keeps what an undo needs and removes orphans; a merge past 100 values
// of a kind is refused, by hand, by "Merge all" and by an import.
test('contacts import, photos and merges: inline photos stored and exported, import merges undoable, sweeps, 100 values per kind', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const sharp = require('sharp') as typeof import('sharp').default;
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-contact-seams-'));
  const previous = { imports: process.env.CONTACT_IMPORTS_ROOT, photos: process.env.CONTACT_PHOTOS_ROOT, spool: process.env.UPLOAD_SPOOL_ROOT };
  process.env.CONTACT_IMPORTS_ROOT = path.join(scratch, 'imports');
  process.env.CONTACT_PHOTOS_ROOT = path.join(scratch, 'photos');
  process.env.UPLOAD_SPOOL_ROOT = path.join(scratch, 'spool');
  t.after(() => {
    for (const [key, value] of [['CONTACT_IMPORTS_ROOT', previous.imports], ['CONTACT_PHOTOS_ROOT', previous.photos], ['UPLOAD_SPOOL_ROOT', previous.spool]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const { sweepContactPhotos } = require('../dist/src/services/contact-photos') as typeof import('../src/services/contact-photos');
  const { photosHeldForUndo } = require('../dist/src/services/contact-merge') as typeof import('../src/services/contact-merge');
  const { isModuleEnabled } = require('../dist/src/services/module-settings') as typeof import('../src/services/module-settings');
  const password = 'synthetic-seams-password';
  const userId = crypto.randomUUID();
  await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)',
    [userId, 'seams@example.test', await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4), 'Seams']);
  const owner = await rawSession(api.origin, 'seams@example.test', password);
  const waitFor = async (id: string) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const status = await owner.call('GET', `/api/contacts/imports/${id}`);
      if (['committed', 'failed', 'expired'].includes(status.state)) return status;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('import did not finish');
  };
  const importFile = async (text: string, decisions?: FixtureValue[]) => {
    const summary = await owner.call('POST', '/api/contacts/imports', Buffer.from(text), 200, 'text/vcard');
    await owner.call('POST', `/api/contacts/imports/${summary.id}/commit`, decisions ? { decisions } : {});
    return { summary, done: await waitFor(summary.id) };
  };
  const count = async () => Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?', [userId]))[0][0].n);
  const photoDir = () => path.join(process.env.CONTACT_PHOTOS_ROOT!, userId);
  const photoFiles = () => (fs.existsSync(photoDir()) ? fs.readdirSync(photoDir()).sort() : []);
  const age = () => { const old = (Date.now() - 2 * 3600 * 1000) / 1000; for (const name of photoFiles()) fs.utimesSync(path.join(photoDir(), name), old, old); };
  // The background job's own options (background-work.ts).
  const sweep = () => sweepContactPhotos({ moduleEnabled: id => isModuleEnabled(id, 'contacts'), heldForUndo: id => photosHeldForUndo(id) });
  const byName = async (q: string) => (await owner.call('GET', `/api/contacts?q=${encodeURIComponent(q)}`)).contacts as FixtureValue[];

  const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#c03020' } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 300, height: 400, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 0.5 } } }).png().toBuffer();
  const rosaJpeg = await sharp({ create: { width: 640, height: 640, channels: 3, background: '#30a050' } }).jpeg().toBuffer();

  // ── An existing contact with its own photo ──
  const rosa = (await owner.call('POST', '/api/contacts', { name: { given: 'Rosa', family: 'Example' }, emails: ['rosa@example.test'], phones: ['+1 555 0101'] })).contact;
  const rosaPhoto = (await owner.call('PUT', `/api/contacts/${rosa.id}/photo`, rosaJpeg, 200, 'image/jpeg')).contact.photo;
  const rosaBefore = (await owner.call('GET', `/api/contacts/${rosa.id}`)).contact;

  // ── Import: a PNG in 4.0, a JPEG in 3.0 (ENCODING=b), an unreadable picture ──
  const file = [
    `BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Rosa Example\r\nN:Example;Rosa;;;\r\nEMAIL:rosa@example.test\r\nTEL:+1 555 0199\r\nPHOTO:data:image/png;base64,${png.toString('base64')}\r\nEND:VCARD\r\n`,
    `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Paul Photo\r\nN:Photo;Paul;;;\r\nEMAIL:paul@example.test\r\nPHOTO;ENCODING=b;TYPE=JPEG:${jpeg.toString('base64')}\r\nEND:VCARD\r\n`,
    `BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Una Readable\r\nN:Readable;Una;;;\r\nEMAIL:una@example.test\r\nPHOTO:data:image/png;base64,${Buffer.from('synthetic, not a picture').toString('base64')}\r\nEND:VCARD\r\n`,
  ].join('');
  const { summary, done } = await importFile(file);
  assert.deepEqual(summary.groups.map((group: FixtureValue) => [group.match, group.default_decision]), [['duplicate', 'merge'], ['new', 'add'], ['new', 'add']]);
  assert.deepEqual(summary.groups[0].conflicts, ['photo'], 'the card\'s photo differs from the stored one');
  assert.equal(summary.groups[0].summaries[0].has_photo, true);
  assert.deepEqual([done.state, done.result.added, done.result.merged], ['committed', 2, 1]);
  assert.deepEqual(done.result.warnings.map((warning: FixtureValue) => [warning.card, warning.property, warning.code]), [[3, 'PHOTO', 'PHOTO_UNREADABLE']]);
  assert.doesNotMatch(JSON.stringify(done.result.warnings), /synthetic, not a picture|c3ludGhldGlj/, 'a warning names the card, never the value');
  assert.deepEqual(done.result.kept_conflicts, [{ contact_id: rosa.id, field: 'photo' }]);

  // The JPEG card's photo is stored and served as a square JPEG of at most 512 pixels.
  const [paul] = await byName('Paul');
  assert.ok(paul.photo, 'Paul has a photo');
  const served = await owner.send('GET', `/api/contacts/${paul.id}/photo`);
  assert.deepEqual([served.status, served.headers.get('content-type'), served.headers.get('etag')], [200, 'image/jpeg', `"${paul.photo.etag}"`]);
  const meta = await sharp(served.bytes).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 512, 512]);
  // The unreadable picture: the contact is there without a photo; the PHOTO is kept as it was in the file.
  const [una] = await byName('Una');
  assert.equal(una.photo, null);
  assert.deepEqual((await owner.call('GET', `/api/contacts/${una.id}`)).contact.properties.map((property: FixtureValue) => property.name), ['PHOTO']);
  // The merge kept Rosa's own photo and added the card's number.
  const rosaMerged = (await owner.call('GET', `/api/contacts/${rosa.id}`)).contact;
  assert.deepEqual([rosaMerged.photo.etag, rosaMerged.phones.map((phone: FixtureValue) => phone.value)], [rosaPhoto.etag, ['+1 555 0101', '+1 555 0199']]);
  assert.equal(await count(), 3);

  // ── Export carries the stored photos ──
  const v4 = (await owner.send('GET', '/api/contacts/export?format=vcard4')).bytes.toString('utf8');
  const unfold = (text: string) => text.replace(/\r\n[ \t]/g, '');
  const cardOf = (text: string, name: string) => unfold(text).split('END:VCARD').find(card => card.includes(`FN:${name}`))!;
  for (const name of ['Paul Photo', 'Rosa Example']) assert.match(cardOf(v4, name), /\r\nPHOTO:data:image\/jpeg;base64,\/9j\//, `${name} in 4.0`);
  assert.equal(cardOf(v4, 'Paul Photo').match(/\r\nPHOTO[:;]/g)!.length, 1);
  assert.match(cardOf(v4, 'Una Readable'), /\r\nPHOTO.*:data:image\/png;base64,/, 'the unreadable picture goes out as it came');
  const v3 = (await owner.send('GET', '/api/contacts/export?format=vcard3')).bytes.toString('utf8');
  assert.match(cardOf(v3, 'Paul Photo'), /\r\nPHOTO;ENCODING=b;TYPE=JPEG:\/9j\//);
  const exportedPhoto = Buffer.from(/\r\nPHOTO:data:image\/jpeg;base64,([^\r]+)/.exec(cardOf(v4, 'Paul Photo'))![1], 'base64');
  assert.equal(crypto.createHash('sha256').update(exportedPhoto).digest('hex'), paul.photo.etag, 'the stored bytes, as served');

  // ── The import's merge is in "Recently merged", its card in the bin with its photo ──
  const { merges } = await owner.call('GET', '/api/contacts/merges');
  assert.equal(merges.length, 1);
  assert.deepEqual([merges[0].survivor_id, merges[0].merged.map((item: FixtureValue) => item.display_name)], [rosa.id, ['Rosa Example']]);
  const [[binned]] = await pool.query<RowDataPacket[]>("SELECT file_refs FROM bin_items WHERE user_id = ? AND reason = 'merged'", [userId]);
  const cardPhoto = (typeof binned.file_refs === 'string' ? JSON.parse(binned.file_refs) : binned.file_refs) as string[];
  assert.equal(cardPhoto.length, 2, 'the card\'s photo and thumbnail wait in the bin');

  // ── The photo sweep: keeps what rows and the undo need, removes an orphan; skips a module that is off ──
  const orphan = path.join(photoDir(), `${'e'.repeat(64)}.jpg`);
  fs.writeFileSync(orphan, 'synthetic');
  age();
  const beforeSweep = photoFiles();
  await owner.call('PUT', '/api/modules', { modules: { contacts: { enabled: false } } });
  assert.equal(await sweep(), 0, 'the Contacts module is off: nothing is swept');
  await owner.call('PUT', '/api/modules', { modules: { contacts: { enabled: true } } });
  assert.equal(await sweep(), 1);
  assert.deepEqual(photoFiles(), beforeSweep.filter(name => name !== path.basename(orphan)), 'only the orphan went');
  for (const sha of cardPhoto) assert.ok(photoFiles().includes(`${sha}.jpg`), 'the merged-away card\'s photo stays for the undo');

  // ── Undo the import's merge: Rosa as before, the card back as its own contact with its photo ──
  const undone = await owner.call('POST', `/api/contacts/merges/${merges[0].id}/undo`);
  assert.equal(undone.survivor_restored, true);
  const rosaAfter = (await owner.call('GET', `/api/contacts/${rosa.id}`)).contact;
  assert.deepEqual([rosaAfter.phones, rosaAfter.emails, rosaAfter.photo], [rosaBefore.phones, rosaBefore.emails, rosaBefore.photo]);
  const [card] = undone.restored_ids;
  const restored = (await owner.call('GET', `/api/contacts/${card}`)).contact;
  assert.deepEqual([restored.display_name, restored.phones.map((phone: FixtureValue) => phone.value), restored.photo.etag], ['Rosa Example', ['+1 555 0199'], cardPhoto[0]]);
  assert.equal((await owner.send('GET', `/api/contacts/${card}/photo?size=thumb`)).status, 200);
  assert.equal(await count(), 4);
  age();
  assert.equal(await sweep(), 0, 'every file is a contact\'s photo again');

  // ── Vertical groups: a merge never ties one card's label to another card's value ──
  const gina = await importFile([
    'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Gina Group\r\nN:Group;Gina;;;\r\nitem1.EMAIL:gina.club@example.test\r\nitem1.X-ABLabel:Club\r\nEND:VCARD\r\n',
    'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Gina Group\r\nN:Group;Gina;;;\r\nitem1.EMAIL:gina.gym@example.test\r\nitem1.X-ABLabel:Gym\r\nEND:VCARD\r\n',
  ].join(''), []);
  assert.equal(gina.done.result.added, 2, 'the same name alone is not merged by default');
  const ginas = await byName('Gina');
  await owner.call('POST', '/api/contacts/merges', { contact_ids: ginas.map((item: FixtureValue) => item.id), versions: Object.fromEntries(ginas.map((item: FixtureValue) => [item.id, item.version])) });
  const ginaCard = unfold((await owner.send('GET', '/api/contacts/export?format=vcard3')).bytes.toString('utf8')).split('END:VCARD').find(text => text.includes('FN:Gina Group'))!;
  const lines = ginaCard.split('\r\n').filter(line => /^item/i.test(line));
  const groupOfLine = (pattern: RegExp) => lines.find(line => pattern.test(line))!.split('.')[0];
  assert.equal(groupOfLine(/EMAIL.*gina\.club/), groupOfLine(/X-ABLabel:Club/));
  assert.equal(groupOfLine(/EMAIL.*gina\.gym/), groupOfLine(/X-ABLabel:Gym/));
  assert.notEqual(groupOfLine(/X-ABLabel:Club/), groupOfLine(/X-ABLabel:Gym/), 'two groups, one label each');

  // ── 100 values of a kind: a merge past it is refused by hand, by Merge all and by an import ──
  const emails = (prefix: string, from: number, to: number) => Array.from({ length: to - from }, (_, at) => `${prefix}${from + at}@example.test`);
  const full = (await owner.call('POST', '/api/contacts', { name: { given: 'Mira', family: 'Many' }, emails: emails('mira', 0, 100) })).contact;
  const more = (await owner.call('POST', '/api/contacts', { name: { given: 'Mira', family: 'Many' }, emails: ['mira0@example.test', 'mira100@example.test'] })).contact;
  const refused = await owner.call('POST', '/api/contacts/merges', { contact_ids: [full.id, more.id], versions: { [full.id]: full.version, [more.id]: more.version } }, 400);
  assert.deepEqual([refused.code, refused.details], ['TOO_MANY_VALUES', { kinds: ['email'], kept_properties: false }]);
  assert.match(refused.error, /more than 100 email addresses/);
  const group = ((await owner.call('GET', '/api/contacts/duplicates?min=high')).groups as FixtureValue[]).find(item => item.members.some((member: FixtureValue) => member.id === full.id));
  assert.equal(group.auto_merge, true, 'same name, same email, nothing to choose');
  assert.deepEqual((await owner.call('POST', '/api/contacts/merges/auto', { group_ids: [group.id], min: 'high' })).results, [{ group_id: group.id, status: 'too_many_values' }]);
  assert.equal((await owner.call('GET', `/api/contacts/${more.id}`)).contact.emails.length, 2, 'both contacts stay as they were');
  // Exactly 100 after de-duplication merges.
  await owner.call('PUT', `/api/contacts/${full.id}`, { version: full.version, name: { given: 'Mira', family: 'Many' }, emails: emails('mira', 0, 99).map(value => ({ value })) });
  const fullNow = (await owner.call('GET', `/api/contacts/${full.id}`)).contact;
  const merged100 = await owner.call('POST', '/api/contacts/merges', { contact_ids: [full.id, more.id], versions: { [full.id]: fullNow.version, [more.id]: more.version } });
  assert.equal(merged100.contact.emails.length, 100);
  // An import card that would push it past 100: added as its own contact, with a warning.
  const before = await count();
  const past = await importFile('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Mira Many\r\nN:Many;Mira;;;\r\nEMAIL:mira0@example.test\r\nEMAIL:mira-extra@example.test\r\nEND:VCARD\r\n');
  assert.deepEqual(past.summary.groups.map((item: FixtureValue) => item.default_decision), ['merge']);
  assert.deepEqual([past.done.result.added, past.done.result.merged, past.done.result.warnings.map((warning: FixtureValue) => [warning.card, warning.code])], [1, 0, [[1, 'TOO_MANY_VALUES']]]);
  assert.equal(await count(), before + 1);
  assert.equal((await owner.call('GET', `/api/contacts/${full.id}`)).contact.emails.length, 100, 'the full contact is unchanged');
});

// Review of 0.26.0's backend (Sol): long values are compared whole, photo
// cleanup never races an undo or a purge, an identical re-import is proven
// by content and photo bytes, a CSV cell is never cut silently, a commit
// rechecks its gates after converting and waiting, and a few hundred copies
// of one person are grouped well within a second.
test('contacts review probes: long values, undo and purge under the photo lock, identity by content, CSV cuts, gates after waiting, dense duplicates', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const sharp = require('sharp') as typeof import('sharp').default;
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-contact-review-'));
  const previous = { imports: process.env.CONTACT_IMPORTS_ROOT, photos: process.env.CONTACT_PHOTOS_ROOT, spool: process.env.UPLOAD_SPOOL_ROOT };
  process.env.CONTACT_IMPORTS_ROOT = path.join(scratch, 'imports');
  process.env.CONTACT_PHOTOS_ROOT = path.join(scratch, 'photos');
  process.env.UPLOAD_SPOOL_ROOT = path.join(scratch, 'spool');
  t.after(() => {
    for (const [key, value] of [['CONTACT_IMPORTS_ROOT', previous.imports], ['CONTACT_PHOTOS_ROOT', previous.photos], ['UPLOAD_SPOOL_ROOT', previous.spool]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const { withContactPhotoLock } = require('../dist/src/services/contact-photos') as typeof import('../src/services/contact-photos');
  const { purgeExpiredMerges } = require('../dist/src/services/contact-merge') as typeof import('../src/services/contact-merge');
  const password = 'synthetic-review-password';
  const userId = crypto.randomUUID();
  await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)',
    [userId, 'review@example.test', await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4), 'Review']);
  const owner = await rawSession(api.origin, 'review@example.test', password);
  const waitFor = async (id: string) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const [[row]] = await pool.query<RowDataPacket[]>('SELECT status FROM contact_imports WHERE id = ?', [id]);
      if (['committed', 'failed'].includes(row.status)) return owner.call('GET', `/api/contacts/imports/${id}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('import did not finish');
  };
  const stage = (text: string | Buffer, type = 'text/vcard') => owner.call('POST', '/api/contacts/imports', Buffer.isBuffer(text) ? text : Buffer.from(text), 200, type);
  const commit = async (summary: FixtureValue) => { await owner.call('POST', `/api/contacts/imports/${summary.id}/commit`, {}); return waitFor(summary.id); };
  const count = async () => Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM contacts WHERE user_id = ?', [userId]))[0][0].n);
  const byName = async (q: string) => (await owner.call('GET', `/api/contacts?q=${encodeURIComponent(q)}`)).contacts as FixtureValue[];
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // ── 1. Two web addresses alike for their first 255 characters stay two (import and merge) ──
  const prefix = `https://example.org/${'a'.repeat(250)}`;
  const [urlA, urlB] = [`${prefix}/first-page-of-the-site`, `${prefix}/second-page-of-the-site`];
  assert.ok(urlA.length > 255 && urlA.length < 300);
  const urls = await commit(await stage(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Lena Long\r\nN:Long;Lena;;;\r\nURL:${urlA}\r\nURL:${urlB}\r\nEND:VCARD\r\n`));
  assert.deepEqual([urls.result.added, urls.result.warnings], [1, []]);
  const [lena] = await byName('Lena');
  assert.deepEqual(lena.urls.map((url: FixtureValue) => url.value), [urlA, urlB], 'both addresses, no warning');
  const left = (await owner.call('POST', '/api/contacts', { name: { given: 'Max', family: 'Merge' }, emails: ['max@example.test'], urls: [urlA] })).contact;
  const right = (await owner.call('POST', '/api/contacts', { name: { given: 'Max', family: 'Merge' }, emails: ['max@example.test'], urls: [urlB] })).contact;
  const mergedUrls = await owner.call('POST', '/api/contacts/merges', { contact_ids: [left.id, right.id], versions: { [left.id]: left.version, [right.id]: right.version } });
  assert.deepEqual(mergedUrls.contact.urls.map((url: FixtureValue) => url.value), [urlA, urlB], 'a merge keeps both');

  // ── 2. Undo and the bin purge wait for the photo lock, so no cleanup judges their files half-way ──
  const jpeg = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#2050c0' } }).jpeg().toBuffer();
  const plain = (await owner.call('POST', '/api/contacts', { name: { given: 'Una', family: 'Undo' }, emails: ['una@example.test'] })).contact;
  const pictured = (await owner.call('POST', '/api/contacts', { name: { given: 'Una', family: 'Undo' }, emails: ['una@example.test'] })).contact;
  const photo = (await owner.call('PUT', `/api/contacts/${pictured.id}/photo`, jpeg, 200, 'image/jpeg')).contact;
  const merge = await owner.call('POST', '/api/contacts/merges', { contact_ids: [plain.id, pictured.id], versions: { [plain.id]: plain.version, [pictured.id]: photo.version } });
  const undoneAt = async () => (await pool.query<RowDataPacket[]>('SELECT undone_at FROM contact_merges WHERE id = ?', [merge.merge_id]))[0][0].undone_at;
  let undo!: Promise<FixtureValue>;
  await withContactPhotoLock(userId, async () => {
    undo = owner.send('POST', `/api/contacts/merges/${merge.merge_id}/undo`, {});
    await sleep(500);
    assert.equal(await undoneAt(), null, 'the undo waits while a photo cleanup holds the lock');
  });
  assert.equal((await undo).status, 200);
  assert.notEqual(await undoneAt(), null);
  assert.equal((await owner.send('GET', `/api/contacts/${pictured.id}/photo`)).status, 200, 'the restored contact\'s photo is served');
  const second = await owner.call('POST', '/api/contacts/merges', { contact_ids: [plain.id, pictured.id],
    versions: Object.fromEntries((await byName('Una')).map((contact: FixtureValue) => [contact.id, contact.version])) });
  const binned = async () => Number((await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM bin_items WHERE group_id = ?', [second.merge_id]))[0][0].n);
  let purge!: Promise<{ items: number; merges: number }>;
  await withContactPhotoLock(userId, async () => {
    purge = purgeExpiredMerges({ now: new Date(Date.now() + 40 * 24 * 3600 * 1000) });
    await sleep(500);
    assert.equal(await binned(), 1, 'the purge waits for the lock too');
  });
  assert.ok((await purge).items >= 1);
  assert.equal(await binned(), 0);

  // ── 3. Identical means the same kept details and the same photo bytes ──
  const png = await sharp({ create: { width: 200, height: 260, channels: 3, background: '#c08020' } }).png().toBuffer();
  const otherPng = await sharp({ create: { width: 200, height: 260, channels: 3, background: '#20c080' } }).png().toBuffer();
  const card = (foo: string, picture: Buffer) => `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:urn:uuid:7a1d2a3c-0000-4000-8000-0000000000aa\r\nFN:Ida Identity\r\nN:Identity;Ida;;;\r\n`
    + `EMAIL:ida@example.test\r\nX-FOO:${foo}\r\nPHOTO:data:image/png;base64,${picture.toString('base64')}\r\nEND:VCARD\r\n`;
  assert.equal((await commit(await stage(card('one', png)))).result.added, 1);
  const decision = async (text: string | Buffer) => { const summary = await stage(text); return [summary.groups[0].match, summary.groups[0].default_decision]; };
  assert.deepEqual(await decision(card('one', png)), ['identical', 'skip'], 'the same file again: its picture converts to the stored photo');
  assert.deepEqual(await decision(card('two', png)), ['uid', 'merge'], 'a changed kept detail is not identical');
  assert.deepEqual(await decision(card('one', otherPng)), ['uid', 'merge'], 'a different picture is not identical');
  const exported = (await owner.send('POST', '/api/contacts/export', { ids: (await byName('Ida')).map((contact: FixtureValue) => contact.id), format: 'vcard4' })).bytes;
  assert.deepEqual(await decision(exported), ['identical', 'skip'], 'UniHub\'s own export carries the stored bytes');

  // ── 4. A CSV cell longer than its field is kept whole and reported ──
  const longName = 'Bartholomew'.repeat(28);
  const longNote = 'n'.repeat(66000);
  const google = await stage(`First Name,Last Name,Notes,E-mail 1 - Value\r\n${longName},Cut,${longNote},cut@example.test\r\n`, 'text/csv');
  assert.equal(google.format, 'google-csv');
  assert.deepEqual(google.warnings.map((warning: FixtureValue) => [warning.card, warning.property, warning.code]), [[1, 'First Name', 'VALUE_CUT'], [1, 'Notes', 'NOTE_CUT']]);
  assert.doesNotMatch(JSON.stringify(google.warnings), /Bartholomew|nnnn/, 'warnings never carry the value');
  await commit(google);
  const [cut] = await byName('cut@example.test');
  const cutDetail = (await owner.call('GET', `/api/contacts/${cut.id}`)).contact;
  assert.equal(cutDetail.name.given.length, 255);
  assert.ok(Buffer.byteLength(cutDetail.notes) <= 65535);
  const keptValues = cutDetail.properties.map((property: FixtureValue) => property.value);
  assert.ok(keptValues.includes(longName) && keptValues.includes(longNote), 'the whole cells are kept as other details');
  const outlook = await stage(`First Name,Last Name,Company,E-mail Address\r\nOtto,Outlook,${'Company '.repeat(40)},otto@example.test\r\n`, 'text/csv');
  assert.deepEqual([outlook.format, outlook.warnings.map((warning: FixtureValue) => [warning.card, warning.property, warning.code])], ['outlook-csv', [[1, 'Company', 'VALUE_CUT']]]);

  // ── 5. A commit that waited for its photos rechecks the module switch before writing ──
  const before = await count();
  const waiting = await stage(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Wanda Wait\r\nN:Wait;Wanda;;;\r\nPHOTO:data:image/png;base64,${png.toString('base64')}\r\nEND:VCARD\r\n`);
  await withContactPhotoLock(userId, async () => {
    await owner.call('POST', `/api/contacts/imports/${waiting.id}/commit`, {});
    await sleep(500);
    await owner.call('PUT', '/api/modules', { modules: { contacts: { enabled: false } } });
  });
  for (let attempt = 0; attempt < 100 && (await pool.query<RowDataPacket[]>('SELECT status FROM contact_imports WHERE id = ?', [waiting.id]))[0][0].status === 'committing'; attempt++) await sleep(50);
  const [[failed]] = await pool.query<RowDataPacket[]>('SELECT status, result FROM contact_imports WHERE id = ?', [waiting.id]);
  const failedState = typeof failed.result === 'string' ? JSON.parse(failed.result) : failed.result;
  assert.deepEqual([failed.status, failedState.error.code, failedState.added], ['failed', 'MODULE_DISABLED', 0]);
  assert.equal(await count(), before, 'nothing was written');
  await owner.call('PUT', '/api/modules', { modules: { contacts: { enabled: true } } });
  const resumed = await commit(waiting);
  assert.deepEqual([resumed.state, resumed.result.added], ['committed', 1], 'committing again resumes');

  // ── 6. Three hundred copies of one person: one large group, well within a second ──
  const ids = Array.from({ length: 300 }, () => crypto.randomUUID());
  await pool.query('INSERT INTO contacts (id, user_id, uid, uid_hash, version, first_name, last_name, name_key) VALUES ?',
    [ids.map(id => [id, userId, `urn:uuid:${id}`, crypto.createHash('sha256').update(`urn:uuid:${id}`).digest('hex'), 1, 'Dora', 'Dense', 'dense dora'])]);
  await pool.query('INSERT INTO contact_values (id, contact_id, user_id, kind, position, label, value, value_key) VALUES ?',
    [ids.flatMap(id => [[crypto.randomUUID(), id, userId, 'email', 0, '', 'dora@example.test', 'dora@example.test'], [crypto.randomUUID(), id, userId, 'phone', 0, '', '+49 171 5550123', '+491715550123']])]);
  const started = Date.now();
  const { groups } = await owner.call('GET', '/api/contacts/duplicates?min=low');
  const elapsed = Date.now() - started;
  const dense = groups.find((group: FixtureValue) => group.members.length === 300);
  assert.ok(dense, 'one group of all three hundred');
  assert.deepEqual([dense.confidence, dense.large, dense.auto_merge], ['high', true, false]);
  assert.ok(dense.reasons.length <= 50);
  assert.ok(elapsed < 1000, `answered in ${elapsed} ms`);
});
