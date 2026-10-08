# 0.19.0: The API is written in TypeScript

The API and the two browser workers are now written in TypeScript and
compiled before they run. UniHub works the same as before: the same pages,
routes, database and backup format. No database upgrade runs at startup.

### Changed

- **The API is compiled from TypeScript.** Routes, services, security helpers
  and the `mail-rollout` operator command are checked in strict mode and
  compiled to the same CommonJS layout as before. The image holds only the
  compiled code and the production dependencies. `/app/api/server.js` and
  `/app/api/mail-rollout.js` are where they were. The frozen database
  baseline (`database.js`) stays JavaScript.
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
