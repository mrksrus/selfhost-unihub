const test = require('node:test');
const assert = require('node:assert/strict');

function setRequireStub(modulePath, exports) {
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports,
  };
}

test('backup import preserves calendar event field order and MySQL values', async (t) => {
  const backupPath = require.resolve('../src/services/backup');
  const statePath = require.resolve('../src/state');
  const mailPath = require.resolve('../src/services/mail');
  const originalBackup = require.cache[backupPath];
  const originalState = require.cache[statePath];
  const originalMail = require.cache[mailPath];
  const calls = [];
  let revision = 0;
  let transactionRevision = 0;
  let rollbacks = 0;
  const stored = new Map();

  t.after(() => {
    if (originalBackup) require.cache[backupPath] = originalBackup;
    else delete require.cache[backupPath];
    if (originalState) require.cache[statePath] = originalState;
    else delete require.cache[statePath];
    if (originalMail) require.cache[mailPath] = originalMail;
    else delete require.cache[mailPath];
  });

  delete require.cache[backupPath];
  setRequireStub(mailPath, {
    MAIL_RAW_STORAGE_ROOT: '/tmp/unihub-test-mail-raw',
    DEFAULT_MAIL_SYNC_FETCH_LIMIT: 'all',
    normalizeSyncFetchLimit: (value, fallback = 'all') => value || fallback,
  });

  const connection = {
    beginTransaction: async () => { transactionRevision = revision; },
    commit: async () => { revision = transactionRevision; },
    rollback: async () => { rollbacks++; transactionRevision = revision; },
    release: () => {},
    execute: async (sql, params = []) => {
      assert.equal(
        params.length,
        (sql.match(/\?/g) || []).length,
        `Prepared statement parameter mismatch:\n${sql}`
      );
      calls.push({ sql, params });
      const insert = sql.match(/^INSERT INTO (\w+) \((.*?)\) VALUES/);
      if (insert) {
        const columns = insert[2].replace(/`/g, '').split(', ');
        const row = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
        stored.set(insert[1] + ':' + row.id, row);
      }
      const owned = sql.match(/^SELECT `?id`? FROM `(\w+)` WHERE/);
      if (owned) {
        const row = stored.get(owned[1] + ':' + params[0]);
        if (!row || row.user_id !== params[1]) return [[]];
        if (sql.includes('`calendar_id` <=>') && row.calendar_id !== params[2]) return [[]];
        if (sql.includes('`account_id` <=>') && row.account_id !== params[2]) return [[]];
        return [[{ id: row.id }]];
      }
      if (sql.startsWith('UPDATE notification_config SET reminder_revision')) transactionRevision++;
      return [[]];
    },
  };

  setRequireStub(statePath, {
    db: {
      getConnection: async () => connection,
      execute: async () => [[]],
    },
  });

  const { importBackupForUser } = require('../src/services/backup');
  const backup = {
    app: 'unihub',
    version: 1,
    files: [],
    data: {
      calendar_accounts: [{
        id: 'calendar-account',
        user_id: 'old-user',
        provider: 'local',
        display_name: 'Local',
        is_active: true,
      }],
      calendar_calendars: [{
        id: 'calendar',
        user_id: 'old-user',
        account_id: 'calendar-account',
        name: 'Local',
        color: '#123456',
        is_visible: true,
        auto_todo_enabled: true,
      }],
      calendar_events: [{
        id: 'event',
        user_id: 'old-user',
        calendar_id: 'calendar',
        title: 'Restored event',
        description: 'Description from backup',
        start_time: '2026-05-22T07:37:15.000Z',
        end_time: '2026-05-22T08:07:15.000Z',
        all_day: false,
        location: 'Office',
        color: '#654321',
        recurrence: 'FREQ=WEEKLY',
        reminder_minutes: 15,
        reminders: [15, 60],
        todo_status: 'done',
        is_todo_only: true,
        done_at: '2026-05-22T08:00:00.000Z',
      }],
      calendar_event_subtasks: [{
        id: 'subtask',
        user_id: 'old-user',
        event_id: 'event',
        title: 'Restored subtask',
        is_done: true,
        position: 2,
      }],
      calendar_event_attendees: [{
        id: 'attendee',
        user_id: 'old-user',
        event_id: 'event',
        email: 'person@example.com',
        display_name: 'Person',
        response_status: 'accepted',
        is_organizer: true,
        optional_attendee: false,
        comment: 'Restored attendee',
      }],
      calendar_event_external_refs: [{
        id: 'external-ref',
        user_id: 'old-user',
        event_id: 'event',
        calendar_id: 'calendar',
        account_id: 'calendar-account',
        provider: 'caldav',
        external_event_id: 'external-event',
        external_etag: '"etag"',
        external_updated_at: '2026-05-22T08:05:00.000Z',
        last_synced_at: '2026-05-22T08:06:00.000Z',
      }],
    },
  };

  const result = await importBackupForUser('new-user', backup, {
    mode: 'apply',
    sections: 'calendar',
    conflict_mode: 'replace',
  });

  assert.equal(result.valid, true);
  const accountId = calls.find(call => call.sql.includes('INSERT INTO calendar_accounts')).params[0];
  const calendarId = calls.find(call => call.sql.includes('INSERT INTO calendar_calendars')).params[0];
  assert.notEqual(accountId, 'calendar-account');
  assert.notEqual(calendarId, 'calendar');
  const eventWrite = calls.find(call => call.sql.includes('INSERT INTO calendar_events'));
  assert.notEqual(eventWrite.params[0], 'event');
  const eventId = eventWrite.params[0];
  assert.deepEqual(eventWrite.params, [
    eventId,
    'new-user',
    calendarId,
    'Restored event',
    'Description from backup',
    '2026-05-22 07:37:15',
    '2026-05-22 08:07:15',
    0,
    'Office',
    '#654321',
    'FREQ=WEEKLY',
    15,
    '[15,60]',
    'done',
    1,
    '2026-05-22 08:00:00',
  ]);

  const subtaskWrite = calls.find(call => call.sql.includes('INSERT INTO calendar_event_subtasks'));
  assert.deepEqual(subtaskWrite.params, [
    subtaskWrite.params[0],
    eventId,
    'new-user',
    'Restored subtask',
    1,
    2,
  ]);

  const attendeeWrite = calls.find(call => call.sql.includes('INSERT INTO calendar_event_attendees'));
  assert.deepEqual(attendeeWrite.params, [
    attendeeWrite.params[0],
    'new-user',
    eventId,
    'person@example.com',
    'Person',
    'accepted',
    1,
    0,
    'Restored attendee',
  ]);

  const externalRefWrite = calls.find(call => call.sql.includes('INSERT INTO calendar_event_external_refs'));
  assert.deepEqual(externalRefWrite.params, [
    externalRefWrite.params[0],
    'new-user',
    eventId,
    calendarId,
    accountId,
    'caldav',
    'external-event',
    '"etag"',
    '2026-05-22 08:05:00',
    '2026-05-22 08:06:00',
  ]);
  assert.equal(revision, 1, 'a committed calendar restore triggers a reminder rescan');

  // Calendar visibility can change without any event field or timestamp changing.
  const visibilityOnly = { ...backup, data: { calendar_calendars: [{ ...backup.data.calendar_calendars[0], id: calendarId, account_id: accountId }] } };
  await importBackupForUser('new-user', visibilityOnly, { mode: 'apply', sections: 'calendar' });
  assert.equal(revision, 2, 'visibility-only restores also trigger a rescan');

  await assert.rejects(importBackupForUser('new-user', backup, {
    mode: 'apply', sections: 'calendar',
    beforeCommit: async () => { throw new Error('Restore cancelled before commit'); },
  }), /Restore cancelled/);
  assert.equal(rollbacks, 1);
  assert.equal(revision, 2, 'the revision bump rolls back with a cancelled restore');
});
