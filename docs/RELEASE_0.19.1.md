# 0.19.1: Tests and tools are written in TypeScript

This release finishes the TypeScript conversion that 0.19.0 started. The API
tests, their helpers, the backup fixture generators and the development tools
are now TypeScript. UniHub itself is unchanged: the same pages, routes,
database and backup format as 0.19.0, and no database upgrade runs at startup.

### Changed

- **API tests are TypeScript and checked against the API.** The tests run
  directly on Node.js 26. API modules they load directly and the database
  driver are typed, so such a call with the wrong arguments fails the type
  check; modules loaded through the shared backup test runtime are not yet
  checked. Test doubles, partial database rows
  and deliberately malformed inputs are marked as such. The release gate
  still runs every database test without skips, and the historical backup
  archives and fixture data are unchanged byte for byte.
- **Development tools are TypeScript.** The container smoke test, the live
  mail smoke test, the email privacy browser check, the frontend notice
  collector and the PostCSS configuration use `.mts`. `npm run typecheck`
  now covers the API tests, these tools and the Tailwind and Vitest
  configuration, and CI runs it on every build.
- **The ESLint configuration stays JavaScript.** Editors and a plain
  `npx eslint` load it without extra flags.

### Upgrade

- With the container image there is nothing to do: pull and restart. The
  database is not changed, and backups from earlier versions restore as
  before.
- A completed 0.18.2 installation can upgrade directly to 0.19.1. Keep the
  same database, uploads volume and encryption keys.
- Development and test commands need Node.js 26, as in 0.19.0.
