# Frozen schema 2 archive

`plain.zip` was created by the unmodified production exporter at `v0.10.3`,
commit `04fc92d99f0af0775e45d6e62345a3ddb5a06c83`, against a disposable MySQL 8.0.46
database containing invented data. It contains one mail account, a local folder,
its provider mapping, and a message. No live data, credentials or files were used.
`expected.json` records original source hashes, archive hash and expected content.

Normal tests consume this frozen archive. Do not regenerate it to make a reader
change pass. `generate.cjs` is an explicit maintenance tool requiring an untouched
`git archive v0.10.3 api` extraction, that version's dependencies, and an empty
`MYSQL_TEST_DATABASE` ending in `_test`. Set the MYSQL_TEST connection variables
and synthetic BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD, then pass the
extraction directory as its first argument. It creates tables and invented rows
in that disposable database. Clean up that database after generation.

This complements the earlier frozen plain/encrypted schema 1 fixtures; it is not
evidence for every possible historical database or backup.
