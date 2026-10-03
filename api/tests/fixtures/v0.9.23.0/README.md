# v0.9.23.0 schema fixture

`schema.sql` freezes the fresh-install schema from release **v0.9.23.0**:

- Commit: `e8813669c75ada5bad870d0f9c380083934ed291`
- Source: `api/src/services/database.js`
- Source Git blob: `7ab3856498bae1588c5814d706afac9bd9e4277a`
- Encryption source: `api/src/security/encryption.js`
- Encryption Git blob: `f7d46c5b2a0f8fdf6430f7a7054cd046edc053ce`

The SQL contains all 29 `CREATE TABLE IF NOT EXISTS` statements verbatim after
unescaping JavaScript backticks, followed by the calendar-event foreign key and
the two backup-job indexes added outside those statements. Other legacy column
and index migrations are already represented in the fresh-install definitions.
This is source-derived DDL, not a dump of someone's deployment. Do not regenerate
it from current application code or change it to make an upgrade regression pass.

To reproduce the schema extraction, save the release source first:

```sh
git show v0.9.23.0:api/src/services/database.js > /tmp/unihub-v09230-database.js
```

The extraction expressions used with Python's `re.S` flag were:

```python
creates = re.findall(r'await db\.execute\(`(CREATE TABLE IF NOT EXISTS .*?)`\);', source, re.S)
creates = [statement.replace('\\`', '`') for statement in creates]
calendar_fk = re.search(r'await db\.execute\(`(\s*ALTER TABLE calendar_events\s+ADD CONSTRAINT.*?)`\);', source, re.S).group(1).strip()
```

Append `calendar_fk` and the two `ALTER TABLE ... ADD INDEX` SQL strings passed
to `ensureIndex` for `idx_data_export_jobs_user_backup` and
`idx_backup_restore_jobs_user_backup`, separating all 32 statements with
semicolons. The SQL fixture intentionally has no semicolons inside SQL literals.

`data.json` is synthetic data for 19 tables, including two users, local and CalDAV
calendars, recurring events, subtasks, attendees, contacts, mail credentials,
message bodies, a draft, attachment metadata, remote mailbox mappings, renamed
and reordered folders, sender rules, settings, and a recording record. Its
passwords and encryption key are public test values, never deployment secrets.
Credential ciphertexts were produced by executing the encryption module from the
tag above with that test key. Login hashes use bcrypt with the release's cost of
12. Ciphertexts and hashes are stored once so decryption and login checks cannot
silently switch to the current writer's format.

Since 0.16.0 (MariaDB, fresh installations only) there is no upgrade test.
`backup-ownership-mysql-integration.test.js` uses `schema.sql` to create its
connection-local tables.
