const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMailHostTrustResult,
  deleteImapUid,
  isTlsTrustError,
  loadExistingImportedUidSet,
  normalizeSyncFetchLimit,
  recordMailServerMessageForDeletion,
  validateMailHostPolicy,
} = require('../src/services/mail');

test('normalizes legacy initial sync limits to all', () => {
  assert.equal(normalizeSyncFetchLimit(undefined), 'all');
  assert.equal(normalizeSyncFetchLimit('all'), 'all');
  assert.equal(normalizeSyncFetchLimit('500'), 'all');
  assert.equal(normalizeSyncFetchLimit('nope'), null);
});

test('host policy validation does not require certificate probes for public custom hosts', async () => {
  const result = await validateMailHostPolicy({
    imap_host: '93.184.216.34',
    imap_port: 993,
    smtp_host: '93.184.216.34',
    smtp_port: 587,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.mailHostTrust.blocked, false);
  assert.equal(result.mailHostTrust.requiresConfirmation, false);
  assert.equal(result.mailHostTrust.requiresInsecureTls, false);
  assert.deepEqual(result.mailHostTrust.certificates, {});
});

test('IMAP TLS verification failures produce host trust confirmation details', async () => {
  const result = await buildMailHostTrustResult({
    imap_host: '93.184.216.34',
    imap_port: 993,
    smtp_host: '93.184.216.34',
    smtp_port: 587,
    imapTlsError: 'self-signed certificate',
  });

  assert.equal(result.blocked, false);
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.requiresInsecureTls, true);
  assert.equal(result.certificates.imap.authorized, false);
  assert.equal(result.certificates.imap.error, 'self-signed certificate');
  assert.equal(result.certificates.smtp, undefined);
  assert.match(result.warnings.join('\n'), /IMAP certificate/);
});

test('classifies Node TLS certificate errors for trust confirmation', () => {
  assert.equal(isTlsTrustError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' }), true);
  assert.equal(isTlsTrustError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'Hostname/IP does not match certificate' }), true);
  assert.equal(isTlsTrustError({ code: 'ECONNRESET', message: 'Connection ended unexpectedly' }), false);
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

test('server delete helper uses UID-scoped expunge', async () => {
  const calls = [];
  const connection = {
    imap: {
      serverSupports: capability => capability === 'UIDPLUS',
      addFlags: (uid, flag, callback) => {
        calls.push(['addFlags', uid, flag]);
        callback(null);
      },
      expunge: (uid, callback) => {
        calls.push(['expunge', uid]);
        callback(null);
      },
      delFlags: (uid, flag, callback) => {
        calls.push(['delFlags', uid, flag]);
        callback(null);
      },
    },
  };

  await deleteImapUid(connection, 42);

  assert.deepEqual(calls, [
    ['addFlags', 42, '\\Deleted'],
    ['expunge', 42],
  ]);
});

test('server deletion queue skips messages without a usable raw archive', async () => {
  let writes = 0;
  const queued = await recordMailServerMessageForDeletion({
    userId: 'user-1',
    accountId: 'account-1',
    emailId: 'email-1',
    sourceFolder: 'INBOX',
    imapUid: 42,
    imapUidValidity: 123,
    rawStoragePath: '/tmp/not-under-mail-raw/email.eml',
    connection: {
      execute: async () => {
        writes++;
        return [{ affectedRows: 1 }];
      },
    },
  });

  assert.equal(queued, false);
  assert.equal(writes, 0);
});

test('server delete helper refuses mailbox-wide expunge fallback', async () => {
  const calls = [];
  const connection = {
    imap: {
      serverSupports: () => false,
      addFlags: () => calls.push('addFlags'),
      expunge: () => calls.push('expunge'),
    },
  };

  await assert.rejects(
    () => deleteImapUid(connection, 42),
    /UIDPLUS/
  );
  assert.deepEqual(calls, []);
});
