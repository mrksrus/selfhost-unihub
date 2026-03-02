const test = require('node:test');
const assert = require('node:assert/strict');
const { getCalendarEventIdFromPath, getCalendarSubtaskIdFromPath } = require('../calendar-route-utils');

test('extracts event id from todo-status route', () => {
  const eventId = getCalendarEventIdFromPath('/api/calendar/events/evt-123/todo-status');
  assert.equal(eventId, 'evt-123');
});

test('extracts event id from subtask route', () => {
  const eventId = getCalendarEventIdFromPath('/api/calendar/events/evt-987/subtasks/sub-1');
  assert.equal(eventId, 'evt-987');
});

test('extracts subtask id from subtask route', () => {
  const subtaskId = getCalendarSubtaskIdFromPath('/api/calendar/events/evt-987/subtasks/sub-1');
  assert.equal(subtaskId, 'sub-1');
});

test('returns null subtask id for /subtasks collection route', () => {
  const subtaskId = getCalendarSubtaskIdFromPath('/api/calendar/events/evt-987/subtasks');
  assert.equal(subtaskId, null);
});
