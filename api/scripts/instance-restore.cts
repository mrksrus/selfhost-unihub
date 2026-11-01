#!/usr/bin/env node
// The instance restore command from a checkout (after npm --prefix api run build):
//   node api/scripts/instance-restore.cts --file <backup.uhib> --key-file <file> [--verify-only]
// The image runs the same code as node /app/api/src/instance-restore.js
// (docs/DATA_RECOVERY.md "Instance backup"). Point MYSQL_* (or DATABASE_URL)
// and the storage roots at the installation to restore into; it must be empty.
// The restore drill of the release gate runs it against a second installation.
'use strict';

// Typed by hand: the scripts' type check does not follow the services' import syntax.
const { main } = require('../dist/src/instance-restore') as { main(argv: readonly string[]): Promise<number> };

main(process.argv.slice(2)).then(code => { process.exitCode = code; });
