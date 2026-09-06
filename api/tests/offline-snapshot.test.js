const test = require('node:test');
const assert = require('node:assert/strict');
const { collectOfflineSnapshot, createOfflineSnapshot, OFFLINE_MAX_BYTES } = require('../src/services/offline');
const routes = require('../src/routes/offline');
const { getDb, setDb } = require('../src/state');

function fixture({ oversizeTable, failTable } = {}) {
  const contact = index => ({ id: `contact-${String(index).padStart(5, '0')}`, user_id: 'user-1', first_name: 'Person', last_name: String(index), is_favorite: 0, notes: 'Full contact note' });
  const data = {
    contacts: [...Array.from({ length: 2105 }, (_, i) => contact(i)), { ...contact(9999), user_id: 'user-2' }],
    calendar_events: [{ id: 'event-1', user_id: 'user-1', title: 'Event', start_time: new Date('2026-09-06T10:00:00Z'), end_time: new Date('2026-09-06T11:00:00Z'), reminders: '[0,15]', all_day: 0 },
      { id: 'todo-1', user_id: 'user-1', title: 'Todo', start_time: new Date(), end_time: new Date(), is_todo_only: 1, todo_status: 'done' },
      { id: 'other-event', user_id: 'user-2' }],
    calendar_event_subtasks: [{ id: 'subtask-1', user_id: 'user-1', event_id: 'event-1', title: 'Subtask', is_done: 1 }],
    calendar_event_attendees: [{ id: 'attendee-1', user_id: 'user-1', event_id: 'event-1', email: 'attendee@example.test', is_organizer: 1 }],
    calendar_calendars: [{ id: 'calendar-1', user_id: 'user-1', name: 'Calendar', is_visible: 1, sync_token: 'secret-sync-token', external_id: 'https://secret-provider.invalid/path' }],
    calendar_accounts: [{ id: 'calendar-account-1', user_id: 'user-1', provider: 'caldav', display_name: 'Account', capabilities: '{"sync":true}', encrypted_password: 'secret-calendar-password', provider_config: '{"password":"secret-config"}' }],
    mail_accounts: [{ id: 'mail-account-1', user_id: 'user-1', email_address: 'me@example.test', encrypted_password: 'secret-mail-password' }],
    mail_folders: [{ id: 'folder-1', user_id: 'user-1', slug: 'inbox', display_name: 'Inbox', is_system: 1 }],
    emails: Array.from({ length: 120 }, (_, i) => ({ id: `email-${i}`, user_id: 'user-1', subject: `Subject ${i}`, body_text: `Complete body ${i}: ` + 'x'.repeat(500), body_html: `<p>Complete HTML ${i}</p>`, received_at: new Date(1700000000000 + i * 1000), is_draft: 0,
      to_addresses: '["recipient@example.test"]', folder: 'inbox', raw_storage_path: '/private/raw.eml', raw_sha256: 'private-hash', encrypted_password: 'secret-unselected' })),
    email_attachments: [{ id: 'attachment-1', user_id: 'user-1', email_id: 'email-119', filename: 'document.pdf', size_bytes: 1234, storage_path: '/private/attachment.pdf' }],
  };
  data.emails.push({ id: 'other-mail', user_id: 'user-2', received_at: new Date() });
  data.emails.push({ id: 'draft-mail', user_id: 'user-1', is_draft: 1, received_at: new Date() });
  const calls = [];
  let transactionData = null;
  function select(sql, params) {
    const table = sql.match(/\bFROM (contacts|calendar_events|calendar_event_subtasks|calendar_event_attendees|calendar_calendars|calendar_accounts|mail_accounts|mail_folders|emails|email_attachments)\b/)[1];
    assert.match(sql, /WHERE user_id = \?/);
    assert.equal(params[0], 'user-1');
    assert.doesNotMatch(sql, /SELECT \*/);
    if (table === failTable) throw new Error('Injected snapshot read failure');
    let rows = (transactionData || data)[table].filter(row => row.user_id === params[0]);
    if (table === 'emails') rows = rows.filter(row => !row.is_draft).sort((a, b) => b.received_at - a.received_at || b.id.localeCompare(a.id)).slice(0, 100);
    if (table === 'email_attachments') rows = rows.filter(row => params.slice(1).includes(row.email_id));
    if (sql.includes('AS estimated_bytes')) return [[{ estimated_bytes: table === oversizeTable ? OFFLINE_MAX_BYTES + 1 : Buffer.byteLength(JSON.stringify(rows)) }]];
    return [rows];
  }
  const connection = { async execute(sql, params) { calls.push(sql); return select(sql, params); },
    async query(sql) { calls.push(sql); }, async beginTransaction() { calls.push('BEGIN'); transactionData = structuredClone(data); },
    async commit() { calls.push('COMMIT'); transactionData = null; }, async rollback() { calls.push('ROLLBACK'); transactionData = null; }, release() { calls.push('RELEASE'); } };
  return { data, calls, connection, db: { async getConnection() { calls.push('CONNECT'); return connection; } } };
}

test('offline snapshot includes all 2,105 contacts, all events/todos and 100 full message bodies with safe serialization', async () => {
  const f = fixture();
  const snapshot = await collectOfflineSnapshot(f.connection, 'user-1');
  assert.equal(snapshot.contacts.length, 2105);
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.emails.length, 100);
  assert.equal(snapshot.emails[0].id, 'email-119');
  assert.ok(snapshot.emails[0].body_text.length > 500);
  assert.deepEqual(snapshot.emails[0].to_addresses, ['recipient@example.test']);
  assert.equal(snapshot.events[0].subtasks[0].is_done, true);
  assert.deepEqual(snapshot.events[0].reminders, [0, 15]);
  assert.equal(snapshot.events[0].attendees[0].email, 'attendee@example.test');
  assert.deepEqual(snapshot.calendarAccounts[0].capabilities, { sync: true });
  assert.equal(snapshot.emails[0].attachments[0].size_bytes, 1234);
  assert.equal(snapshot.emails[0].attachments[0].offline_available, false);
  assert.equal(snapshot.bytes, Buffer.byteLength(JSON.stringify(snapshot)));
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /secret-|\/private\/|encrypted_password|storage_path|raw_sha256|sync_token|provider_config/);
  assert.doesNotMatch(serialized, /other-event|other-mail|draft-mail/);
});

test('refresh replaces deleted contacts, events and messages from the current transaction snapshot', async (t) => {
  const previous = getDb();
  const f = fixture(); setDb(f.db); t.after(() => setDb(previous));
  const before = await createOfflineSnapshot('user-1');
  f.data.contacts = f.data.contacts.filter(row => row.id !== 'contact-00000');
  f.data.calendar_events = f.data.calendar_events.filter(row => row.id !== 'event-1');
  f.data.emails = f.data.emails.filter(row => row.id !== 'email-119');
  const after = await createOfflineSnapshot('user-1');
  assert.equal(before.contacts.length, 2105);
  assert.equal(after.contacts.length, 2104);
  assert.equal(after.events.length, 1);
  assert.equal(after.emails.length, 100);
  assert.equal(after.emails[0].id, 'email-118');
  assert.ok(!after.contacts.some(row => row.id === 'contact-00000'));
  assert.equal(f.calls.filter(call => call === 'COMMIT').length, 2);
  assert.equal(f.calls.filter(call => call === 'RELEASE').length, 2);
  assert.equal(f.calls.includes('ROLLBACK'), false);
});

test('oversized metadata fails preflight before any full rows are transferred and rolls back', async (t) => {
  const previous = getDb();
  const f = fixture({ oversizeTable: 'contacts' }); setDb(f.db); t.after(() => setDb(previous));
  await assert.rejects(createOfflineSnapshot('user-1'), { status: 413 });
  assert.equal(f.calls.filter(sql => sql.startsWith('SELECT ') && !sql.includes('estimated_bytes')).length, 0);
  assert.ok(f.calls.includes('ROLLBACK'));
  assert.ok(f.calls.includes('RELEASE'));
  assert.equal(f.calls.includes('COMMIT'), false);
});

test('snapshot query failure rolls back and unauthenticated snapshot routes never touch the database', async (t) => {
  const previous = getDb();
  const f = fixture({ failTable: 'calendar_events' }); setDb(f.db); t.after(() => setDb(previous));
  assert.equal((await routes['GET /api/offline/snapshot']({}, null)).status, 401);
  assert.equal(f.calls.length, 0);
  const result = await routes['GET /api/offline/snapshot']({}, 'user-1');
  assert.equal(result.status, 500);
  assert.match(result.error, /previous snapshot was kept/);
  assert.ok(f.calls.includes('ROLLBACK'));
  assert.ok(f.calls.includes('RELEASE'));
});
