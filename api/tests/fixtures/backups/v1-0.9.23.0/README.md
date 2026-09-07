# Frozen v0.9.23.0 backup fixtures

These archives contain **only invented test data**. They exercise imports of a
historical export, rather than generating a new archive with the current exporter
and merely changing its version number.

## Provenance

- Historical tag: `v0.9.23.0`
- Immutable source commit: `e8813669c75ada5bad870d0f9c380083934ed291`
- Source: [v0.9.23.0 on GitHub](https://github.com/mrksrus/selfhost-unihub/tree/e8813669c75ada5bad870d0f9c380083934ed291)
- Generator: [generate.cjs](generate.cjs)
- Full source-file SHA-256 digests, generator digest, generated timestamp, Node
  version, artifact digests, row counts, and expected contents: [expected.json](expected.json)

The generator loads the exact historical `backup.js`, `export-jobs.js`,
`backup-container.js`, and credential `encryption.js` source from Git through an
isolated CommonJS loader. **Their source text is not modified.** It calls the old
`buildBackupArchiveEntriesForUser`, `writeZip`, and `encryptBackupFile` functions.
The database dependency supplies synthetic rows for the old exporter's SELECTs.
Filesystem calls for `/app/uploads` are redirected to a disposable temporary
directory, while the original storage paths remain in the exported records.
The generator makes no mail, calendar, or other network connections and never
reads or writes a deployed application's uploads.

This proves the behavior of the exporter at the recorded commit with these
inputs. It does not claim that every older version or every possible legacy
database state is covered.

## Files and expected behavior

| File | Contents |
| --- | --- |
| `plain.zip` | Historical payload/ZIP format version 1; credentials use the original deployment encryption key. |
| `encrypted.unihub-backup` | Historical encrypted container version 1 containing a format-1 ZIP and protected portable credentials. |
| `expected.json` | Original exported rows, file bytes and hashes, synthetic credentials, and archive provenance. |

Both archives cover settings, contacts, calendar, mail, and recordings. There are
two mail accounts using the same global custom folder, two emails and sender
rules, two raw MIME messages, an inline PNG, a binary attachment, calendar
subtasks/attendees/external references, and a short PCM WAV with a recording tag.
One saved HTML body contains the old attachment ID in
`/api/mail/attachments/<id>` as well as a `cid:` reference. Import tests should
verify any ID remapping and byte preservation separately: the raw EML itself
must remain unchanged.

The source account ID is `09230000-0000-4000-8000-000000000001`.
All keys/passwords below are public synthetic fixture values, never production
secrets:

- Recovery password: `Synthetic-0.9.23-Fixture-Recovery-Only-2026`
- Source `ENCRYPTION_KEY`: `synthetic-legacy-0.9.23-encryption-key-not-a-secret`
- Source `BACKUP_MASTER_KEY`: `synthetic-legacy-0.9.23-backup-master-not-a-secret`
- Data key and individual account passwords/tokens are recorded in `expected.json`.

On another deployment, the encrypted fixture's recovery password should recover
portable account credentials under that destination's encryption key. The plain
fixture's credentials require the original encryption key; with a different
key, the importer should retain data and safely report unavailable credentials.
Restored mail must not enable deletion on the original mail server.

## Deliberate regeneration

Normal tests use the checked-in artifacts. They do not need historical tags or
run this generator. To intentionally refresh the fixtures from the repository
root, with the historical tag available:

```sh
node api/tests/fixtures/backups/v1-0.9.23.0/generate.cjs --write
```

The generator checks the tag's immutable commit, writes only its named fixture
artifacts, validates the ZIP and recovery-password decryption, and removes its
temporary tree. Regeneration changes archive digests because the historical
exporter uses real cryptographic randomness and timestamps. Review and commit
the resulting archives and `expected.json` together; never regenerate them
automatically in a compatibility test.
