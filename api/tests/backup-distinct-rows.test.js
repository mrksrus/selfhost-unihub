const test = require('node:test');
const assert = require('node:assert/strict');
const { setDb } = require('../src/state');
const { importBackupForUser } = require('../src/services/backup');

// Model the relevant SQL lookups, including rows inserted earlier in the restore.
function database(t) {
  const tables = { contacts: [], calendar_events: [], calendar_event_subtasks: [], calendar_event_attendees: [] };
  let reverseCandidates = false;
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
    async execute(sql, params = []) {
      assert.equal(params.length, (sql.match(/\?/g) || []).length);
      const insert = sql.match(/^INSERT INTO (\w+) \((.*?)\) VALUES/);
      if (insert) {
        const columns = insert[2].replaceAll('`', '').split(', ');
        tables[insert[1]].push(Object.fromEntries(columns.map((key, index) => [key, params[index]])));
        return [{ affectedRows: 1 }];
      }
      const update = sql.match(/^UPDATE `(\w+)` SET (.*?) WHERE/);
      if (update) {
        const columns = update[2].split(', ').map(value => value.match(/^`(\w+)`/)[1]);
        const row = tables[update[1]].find(row => row.id === params[columns.length] && row.user_id === params[columns.length + 1]);
        assert.ok(row);
        columns.forEach((column, index) => { row[column] = params[index]; });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE notification_config')) return [{ affectedRows: 1 }];
      const table = sql.match(/FROM `?(\w+)`?/)[1];
      let rows = tables[table];
      assert.ok(rows, sql);
      if (sql.includes('WHERE id = ?') || sql.includes('WHERE `id` = ?')) {
        rows = rows.filter(row => row.id === params[0] && row.user_id === params[1]);
      } else if (table === 'calendar_events') {
        rows = rows.filter(row => row.user_id === params[0] && row.calendar_id === params[1]
          && row.title === params[2] && row.start_time === params[3] && row.end_time === params[4]);
      } else if (table === 'contacts') {
        rows = rows.filter(row => row.user_id === params[0]);
        if (sql.includes('LOWER(email)')) rows = rows.filter(row => [row.email, row.email2, row.email3].some(value => value?.toLowerCase() === params[1]));
        else rows = rows.filter(row => row.first_name.toLowerCase() === params[1] && (row.last_name || '').toLowerCase() === params[2]);
      } else if (table === 'calendar_event_subtasks') {
        rows = rows.filter(row => row.user_id === params[0] && row.event_id === params[1] && row.title === params[2] && row.position === params[3]);
      } else if (table === 'calendar_event_attendees') {
        rows = rows.filter(row => row.event_id === params[0] && row.email === params[1] && row.user_id === params[2]);
      }
      return [reverseCandidates ? [...rows].reverse() : rows];
    },
  };
  setDb({ getConnection: async () => connection, execute: async () => [[]] });
  t.after(() => setDb(null));
  return { tables, reverse() { reverseCandidates = true; } };
}

for (const mode of ['keep_existing', 'replace']) {
  test(`${mode} preserves equal-shape events and their children across repeated imports`, async t => {
    const db = database(t);
    const events = ['first', 'second'].map(id => ({ id, calendar_id: null, title: 'Same time', description: id,
      start_time: '2026-09-19T10:00:00Z', end_time: '2026-09-19T11:00:00Z' }));
    const backup = { app: 'unihub', version: 3, files: [], data: {
      calendar_events: events,
      calendar_event_subtasks: events.map(event => ({ id: `task-${event.id}`, event_id: event.id, title: 'Same child title', position: 0 })),
      calendar_event_attendees: events.map(event => ({ id: `attendee-${event.id}`, event_id: event.id, email: 'same@example.test' })),
    } };
    const options = { mode: 'apply', sections: 'calendar', conflict_mode: mode };
    const first = await importBackupForUser('owner', backup, options);
    assert.equal(first.valid, true);
    assert.equal(db.tables.calendar_events.length, 2);
    const ids = new Map(db.tables.calendar_events.map(event => [event.description, event.id]));
    assert.equal(ids.size, 2);
    for (const table of ['calendar_event_subtasks', 'calendar_event_attendees']) {
      assert.equal(db.tables[table].length, 2);
      assert.deepEqual(new Set(db.tables[table].map(row => row.event_id)), new Set(ids.values()));
    }
    const before = structuredClone(db.tables);
    db.reverse(); // Database candidate ordering must not swap distinguishable parents.
    await importBackupForUser('owner', backup, options);
    assert.deepEqual(db.tables, before);
  });

  for (const sharedEmail of [false, true]) {
    test(`${mode} preserves distinct contacts matched by ${sharedEmail ? 'shared email' : 'name'} on repeated import`, async t => {
      const db = database(t);
      const backup = { app: 'unihub', version: 3, files: [], data: { contacts: ['first', 'second'].map(id => ({
        id, first_name: 'Same', last_name: 'Name', notes: id, ...(sharedEmail ? { email: 'shared@example.test' } : {}),
      })) } };
      const options = { mode: 'apply', sections: 'contacts', conflict_mode: mode };
      await importBackupForUser('owner', backup, options);
      assert.equal(db.tables.contacts.length, 2);
      assert.deepEqual(new Set(db.tables.contacts.map(row => row.notes)), new Set(['first', 'second']));
      const before = structuredClone(db.tables.contacts);
      db.reverse();
      await importBackupForUser('owner', backup, options);
      assert.deepEqual(db.tables.contacts, before);
    });
  }
}
