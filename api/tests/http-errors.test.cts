const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { ApiError, badRequest, clientError } = require('../dist/src/http/errors') as typeof import('../src/http/errors');

test('clientError forwards only 4xx errors meant for the client; driver and file system text becomes the fallback', () => {
  assert.deepEqual(clientError(badRequest('CALENDAR_ID_INVALID', 'Calendar id required'), 'Failed to update event'),
    { error: 'Calendar id required', status: 400, code: 'CALENDAR_ID_INVALID' });
  assert.deepEqual(clientError(Object.assign(new Error('Account is busy'), { status: 409, code: 'MAIL_ACCOUNT_BUSY' }), 'Failed to sync'),
    { error: 'Account is busy', status: 409, code: 'MAIL_ACCOUNT_BUSY' });
  assert.deepEqual(clientError(Object.assign(new Error("Data too long for column 'notes' at row 1"), { code: 'ER_DATA_TOO_LONG', errno: 1406, sqlState: '22001' }), 'Failed to update event'),
    { error: 'Failed to update event', status: 500 });
  assert.deepEqual(clientError(Object.assign(new Error("ENOENT: no such file or directory, open '/app/uploads/recordings/x.webm'"), { code: 'ENOENT', errno: -2 }), 'Failed to delete recording'),
    { error: 'Failed to delete recording', status: 500 });
  // A status outside 4xx, a non-error value and an error whose text is internal all stay generic.
  assert.deepEqual(clientError(Object.assign(new Error('upstream'), { status: 502 }), 'Failed'), { error: 'Failed', status: 500 });
  assert.deepEqual(clientError(null, 'Failed'), { error: 'Failed', status: 500 });
  assert.deepEqual(clientError(Object.assign(new ApiError(404, 'HIDDEN', 'internal path'), { expose: false }), 'Not found'), { error: 'Not found', status: 500 });
  const error = badRequest('FIELDS', 'Check the fields', { fields: ['title'] });
  assert.ok(error instanceof Error && error instanceof ApiError);
  assert.deepEqual(clientError(error, 'Failed'), { error: 'Check the fields', status: 400, code: 'FIELDS', details: { fields: ['title'] } });
});
