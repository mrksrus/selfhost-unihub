# Frozen schema 4 contacts archive

`plain.zip` was created by the unmodified production exporter of `v0.25.1`
(commit `7be6f753ac50b5e8083224379a1aba4fc53d7396`), the last release writing
data schema 4, from a disposable MariaDB 11.8 test database containing invented
data: one person and four contacts in the fixed 3+3 shape, with unicode names
and notes (umlauts, CJK, Arabic, an emoji), empty, blank and skipped slots,
repeated values within one contact and a filled but never-used `avatar_url`.
Only reserved example domains are used. `expected.json` records the archive
hash, hashes of the exporter's source files and the inserted rows.

`backup-contacts-mysql-integration.test.cts` restores it through the current
reader: the fixed fields become `contact_values` as upgrade step 22 copies
them. Do not regenerate it to make a reader change pass.

`generate.cts` is the maintenance tool. It needs an untouched
`git archive v0.25.1 api package.json` extraction built with its own
`node scripts/build.cts` (dependencies from a current `api/node_modules` work),
an empty `MYSQL_TEST_DATABASE` ending in `_test` and the `MYSQL_TEST_*`
connection variables; pass the extraction directory as its first argument.
Remove that database afterwards.

The same extraction's reader refuses a schema 5 archive with "Unsupported
backup data version: 5. This UniHub version reads versions 1, 2, 3 and 4; a
newer backup may need a newer UniHub release." (checked 2026-10-30).
