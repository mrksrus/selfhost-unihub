#!/usr/bin/env node
// Synthetic sample data for local development (scripts/local-mysql.sh dev).
//   node scripts/seed-dev.cjs [--reset]
// Only runs against a database whose name ends in _dev. The schema is built by
// the app's own startup code; rows are written through service functions where
// practical, otherwise with parameterized SQL matching the real schema.
// Deterministic: a seeded PRNG drives all content, dates are relative to today
// (UTC midnight), so screenshots are reproducible on the same day.
// Mail hosts use the reserved .test TLD on port 1: the outbound-network policy
// refuses loopback (127.0.0.1) unless TRUSTED_MAIL_HOSTS allows it, while a
// .test name fails DNS, so any sync attempt fails fast and never leaves the host.
'use strict';

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');

const RESET = process.argv.includes('--reset');
const SEED_VERSION = '1';
const MARKER = 'dev_seed_version';
const PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
const MAIL_HOST = { imap: 'imap.unihub-dev.test', smtp: 'smtp.unihub-dev.test', port: 1 };

function die(message) { console.error(`seed-dev: ${message}`); process.exit(1); }
const database = process.env.MYSQL_DATABASE || '';
if (!/_dev$/.test(database)) die(`refusing to run: MYSQL_DATABASE must end with _dev (got "${database}")`);
if (process.env.BOOTSTRAP_ADMIN_EMAIL !== 'admin@example.com' || PASSWORD.length < 12) {
  die('run through scripts/local-mysql.sh dev (BOOTSTRAP_ADMIN_* not set as expected)');
}

// ── Deterministic helpers ─────────────────────────────────────────
let seed = 0x5eed2026;
function rand() { // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = list => list[Math.floor(rand() * list.length)];
const chance = p => rand() < p;
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
function uuid() {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
  hex[12] = '4'; hex[16] = '89ab'[Math.floor(rand() * 4)];
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const TODAY = new Date(); TODAY.setUTCHours(0, 0, 0, 0);
const at = (days, hours = 0, minutes = 0) => new Date(TODAY.getTime() + ((days * 24 + hours) * 60 + minutes) * 60000);
const sqlDate = date => date.toISOString().slice(0, 19).replace('T', ' ');

const FIRST = ['Ada', 'Ben', 'Clara', 'Dmitri', 'Elif', 'Farah', 'Gustav', 'Hana', 'Ivo', 'Jonas', 'Kira', 'Lena', 'Mateo', 'Nina',
  'Oskar', 'Priya', 'Quinn', 'Rosa', 'Sami', 'Tariq', 'Uma', 'Vera', 'Wim', 'Xenia', 'Yusuf', 'Zoe'];
const LAST = ['Example', 'Sample', 'Testmann', 'Placeholder', 'Demo', 'Fictive', 'Mockley', 'Dummett', 'Stubbs', 'Fakeworth',
  'Specimen', 'Trialson'];
const COMPANIES = ['Example Corp', 'Sample Labs', 'Placeholder GmbH', 'Demo Logistics', 'Test Kitchen Co.', null, null];
const DOMAINS = ['example.com', 'example.org', 'mail.example.com', 'team.example.org', 'lists.example.test'];
const ORG_SENDERS = [
  ['Example Bank', 'no-reply@bank.example.com'], ['Sample Shop', 'orders@shop.example.org'],
  ['Demo Airlines', 'bookings@air.example.com'], ['Placeholder News', 'digest@news.example.test'],
  ['Example Cloud', 'billing@cloud.example.com'], ['Sample Community Forum', 'notify@forum.example.org'],
];
const TOPICS = ['Quarterly report draft', 'Lunch on Thursday?', 'Your order has shipped', 'Invoice #{n}', 'Meeting notes: planning',
  'Re: holiday photos', 'Weekly digest #{n}', 'Reminder: dentist appointment', 'Project timeline update', 'Welcome to the team',
  'Security alert: new sign-in', 'Fwd: apartment viewing', 'Book club pick for next month', 'Build #{n} passed',
  'Your monthly statement', 'Question about the budget', 'Conference agenda', 'Re: garden plans', 'Receipt for your purchase',
  'Draft proposal – feedback welcome'];

// ── Database setup ────────────────────────────────────────────────
async function dropAllTables() {
  const config = require('../src/services/database-config').getDatabaseConfig();
  const cx = await mysql.createConnection({ ...config, multipleStatements: false });
  try {
    const [tables] = await cx.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()');
    await cx.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const { name } of tables) await cx.query(`DROP TABLE IF EXISTS \`${name.replace(/`/g, '')}\``);
    await cx.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log(`seed-dev: dropped ${tables.length} tables from ${database}`);
  } finally { await cx.end(); }
}

const counts = {};
async function insert(db, table, row) {
  const keys = Object.keys(row);
  await db.execute(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    keys.map(key => row[key] !== null && typeof row[key] === 'object' && !(row[key] instanceof Date) ? JSON.stringify(row[key]) : row[key]));
}

// ── Users ─────────────────────────────────────────────────────────
async function seedUsers(db) {
  const { hashPassword } = require('../src/auth');
  const [[admin]] = await db.execute("SELECT id FROM users WHERE email = 'admin@example.com'");
  if (!admin) die('bootstrap admin missing; was the database already populated with other users?');
  await db.execute("UPDATE users SET full_name = 'Avery Admin', timezone = 'Europe/Berlin' WHERE id = ?", [admin.id]);
  const alexId = uuid();
  await db.execute(`INSERT INTO users (id, email, password_hash, full_name, email_verified, role, timezone)
    VALUES (?, 'alex@example.com', ?, 'Alex Example', TRUE, 'user', 'Europe/Berlin')`, [alexId, await hashPassword(PASSWORD)]);
  await require('../src/services/calendar').ensureDefaultLocalCalendarForUser(alexId, db);
  return { admin: admin.id, alex: alexId };
}

// ── Contacts, calendar, todos, notes ──────────────────────────────
async function seedContacts(db, userId, n) {
  const people = [];
  for (let i = 0; i < n; i++) {
    const first = FIRST[i % FIRST.length], last = pick(LAST);
    const email = `${first}.${last}`.toLowerCase() + '@' + pick(DOMAINS);
    people.push({ name: `${first} ${last}`, email });
    await insert(db, 'contacts', {
      id: uuid(), user_id: userId, first_name: first, last_name: last, email,
      email2: chance(0.2) ? `${first.toLowerCase()}@example.org` : null,
      phone: chance(0.8) ? `+1 555 01${String(int(0, 99)).padStart(2, '0')}` : null,
      company: pick(COMPANIES), job_title: chance(0.5) ? pick(['Engineer', 'Designer', 'Manager', 'Accountant', 'Teacher']) : null,
      notes: chance(0.2) ? 'Synthetic contact created by seed-dev.' : null, is_favorite: chance(0.15),
    });
  }
  counts.contacts = (counts.contacts || 0) + n;
  return people;
}

async function seedCalendar(db, userId, eventCount, todoCount) {
  const { calendarId, accountId } = await require('../src/services/calendar').ensureDefaultLocalCalendarForUser(userId, db);
  const workId = uuid();
  await insert(db, 'calendar_calendars', { id: workId, user_id: userId, account_id: accountId, name: 'Work',
    external_id: `local-seed-work-${workId}`, color: '#16a34a', is_visible: true, auto_todo_enabled: true, read_only: false, is_primary: false });
  counts.calendar_calendars = (counts.calendar_calendars || 0) + 1;
  const titles = ['Team standup', 'Design review', 'Dentist', 'Yoga class', '1:1 with Kira', 'Lunch with Ben', 'Sprint planning',
    'Parent-teacher meeting', 'Car service', 'Birthday dinner', 'Budget review', 'Hackathon kickoff', 'Piano lesson'];
  const event = (fields) => insert(db, 'calendar_events', { id: uuid(), user_id: userId, description: null, location: null,
    color: '#2563eb', recurrence: null, reminders: null, todo_status: null, is_todo_only: false, done_at: null, ...fields });
  for (let i = 0; i < eventCount; i++) {
    const day = int(-14, 21), allDay = i % 9 === 0, work = chance(0.5);
    const start = allDay ? at(day) : at(day, int(8, 18), pick([0, 15, 30]));
    const end = allDay ? new Date(start.getTime() + 86399000) : new Date(start.getTime() + pick([30, 45, 60, 90]) * 60000);
    await event({ calendar_id: work ? workId : calendarId, title: allDay ? pick(['Public holiday (sample)', 'Conference day', 'Offsite']) : pick(titles),
      start_time: sqlDate(start), end_time: sqlDate(end), all_day: allDay, color: work ? '#16a34a' : '#2563eb',
      location: chance(0.3) ? pick(['Room 2.14', 'Video call', 'Example Café, Sample Street 1']) : null,
      reminders: chance(0.4) ? [0, 15] : null });
  }
  // Recurrence is stored as an RRULE string (as CalDAV imports keep it); the UI shows the first occurrence.
  await event({ calendar_id: workId, title: 'Weekly team sync', start_time: sqlDate(at(-7, 9)), end_time: sqlDate(at(-7, 9, 30)),
    recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=MO', color: '#16a34a' });
  await event({ calendar_id: calendarId, title: 'Water the plants', start_time: sqlDate(at(-3, 18)), end_time: sqlDate(at(-3, 18, 15)),
    recurrence: 'RRULE:FREQ=DAILY;INTERVAL=3' });
  const todoTitles = ['Renew passport', 'Pay electricity bill', 'Call the landlord', 'Order printer ink', 'Update CV', 'Book train tickets',
    'Backup laptop', 'Return library books', 'Plan weekend trip', 'Fix bike light', 'Write thank-you cards', 'Clean out garage'];
  for (let i = 0; i < todoCount; i++) {
    const scheduled = i % 3 === 0, done = i % 4 === 1, start = scheduled ? at(int(-5, 10), int(9, 17)) : at(int(-10, 0), 12);
    await event({ calendar_id: calendarId, title: todoTitles[i % todoTitles.length], start_time: sqlDate(start),
      end_time: sqlDate(new Date(start.getTime() + 1800000)), is_todo_only: !scheduled, color: '#f59e0b',
      todo_status: done ? 'done' : i % 7 === 5 ? 'changed' : null, done_at: done ? sqlDate(at(int(-4, 0), 16)) : null });
  }
  counts.calendar_events = (counts.calendar_events || 0) + eventCount + 2 + todoCount;
}

async function seedNotes(db, userId, n) {
  const notes = require('../src/services/notes');
  const topics = ['Grocery list', 'Meeting notes – roadmap', 'Book recommendations', 'Recipe: lentil soup', 'Ideas for the garden',
    'Travel packing list', 'Home network setup', 'Gift ideas', 'Workout plan', 'Old draft (can go)'];
  let last = null;
  for (let i = 0; i < n; i++) {
    const body = `# ${topics[i % topics.length]}\n\n- First point about ${pick(['plans', 'costs', 'dates', 'people'])}\n- Second point\n\nSynthetic note ${i + 1}.`;
    const { note } = await notes.createNote(userId, { title: topics[i % topics.length], body, linked_note_ids: last && i === 3 ? [last] : [] });
    last = note.id;
  }
  await db.execute('UPDATE notes SET trashed_at = UTC_TIMESTAMP() WHERE id = ? AND user_id = ?', [last, userId]); // one note in trash
  counts.notes = (counts.notes || 0) + n;
}

// ── Mail ──────────────────────────────────────────────────────────
const REMOTE = { inbox: 'INBOX', sent: 'Sent', archive: 'Archive', trash: 'Trash' };
async function createAccount(db, userId, { email, display, mode, disconnected = false, custom = [] }) {
  const { encrypt } = require('../src/security/encryption');
  const { registerCustomImapFoldersForUser, ensureDefaultMailFoldersForUser } = require('../src/services/mail');
  const id = uuid();
  // Same columns and encryption as POST /api/mail/accounts; disconnect mirrors disconnectAccount().
  await db.execute(`INSERT INTO mail_accounts (id, user_id, email_address, display_name, provider, username, imap_host, imap_port,
      smtp_host, smtp_port, encrypted_password, sync_fetch_limit, sync_mode, sync_status, delete_emails_on_server, allow_self_signed,
      is_active, disconnected_at, last_synced_at)
    VALUES (?, ?, ?, ?, 'imap', ?, ?, ?, ?, ?, ?, 'all', ?, ?, FALSE, FALSE, ?, ?, ?)`,
  [id, userId, email, display, email, MAIL_HOST.imap, MAIL_HOST.port, MAIL_HOST.smtp, MAIL_HOST.port,
    disconnected ? null : encrypt('sample-mail-password'), mode, disconnected ? 'cancelled' : 'idle', !disconnected,
    disconnected ? sqlDate(at(-20, 10)) : null, sqlDate(at(0, -1))]);
  await ensureDefaultMailFoldersForUser(userId, db);
  const specialUses = new Map(Object.entries(REMOTE).map(([slug, name]) => [name, slug]));
  const registered = disconnected ? [] : await registerCustomImapFoldersForUser(userId, id, [...Object.values(REMOTE), ...custom], db, specialUses);
  const folders = Object.entries(REMOTE).map(([slug, remote]) => ({ slug, remote }));
  for (const name of custom) folders.push({ slug: registered.find(item => item.remoteName === name).slug, remote: name, custom: true });
  counts.mail_accounts = (counts.mail_accounts || 0) + 1;
  return { id, userId, email, display, mode, disconnected, folders };
}

function htmlBody(subject, name, paragraphs) {
  return `<html><body style="font-family:sans-serif"><h2 style="color:#2563eb">${subject}</h2><p>Hello ${name},</p>`
    + paragraphs.map(p => `<p>${p}</p>`).join('') + '<p style="color:#666;font-size:12px">This is synthetic sample mail for UniHub development.</p></body></html>';
}

async function seedMailbox(db, account, people, total) {
  const repository = require('../src/services/mail-engine/repository');
  const weights = [['inbox', 0.5], ['archive', 0.2], ['sent', 0.12], ['trash', 0.06], ['custom', 0.12]];
  const epochs = new Map(), boxes = new Map(), nextUid = new Map();
  for (const [index, folder] of account.folders.entries()) {
    epochs.set(folder.slug, 1700000000 + index * 7 + account.email.length);
    nextUid.set(folder.slug, 100);
    if (account.mode === 'sync') {
      boxes.set(folder.slug, await repository.ensureMailbox({ userId: account.userId, accountId: account.id, folderName: folder.remote,
        epoch: epochs.get(folder.slug), metadata: { delimiter: '/', specialUse: folder.custom ? null : `\\${folder.remote === 'INBOX' ? 'Inbox' : folder.remote}` } }, db));
    }
  }
  const customs = account.folders.filter(folder => folder.custom);
  const emails = [];
  for (let i = 0; i < total; i++) {
    let r = rand(), kind = 'inbox';
    for (const [name, weight] of weights) { if ((r -= weight) < 0) { kind = name; break; } }
    if (kind === 'custom' && !customs.length) kind = 'inbox';
    const folder = kind === 'custom' ? pick(customs) : account.folders.find(item => item.slug === kind);
    const person = pick(people), org = chance(0.35) ? pick(ORG_SENDERS) : null;
    const sent = folder.slug === 'sent';
    const [fromName, fromAddress] = sent ? [account.display, account.email] : org || [person.name, person.email];
    const subject = pick(TOPICS).replace('{n}', String(int(1000, 9999)));
    const received = new Date(at(0, 8).getTime() - Math.floor(Math.pow(rand(), 2) * 120 * 86400000) - int(0, 3600) * 1000);
    const html = chance(0.4);
    const text = `Hello ${sent ? person.name : account.display},\n\n${pick(['Quick update on this.', 'Please see the details below.',
      'Thanks for getting back to me.', 'Just a friendly reminder.'])}\n\nBest,\n${fromName}`;
    const uid = nextUid.get(folder.slug) + int(1, 3); nextUid.set(folder.slug, uid);
    const epoch = epochs.get(folder.slug), synced = account.mode === 'sync';
    const row = {
      id: uuid(), user_id: account.userId, mail_account_id: account.id, message_id: `<seed-${i}-${account.id.slice(0, 8)}@unihub-dev.test>`,
      subject, from_address: fromAddress, from_name: fromName, to_addresses: sent ? [person.email] : [account.email],
      cc_addresses: chance(0.1) ? [pick(people).email] : null, body_text: text,
      body_html: html ? htmlBody(subject, sent ? person.name : account.display, [text.split('\n\n')[1], 'Kind regards.']) : null,
      folder: folder.slug, source_folder: folder.remote, imap_uid: uid, imap_uidvalidity: epoch,
      remote_folder: synced ? folder.remote : null, remote_uid: synced ? uid : null, remote_uidvalidity: synced ? epoch : null,
      is_read: sent || received < at(-2) ? chance(0.92) || sent : chance(0.3), is_starred: chance(0.08),
      has_attachments: chance(0.06), received_at: sqlDate(received),
    };
    await insert(db, 'emails', row);
    if (row.has_attachments) {
      await insert(db, 'email_attachments', { id: uuid(), email_id: row.id, user_id: account.userId,
        filename: pick(['report.pdf', 'photo.jpg', 'invoice.pdf', 'agenda.docx']), content_type: 'application/octet-stream',
        size_bytes: int(20000, 900000), storage_path: null });
      counts.email_attachments = (counts.email_attachments || 0) + 1;
    }
    if (synced) {
      const flags = [...(row.is_read ? ['\\Seen'] : []), ...(row.is_starred ? ['\\Flagged'] : [])];
      await repository.upsertOccurrence({ userId: account.userId, accountId: account.id, mailboxId: boxes.get(folder.slug).id,
        epoch, uid, emailId: row.id, flags, modseq: String(1000 + i) }, db);
    }
    emails.push(row);
  }
  counts.emails = (counts.emails || 0) + total;
  return { emails, boxes };
}

// Writebacks in every state the sync UI distinguishes, queued through the real
// queueChanges() and then advanced the way the worker's setState() would.
async function seedWritebacks(db, account, emails) {
  const { queueChanges } = require('../src/services/mail-writebacks');
  const inbox = emails.filter(email => email.folder === 'inbox');
  const plans = [
    { change: { read: true }, email: inbox.find(e => !e.is_read) },
    { change: { star: true }, email: inbox.filter(e => !e.is_starred)[1],
      update: { state: 'retry_wait', status: 'pending', attempts: 2, error: 'Mail/calendar hostname could not be resolved (ENOTFOUND).', availableIn: 25 } },
    { change: { read: false }, email: inbox.filter(e => e.is_read)[0],
      update: { state: 'needs_attention', status: 'conflict', attempts: 8, error: 'Provider flags changed while this change was pending; retry or discard it.' } },
    { change: { move: 'archive' }, email: inbox.filter(e => e.is_read)[3],
      update: { state: 'needs_attention', status: 'conflict', attempts: 1, dispatched: true,
        error: 'Move outcome could not be confirmed; check the outcome or accept the server state.',
        evidence: { kind: 'move_outcome_unknown', original_folder: 'INBOX' } } },
    { change: { star: true }, email: inbox.filter(e => !e.is_starred)[5], update: { state: 'confirmed', status: 'done', attempts: 1, dispatched: true } },
  ];
  for (const plan of plans) {
    const cx = await db.getConnection(), operationIds = [];
    try {
      await cx.beginTransaction();
      const [[email]] = await cx.execute(`SELECT e.*, a.sync_mode, a.is_active FROM emails e JOIN mail_accounts a ON a.id = e.mail_account_id
        WHERE e.id = ?`, [plan.email.id]);
      await queueChanges(cx, account.userId, [email], plan.change, { operationIds });
      const u = plan.update;
      if (u) {
        await cx.execute(`UPDATE mail_writebacks SET state = ?, status = ?, attempts = ?, error = ?, dispatched = ?, evidence_json = ?,
          available_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? MINUTE), created_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? MINUTE) WHERE id = ?`,
        [u.state, u.status, u.attempts, u.error || null, Boolean(u.dispatched), u.evidence ? JSON.stringify(u.evidence) : null,
          u.availableIn || 0, int(5, 300), operationIds[0]]);
        // Only the queued intent keeps its operation job; the others model settled or waiting work.
        await cx.execute("DELETE FROM mail_engine_jobs WHERE operation_id = ? AND state = 'queued'", [operationIds[0]]);
        if (u.state === 'confirmed') await cx.execute('UPDATE emails SET is_starred = TRUE WHERE id = ?', [email.id]);
      }
      await cx.commit();
    } catch (error) { await cx.rollback(); throw error; } finally { cx.release(); }
  }
}

async function seedJobs(db, account, boxes) {
  const runtime = require('../src/services/mail-engine/runtime');
  await runtime.enqueueJob({ userId: account.userId, accountId: account.id, kind: 'sync', priority: 50 });
  const job = (fields) => insert(db, 'mail_engine_jobs', { id: uuid(), user_id: account.userId, mail_account_id: account.id, priority: 50, ...fields });
  await job({ kind: 'recent', mailbox_id: boxes.get('inbox').id, state: 'running', phase: 'fetch_headers', lease_owner: 'seed-dev-worker',
    lease_until: sqlDate(at(0, -1)), worker_generation: 1, processed: 42, total: 120, started_at: sqlDate(at(0, -1, -5)),
    heartbeat_at: sqlDate(at(0, -1, -1)) });
  await job({ kind: 'flags', mailbox_id: boxes.get('archive').id, state: 'error', phase: null, processed: 0,
    error: 'Mail/calendar hostname could not be resolved (ENOTFOUND).', started_at: sqlDate(at(0, -2)), completed_at: sqlDate(at(0, -2, 1)) });
}

// ── Main ──────────────────────────────────────────────────────────
// Bulk rows go through one transaction (repository helpers accept a connection).
async function inTransaction(db, callback) {
  const cx = await db.getConnection();
  try { await cx.beginTransaction(); const result = await callback(cx); await cx.commit(); return result; }
  catch (error) { await cx.rollback(); throw error; } finally { cx.release(); }
}
async function tableCounts(db) {
  const tables = ['users', 'contacts', 'calendar_calendars', 'calendar_events', 'notes', 'mail_accounts', 'mail_folders',
    'mail_folder_remote_boxes', 'emails', 'email_attachments', 'mail_remote_mailboxes', 'mail_remote_occurrences', 'mail_writebacks', 'mail_engine_jobs'];
  const out = {};
  for (const table of tables) { const [[row]] = await db.query(`SELECT COUNT(*) AS n FROM \`${table}\``); out[table] = Number(row.n); }
  const [states] = await db.query("SELECT CONCAT('mail_writebacks.', state) AS k, COUNT(*) AS n FROM mail_writebacks GROUP BY state ORDER BY state");
  const [jobs] = await db.query("SELECT CONCAT('mail_engine_jobs.', state) AS k, COUNT(*) AS n FROM mail_engine_jobs GROUP BY state ORDER BY state");
  for (const row of [...states, ...jobs]) out[`  ${row.k}`] = Number(row.n);
  return out;
}

async function main() {
  const started = Date.now();
  if (RESET) await dropAllTables();
  await require('../src/services/database').initDatabase();
  const schemaSeconds = ((Date.now() - started) / 1000).toFixed(1);
  const { db } = require('../src/state');
  try {
    const [[marker]] = await db.execute('SELECT setting_value FROM system_settings WHERE setting_key = ?', [MARKER]);
    if (marker) {
      console.log(`seed-dev: ${database} already has sample data (version ${marker.setting_value}); nothing to do. Use --reset to rebuild.`);
    } else {
      const [[existing]] = await db.execute("SELECT COUNT(*) AS n FROM users WHERE email <> 'admin@example.com'");
      if (Number(existing.n)) die(`${database} already contains other users; run with --reset to rebuild it`);
      console.log('seed-dev: inserting sample data…');
      const users = await seedUsers(db);
      const adminPeople = await inTransaction(db, cx => seedContacts(cx, users.admin, 30));
      const alexPeople = await inTransaction(db, cx => seedContacts(cx, users.alex, 12));
      await inTransaction(db, cx => seedCalendar(cx, users.admin, 32, 16));
      await inTransaction(db, cx => seedCalendar(cx, users.alex, 8, 4));
      await seedNotes(db, users.admin, 10);
      await seedNotes(db, users.alex, 3);
      const work = await createAccount(db, users.admin, { email: 'admin@example.com', display: 'Avery Admin', mode: 'sync', custom: ['Projects', 'Receipts'] });
      const personal = await createAccount(db, users.admin, { email: 'avery.personal@example.org', display: 'Avery (personal)', mode: 'download' });
      const alexMail = await createAccount(db, users.alex, { email: 'alex@example.com', display: 'Alex Example', mode: 'sync', custom: ['Travel'] });
      const oldMail = await createAccount(db, users.alex, { email: 'alex.old@example.org', display: 'Alex (old address)', mode: 'download', disconnected: true });
      const workMail = await inTransaction(db, cx => seedMailbox(cx, work, adminPeople, 160));
      await inTransaction(db, cx => seedMailbox(cx, personal, adminPeople, 70));
      const alexBoxes = await inTransaction(db, cx => seedMailbox(cx, alexMail, alexPeople, 90));
      await inTransaction(db, cx => seedMailbox(cx, oldMail, alexPeople, 25));
      await seedWritebacks(db, work, workMail.emails);
      await seedJobs(db, work, workMail.boxes);
      await require('../src/services/mail-engine/runtime').enqueueJob({ userId: users.alex, accountId: alexMail.id, kind: 'presence',
        mailboxId: alexBoxes.boxes.get('inbox').id });
      await db.execute('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [MARKER, SEED_VERSION]);
      console.log(`seed-dev: done (schema ${schemaSeconds}s, data ${((Date.now() - started) / 1000 - schemaSeconds).toFixed(1)}s)`);
    }
    console.table(await tableCounts(db));
  } finally { await db.end(); }
}

main().then(() => process.exit(0), error => { console.error('seed-dev: failed:', error); process.exit(1); });
