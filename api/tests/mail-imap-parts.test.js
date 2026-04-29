const test = require('node:test');
const assert = require('node:assert/strict');
const { simpleParser } = require('mailparser');
const {
  buildRawEmailFromImapParts,
  loadExistingImportedUidSet,
  normalizeSyncFetchLimit,
} = require('../src/services/mail');

test('prefers complete RFC822 IMAP body over split HEADER/TEXT parts', async () => {
  const rawEmail = [
    'From: CodeWeavers <noreply_at_codeweavers_com_7c4dpmf5k60072_977234f6@icloud.com>',
    'To: user@icloud.com',
    'Subject: Now Dispensing CrossOver 26 at 26% Off!',
    'Date: Tue, 10 Feb 2026 16:38:30 +0000',
    'Message-ID: <202610021638.test@example.com>',
    'Content-Type: multipart/alternative; boundary="mail-boundary"',
    '',
    '--mail-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Offer body',
    '--mail-boundary--',
    '',
  ].join('\r\n');

  const splitTextBody = [
    'content-type: multipart/alternative; boundary="mail-boundary"',
    'date: Tue, 10 Feb 2026 16:38:30 +0000',
    'from: CodeWeavers <noreply_at_codeweavers_com_7c4dpmf5k60072_977234f6@icloud.com>',
    '',
    '--mail-boundary',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Offer body',
    '--mail-boundary--',
    '',
  ].join('\r\n');

  const fullEmail = buildRawEmailFromImapParts({
    parts: [
      { which: 'HEADER', body: { subject: ['Now Dispensing CrossOver 26 at 26% Off!'] } },
      { which: 'TEXT', body: splitTextBody },
      { which: '', body: rawEmail },
    ],
  });

  const parsed = await simpleParser(fullEmail);

  assert.equal(fullEmail, rawEmail);
  assert.equal(parsed.from.value[0].address, 'noreply_at_codeweavers_com_7c4dpmf5k60072_977234f6@icloud.com');
  assert.equal(parsed.text.trim(), 'Offer body');
  assert.equal(parsed.text.includes('content-type:'), false);
});

test('reconstructs split HEADER/TEXT parts when complete IMAP body is unavailable', () => {
  const fullEmail = buildRawEmailFromImapParts({
    parts: [
      {
        which: 'HEADER',
        body: {
          from: ['Alice <alice@example.com>'],
          to: ['Bob <bob@example.com>'],
          subject: ['Hello'],
        },
      },
      { which: 'TEXT', body: 'Plain body' },
    ],
  });

  assert.match(fullEmail, /^from: Alice <alice@example.com>\r\nto: Bob <bob@example.com>\r\nsubject: Hello\r\n\r\nPlain body$/);
});

test('normalizes legacy initial sync limits to all', () => {
  assert.equal(normalizeSyncFetchLimit(undefined), 'all');
  assert.equal(normalizeSyncFetchLimit('all'), 'all');
  assert.equal(normalizeSyncFetchLimit('500'), 'all');
  assert.equal(normalizeSyncFetchLimit('nope'), null);
});

test('loads existing imported UIDs before message download', async () => {
  const calls = [];
  const existingUids = await loadExistingImportedUidSet({
    accountId: 'account-1',
    folderName: 'INBOX',
    uidValidity: 123,
    uids: [1, 2, 2, 3],
    connection: {
      async execute(query, params) {
        calls.push({ query, params });
        return [[{ imap_uid: 2 }, { imap_uid: 3 }]];
      },
    },
  });

  assert.deepEqual(Array.from(existingUids).sort((a, b) => a - b), [2, 3]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /source_folder = \?/);
  assert.match(calls[0].query, /imap_uid IN \(\?,\?,\?\)/);
  assert.deepEqual(calls[0].params, ['account-1', 'INBOX', 1, 2, 3, 123]);
});
