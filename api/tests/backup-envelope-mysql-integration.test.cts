import type { FixtureValue } from './helpers/test-types.cts';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const http = (require('node:http') as typeof import('node:http'));
const fs = (require('node:fs/promises') as typeof import('node:fs/promises'));
const os = (require('node:os') as typeof import('node:os'));
const path = (require('node:path') as typeof import('node:path'));
const crypto = (require('node:crypto') as typeof import('node:crypto'));
const { createBackupRuntime } = require('./helpers/isolated-backup-runtime.cts');
const { readZip, sevenZipBinary, sevenZip } = require('./helpers/winzip-aes-reader.cts');
const ICAL: FixtureValue = require('ical.js');

// D37 (0.28): a user backup is an AES-encrypted ZIP that other programs open
// with the recovery password, holding readable mail, contacts, calendars and
// recordings. Synthetic data, the real request handler and a disposable
// database; the archive is opened by a reader written apart from the writer
// (helpers/winzip-aes-reader.cts) and, where installed, by 7-Zip.

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
function wav(seed: number) {
  const bytes = Buffer.alloc(76);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32, 40);
  for (let index = 0; index < 16; index++) bytes.writeInt16LE(Math.round(Math.sin(index + seed) * 1000), 44 + index * 2);
  return bytes;
}

// A stored ZIP built by hand, so a test can name entries the app's writer would refuse.
function handZip(entries: { name: string; data: Buffer }[]) {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (data: Buffer) => { let c = -1; for (const byte of data) c = (c >>> 8) ^ crcTable[(c ^ byte) & 0xff]; return (c ^ -1) >>> 0; };
  for (const entry of entries) {
    const name = Buffer.from(entry.name), local = Buffer.alloc(30), head = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc(entry.data), 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8);
    head.writeUInt32LE(crc(entry.data), 16); head.writeUInt32LE(entry.data.length, 20); head.writeUInt32LE(entry.data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, name, entry.data); central.push(head, name);
    offset += 30 + name.length + entry.data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// What every file system UniHub's users have accepts as a name.
function assertPortable(entryName: string) {
  for (const part of entryName.split('/')) {
    assert.ok(part.length > 0 && Buffer.byteLength(part) <= 255, `${entryName}: part length`);
    // eslint-disable-next-line no-control-regex -- the control characters are what it refuses
    assert.doesNotMatch(part, /[\u0000-\u001f\u007f<>:"\\|?*\u202a-\u202e\u2066-\u2069]/, `${entryName}: forbidden character`);
    assert.doesNotMatch(part, /[. ]$/, `${entryName}: trailing dot or space`);
    assert.doesNotMatch(part, /^\./, `${entryName}: leading dot`);
    assert.doesNotMatch(part.split('.')[0], /^(con|prn|aux|nul|com\d|lpt\d)$/i, `${entryName}: reserved name`);
  }
}

test('a user backup is an encrypted ZIP other programs open, with readable mail, contacts, calendars and recordings, and it restores', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async t => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-envelope-'));
  let server: FixtureValue; let owned = false;
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    const runtime = createBackupRuntime(directory, 'envelope-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    const loginPassword = 'envelope-fixture-password-2026';
    const passwordHash = await require('bcryptjs').hash(loginPassword, 10);
    const users: Record<string, string> = {};
    for (const name of ['source', 'destination']) {
      users[name] = crypto.randomUUID();
      await pool.execute<ResultSetHeader>('INSERT INTO users (id,email,password_hash,full_name,timezone) VALUES (?,?,?,?,?)', [users[name], `${name}@example.test`, passwordHash, name, 'Europe/Vienna']);
    }
    const insert = async (table: string, row: Record<string, unknown>) => {
      const keys = Object.keys(row);
      await pool.execute(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(key => row[key]) as FixtureValue);
    };
    const { handleRequest } = runtime('request-handler');
    server = http.createServer((req, res) => handleRequest(req, res).catch((error: FixtureValue) => res.destroy(error)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    function session() {
      const cookies = new Map(); let csrf: FixtureValue;
      const request = async (method: string, route: string, body?: FixtureValue, expected = 200, binary = false) => {
        const response = await fetch(base + '/api' + route, { method, headers: {
          ...(body === undefined ? {} : { 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json' }),
          ...(cookies.size ? { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}),
          ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
        }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body as FixtureValue : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        for (const cookie of response.headers.getSetCookie()) { const pair = cookie.split(';')[0]; const separator = pair.indexOf('='); cookies.set(pair.slice(0, separator), pair.slice(separator + 1)); }
        const result = binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
        assert.equal(response.status, expected, `${method} ${route}: ${binary ? response.status : JSON.stringify(result)}`);
        if (result.csrfToken) csrf = result.csrfToken;
        if (binary) (result as FixtureValue).headers = response.headers;
        return result;
      };
      return request;
    }
    async function settle(read: () => Promise<FixtureValue>, statuses: string[]) {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const { job } = await read();
        if (statuses.includes(job.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(`The job never reached ${statuses.join(' or ')}`);
    }
    const source = session(), destination = session();
    for (const [request, name] of [[source, 'source'], [destination, 'destination']] as const) await request('POST', '/auth/signin', { email: `${name}@example.test`, password: loginPassword });

    // Download-mode mail with hostile folder and subject names.
    const uploads = (...parts: string[]) => path.join(directory, ...parts);
    const accountId = crypto.randomUUID();
    await insert('mail_accounts', { id: accountId, user_id: users.source, email_address: 'owner@example.test', provider: 'custom', username: 'owner@example.test', imap_host: '192.0.2.10', smtp_host: '192.0.2.11', is_active: 1, sync_mode: 'download', sync_status: 'idle' });
    await insert('mail_folders', { id: crypto.randomUUID(), user_id: users.source, slug: 'hostile', display_name: 'Projects/CON/..', position: 7, is_system: 0, mail_account_id: accountId });
    await insert('mail_folders', { id: crypto.randomUUID(), user_id: users.source, slug: 'plain', display_name: 'Receipts', position: 8, is_system: 0, mail_account_id: accountId });
    // A subfolder named as a message of its parent is named, and two folders
    // whose portable names agree (R1 F1).
    // And (R2-F1) two folders that share their first eight levels, and two
    // folder records with the same name.
    for (const [slug, display] of [['collide', 'Receipts/00001 2030-01-04 Same.eml'], ['workcolon', 'Work:Docs'], ['workquestion', 'Work?Docs'],
      ['deep_i', 'A/B/C/D/E/F/G/H/I'], ['deep_j', 'A/B/C/D/E/F/G/H/J'], ['twin_1', 'Twin'], ['twin_2', 'Twin']]) {
      await insert('mail_folders', { id: crypto.randomUUID(), user_id: users.source, slug, display_name: display, position: 9, is_system: 0, mail_account_id: accountId });
    }
    const messages = [
      { folder: 'hostile', subject: 'a/b\\c:d*e?f"g|h<i>', received: '2030-01-02 08:00:00' },
      { folder: 'hostile', subject: 'invoice\u202Egpj.exe', received: '2030-01-03 08:00:00' },
      { folder: 'plain', subject: 'Same', received: '2030-01-04 08:00:00' },
      { folder: 'plain', subject: 'Same', received: '2030-01-04 08:00:00' },
      { folder: 'plain', subject: '   ', received: '2030-01-05 08:00:00' },
      { folder: 'plain', subject: 'Ünïcødé — ' + 'long '.repeat(60), received: '2030-01-06 08:00:00' },
      { folder: 'collide', subject: 'Child', received: '2030-01-07 08:00:00' },
      { folder: 'workcolon', subject: 'Colon', received: '2030-01-08 08:00:00' },
      { folder: 'workquestion', subject: 'Question', received: '2030-01-09 08:00:00' },
      { folder: 'deep_i', subject: 'Deep I', received: '2030-01-10 08:00:00' },
      { folder: 'deep_j', subject: 'Deep J', received: '2030-01-11 08:00:00' },
      { folder: 'twin_1', subject: 'Twin one', received: '2030-01-12 08:00:00' },
      { folder: 'twin_2', subject: 'Twin two', received: '2030-01-13 08:00:00' },
    ];
    const rawById = new Map<string, Buffer>();
    for (const [index, message] of messages.entries()) {
      const id = crypto.randomUUID();
      const raw = Buffer.from(`From: sender@example.test\r\nTo: owner@example.test\r\nMessage-ID: <envelope-${index}@example.test>\r\nSubject: ${message.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGrüße, message ${index}.\r\n`);
      const rawPath = uploads('mail-raw', users.source, `${id}.eml`);
      await fs.mkdir(path.dirname(rawPath), { recursive: true }); await fs.writeFile(rawPath, raw);
      rawById.set(id, raw);
      await insert('emails', { id, user_id: users.source, mail_account_id: accountId, message_id: `<envelope-${index}@example.test>`, subject: message.subject, from_address: 'sender@example.test',
        to_addresses: JSON.stringify(['owner@example.test']), body_text: `Grüße, message ${index}.`, folder: message.folder, raw_storage_path: rawPath, raw_sha256: sha256(raw), raw_bytes: raw.length,
        raw_format: 'exact_octets', raw_verified: 1, received_at: message.received, import_complete: 1 });
    }
    // Recordings, two with one title and one with a title of only dots.
    const audioByTitle = new Map<string, Buffer>();
    for (const [index, title] of ['Memo', 'memo', 'Lecture: 1/2 "intro"', '...'].entries()) {
      const id = crypto.randomUUID(), audio = wav(index);
      const audioPath = uploads('recordings', users.source, `${id}.wav`);
      await fs.mkdir(path.dirname(audioPath), { recursive: true }); await fs.writeFile(audioPath, audio);
      audioByTitle.set(title, audio);
      await insert('recordings', { id, user_id: users.source, title, original_filename: 'tone.WAV', content_type: 'audio/wav', size_bytes: audio.length, storage_path: audioPath, source: 'recorded', category: 'none' });
    }
    await source('POST', '/contacts', { first_name: 'Zoë', last_name: 'Example', email: 'zoe@example.test' });
    await source('POST', '/contacts', { first_name: 'Ana', last_name: 'Example', email: 'ana@example.test' });
    // A local calendar with an event, a finished ToDo and its subtasks.
    const localAccount = crypto.randomUUID(), calendarId = crypto.randomUUID(), eventId = crypto.randomUUID(), taskId = crypto.randomUUID();
    await insert('calendar_accounts', { id: localAccount, user_id: users.source, provider: 'local', display_name: 'UniHub', is_active: 1 });
    await insert('calendar_calendars', { id: calendarId, user_id: users.source, account_id: localAccount, name: 'Home: Errands?', color: '#22c55e', is_visible: 1 });
    await insert('calendar_events', { id: eventId, user_id: users.source, calendar_id: calendarId, uid: 'envelope-event@example.test', title: 'Dentist', start_time: '2030-02-04 09:00:00', end_time: '2030-02-04 09:30:00', recurrence: 'FREQ=WEEKLY;COUNT=3', location: 'Graz' });
    // All-day events (R1 F2): a range ending at a time on its last day, one
    // stored from local midnight to local midnight, and one over the change
    // to summer time (Europe/Vienna, 2030-03-31).
    for (const [title, start, end] of [['Trip', '2030-03-01 09:00:00', '2030-03-03 17:00:00'], ['Holiday', '2030-03-10 23:00:00', '2030-03-12 23:00:00'],
      ['Clock change', '2030-03-30 23:00:00', '2030-03-31 22:00:00']]) {
      await insert('calendar_events', { id: crypto.randomUUID(), user_id: users.source, calendar_id: calendarId, uid: `envelope-${title.replace(' ', '-').toLowerCase()}@example.test`, title, start_time: start, end_time: end, all_day: 1 });
    }
    await insert('calendar_events', { id: taskId, user_id: users.source, calendar_id: calendarId, uid: 'envelope-task@example.test', title: 'Post the letter', start_time: '2030-02-05 00:00:00', end_time: '2030-02-05 00:00:00', is_todo_only: 1, todo_status: 'done', done_at: '2030-02-05 10:00:00' });
    await insert('calendar_event_subtasks', { id: crypto.randomUUID(), user_id: users.source, event_id: taskId, title: 'Buy stamps', is_done: 1, position: 0 });
    await insert('calendar_event_subtasks', { id: crypto.randomUUID(), user_id: users.source, event_id: taskId, title: 'Find the address', is_done: 0, position: 1 });

    // The export, through the request handler.
    const created = await source('POST', '/backup/jobs', { sections: 'full' }, 202);
    const job = await settle(() => source('GET', `/backup/jobs/${created.job.id}`), ['ready', 'failed']);
    assert.equal(job.status, 'ready', job.error);
    const { recovery_password: password } = await source('POST', `/backup/jobs/${job.id}/recovery-password/reveal`, {});
    const archive = await source('GET', `/backup/jobs/${job.id}/download`, undefined, 200, true);
    assert.match(archive.headers.get('content-type'), /^application\/zip/);
    assert.match(archive.headers.get('content-disposition'), /\.zip"/);
    await fs.writeFile(uploads('download.zip'), archive);

    // The envelope: a plain README and one encrypted entry; nothing else is readable without the password.
    assert.throws(() => readZip(archive), /unihub-backup\.zip is encrypted/);
    assert.throws(() => readZip(archive, 'not-the-password'), /wrong password/);
    const outer = readZip(archive, password);
    assert.deepEqual(outer.map((entry: FixtureValue) => [entry.name, entry.encrypted]), [['README.txt', false], ['unihub-backup.zip', true]]);
    assert.match(outer[0].data.toString('utf8'), /recovery password/);
    assert.equal(archive.includes(Buffer.from('Grüße, message 0')), false, 'no message text is readable in the file');
    assert.equal(archive.includes(Buffer.from('owner@example.test')), false, 'no names are readable in the file');
    const inner: { name: string; data: Buffer }[] = readZip(outer[1].data);
    const byName = new Map(inner.map(entry => [entry.name, entry.data]));
    for (const entry of inner) assertPortable(entry.name);
    assert.equal(new Set(inner.map(entry => entry.name.normalize('NFC').toLowerCase())).size, inner.length, 'names are unique as Windows and macOS compare them');

    // Mail: each stored message once, byte for byte, under its account and folder.
    const eml = inner.filter(entry => entry.name.startsWith('Mail/'));
    assert.equal(eml.length, messages.length);
    for (const raw of rawById.values()) assert.equal(inner.filter(entry => entry.data.equals(raw)).length, 1, 'each message is stored once');
    assert.ok(byName.has('Mail/owner@example.test/Projects/_CON/Folder/00001 2030-01-02 a_b_c_d_e_f_g_h_i_.eml'), [...byName.keys()].join('\n'));
    assert.ok(byName.has('Mail/owner@example.test/Projects/_CON/Folder/00002 2030-01-03 invoice_gpj.exe.eml'));
    // The subfolder keeps its name; the message it would have hidden gets "(2)".
    assert.ok(byName.has('Mail/owner@example.test/Receipts/00001 2030-01-04 Same.eml/00001 2030-01-07 Child.eml'));
    assert.ok(byName.has('Mail/owner@example.test/Receipts/00001 2030-01-04 Same (2).eml'));
    assert.ok(byName.has('Mail/owner@example.test/Receipts/00002 2030-01-04 Same.eml'));
    assert.ok(byName.has('Mail/owner@example.test/Work_Docs/00001 2030-01-08 Colon.eml'));
    assert.ok(byName.has('Mail/owner@example.test/Work_Docs (2)/00001 2030-01-09 Question.eml'));
    // Every source folder keeps a folder of its own: past eight levels the
    // rest of the path is in the last folder's name, and two records with one
    // name are two folders (R2-F1).
    assert.ok(byName.has('Mail/owner@example.test/A/B/C/D/E/F/G/H - I/00001 2030-01-10 Deep I.eml'), [...byName.keys()].filter(name => name.includes('/A/')).join('\n'));
    assert.ok(byName.has('Mail/owner@example.test/A/B/C/D/E/F/G/H - J/00001 2030-01-11 Deep J.eml'));
    assert.ok(byName.has('Mail/owner@example.test/Twin/00001 2030-01-12 Twin one.eml'));
    assert.ok(byName.has('Mail/owner@example.test/Twin (2)/00001 2030-01-13 Twin two.eml'));
    const archived = JSON.parse(byName.get('UniHub restore data/backup.json')!.toString('utf8'));
    const dirsBySlug = new Map<string, Set<string>>();
    for (const file of archived.files.filter((item: FixtureValue) => item.kind === 'raw_email')) {
      const slug = archived.data.emails.find((email: FixtureValue) => email.id === file.id).folder;
      dirsBySlug.set(slug, new Set([...(dirsBySlug.get(slug) || []), path.posix.dirname(file.archive_path).normalize('NFC').toUpperCase()]));
    }
    assert.ok([...dirsBySlug.values()].every(dirs => dirs.size === 1), 'a source folder is one readable folder');
    assert.equal(new Set([...dirsBySlug.values()].flatMap(dirs => [...dirs])).size, dirsBySlug.size, 'and no two share one');
    // No file has the name, as Windows and macOS compare names, of a folder another file is in.
    const folderNames = new Set(inner.flatMap(entry => entry.name.split('/').slice(0, -1).map((_, at, parts) => parts.slice(0, at + 1).join('/').normalize('NFC').toLowerCase())));
    assert.deepEqual(inner.filter(entry => folderNames.has(entry.name.normalize('NFC').toLowerCase())).map(entry => entry.name), []);
    assert.ok(byName.has('Mail/owner@example.test/Receipts/00003 2030-01-05 (no subject).eml'));
    assert.ok(eml.every(entry => Buffer.byteLength(path.posix.basename(entry.name)) <= 104));
    // Recordings: the original bytes, unique names.
    const recordingNames = inner.filter(entry => entry.name.startsWith('Recordings/')).map(entry => entry.name);
    assert.deepEqual(recordingNames.map(name => name.toLowerCase()).sort(),
      ['recordings/lecture_ 1_2 _intro_.wav', 'recordings/memo (2).wav', 'recordings/memo.wav', 'recordings/recording.wav']);
    assert.ok(byName.get('Recordings/Lecture_ 1_2 _intro_.wav')!.equals(audioByTitle.get('Lecture: 1/2 "intro"')!));
    assert.ok(byName.get('Recordings/Recording.wav')!.equals(audioByTitle.get('...')!));
    // "Memo" and "memo" are one name on Windows and macOS: the second gets "(2)".
    for (const title of ['Memo', 'memo']) {
      const name = recordingNames.find(entry => entry.replace(' (2)', '') === `Recordings/${title}.wav`)!;
      assert.ok(byName.get(name)!.equals(audioByTitle.get(title)!), title);
    }
    // Contacts: vCard 4.0 that a calendar library parses.
    const vcf = byName.get('Contacts/Contacts.vcf')!.toString('utf8');
    const cards = ICAL.parse(vcf);
    const parsedCards = (Array.isArray(cards[0]) ? cards : [cards]).map((jcal: FixtureValue) => new ICAL.Component(jcal));
    assert.deepEqual(parsedCards.map((card: FixtureValue) => card.getFirstPropertyValue('fn')).sort(), ['Ana Example', 'Zoë Example']);
    assert.ok(parsedCards.every((card: FixtureValue) => card.getFirstPropertyValue('version') === '4.0'));
    // Calendars: iCalendar with the event, the finished task and its subtasks.
    const ics = byName.get('Calendars/Home_ Errands_.ics')!.toString('utf8');
    const calendar = new ICAL.Component(ICAL.parse(ics));
    const event = calendar.getAllSubcomponents('vevent').find((item: FixtureValue) => item.getFirstPropertyValue('uid') === 'envelope-event@example.test');
    assert.equal(event.getFirstPropertyValue('summary'), 'Dentist');
    assert.equal(event.getFirstPropertyValue('uid'), 'envelope-event@example.test');
    assert.equal(event.getFirstPropertyValue('dtstart').toJSDate().toISOString(), '2030-02-04T09:00:00.000Z');
    assert.equal(String(event.getFirstPropertyValue('rrule')), 'FREQ=WEEKLY;COUNT=3');
    const todos = calendar.getAllSubcomponents('vtodo');
    const task = todos.find((todo: FixtureValue) => todo.getFirstPropertyValue('uid') === 'envelope-task@example.test');
    assert.equal(task.getFirstPropertyValue('status'), 'COMPLETED');
    // A ToDo-only task has no date in UniHub, so none outside it either (R1 F4).
    assert.deepEqual([task.hasProperty('due'), task.hasProperty('dtstart')], [false, false]);
    // All-day events end, exclusively, the day after their last day (R1 F2).
    const allDay = Object.fromEntries(calendar.getAllSubcomponents('vevent').filter((item: FixtureValue) => item.getFirstPropertyValue('dtstart').isDate)
      .map((item: FixtureValue) => [item.getFirstPropertyValue('summary'), [String(item.getFirstPropertyValue('dtstart')), String(item.getFirstPropertyValue('dtend'))]]));
    assert.deepEqual(allDay, { Trip: ['2030-03-01', '2030-03-04'], Holiday: ['2030-03-11', '2030-03-13'], 'Clock change': ['2030-03-31', '2030-04-01'] });
    assert.equal(task.getFirstPropertyValue('completed').toJSDate().toISOString(), '2030-02-05T10:00:00.000Z');
    const subtasks = todos.filter((todo: FixtureValue) => todo.getFirstPropertyValue('related-to') === 'envelope-task@example.test');
    assert.deepEqual(subtasks.map((todo: FixtureValue) => [todo.getFirstPropertyValue('summary'), todo.getFirstPropertyValue('status')]), [['Buy stamps', 'COMPLETED'], ['Find the address', 'NEEDS-ACTION']]);
    // Restore data: backup.json names the readable files; the manifest the envelope's UUID.
    const manifest = JSON.parse(byName.get('UniHub restore data/manifest.json')!.toString('utf8'));
    assert.equal(manifest.format_version, 2);
    assert.equal(manifest.backup_uuid, job.backup_uuid);
    assert.deepEqual(manifest.derived_files, ['Contacts/Contacts.vcf', 'Calendars/Home_ Errands_.ics']);
    const backup = JSON.parse(byName.get('UniHub restore data/backup.json')!.toString('utf8'));
    assert.ok(backup.files.filter((file: FixtureValue) => file.kind === 'raw_email').every((file: FixtureValue) => file.archive_path.startsWith('Mail/') && byName.has(file.archive_path)));
    assert.equal(archive.includes(Buffer.from(password)), false);

    // 7-Zip, where installed (CI images carry 7z), opens the same file.
    const binary = sevenZipBinary();
    t.diagnostic(binary ? `7-Zip: ${binary}` : '7-Zip: not installed, the independent reader alone opened the archive');
    if (binary) {
      assert.equal(sevenZip(binary, uploads('download.zip'), uploads('7z-outer'), password), 0);
      assert.notEqual(sevenZip(binary, uploads('download.zip'), uploads('7z-wrong'), 'not-the-password'), 0);
      assert.equal(sevenZip(binary, uploads('7z-outer', 'unihub-backup.zip'), uploads('7z-inner'), ''), 0);
      // Every message extracts, byte for byte (R1 F1: a file in a folder's place stopped 7-Zip).
      const extracted = await fs.readdir(uploads('7z-inner', 'Mail'), { recursive: true, withFileTypes: true });
      const onDisk = await Promise.all(extracted.filter(entry => entry.isFile()).map(entry => fs.readFile(path.join(entry.parentPath, entry.name))));
      assert.deepEqual(onDisk.map(sha256).sort(), [...rawById.values()].map(sha256).sort());
    }

    // Round trip: another person uploads it, unlocks it with the password and restores it.
    const imported = await destination('POST', '/backup/import?sections=full', archive, 202);
    assert.equal(imported.job.status, 'awaiting_password');
    assert.equal(imported.job.is_encrypted, true);
    await destination('POST', `/backup/restore-jobs/${imported.job.id}/unlock`, { password: 'not-the-password' }, 400);
    await destination('POST', `/backup/restore-jobs/${imported.job.id}/unlock`, { password }, 202);
    const validated = await settle(() => destination('GET', `/backup/restore-jobs/${imported.job.id}`), ['validated', 'failed']);
    assert.equal(validated.status, 'validated', validated.error);
    await destination('POST', `/backup/restore-jobs/${imported.job.id}/start`, {}, 202);
    const restored = await settle(() => destination('GET', `/backup/restore-jobs/${imported.job.id}`), ['completed', 'failed']);
    assert.equal(restored.status, 'completed', restored.error);
    const [restoredMail] = await pool.execute<RowDataPacket[]>('SELECT raw_storage_path FROM emails WHERE user_id = ?', [users.destination]);
    assert.equal(restoredMail.length, messages.length);
    const restoredRaw = await Promise.all(restoredMail.map(row => fs.readFile(row.raw_storage_path)));
    assert.deepEqual(restoredRaw.map(sha256).sort(), [...rawById.values()].map(sha256).sort());
    const [restoredAudio] = await pool.execute<RowDataPacket[]>('SELECT title, storage_path FROM recordings WHERE user_id = ?', [users.destination]);
    for (const row of restoredAudio) assert.ok((await fs.readFile(row.storage_path)).equals(audioByTitle.get(row.title)!));
    assert.equal((await destination('GET', '/contacts')).contacts.length, 2);
    const [restoredTasks] = await pool.execute<RowDataPacket[]>('SELECT todo_status FROM calendar_events WHERE user_id = ? AND is_todo_only = 1', [users.destination]);
    assert.deepEqual(restoredTasks.map(row => row.todo_status), ['done']);

    // The server opens its own backup without the password.
    const again = await source('POST', '/backup/import?sections=contacts', archive, 202);
    assert.equal(again.job.status, 'uploaded');
    assert.equal((await settle(() => source('GET', `/backup/restore-jobs/${again.job.id}`), ['validated', 'failed'])).status, 'validated');

    // Once the sweep has removed an upload past its seven days, unlock and
    // start say so and how to go on, through the request handler (R3-F2).
    const stale = await destination('POST', '/backup/import?sections=full', archive, 202);
    assert.equal(stale.job.status, 'awaiting_password');
    await pool.execute('UPDATE backup_restore_jobs SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id IN (?, ?)', [stale.job.id, again.job.id]);
    assert.ok(await runtime('services/backup-restore-jobs').cleanupExpiredRestoreArchives() >= 2);
    const expiredAnswer = { error: 'This uploaded backup has expired. Upload it again to restore it.' };
    assert.deepEqual(await destination('POST', `/backup/restore-jobs/${stale.job.id}/unlock`, { password }, 410), expiredAnswer);
    assert.deepEqual(await source('POST', `/backup/restore-jobs/${again.job.id}/start`, {}, 410), expiredAnswer);

    // A changed byte in the encrypted entry is refused after the password was right.
    const envelope = runtime('services/backup-envelope');
    const tampered = Buffer.from(archive);
    // Past the salt and the password verifier, inside the ciphertext.
    tampered[(await envelope.readBackupEnvelope(uploads('download.zip'))).dataStart + 18 + 200] ^= 0x01;
    const damaged = await destination('POST', '/backup/import?sections=full', tampered, 202);
    await destination('POST', `/backup/restore-jobs/${damaged.job.id}/unlock`, { password }, 202);
    const refused = await settle(() => destination('GET', `/backup/restore-jobs/${damaged.job.id}`), ['validated', 'failed']);
    assert.equal(refused.status, 'failed');
    assert.match(refused.error, /password is incorrect or the backup is damaged/);

    // An archive whose inner ZIP names a path outside it is refused.
    const hostileUuid = crypto.randomUUID(), hostilePassword = 'hostile-synthetic-password';
    await fs.writeFile(uploads('hostile-inner.zip'), handZip([
      { name: 'UniHub restore data/manifest.json', data: Buffer.from('{}') },
      { name: '../escape.eml', data: Buffer.from('From: x@example.test\r\n\r\n') },
    ]));
    await envelope.writeBackupEnvelope(uploads('hostile-inner.zip'), uploads('hostile.zip'), { password: hostilePassword, backupUuid: hostileUuid });
    const hostile = await destination('POST', '/backup/import?sections=full', await fs.readFile(uploads('hostile.zip')), 202);
    await destination('POST', `/backup/restore-jobs/${hostile.job.id}/unlock`, { password: hostilePassword }, 202);
    const unsafe = await settle(() => destination('GET', `/backup/restore-jobs/${hostile.job.id}`), ['validated', 'failed']);
    assert.equal(unsafe.status, 'failed');
    assert.match(unsafe.error, /unsafe entry path: \.\.\/escape\.eml/);
    // A file whose comment names a UniHub backup but whose entries are not the envelope's.
    const fake = handZip([{ name: 'README.txt', data: Buffer.from('x') }]);
    const comment = Buffer.from(`UniHub backup ${crypto.randomUUID()}`);
    const forged = Buffer.concat([fake.subarray(0, fake.length - 2), Buffer.from([comment.length, 0]), comment]);
    await destination('POST', '/backup/import?sections=full', forged, 400);

    // The per-account mail backup uses the same envelope and holds that account's mail only.
    const accountJob = await source('POST', `/mail/accounts/${accountId}/backup-export`, {}, 202);
    const accountReady = await settle(() => source('GET', `/backup/jobs/${accountJob.job.id}`), ['ready', 'failed']);
    assert.equal(accountReady.status, 'ready', accountReady.error);
    const accountKey = await source('POST', `/backup/jobs/${accountReady.id}/recovery-password/reveal`, {});
    const accountArchive = await source('GET', `/backup/jobs/${accountReady.id}/download`, undefined, 200, true);
    const accountInner: { name: string }[] = readZip(readZip(accountArchive, accountKey.recovery_password)[1].data);
    assert.equal(accountInner.filter(entry => entry.name.startsWith('Mail/owner@example.test/')).length, messages.length);
    assert.equal(accountInner.some(entry => /^(Contacts|Calendars|Recordings)\//.test(entry.name)), false);

    // The vCard copy holds the contacts the snapshot holds, also when one is
    // deleted while the archive is written (R1 F3): the deletion lands just
    // before the vCard records are read.
    await source('POST', '/contacts', { first_name: 'Deleted', last_name: 'Meanwhile', email: 'meanwhile@example.test' });
    const [[meanwhile]] = await pool.execute<RowDataPacket[]>("SELECT id FROM contacts WHERE user_id = ? AND first_name = 'Deleted'", [users.source]);
    const contactsExport = runtime('services/contacts-export');
    const readCards = contactsExport.exportContacts;
    // Another client's connection, as the deletion would come from a request.
    const other = await mysql.createConnection({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD });
    contactsExport.exportContacts = async (...args: FixtureValue[]) => {
      await other.execute('DELETE FROM contacts WHERE id = ?', [meanwhile.id]);
      return readCards(...args);
    };
    try {
      const raced = await source('POST', '/backup/jobs', { sections: ['contacts'] }, 202);
      const racedReady = await settle(() => source('GET', `/backup/jobs/${raced.job.id}`), ['ready', 'failed']);
      assert.equal(racedReady.status, 'ready', racedReady.error);
      const racedKey = await source('POST', `/backup/jobs/${racedReady.id}/recovery-password/reveal`, {});
      const racedInner = new Map<string, Buffer>(readZip(readZip(await source('GET', `/backup/jobs/${racedReady.id}/download`, undefined, 200, true), racedKey.recovery_password)[1].data)
        .map((entry: FixtureValue) => [entry.name, entry.data]));
      const racedBackup = JSON.parse(racedInner.get('UniHub restore data/backup.json')!.toString('utf8'));
      assert.ok(racedBackup.data.contacts.some((row: FixtureValue) => row.id === meanwhile.id), 'backup.json holds the contact');
      const racedCards = ICAL.parse(racedInner.get('Contacts/Contacts.vcf')?.toString('utf8') ?? '');
      const racedNames = (Array.isArray(racedCards[0]) ? racedCards : [racedCards]).map((jcal: FixtureValue) => new ICAL.Component(jcal).getFirstPropertyValue('fn'));
      assert.deepEqual(racedNames.sort(), ['Ana Example', 'Deleted Meanwhile', 'Zoë Example']);
    } finally {
      contactsExport.exportContacts = readCards;
      await other.end();
    }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (owned) { const connection = await pool.getConnection(); try { await connection.query('SET FOREIGN_KEY_CHECKS=0'); const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES'); for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]); } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); } }
    await pool.end(); await fs.rm(directory, { recursive: true, force: true });
  }
});

test('uploaded restore archives expire after seven days, never while a restore uses them', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async () => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const pool = mysql.createPool({ host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, connectionLimit: 8, timezone: 'Z' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-restore-expiry-'));
  let owned = false;
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    const runtime = createBackupRuntime(directory, 'expiry-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    const userId = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [userId, 'expiry@example.test', 'x', 'Expiry']);
    const jobs = runtime('services/backup-restore-jobs');
    const envelope = runtime('services/backup-envelope');
    // Envelopes with UUIDs no key row names: each waits for its password.
    const upload = async (name: string) => {
      const inner = path.join(directory, `${name}-inner.zip`), outer = path.join(directory, `${name}.zip`);
      await fs.writeFile(inner, handZip([{ name: 'UniHub restore data/manifest.json', data: Buffer.from('{}') }]));
      await envelope.writeBackupEnvelope(inner, outer, { password: `${name}-synthetic-password`, backupUuid: crypto.randomUUID() });
      return jobs.createUploadedRestoreJob(userId, outer, {});
    };
    const states = ['awaiting_password', 'validated', 'failed', 'uploaded', 'validating', 'queued', 'running', 'cancelling'];
    const created: Record<string, FixtureValue> = {};
    for (const state of states) created[state] = await upload(state);
    const fresh = await upload('fresh');
    for (const state of states) {
      await pool.execute("UPDATE backup_restore_jobs SET status = ?, expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE id = ?", [state, created[state].id]);
      await pool.execute('INSERT INTO backup_archive_keys (backup_uuid, user_id, server_wrapped_key, expires_at) VALUES (?, ?, ?, NULL)', [created[state].backup_uuid, userId, '{}']);
    }
    const paths = Object.fromEntries(await Promise.all([...states, 'fresh'].map(async state => {
      const [[row]] = await pool.execute<RowDataPacket[]>('SELECT archive_path FROM backup_restore_jobs WHERE id = ?', [(created[state] || fresh).id]);
      return [state, row.archive_path];
    })));
    assert.equal(await jobs.cleanupExpiredRestoreArchives(), 3);
    for (const state of states) {
      const [[row]] = await pool.execute<RowDataPacket[]>('SELECT status, archive_path FROM backup_restore_jobs WHERE id = ?', [created[state].id]);
      const [keys] = await pool.execute<RowDataPacket[]>('SELECT 1 FROM backup_archive_keys WHERE backup_uuid = ?', [created[state].backup_uuid]);
      const present = await fs.stat(paths[state]).then(() => true, () => false);
      if (['awaiting_password', 'validated', 'failed'].includes(state)) {
        assert.deepEqual([row.status, row.archive_path, present, keys.length], ['expired', null, false, 0], `${state}: expired`);
      } else {
        // A job the worker validates or restores from keeps its archive.
        assert.deepEqual([row.status, row.archive_path, present, keys.length], [state, paths[state], true, 1], `${state}: kept`);
      }
    }
    assert.ok(await fs.stat(paths.fresh), 'an upload younger than seven days stays');
    // An expired upload can no longer start.
    assert.deepEqual(await jobs.startRestoreJob(userId, created.validated.id), { error: 'This uploaded backup has expired. Upload it again to restore it.', status: 410 });
    assert.equal(await jobs.cleanupExpiredRestoreArchives(), 0, 'a second pass finds nothing');
  } finally {
    if (owned) { const connection = await pool.getConnection(); try { await connection.query('SET FOREIGN_KEY_CHECKS=0'); const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES'); for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]); } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); } }
    await pool.end(); await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an uploaded archive past its seven days is not unlocked or started, atomically, also racing the sweep', { skip: !process.env.MYSQL_TEST_HOST, timeout: 300000 }, async () => {
  const mysql = require('mysql2/promise') as typeof import('mysql2/promise');
  assert.match((process.env.MYSQL_TEST_DATABASE as string), /_test$/);
  const settings = { host: process.env.MYSQL_TEST_HOST, port: Number(process.env.MYSQL_TEST_PORT || 3306), database: process.env.MYSQL_TEST_DATABASE, user: process.env.MYSQL_TEST_USER, password: process.env.MYSQL_TEST_PASSWORD, timezone: 'Z' };
  const pool = mysql.createPool({ ...settings, connectionLimit: 8 });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unihub-restore-deadline-'));
  let owned = false;
  try {
    const [tables] = await pool.query<RowDataPacket[]>('SHOW TABLES'); assert.equal(tables.length, 0, 'Use an empty disposable test database'); owned = true;
    const runtime = createBackupRuntime(directory, 'deadline-synthetic-key', pool);
    await runtime('services/database').ensureSchema();
    const userId = crypto.randomUUID();
    await pool.execute('INSERT INTO users (id,email,password_hash,full_name) VALUES (?,?,?,?)', [userId, 'deadline@example.test', 'x', 'Deadline']);
    const jobs = runtime('services/backup-restore-jobs');
    const envelope = runtime('services/backup-envelope');
    const passwordOf = (name: string) => `${name}-synthetic-password`;
    // An envelope no key row names: it waits for its password.
    const upload = async (name: string) => {
      const inner = path.join(directory, `${name}-inner.zip`), outer = path.join(directory, `${name}.zip`);
      await fs.writeFile(inner, handZip([{ name: 'UniHub restore data/manifest.json', data: Buffer.from('{}') }]));
      await envelope.writeBackupEnvelope(inner, outer, { password: passwordOf(name), backupUuid: crypto.randomUUID() });
      return jobs.createUploadedRestoreJob(userId, outer, {});
    };
    const deadline = (id: string, minutes: number) => pool.execute('UPDATE backup_restore_jobs SET expires_at = UTC_TIMESTAMP() + INTERVAL ? MINUTE WHERE id = ?', [minutes, id]);
    const validated = (id: string) => pool.execute("UPDATE backup_restore_jobs SET status = 'validated', phase = 'validated' WHERE id = ?", [id]);
    const row = async (id: string) => (await pool.execute<RowDataPacket[]>('SELECT status, archive_path, backup_uuid FROM backup_restore_jobs WHERE id = ?', [id]))[0][0];
    const keys = async (uuid: string) => (await pool.execute<RowDataPacket[]>('SELECT 1 FROM backup_archive_keys WHERE backup_uuid = ?', [uuid]))[0].length;

    // Before the deadline: unlock and start go through.
    const early = await upload('early');
    await deadline(early.id, 1);
    assert.equal((await jobs.unlockRestoreJob(userId, early.id, passwordOf('early'))).error, undefined);
    assert.equal(await keys(early.backup_uuid), 1);
    const earlyStart = await upload('early-start');
    await deadline(earlyStart.id, 1); await validated(earlyStart.id);
    assert.equal((await jobs.startRestoreJob(userId, earlyStart.id)).error, undefined);

    // After it, before any sweep: both are refused, and nothing changes.
    const late = await upload('late');
    await deadline(late.id, -1);
    const refused = await jobs.unlockRestoreJob(userId, late.id, passwordOf('late'));
    assert.deepEqual([refused.status, (await row(late.id)).status, await keys(late.backup_uuid)], [410, 'awaiting_password', 0]);
    const lateStart = await upload('late-start');
    await deadline(lateStart.id, -1); await validated(lateStart.id);
    assert.equal((await jobs.startRestoreJob(userId, lateStart.id)).status, 410);
    assert.equal((await row(lateStart.id)).status, 'validated');

    // An unlock or a start waits on the job's row (held here) while it turns
    // out to be past its deadline: moved back meanwhile (a check on the job as
    // read before the transition would let it through), or simply reached
    // while waiting (R3-F1: a statement that waited for the row would compare
    // the deadline with the clock of its start). The transition still sees it,
    // and the sweep removes the upload afterwards.
    for (const [name, act] of [
      ['racing-unlock', (id: string) => jobs.unlockRestoreJob(userId, id, passwordOf('racing-unlock'))],
      ['racing-start', (id: string) => jobs.startRestoreJob(userId, id)],
      ['waiting-unlock', (id: string) => jobs.unlockRestoreJob(userId, id, passwordOf('waiting-unlock'))],
      ['waiting-start', (id: string) => jobs.startRestoreJob(userId, id)],
    ] as const) {
      const job = await upload(name);
      const waits = name.startsWith('waiting');
      if (waits) await pool.execute('UPDATE backup_restore_jobs SET expires_at = UTC_TIMESTAMP() + INTERVAL 5 SECOND WHERE id = ?', [job.id]);
      else await deadline(job.id, 1);
      if (name.endsWith('start')) await validated(job.id);
      const holder = await mysql.createConnection(settings);
      try {
        await holder.beginTransaction();
        await holder.execute('SELECT id FROM backup_restore_jobs WHERE id = ? FOR UPDATE', [job.id]);
        const pending = act(job.id);
        if (waits) {
          // The deadline, unchanged, passes while the action waits.
          for (let passed = false; !passed; await new Promise(resolve => setTimeout(resolve, 250))) {
            const [[clock]] = await pool.execute<RowDataPacket[]>('SELECT expires_at < UTC_TIMESTAMP() - INTERVAL 1 SECOND AS passed FROM backup_restore_jobs WHERE id = ?', [job.id]);
            passed = Number(clock.passed) === 1;
          }
        } else {
          await new Promise(resolve => setTimeout(resolve, 1500));
          // Well before the waiting statement began (it reads the clock once, as it starts).
          await holder.execute('UPDATE backup_restore_jobs SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE id = ?', [job.id]);
        }
        await holder.commit();
        assert.deepEqual(await pending, { error: 'This uploaded backup has expired. Upload it again to restore it.', status: 410 }, name);
      } finally {
        await holder.end();
      }
      const { archive_path: archive, backup_uuid: uuid } = await row(job.id);
      assert.equal(await keys(uuid), 0, `${name}: no key stored`);
      assert.ok(await jobs.cleanupExpiredRestoreArchives() >= 1);
      assert.deepEqual([(await row(job.id)).status, (await row(job.id)).archive_path, await fs.stat(archive).then(() => true, () => false)], ['expired', null, false], name);
    }
    // The unlocked and started jobs were not touched by the sweeps.
    assert.notEqual((await row(early.id)).status, 'expired');
    assert.notEqual((await row(earlyStart.id)).status, 'expired');
    // Let the worker finish with them before the tables go.
    const deadlineMs = Date.now() + 60000;
    while (Date.now() < deadlineMs) {
      const [busy] = await pool.execute<RowDataPacket[]>("SELECT id FROM backup_restore_jobs WHERE status IN ('uploaded', 'validating', 'queued', 'running')");
      if (!busy.length) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    if (owned) { const connection = await pool.getConnection(); try { await connection.query('SET FOREIGN_KEY_CHECKS=0'); const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES'); for (const row of tables) await connection.query('DROP TABLE ??', [Object.values(row)[0]]); } finally { await connection.query('SET FOREIGN_KEY_CHECKS=1'); connection.release(); } }
    await pool.end(); await fs.rm(directory, { recursive: true, force: true });
  }
});
