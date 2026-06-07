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
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    execute: async (sql, params = []) => {
      assert.equal(
        params.length,
        (sql.match(/\?/g) || []).length,
        `Prepared statement parameter mismatch:\n${sql}`
      );
      calls.push({ sql, params });
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
  const eventWrite = calls.find(call => call.sql.includes('INSERT INTO calendar_events'));
  assert.deepEqual(eventWrite.params, [
    'event',
    'new-user',
    'calendar',
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
    'subtask',
    'event',
    'new-user',
    'Restored subtask',
    1,
    2,
  ]);

  const attendeeWrite = calls.find(call => call.sql.includes('INSERT INTO calendar_event_attendees'));
  assert.deepEqual(attendeeWrite.params, [
    'attendee',
    'new-user',
    'event',
    'person@example.com',
    'Person',
    'accepted',
    1,
    0,
    'Restored attendee',
  ]);

  const externalRefWrite = calls.find(call => call.sql.includes('INSERT INTO calendar_event_external_refs'));
  assert.deepEqual(externalRefWrite.params, [
    'external-ref',
    'new-user',
    'event',
    'calendar',
    'calendar-account',
    'caldav',
    'external-event',
    '"etag"',
    '2026-05-22 08:05:00',
    '2026-05-22 08:06:00',
  ]);
});
