# 0.19.0: The API is written in TypeScript

The API and the two browser workers are now written in TypeScript and
compiled before they run. UniHub works the same as before: the same pages,
routes, database and backup format. No database upgrade runs at startup.

### Changed

- **The API is compiled from TypeScript.** Routes, services, security helpers
  and the `mail-rollout` operator command are checked in strict mode and
  compiled to the same CommonJS layout as before. The image holds only the
  compiled code and the production dependencies. `/app/api/server.js` and
  `/app/api/mail-rollout.js` are where they were. The development scripts
  in `api/scripts/` are type-checked TypeScript that Node runs directly.
- **New databases start from the 0.16.0 schema.** Every installation since
  0.16.0 began with an empty MariaDB database, so the upgrade steps for
  databases from 0.9.x to 0.15.x never ran on existing data. They are
  replaced by one step that creates the same tables and records the same
  upgrade history. A new database is the same as one created by 0.18.2, and
  existing databases are not changed.
- **The browser workers are compiled too.** The notification service worker
  and the recording worklet keep their URLs (`/sw-custom.js`,
  `/audio-recorder-worklet.js`). Installed apps and push subscriptions keep
  working.
- **The image runs on Node.js 26.** The container, CI and the package
  manifests move from Node 24 to Node 26.

### Upgrade

- With the container image there is nothing to do: pull and restart. The
  database is not changed, and backups from earlier versions restore as
  before.
- Running the API from source (not the image) now needs Node.js 26 and its
  development dependencies to compile it: `npm --prefix api ci`, then
  `npm --prefix api start`, which builds `api/dist/` first.
- A new installation needs an empty database. UniHub no longer adds its
  tables to a database that already holds other tables or data without an
  upgrade history. A first setup by an earlier release that stopped partway
  is refused too: start 0.18.2 once to finish it.
