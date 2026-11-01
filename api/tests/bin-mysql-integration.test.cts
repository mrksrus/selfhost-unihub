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
const { installCalDavFake, insertCalDavAccount, eventIcs, WORK } = require('./helpers/caldav-fake.cts');
const { installSqlHooks, deadlock, within } = require('./helpers/sql-hooks.cts');

// The bin (0.28 stream B, D13) through the real request handler and MariaDB:
// per kind, delete -> bin -> restore -> delete for good; a synced CalDAV task
// deleted at its server and created there again with the same UID (a lost
// answer adopted, never a second copy; a conflict or a read-only or removed
// calendar handled); the merge bin's undo; the purge with two people, the
// module switch, a restore lock and the retention as the policies resolve
// it. Alex owns the items; Blair is the stranger.
test('the bin: deleting moves items there, restore brings them back, the purge keeps what the rules keep', {
  skip: !process.env.MYSQL_TEST_HOST, timeout: 300000,
}, async t => {
  const recordingsRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-bin-recordings-'));
  process.env.RECORDINGS_ROOT = recordingsRoot;
  t.after(() => fs.rmSync(recordingsRoot, { recursive: true, force: true }));
  const { captureLog } = require('../dist/src/log') as typeof import('../src/log');
  t.after(captureLog(() => {}));
  const pool = await withTestDatabase(t);
  const api = await startTestApi(t);
  const hooks = installSqlHooks(pool as FixtureValue);
  const server = installCalDavFake(require('../dist/src/services/caldav'));
  const calendarSync = require('../dist/src/services/calendar-sync') as typeof import('../src/services/calendar-sync');
  const calendarMove = require('../dist/src/services/calendar-move') as typeof import('../src/services/calendar-move');
  const { purgeBin } = require('../dist/src/services/bin') as typeof import('../src/services/bin');
  const { photosHeldForUndo } = require('../dist/src/services/contact-merge') as typeof import('../src/services/contact-merge');
  const { ensureDefaultLocalCalendarForUser } = require('../dist/src/services/calendar') as typeof import('../src/services/calendar');
  const { encrypt } = require('../dist/src/security/encryption') as typeof import('../src/security/encryption');
  const password = 'synthetic-bin-password';
  const passwordHash = await (require('bcryptjs') as typeof import('bcryptjs')).hash(password, 4);
  const users: Record<string, string> = {};
  for (const name of ['alex', 'blair']) {
    users[name] = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [users[name], `${name}@example.test`, passwordHash, name]);
  }
  async function signIn(name: string) {
    const client = api.client();
    assert.equal((await client.request('POST', '/api/auth/signin', { email: `${name}@example.test`, password })).status, 200);
    return client;
  }
  type Client = Awaited<ReturnType<typeof signIn>>;
  const alex = await signIn('alex');
  const blair = await signIn('blair');
  async function call(client: Client, method: string, route: string, body?: unknown, status = 200): Promise<FixtureValue> {
    const reply = await client.request(method, route, body);
    assert.equal(reply.status, status, `${method} ${route}: ${JSON.stringify(reply.body).slice(0, 500)}`);
    return reply.body;
  }
  const bin = async (client = alex, module = '') => (await call(client, 'GET', `/api/bin${module ? `?module=${module}` : ''}`)).items as FixtureValue[];
  const restore = (id: string, client = alex, status = 200) => call(client, 'POST', `/api/bin/${id}/restore`, undefined, status);
  const count = async (sql: string, params: unknown[]) => Number(((await pool.query<RowDataPacket[]>(sql, params))[0][0]).n);
  const at = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  // A barrier a hooked statement waits at, and the deadlocks the database reported.
  const gate = () => { let open!: () => void; const reached = new Promise<void>(resolve => { open = resolve; }); return { open, reached }; };
  const deadlocks = () => hooks.errors.filter((code: string) => code === 'ER_LOCK_DEADLOCK').length;

  await t.test('contacts: one and several, owner scope, photo and identity kept', async () => {
    const casey = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Casey' }, emails: ['casey@example.test'] })).contact;
    await pool.execute(`INSERT INTO contact_photos (contact_id, user_id, sha256, width, height, bytes, thumb_sha256, source) VALUES (?, ?, ?, 512, 512, 1000, ?, 'upload')`,
      [casey.id, users.alex, sha('casey'), sha('casey-96')]);
    await call(alex, 'DELETE', `/api/contacts/${casey.id}`);
    assert.equal((await call(alex, 'GET', '/api/contacts')).contacts.length, 0, 'it leaves the contact list');
    const [item] = await bin(alex, 'contacts');
    assert.deepEqual([item.item_type, item.reason, item.title, item.provider], ['contact', 'deleted', 'Casey', 'local']);
    assert.ok(item.purge_after, 'the default retention ends it');
    assert.ok((await photosHeldForUndo(users.alex)).has(sha('casey')), 'its photo stays on disk while it is in the bin');
    // Blair cannot see, restore or delete it.
    assert.deepEqual(await bin(blair), []);
    await restore(item.id, blair, 404);
    await call(blair, 'DELETE', `/api/bin/${item.id}`, undefined, 404);
    assert.deepEqual((await call(blair, 'POST', '/api/bin/restore', { ids: [item.id] })).failed.map((entry: FixtureValue) => entry.code), ['BIN_ITEM_NOT_FOUND']);
    const answer = await restore(item.id);
    assert.deepEqual(answer.restored.map((entry: FixtureValue) => entry.item_id), [casey.id], 'the same id');
    const back = (await call(alex, 'GET', `/api/contacts/${casey.id}`)).contact;
    assert.equal(back.uid, casey.uid);
    assert.deepEqual(back.emails.map((email: FixtureValue) => email.value), ['casey@example.test']);
    assert.equal(await count('SELECT COUNT(*) AS n FROM contact_photos WHERE contact_id = ?', [casey.id]), 1);
    assert.deepEqual(await bin(alex), []);
    // Several at once are one group: restoring one brings back all.
    const dana = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Dana' } })).contact;
    const eli = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Eli' } })).contact;
    const theirs = (await call(blair, 'POST', '/api/contacts', { name: { given: 'Theirs' } })).contact;
    assert.equal((await call(alex, 'POST', '/api/contacts/bulk-delete', { ids: [dana.id, eli.id, theirs.id] })).deleted, 2, 'only the owner\'s');
    const group = await bin(alex, 'contacts');
    assert.equal(group.length, 2);
    assert.ok(group[0].group_id && group[0].group_id === group[1].group_id);
    assert.equal((await restore(group[0].id)).restored.length, 2);
    assert.equal((await call(alex, 'GET', '/api/contacts')).contacts.length, 3);
    assert.equal((await call(blair, 'GET', '/api/contacts')).contacts.length, 1);
  });

  await t.test('the merge bin: an undo through the bin within 30 days, a plain restore after', async () => {
    const one = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Fran' }, emails: ['fran@example.test'] })).contact;
    const two = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Fran' }, emails: ['fran.work@example.test'] })).contact;
    const merge = await call(alex, 'POST', '/api/contacts/merges', { contact_ids: [one.id, two.id], versions: { [one.id]: one.version, [two.id]: two.version } });
    const [merged] = await bin(alex, 'contacts');
    assert.deepEqual([merged.reason, merged.group_id], ['merged', merge.merge_id]);
    const answer = await restore(merged.id);
    assert.equal(answer.restored[0].item_id, two.id);
    assert.match(answer.restored[0].note, /back as they were before the merge/);
    assert.notEqual((await pool.query<RowDataPacket[]>('SELECT undone_at FROM contact_merges WHERE id = ?', [merge.merge_id]))[0][0].undone_at, null, 'it was the merge\'s undo');
    assert.deepEqual((await call(alex, 'GET', `/api/contacts/${one.id}`)).contact.emails.map((email: FixtureValue) => email.value), ['fran@example.test']);
    // Merged again, and the undo window ends: the contact still comes back from the bin, alone, with its UID.
    const [first, second] = [(await call(alex, 'GET', `/api/contacts/${one.id}`)).contact, (await call(alex, 'GET', `/api/contacts/${two.id}`)).contact];
    const again = await call(alex, 'POST', '/api/contacts/merges', { contact_ids: [first.id, second.id], versions: { [first.id]: first.version, [second.id]: second.version } });
    await pool.execute('UPDATE contact_merges SET purge_after = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = ?', [again.merge_id]);
    const [late] = await bin(alex, 'contacts');
    assert.equal(late.reason, 'merged', 'the person\'s retention keeps it past the undo window');
    assert.equal((await restore(late.id)).restored[0].item_id, two.id);
    assert.equal((await call(alex, 'GET', `/api/contacts/${two.id}`)).contact.uid, two.uid);
    assert.equal((await pool.query<RowDataPacket[]>('SELECT undone_at FROM contact_merges WHERE id = ?', [again.merge_id]))[0][0].undone_at, null);
    assert.equal(await count('SELECT COUNT(*) AS n FROM contact_uid_aliases WHERE user_id = ? AND uid = ? AND contact_id <> ?', [users.alex, two.uid, two.id]), 0,
      'its own UID no longer names the survivor');
  });

  const { calendarId: inbox } = await ensureDefaultLocalCalendarForUser(users.alex);
  const [[{ account_id: localAccount }]] = await pool.query<RowDataPacket[]>('SELECT account_id FROM calendar_calendars WHERE id = ?', [inbox]);
  let clock = Date.UTC(2026, 10, 12, 9);
  async function localTask(title: string, list = inbox) {
    const id = crypto.randomUUID();
    clock += 3600000;
    await pool.execute(`INSERT INTO calendar_events (id, user_id, calendar_id, title, start_time, end_time, todo_status, done_at) VALUES (?, ?, ?, ?, ?, ?, 'done', ?)`,
      [id, users.alex, list, title, at(clock), at(clock + 1800000), at(clock - 86400000)]);
    await pool.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, TRUE, 0)', [crypto.randomUUID(), id, users.alex, `${title} step`]);
    await pool.execute("INSERT INTO calendar_event_attendees (id, user_id, event_id, email) VALUES (?, ?, ?, 'guest@example.test')", [crypto.randomUUID(), users.alex, id]);
    return id;
  }
  const eventRow = async (id: string) => (await pool.query<RowDataPacket[]>('SELECT * FROM calendar_events WHERE id = ?', [id]))[0][0];
  const stepsOf = async (id: string) => (await pool.query<RowDataPacket[]>('SELECT title, is_done FROM calendar_event_subtasks WHERE event_id = ? ORDER BY position', [id]))[0]
    .map(row => [row.title, !!row.is_done]);

  await t.test('UniHub events, tasks and lists: back into their list, or the default list when it is gone', async () => {
    const pay = await localTask('Pay rent');
    await call(blair, 'DELETE', `/api/calendar/events/${pay}`);
    assert.ok(await eventRow(pay), 'another person cannot delete it');
    assert.equal((await call(alex, 'DELETE', `/api/calendar/events/${pay}`)).message, 'Event moved to the bin');
    assert.equal(await eventRow(pay), undefined);
    const [item] = await bin(alex, 'calendar');
    const [[list]] = await pool.query<RowDataPacket[]>('SELECT name FROM calendar_calendars WHERE id = ?', [inbox]);
    assert.deepEqual([item.item_type, item.origin], ['task', list.name], 'named by its list');
    await restore(item.id);
    const back = await eventRow(pay);
    assert.deepEqual([back.calendar_id, back.todo_status], [inbox, 'done']);
    assert.deepEqual(await stepsOf(pay), [['Pay rent step', true]]);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_event_attendees WHERE event_id = ?', [pay]), 1);
    // A list deleted with its events is one group; a task binned before from that list goes to the default list.
    const errands = crypto.randomUUID();
    await pool.execute("INSERT INTO calendar_calendars (id, user_id, account_id, name, color) VALUES (?, ?, ?, 'Errands', '#22c55e')", [errands, users.alex, localAccount]);
    const early = await localTask('Buy stamps', errands);
    const kept = await localTask('Post letter', errands);
    await call(alex, 'PUT', `/api/settings/values/calendars/${errands}`, { values: { notify_enabled: false } });
    await call(alex, 'DELETE', `/api/calendar/events/${early}`);
    await call(alex, 'DELETE', `/api/calendar/calendars/${errands}`);
    const items = await bin(alex, 'calendar');
    const listItem = items.find(entry => entry.item_type === 'calendar');
    assert.equal(items.filter(entry => entry.group_id === listItem.group_id).length, 2, 'the list and its event');
    const earlyItem = items.find(entry => entry.title === 'Buy stamps');
    const answer = await restore(earlyItem.id);
    assert.match(answer.restored[0].note, /default list/);
    assert.equal((await eventRow(early)).calendar_id, inbox);
    await restore(listItem.id);
    assert.equal((await pool.query<RowDataPacket[]>('SELECT name FROM calendar_calendars WHERE id = ?', [errands]))[0][0].name, 'Errands', 'the list under its own id');
    assert.equal((await eventRow(kept)).calendar_id, errands);
    assert.deepEqual((await call(alex, 'GET', '/api/settings/values/calendars')).calendars[errands].notify_enabled, { value: false, source: 'user', locked: false }, 'its settings back');
    assert.deepEqual(await stepsOf(kept), [['Post letter step', true]]);
    assert.deepEqual(await bin(alex, 'calendar'), []);
  });

  await t.test('recordings: the file waits in the bin folder, comes back, and goes with a delete for good', async () => {
    const id = crypto.randomUUID();
    const folder = path.join(recordingsRoot, users.alex);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${id}.webm`);
    fs.writeFileSync(file, 'synthetic recording bytes');
    await pool.execute("INSERT INTO recordings (id, user_id, title, content_type, size_bytes, storage_path) VALUES (?, ?, 'Synthetic memo', 'audio/webm', 25, ?)", [id, users.alex, file]);
    await call(blair, 'DELETE', `/api/recordings/${id}`, undefined, 404);
    await call(alex, 'DELETE', `/api/recordings/${id}`);
    assert.ok(!fs.existsSync(file) && fs.existsSync(path.join(folder, 'bin', `${id}.webm`)), 'moved to the bin folder');
    assert.deepEqual((await call(alex, 'GET', '/api/recordings')).recordings, []);
    const [item] = await bin(alex, 'recordings');
    await restore(item.id);
    assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic recording bytes', 'the original bytes, where they were');
    assert.equal((await call(alex, 'GET', '/api/recordings')).recordings[0].id, id);
    await call(alex, 'DELETE', `/api/recordings/${id}`);
    const [again] = await bin(alex, 'recordings');
    assert.deepEqual(await call(alex, 'DELETE', `/api/bin/${again.id}`), { deleted: 1 });
    assert.ok(!fs.existsSync(path.join(folder, 'bin', `${id}.webm`)) && !fs.existsSync(file), 'deleted for good');
  });

  await t.test('recordings: two restores at once leave the file with the one that won', async () => {
    const folder = path.join(recordingsRoot, users.alex);
    const id = crypto.randomUUID();
    const file = path.join(folder, `${id}.webm`);
    fs.writeFileSync(file, 'raced recording bytes');
    await pool.execute("INSERT INTO recordings (id, user_id, title, content_type, size_bytes, storage_path) VALUES (?, ?, 'Raced memo', 'audio/webm', 21, ?)", [id, users.alex, file]);
    await call(alex, 'DELETE', `/api/recordings/${id}`);
    const [item] = await bin(alex, 'recordings');
    // The first restore puts the file back and stops there; the second runs meanwhile.
    const files = (require('node:fs') as typeof import('node:fs')).promises;
    const { rename, link } = files;
    let reached!: () => void; let release!: () => void;
    const atPause = new Promise<void>(resolve => { reached = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    let once = true;
    const pausing = (real: (from: string, to: string) => Promise<void>) => async (from: string, to: string) => {
      await real(from, to);
      if (once && String(to) === file) { once = false; reached(); await within(paused, 5000); }
    };
    files.rename = pausing(rename) as typeof files.rename;
    files.link = pausing(link) as typeof files.link;
    try {
      const first = alex.request('POST', `/api/bin/${item.id}/restore`);
      assert.ok((await within(atPause, 5000)).done, 'the first restore moved the file');
      const second = alex.request('POST', `/api/bin/${item.id}/restore`);
      await within(second, 1000);
      release();
      const statuses = (await Promise.all([first, second])).map(reply => reply.status).sort();
      assert.deepEqual(statuses, [200, 404], 'one restore, the other finds it gone');
    } finally { Object.assign(files, { rename, link }); release(); }
    assert.equal(fs.readFileSync(file, 'utf8'), 'raced recording bytes', 'the file stays with the restored recording');
    assert.equal((await pool.query<RowDataPacket[]>('SELECT storage_path FROM recordings WHERE id = ?', [id]))[0][0].storage_path, file);
    assert.ok(!fs.existsSync(path.join(folder, 'bin', `${id}.webm`)));
    assert.deepEqual(await bin(alex, 'recordings'), []);
    await pool.execute('DELETE FROM recordings WHERE id = ?', [id]);
    fs.rmSync(file, { force: true });
  });

  // A process that stops right after the file got its new name, before the
  // transaction commits (a crash, a container stop): the rows roll back, so
  // the file must still be where they name it.
  const stopAfterFileMove = (task: string) => new Promise<number | null>((resolve, reject) => {
    const code = `
      const pool = require('mysql2/promise').createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306),
        user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, database: process.env.MYSQL_TEST_DATABASE, timezone: '+00:00', connectionLimit: 2 });
      require('./dist/src/state').setDb(pool);
      const files = require('node:fs').promises;
      for (const name of ['rename', 'link', 'copyFile']) {
        const real = files[name];
        files[name] = async (...args) => { await real(...args); process.exit(77); };
      }
      (${task})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });`;
    const child = (require('node:child_process') as typeof import('node:child_process')).spawn(process.execPath, ['-e', code],
      { cwd: path.join(__dirname, '..'), env: process.env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
    let stderr = '';
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', status => (status === 77 ? resolve(status) : reject(new Error(`the stopped process ended with ${status}: ${stderr.slice(0, 500)}`))));
  });

  await t.test('recordings: a stop right after the file moved, before the commit, leaves the file with its rows (delete and restore)', async context => {
    const folder = path.join(recordingsRoot, users.alex);
    const id = crypto.randomUUID();
    const file = path.join(folder, `${id}.webm`);
    fs.writeFileSync(file, 'interrupted recording bytes');
    await pool.execute("INSERT INTO recordings (id, user_id, title, content_type, size_bytes, storage_path) VALUES (?, ?, 'Interrupted memo', 'audio/webm', 27, ?)", [id, users.alex, file]);
    const binned = path.join(folder, 'bin', `${id}.webm`);
    context.after(async () => {
      await pool.execute("DELETE FROM bin_items WHERE user_id = ? AND title = 'Interrupted memo'", [users.alex]);
      await pool.execute('DELETE FROM recordings WHERE id = ?', [id]);
      for (const name of [file, binned]) fs.rmSync(name, { force: true });
    });
    await stopAfterFileMove(`() => require('./dist/src/services/recordings').deleteRecording(${JSON.stringify(users.alex)}, ${JSON.stringify(id)})`);
    assert.equal((await pool.query<RowDataPacket[]>('SELECT storage_path FROM recordings WHERE id = ?', [id]))[0][0]?.storage_path, file, 'the delete rolled back');
    assert.equal(fs.readFileSync(file, 'utf8'), 'interrupted recording bytes', 'the recording still has its file');
    assert.deepEqual(await bin(alex, 'recordings'), []);
    // Deleting again works, and its file waits in the bin.
    await call(alex, 'DELETE', `/api/recordings/${id}`);
    const [item] = await bin(alex, 'recordings');
    assert.ok(!fs.existsSync(file) && fs.readFileSync(binned, 'utf8') === 'interrupted recording bytes');
    await stopAfterFileMove(`() => require('./dist/src/services/bin').restoreBinItem(${JSON.stringify(users.alex)}, ${JSON.stringify(item.id)})`);
    assert.equal((await bin(alex, 'recordings')).length, 1, 'the restore rolled back');
    assert.equal(fs.readFileSync(binned, 'utf8'), 'interrupted recording bytes', 'the bin item still has its file');
    await restore(item.id);
    assert.equal(fs.readFileSync(file, 'utf8'), 'interrupted recording bytes', 'restored with its bytes, where it was');
    assert.ok(!fs.existsSync(binned), 'nothing is left in the bin folder');
  });

  await t.test('recordings: a bin folder that is a link out of the recordings root is refused, nothing moves', async () => {
    const folder = path.join(recordingsRoot, users.alex);
    const outside = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'unihub-bin-outside-'));
    const binFolder = path.join(folder, 'bin');
    assert.deepEqual(fs.readdirSync(binFolder), [], 'nothing waits in the bin folder');
    fs.rmdirSync(binFolder);
    fs.symlinkSync(outside, binFolder);
    const id = crypto.randomUUID();
    const file = path.join(folder, `${id}.webm`);
    fs.writeFileSync(file, 'linked folder bytes');
    await pool.execute("INSERT INTO recordings (id, user_id, title, content_type, size_bytes, storage_path) VALUES (?, ?, 'Linked memo', 'audio/webm', 19, ?)", [id, users.alex, file]);
    try {
      assert.equal((await call(alex, 'DELETE', `/api/recordings/${id}`, undefined, 409)).code, 'RECORDING_FOLDER_UNSAFE');
      assert.ok(fs.existsSync(file), 'the file stays where it was');
      assert.deepEqual(fs.readdirSync(outside), [], 'nothing reached the folder outside the root');
      assert.equal(await count('SELECT COUNT(*) AS n FROM recordings WHERE id = ?', [id]), 1);
      assert.deepEqual(await bin(alex, 'recordings'), []);
    } finally {
      fs.unlinkSync(binFolder);
      fs.mkdirSync(binFolder);
      fs.rmSync(outside, { recursive: true, force: true });
    }
    await call(alex, 'DELETE', `/api/recordings/${id}`);
    assert.ok(fs.existsSync(path.join(binFolder, `${id}.webm`)), 'a plain folder works again');
    const [item] = await bin(alex, 'recordings');
    await call(alex, 'DELETE', `/api/bin/${item.id}`);
  });

  await t.test('deleting for good and emptying obey bin.delete; empty takes one module or all', async () => {
    const gone = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Gale' } })).contact;
    await call(alex, 'DELETE', `/api/contacts/${gone.id}`);
    const task = await localTask('Water plants');
    await call(alex, 'DELETE', `/api/calendar/events/${task}`);
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'policy.bin.delete', 'forbidden', 0)");
    const [item] = await bin(alex, 'contacts');
    assert.equal((await call(alex, 'DELETE', `/api/bin/${item.id}`, undefined, 403)).code, 'POLICY_FORBIDS');
    assert.equal((await call(alex, 'POST', '/api/bin/empty', {}, 403)).code, 'POLICY_FORBIDS');
    assert.equal((await bin(alex)).length, 2, 'nothing removed');
    await pool.execute("DELETE FROM setting_policies WHERE setting_key = 'policy.bin.delete'");
    assert.deepEqual(await call(alex, 'POST', '/api/bin/empty', { module: 'contacts' }), { deleted: 1 });
    assert.deepEqual((await bin(alex)).map(entry => entry.title), ['Water plants']);
    assert.deepEqual(await call(alex, 'POST', '/api/bin/empty', {}), { deleted: 1 });
    assert.equal((await call(alex, 'POST', '/api/bin/empty', { module: 'mail' }, 400)).code, 'BIN_INVALID');
  });

  await t.test('the purge: two people, the module switch, a restore lock, the retention as the policies resolve it', async () => {
    const later = new Date(Date.now() + 31 * 86400000);
    const mine = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Hale' } })).contact;
    const theirs = (await call(blair, 'POST', '/api/contacts', { name: { given: 'Ivo' } })).contact;
    await call(blair, 'PUT', '/api/settings/values', { values: { bin_retention: 'forever' } });
    await call(alex, 'DELETE', `/api/contacts/${mine.id}`);
    await call(blair, 'DELETE', `/api/contacts/${theirs.id}`);
    assert.equal((await bin(blair))[0].purge_after, null, 'forever keeps it until restored or deleted');
    // The module off, then a restore of the section: Alex's item waits.
    await call(alex, 'PUT', '/api/modules', { modules: { contacts: { enabled: false } } });
    assert.deepEqual(await purgeBin({ now: later }), { items: 0, merges: 0 });
    assert.equal((await call(alex, 'POST', '/api/bin/empty', { module: 'contacts' }, 403)).code, 'MODULE_DISABLED');
    await call(alex, 'PUT', '/api/modules', { modules: { contacts: { enabled: true } } });
    const restoreId = crypto.randomUUID();
    await pool.execute("INSERT INTO backup_restore_jobs (id, user_id, status, requested_sections) VALUES (?, ?, 'running', '[\"contacts\"]')", [restoreId, users.alex]);
    assert.deepEqual(await purgeBin({ now: later }), { items: 0, merges: 0 });
    const [waiting] = await bin(alex);
    assert.equal((await call(alex, 'POST', '/api/bin/restore', { ids: [waiting.id] })).failed[0].code, 'RESTORE_IN_PROGRESS');
    await pool.execute('DELETE FROM backup_restore_jobs WHERE id = ?', [restoreId]);
    // An administrator's locked retention holds it, though its time has come.
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'user.bin_retention', 'forever', 1)");
    assert.deepEqual(await purgeBin({ now: later }), { items: 0, merges: 0 }, 'the policy keeps it');
    await pool.execute("UPDATE setting_policies SET setting_value = '90', locked = 0 WHERE setting_key = 'user.bin_retention'");
    // (The rows an undo of a merge left behind go at their time.)
    await purgeBin({ now: later });
    assert.equal((await bin(alex)).length, 1, 'a 90-day minimum keeps it at 31 days');
    await pool.execute("DELETE FROM setting_policies WHERE setting_key = 'user.bin_retention'");
    assert.deepEqual(await purgeBin(), { items: 0, merges: 0 }, 'nothing is due today');
    assert.equal((await purgeBin({ now: later })).items, 1);
    assert.deepEqual(await bin(alex), []);
    assert.equal((await bin(blair)).length, 1, 'Blair keeps theirs');
    // A new retention applies to what is in the bin already.
    await call(blair, 'PUT', '/api/settings/values', { values: { bin_retention: '7' } });
    const [{ purge_after: purgeAfter, deleted_at: deletedAt }] = await bin(blair);
    assert.equal(Math.round((Date.parse(purgeAfter) - Date.parse(deletedAt)) / 86400000), 7);
  });

  await t.test('the purge and a longer retention saved at the same moment: the purge never deletes what the saved retention keeps', async () => {
    const later = new Date(Date.now() + 31 * 86400000);
    // Only Alex's item is due, so the pause below comes at their purge.
    await call(blair, 'POST', '/api/bin/empty', { module: 'contacts' });
    await call(alex, 'PUT', '/api/settings/values', { values: { bin_retention: '30' } });
    const jules = (await call(alex, 'POST', '/api/contacts', { name: { given: 'Jules' } })).contact;
    await call(alex, 'DELETE', `/api/contacts/${jules.id}`);
    // The purge stops right after it chose what is due; the person extends the retention then.
    let put!: Promise<FixtureValue>;
    let savedMeanwhile = false;
    hooks.once({ match: /FROM bin_items .*module = \?.*purge_after <= \?/s, after: async () => {
      put = call(alex, 'PUT', '/api/settings/values', { values: { bin_retention: '90' } });
      savedMeanwhile = (await within(put, 1000)).done;
    } });
    await purgeBin({ now: later });
    hooks.clear();
    await put;
    const remains = (await bin(alex, 'contacts')).some(item => item.title === 'Jules');
    assert.ok(remains || !savedMeanwhile, 'a retention saved before the purge deleted keeps the item');
    if (remains) {
      const [{ purge_after: purgeAfter, deleted_at: deletedAt }] = await bin(alex, 'contacts');
      assert.equal(Math.round((Date.parse(purgeAfter) - Date.parse(deletedAt)) / 86400000), 90);
    }
    await call(alex, 'POST', '/api/bin/empty', { module: 'contacts' });
    await call(alex, 'PUT', '/api/settings/values', { values: { bin_retention: '30' } });
  });

  // A person of their own for the purge's lock tests, so other people's items never meet the hooks.
  async function person(context: { after: (fn: () => unknown) => void }, name: string) {
    const id = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)', [id, `${name}@example.test`, passwordHash, name]);
    context.after(() => pool.execute('DELETE FROM users WHERE id = ?', [id]));
    return id;
  }
  const binRows = (userId: string, rows: { id: string; purgeAfter: string }[]) => pool.execute(
    `INSERT INTO bin_items (id, user_id, module, item_type, item_id, title, reason, payload, deleted_at, purge_after) VALUES
     ${rows.map(() => "(?, ?, 'calendar', 'task', ?, 'Waiting task', 'deleted', '{}', '2025-01-01 00:00:00', ?)").join(', ')}`,
    rows.flatMap(row => [row.id, userId, crypto.randomUUID(), row.purgeAfter]));
  // A journal row: the item is being created at its calendar server again.
  const reCreating = (userId: string, ids: string[]) => pool.execute(
    `INSERT INTO calendar_event_moves (id, user_id, target_calendar_id, target_uid, state, bin_item_id) VALUES ${ids.map(() => "(?, ?, NULL, ?, 'creating', ?)").join(', ')}`,
    ids.flatMap(id => [crypto.randomUUID(), userId, `${crypto.randomUUID()}@example.test`, id]));

  await t.test('the purge passes items that must wait: 200 being created at their server again do not hold back the next one', async context => {
    const drew = await person(context, 'drew');
    const waiting = Array.from({ length: 200 }, () => crypto.randomUUID());
    const due = crypto.randomUUID();
    await binRows(drew, [...waiting.map(id => ({ id, purgeAfter: '2026-01-01 00:00:00' })), { id: due, purgeAfter: '2026-01-02 00:00:00' }]);
    await reCreating(drew, waiting);
    await purgeBin();
    await purgeBin();
    assert.equal(await count('SELECT COUNT(*) AS n FROM bin_items WHERE id = ?', [due]), 0, 'the 201st item, due and free, is purged');
    assert.equal(await count('SELECT COUNT(*) AS n FROM bin_items WHERE user_id = ?', [drew]), 200, 'the items being created again wait');
  });

  await t.test('the purge and a delete for good of the same item lock in one order: neither is a deadlock victim', async context => {
    const { deleteBinItem } = require('../dist/src/services/bin') as typeof import('../src/services/bin');
    const emery = await person(context, 'emery');
    const item = crypto.randomUUID();
    await binRows(emery, [{ id: item, purgeAfter: '2026-01-01 00:00:00' }]);
    await reCreating(emery, [item]);
    const [deleteHolds, purgeChose, deleteAtItem, goDelete, goPurge] = [gate(), gate(), gate(), gate(), gate()];
    const before = deadlocks();
    // The delete holds the item's journal; the purge chooses its candidates;
    // the delete goes on to the item while the purge waits, then the purge goes on.
    hooks.once({ match: /^SELECT id FROM calendar_event_moves WHERE user_id = \? AND bin_item_id IN/, params: (values: unknown[]) => values[0] === emery,
      after: async () => { deleteHolds.open(); await within(goDelete.reached, 5000); } });
    hooks.once({ match: /FROM bin_items .*module = \?.*purge_after <= \?/s, params: (values: unknown[]) => values[0] === emery && values[1] === 'calendar',
      after: async () => { purgeChose.open(); await within(goPurge.reached, 5000); } });
    hooks.once({ match: /FROM bin_items WHERE user_id = \? AND restored_at IS NULL AND id IN .*FOR UPDATE/s, params: (values: unknown[]) => values[0] === emery,
      before: () => deleteAtItem.open() });
    try {
      const deleting = deleteBinItem(emery, item);
      assert.ok((await within(deleteHolds.reached, 5000)).done, 'the delete holds the journal');
      const purging = purgeBin();
      assert.ok((await within(purgeChose.reached, 5000)).done, 'the purge chose its candidates');
      goDelete.open();
      assert.ok((await within(deleteAtItem.reached, 5000)).done, 'the delete goes on to the item');
      await new Promise(resolve => setTimeout(resolve, 300));
      goPurge.open();
      const both = await within(Promise.all([deleting, purging]), 30000);
      assert.ok(both.done, 'both finish');
    } finally { hooks.clear(); goDelete.open(); goPurge.open(); }
    assert.equal(deadlocks() - before, 0, 'no deadlock between them');
    assert.equal(await count('SELECT COUNT(*) AS n FROM bin_items WHERE id = ?', [item]), 0);
  });

  await t.test('a restore and a retention change take the person before the bin rows: neither is a deadlock victim', async () => {
    const { calendarId: inbox } = await ensureDefaultLocalCalendarForUser(users.alex);
    const task = (await call(alex, 'POST', '/api/calendar/events', { title: 'Lock order task', start_time: '2026-11-20T09:00:00.000Z', end_time: '2026-11-20T10:00:00.000Z', calendar_id: inbox })).event;
    await call(alex, 'DELETE', `/api/calendar/events/${task.id}`);
    const item = (await bin(alex, 'calendar')).find(entry => entry.title === 'Lock order task');
    const [binHeld, userHeld, goRestore, goRetention] = [gate(), gate(), gate(), gate()];
    const before = deadlocks();
    // The restore holds the item; the retention change takes the person; then both go on.
    hooks.once({ match: /^SELECT \* FROM bin_items WHERE user_id = \? AND restored_at IS NULL AND id IN .*FOR UPDATE/s, params: (values: unknown[]) => values[0] === users.alex && values.includes(item.id),
      after: async () => { binHeld.open(); await within(goRestore.reached, 5000); } });
    hooks.once({ match: /^SELECT id FROM users WHERE id = \? FOR UPDATE/, params: (values: unknown[]) => values[0] === users.alex,
      after: async () => { userHeld.open(); await within(goRetention.reached, 5000); } });
    try {
      const restoring = alex.request('POST', `/api/bin/${item.id}/restore`);
      assert.ok((await within(binHeld.reached, 5000)).done, 'the restore holds the item');
      const setting = alex.request('PUT', '/api/settings/values', { values: { bin_retention: '90' } });
      await within(userHeld.reached, 1000);
      goRestore.open();
      await new Promise(resolve => setTimeout(resolve, 200));
      goRetention.open();
      const replies = await within(Promise.all([restoring, setting]), 30000);
      assert.ok(replies.done, 'both finish');
      assert.deepEqual(replies.value!.map((reply: { status: number }) => reply.status), [200, 200]);
    } finally { hooks.clear(); goRestore.open(); goRetention.open(); }
    assert.equal(deadlocks() - before, 0, 'no deadlock between them');
    assert.equal((await pool.query<RowDataPacket[]>('SELECT calendar_id FROM calendar_events WHERE id = ?', [task.id]))[0][0]?.calendar_id, inbox, 'restored');
    await call(alex, 'PUT', '/api/settings/values', { values: { bin_retention: '30' } });
  });

  // --- A CalDAV calendar ------------------------------------------------------
  const accountId = crypto.randomUUID();
  await insertCalDavAccount(pool, encrypt, users.alex, accountId);
  // A sync the conflict handling started in the background finishes first
  // (a call joins a run going on), then one that sees the server as it is now.
  const sync = async () => {
    await calendarSync.syncCalendarAccount(accountId, { userId: users.alex, full: true }).catch(() => undefined);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await calendarSync.syncCalendarAccount(accountId, { userId: users.alex, full: true }) as FixtureValue;
      if (!result?.skipped) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('the calendar account stayed busy');
  };
  await sync();
  const [[{ id: work }]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_calendars WHERE account_id = ? AND name = 'Work'", [accountId]);
  async function serverTask(title: string) {
    clock += 3600000;
    const uid = `${crypto.randomUUID()}@example.test`;
    const href = `${WORK}${title.toLowerCase().replace(/\W+/g, '-')}.ics`;
    server.store(href, eventIcs(uid, title, clock));
    await sync();
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT id FROM calendar_events WHERE user_id = ? AND title = ?', [users.alex, title]);
    await pool.execute("UPDATE calendar_events SET todo_status = 'done', done_at = ? WHERE id = ?", [at(clock - 86400000), row.id]);
    await pool.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, TRUE, 0)', [crypto.randomUUID(), row.id, users.alex, 'Only step']);
    return { id: row.id as string, uid, href };
  }
  const rowsTitled = async (title: string) => (await pool.query<RowDataPacket[]>('SELECT * FROM calendar_events WHERE user_id = ? AND title = ?', [users.alex, title]))[0];
  // Once in UniHub, linked to its one copy at the server, with its own state back.
  async function assertBack(title: string, uid: string, calendarId = work) {
    const rows = await rowsTitled(title);
    assert.equal(rows.length, 1, `${title}: one row`);
    assert.deepEqual([rows[0].calendar_id, rows[0].uid, rows[0].todo_status], [calendarId, uid, 'done']);
    assert.deepEqual(await stepsOf(rows[0].id), [['Only step', true]]);
    assert.equal(server.copiesOf(title).length, calendarId === work ? 1 : 0, `${title}: copies at the server`);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_event_moves WHERE user_id = ?', [users.alex]), 0, 'no journal left');
  }
  const resume = async () => {
    await pool.execute('UPDATE calendar_event_moves SET next_attempt_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND');
    return calendarMove.resumeDueMoves();
  };

  await t.test('a synced task: deleted at its server, kept in the bin, created there again with the same UID', async () => {
    const task = await serverTask('Review notes');
    server.remote.writes.length = 0;
    await call(alex, 'DELETE', `/api/calendar/events/${task.id}`);
    assert.deepEqual(server.remote.writes.map(([kind, at]: string[]) => [kind, at]), [['delete', task.href]]);
    assert.match(server.remote.writes[0][2], /^If-Match "e\d+"$/, 'deleted only in the version UniHub has');
    assert.equal(server.copiesOf('Review notes').length, 0, 'deleted at the provider');
    assert.equal((await rowsTitled('Review notes')).length, 0);
    const [item] = await bin(alex, 'calendar');
    assert.deepEqual([item.provider, item.origin, item.item_type], ['caldav', 'Work', 'task']);
    server.remote.writes.length = 0;
    await restore(item.id);
    assert.deepEqual(server.remote.writes, [['put', task.href, 'If-None-Match *']], 'one create at its old address');
    assert.ok(server.remote.objects.get(task.href)!.ics.includes(`UID:${task.uid}`));
    await assertBack('Review notes', task.uid);
    await sync();
    await assertBack('Review notes', task.uid);
  });

  await t.test('a provider refusing the delete leaves the task as it is, and nothing in the bin', async () => {
    const task = await serverTask('Changed elsewhere');
    // Another app changed it: UniHub's version is stale, the If-Match fails.
    server.store(task.href, eventIcs(task.uid, 'Changed elsewhere', clock, ['DESCRIPTION:edited elsewhere']));
    assert.equal((await call(alex, 'DELETE', `/api/calendar/events/${task.id}`, undefined, 409)).code, 'CALDAV_CONFLICT');
    assert.ok(await eventRow(task.id));
    assert.deepEqual(await bin(alex, 'calendar'), []);
    assert.equal(server.copiesOf('Changed elsewhere').length, 1);
  });

  await t.test('a lost answer: the restore waits, its retry adopts the stored copy, never a second one', async () => {
    const task = await serverTask('Lost answer');
    await call(alex, 'DELETE', `/api/calendar/events/${task.id}`);
    const [item] = await bin(alex, 'calendar');
    let once = true;
    server.faults.put = () => { if (once) { once = false; return 'store-then-lose'; } };
    const answer = await restore(item.id);
    assert.equal(answer.restored[0].pending, true);
    assert.equal((await bin(alex, 'calendar'))[0].restoring, true, 'shown as being restored');
    await resume();
    server.faults.put = undefined;
    await assertBack('Lost answer', task.uid);
    assert.deepEqual(await bin(alex, 'calendar'), []);
  });

  await t.test('a lost answer the sync finds first: the sync makes the rows with their state, and the retry finds nothing to do', async () => {
    const task = await serverTask('Sync first');
    await call(alex, 'DELETE', `/api/calendar/events/${task.id}`);
    const [item] = await bin(alex, 'calendar');
    server.faults.put = () => 'store-then-lose';
    assert.equal((await restore(item.id)).restored[0].pending, true);
    server.faults.put = undefined;
    await sync();
    await assertBack('Sync first', task.uid);
    await resume();
    await assertBack('Sync first', task.uid);
  });

  await t.test('the UID back at the server already: adopted on the 412, or at once when a sync has it', async () => {
    const task = await serverTask('Back already');
    await call(alex, 'DELETE', `/api/calendar/events/${task.id}`);
    const ics = eventIcs(task.uid, 'Back already', clock);
    server.store(task.href, ics);
    const [item] = await bin(alex, 'calendar');
    await restore(item.id);
    await assertBack('Back already', task.uid);
    // Synced before the restore: its rows exist and take their state.
    const other = await serverTask('Synced back');
    await call(alex, 'DELETE', `/api/calendar/events/${other.id}`);
    server.store(other.href, eventIcs(other.uid, 'Synced back', clock));
    await sync();
    const [second] = await bin(alex, 'calendar');
    assert.match((await restore(second.id)).restored[0].note, /on its calendar again/);
    await assertBack('Synced back', other.uid);
  });

  await t.test('another item at its address: refused, and it stays in the bin', async () => {
    const task = await serverTask('Address taken');
    await call(alex, 'DELETE', `/api/calendar/events/${task.id}`);
    server.store(task.href, eventIcs('someone-else@example.test', 'Someone else', clock));
    const [item] = await bin(alex, 'calendar');
    const answer = await call(alex, 'POST', '/api/bin/restore', { ids: [item.id] });
    assert.equal(answer.failed[0].code, 'CALDAV_CONFLICT');
    assert.equal((await bin(alex, 'calendar')).length, 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_event_moves WHERE user_id = ?', [users.alex]), 0);
    server.remote.objects.delete(task.href);
    await restore(item.id);
    await assertBack('Address taken', task.uid);
  });

  await t.test('a sync running while a synced task is deleted: the task still goes to the bin', async () => {
    const task = await serverTask('Raced delete');
    let racing: Promise<unknown> = Promise.resolve();
    // Right after the server deleted it, before UniHub removes its rows, a sync starts.
    server.faults.afterRemove = async () => {
      server.faults.afterRemove = undefined;
      racing = calendarSync.syncCalendarAccount(accountId, { userId: users.alex, full: true });
      await within(racing, 2000);
    };
    const answer = await call(alex, 'DELETE', `/api/calendar/events/${task.id}`);
    await within(racing, 10000);
    assert.ok(answer.bin_item_id, 'kept in the bin');
    assert.equal(server.copiesOf('Raced delete').length, 0);
    assert.equal((await rowsTitled('Raced delete')).length, 0);
    const item = (await bin(alex, 'calendar')).find(entry => entry.title === 'Raced delete');
    assert.equal(item?.id, answer.bin_item_id);
    await restore(item.id);
    await assertBack('Raced delete', task.uid);
  });

  await t.test('a deadlock retry of the delete still keeps the task in the bin', async () => {
    const task = await serverTask('Deadlocked delete');
    let fired = false;
    hooks.once({ match: /^DELETE FROM calendar_events WHERE user_id = \? AND id IN/, before: () => { fired = true; throw deadlock(); } });
    const answer = await call(alex, 'DELETE', `/api/calendar/events/${task.id}`);
    assert.ok(fired, 'the first attempt was a deadlock victim');
    assert.equal(await count('SELECT COUNT(*) AS n FROM bin_items WHERE id = ?', [answer.bin_item_id]), 1, 'the answered bin item is the committed one');
    assert.equal((await rowsTitled('Deadlocked delete')).length, 0);
    await restore(answer.bin_item_id);
    await assertBack('Deadlocked delete', task.uid);
  });

  await t.test('deleting one date of a repeating server event is checked against bin.delete before the server is written', async () => {
    clock += 86400000;
    const href = `${WORK}daily-standup.ics`;
    server.store(href, eventIcs(`${crypto.randomUUID()}@example.test`, 'Daily standup', clock, ['RRULE:FREQ=DAILY;COUNT=3']));
    await sync();
    const dates = await rowsTitled('Daily standup');
    assert.equal(dates.length, 3);
    await pool.execute("INSERT INTO setting_policies (target_kind, target_id, setting_key, setting_value, locked) VALUES ('installation', '', 'policy.bin.delete', 'forbidden', 0)");
    server.remote.writes.length = 0;
    try {
      const refused = await call(alex, 'DELETE', `/api/calendar/events/${dates[1].id}?scope=occurrence`, undefined, 403);
      assert.equal(refused.code, 'POLICY_FORBIDS');
      assert.deepEqual(server.remote.writes, [], 'nothing written to the server');
      assert.equal((await rowsTitled('Daily standup')).length, 3);
      // The whole series goes to the bin, which the policy allows.
      assert.ok((await call(alex, 'DELETE', `/api/calendar/events/${dates[0].id}?scope=series`)).bin_item_id);
    } finally {
      await pool.execute("DELETE FROM setting_policies WHERE setting_key = 'policy.bin.delete'");
    }
    const [item] = (await bin(alex, 'calendar')).filter(entry => entry.title === 'Daily standup');
    await restore(item.id);
    const back = await rowsTitled('Daily standup');
    assert.equal(back.length, 3);
    assert.equal((await call(alex, 'DELETE', `/api/calendar/events/${back[1].id}?scope=occurrence`)).bin_item_id, null, 'one date, allowed again, is not kept in the bin');
    assert.equal((await rowsTitled('Daily standup')).length, 2);
  });

  await t.test('a repeating synced event with details on several dates waits in the bin for a calendar that can take it', async () => {
    clock += 86400000;
    const uid = `${crypto.randomUUID()}@example.test`;
    server.store(`${WORK}weekly-plan.ics`, eventIcs(uid, 'Weekly plan', clock, ['RRULE:FREQ=DAILY;COUNT=3']));
    await sync();
    const dates = (await pool.query<RowDataPacket[]>("SELECT id FROM calendar_events WHERE user_id = ? AND title = 'Weekly plan' ORDER BY start_time", [users.alex]))[0];
    assert.equal(dates.length, 3);
    for (const [index, date] of dates.entries()) {
      await pool.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, FALSE, 0)', [crypto.randomUUID(), date.id, users.alex, `Step ${index}`]);
    }
    await call(alex, 'DELETE', `/api/calendar/events/${dates[0].id}?scope=series`);
    const item = (await bin(alex, 'calendar')).find(entry => entry.title === 'Weekly plan');
    await pool.execute('UPDATE calendar_calendars SET read_only = 1 WHERE id = ?', [work]);
    try {
      const answer = await call(alex, 'POST', '/api/bin/restore', { ids: [item.id] });
      assert.equal(answer.failed[0].code, 'BIN_RESTORE_NEEDS_CALENDAR');
      assert.equal((await rowsTitled('Weekly plan')).length, 0, 'not restored as a part of itself');
      assert.ok((await bin(alex, 'calendar')).some(entry => entry.id === item.id), 'it stays in the bin');
    } finally {
      await pool.execute('UPDATE calendar_calendars SET read_only = 0 WHERE id = ?', [work]);
    }
    await restore(item.id);
    const back = (await pool.query<RowDataPacket[]>("SELECT id FROM calendar_events WHERE user_id = ? AND title = 'Weekly plan' ORDER BY start_time", [users.alex]))[0];
    assert.deepEqual(await Promise.all(back.map(async row => (await stepsOf(row.id)).map(([title]) => title))), [['Step 0'], ['Step 1'], ['Step 2']], 'every date keeps its own');
  });

  await t.test('UIDs 0.27 stored trimmed: upgrade step 25 gives them back the server\'s spaces, so the bin and the hand order still find the task', async () => {
    const { runMigrations } = require('../dist/src/services/database-migrations') as typeof import('../src/services/database-migrations');
    const { MIGRATIONS } = require('../dist/src/services/database') as typeof import('../src/services/database');
    const { BASELINE } = require('../dist/src/services/database-baseline') as typeof import('../src/services/database-baseline');
    const { itemKey, attachRanks } = require('../dist/src/services/task-order') as typeof import('../src/services/task-order');
    clock += 3600000;
    // UIDs with a trailing space, as another calendar app wrote them; two
    // objects whose UIDs differ only by it, which 0.27 stored alike.
    const [kept, ranked, twin] = [0, 1, 2].map(() => `${crypto.randomUUID()}@example.test`);
    server.store(`${WORK}padded-done.ics`, eventIcs(`${kept} `, 'Padded done', clock));
    server.store(`${WORK}padded-ranked.ics`, eventIcs(`${ranked} `, 'Padded ranked', clock));
    server.store(`${WORK}twin-plain.ics`, eventIcs(twin, 'Twin plain', clock));
    server.store(`${WORK}twin-padded.ics`, eventIcs(`${twin} `, 'Twin padded', clock));
    await sync();
    const [done] = await rowsTitled('Padded done');
    await pool.execute("UPDATE calendar_events SET todo_status = 'done' WHERE id = ?", [done.id]);
    await pool.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, TRUE, 0)', [crypto.randomUUID(), done.id, users.alex, 'Kept step']);
    // As 0.27 left them: the stored UIDs trimmed, the hand ranks keyed by those.
    for (const uid of [kept, ranked, twin]) {
      await pool.execute('UPDATE calendar_remote_objects SET uid = ? WHERE calendar_id = ? AND uid COLLATE utf8mb4_nopad_bin IN (?, ?)', [uid, work, uid, `${uid} `]);
      await pool.execute('UPDATE calendar_events SET uid = ? WHERE user_id = ? AND uid COLLATE utf8mb4_nopad_bin IN (?, ?)', [uid, users.alex, uid, `${uid} `]);
    }
    for (const [uid, rank] of [[ranked, 111], [twin, 222]] as const) {
      await pool.execute("INSERT INTO task_order (user_id, item_key, calendar_id, remote_uid, recurrence_id, sort_rank) VALUES (?, ?, ?, ?, '', ?)",
        [users.alex, itemKey({ calendar_id: work, remote_uid: uid, recurrence_id: '' }), work, uid, rank]);
    }
    // The upgrade: step 25 again, as an installation of 0.27 runs it.
    await pool.execute('DELETE FROM schema_migrations WHERE id = 25');
    await runMigrations(pool, MIGRATIONS, BASELINE);
    const hand = async (title: string) => (await attachRanks(users.alex, (await rowsTitled(title)) as FixtureValue[]))[0];
    // The bin: deleted and restored, the task keeps its own state.
    await call(alex, 'DELETE', `/api/calendar/events/${done.id}`);
    await restore((await bin(alex, 'calendar')).find(entry => entry.title === 'Padded done').id);
    const [back] = await rowsTitled('Padded done');
    assert.equal(back.uid, `${kept} `, 'under the server\'s UID');
    assert.equal(back.todo_status, 'done', 'its done state back');
    assert.deepEqual(await stepsOf(back.id), [['Kept step', true]], 'its subtasks back');
    assert.equal(await count('SELECT COUNT(*) AS n FROM calendar_overlay_restores WHERE calendar_id = ? AND uid COLLATE utf8mb4_nopad_bin IN (?, ?)', [work, kept, `${kept} `]), 0, 'no state left waiting');
    // The hand order, also after the server changed the task.
    assert.equal((await hand('Padded ranked')).sort_rank, 111);
    server.store(`${WORK}padded-ranked.ics`, eventIcs(`${ranked} `, 'Padded ranked', clock, ['DESCRIPTION:Changed at the server']));
    await sync();
    const after = await hand('Padded ranked');
    assert.deepEqual([after.hand_ordered, after.sort_rank], [true, 111], 'its hand place stays');
    // Two items could own the trimmed UID's rank: it stays with the one whose UID it is.
    assert.equal((await rowsTitled('Twin padded'))[0].uid, `${twin} `);
    assert.equal((await rowsTitled('Twin plain'))[0].uid, twin);
    assert.deepEqual([(await hand('Twin plain')).sort_rank, (await hand('Twin padded')).hand_ordered], [222, false]);
  });

  await t.test('a read-only or removed calendar: restored into the default list instead', async () => {
    const readOnly = await serverTask('Now read-only');
    const removed = await serverTask('Calendar removed');
    await call(alex, 'DELETE', `/api/calendar/events/${readOnly.id}`);
    await call(alex, 'DELETE', `/api/calendar/events/${removed.id}`);
    const items = await bin(alex, 'calendar');
    const { resolveCalendarDefaults } = require('../dist/src/services/calendar') as typeof import('../src/services/calendar');
    const { taskListId: defaultList } = await resolveCalendarDefaults(users.alex);
    await pool.execute('UPDATE calendar_calendars SET read_only = 1 WHERE id = ?', [work]);
    server.remote.writes.length = 0;
    const first = await restore(items.find(entry => entry.title === 'Now read-only').id);
    assert.match(first.restored[0].note, /read-only now/);
    assert.deepEqual(server.remote.writes, [], 'nothing written to a read-only calendar');
    assert.equal((await rowsTitled('Now read-only'))[0].calendar_id, defaultList);
    assert.equal((await rowsTitled('Now read-only'))[0].todo_status, 'done');
    await pool.execute('DELETE FROM calendar_calendars WHERE id = ?', [work]);
    const second = await restore(items.find(entry => entry.title === 'Calendar removed').id);
    assert.match(second.restored[0].note, /calendar is gone/);
    const [row] = await rowsTitled('Calendar removed');
    assert.deepEqual([row.calendar_id, row.uid], [defaultList, removed.uid], 'its identity kept');
    assert.deepEqual(await stepsOf(row.id), [['Only step', true]]);
  });

  await t.test('a calendar gone with its account: the person chooses another of their calendars, and a repeating item goes there whole', async () => {
    await sync();
    const [[{ id: workAgain }]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_calendars WHERE account_id = ? AND name = 'Work'", [accountId]);
    clock += 86400000;
    const uid = `${crypto.randomUUID()}@example.test`;
    server.store(`${WORK}daily-check.ics`, eventIcs(uid, 'Daily check', clock, ['RRULE:FREQ=DAILY;COUNT=3']));
    await sync();
    const dates = (await pool.query<RowDataPacket[]>("SELECT id FROM calendar_events WHERE user_id = ? AND calendar_id = ? AND title = 'Daily check' ORDER BY start_time", [users.alex, workAgain]))[0];
    assert.equal(dates.length, 3);
    for (const [index, date] of dates.entries()) {
      await pool.execute('INSERT INTO calendar_event_subtasks (id, event_id, user_id, title, is_done, position) VALUES (?, ?, ?, ?, FALSE, 0)', [crypto.randomUUID(), date.id, users.alex, `Check ${index}`]);
    }
    await call(alex, 'DELETE', `/api/calendar/events/${dates[0].id}?scope=series`);
    const item = (await bin(alex, 'calendar')).find(entry => entry.title === 'Daily check');
    await call(alex, 'DELETE', `/api/calendar/accounts/${accountId}`);
    const failure = async (body: object) => (await call(alex, 'POST', '/api/bin/restore', { ids: [item.id], ...body })).failed[0]?.code;
    assert.equal(await failure({}), 'BIN_RESTORE_NEEDS_CALENDAR', 'its own calendar is gone');
    const { calendarId: blairsList } = await ensureDefaultLocalCalendarForUser(users.blair);
    assert.equal(await failure({ calendar_id: blairsList }), 'BIN_RESTORE_CALENDAR_NOT_FOUND', 'another person\'s calendar is not one to choose');
    const { calendarId: ownList } = await ensureDefaultLocalCalendarForUser(users.alex);
    assert.equal(await failure({ calendar_id: ownList }), 'BIN_RESTORE_NEEDS_CALENDAR', 'a UniHub list cannot hold it whole');
    assert.equal((await rowsTitled('Daily check')).length, 0);
    // The same server, connected again: its calendars have new ids.
    const again = crypto.randomUUID();
    await insertCalDavAccount(pool, encrypt, users.alex, again);
    await calendarSync.syncCalendarAccount(again, { userId: users.alex, full: true });
    const [[{ id: chosen }]] = await pool.query<RowDataPacket[]>("SELECT id FROM calendar_calendars WHERE account_id = ? AND name = 'Work'", [again]);
    const answer = await call(alex, 'POST', `/api/bin/${item.id}/restore`, { calendar_id: chosen });
    assert.equal(answer.restored[0].pending, undefined, 'the server confirmed');
    assert.equal(server.copiesOf('Daily check').length, 1, 'created at the chosen calendar, once');
    const back = (await pool.query<RowDataPacket[]>("SELECT id, calendar_id, uid FROM calendar_events WHERE user_id = ? AND title = 'Daily check' ORDER BY start_time", [users.alex]))[0];
    assert.deepEqual(back.map(row => [row.calendar_id, row.uid]), [[chosen, uid], [chosen, uid], [chosen, uid]], 'every date, under its UID');
    assert.deepEqual(await Promise.all(back.map(async row => (await stepsOf(row.id)).map(([title]) => title))), [['Check 0'], ['Check 1'], ['Check 2']], 'every date keeps its own');
    assert.ok(!(await bin(alex, 'calendar')).some(entry => entry.id === item.id));
    // A UniHub task goes back to a UniHub list only.
    const local = (await call(alex, 'POST', '/api/calendar/events', { title: 'List only', start_time: new Date(clock).toISOString(), end_time: new Date(clock + 3600000).toISOString(), calendar_id: ownList })).event;
    await call(alex, 'DELETE', `/api/calendar/events/${local.id}`);
    const localItem = (await bin(alex, 'calendar')).find(entry => entry.title === 'List only');
    assert.equal((await call(alex, 'POST', `/api/bin/${localItem.id}/restore`, { calendar_id: chosen }, 409)).code, 'BIN_RESTORE_NEEDS_LIST');
    await restore(localItem.id);
  });
});
