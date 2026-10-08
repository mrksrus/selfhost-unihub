# 0.19.0 review draft

0.19.0 prepares UniHub's API and classic browser workers in TypeScript. API
routes and services compile to the same CommonJS runtime layout. Source
startup/test commands compile first, and the image contains emitted code with
runtime dependencies. Notification and audio worker URLs stay the same.

The frozen database baseline remains JavaScript. Numbered migrations, SQL
schema and backup format versions are unchanged. Keep the usual consistent
pre-upgrade backup of the database, uploads, configuration and keys.

## Review status

Local branch: `conversion/typescript-20261008`.
Base: `283ed82071375d47bcb41201df4e92862443b5ec`.
Root and API manifests/locks are prepared as 0.19.0. No commit, push, tag,
image publication or deployment has occurred. 0.19.0 is not a published image.
The maintainer must inspect the full diff, including new untracked TypeScript
files, before authorizing publication.

Local validation passed: 669 API/MariaDB tests with zero skips, 231 frontend
tests, compiler/lint checks, frontend production build and a disposable
flattened API runtime install. Final whitespace cleanup left emitted runtime
bytes unchanged. These checks ran on local Node 26.7.0.

See [the migration checkpoint](TYPESCRIPT_MIGRATION.md) for exact coverage,
validation, remaining typing seams and resumption commands.

## Checks still needed before publication

- Build the image with Node 24 and run the existing container smoke workflow
  once Docker access is available. Local Node 26 tests and a flattened runtime
  install do not establish an Alpine image or managed-install result.
- Review emitted-worker behavior in a browser: recording capture, offline
  handover, sign-out/account-switch notification privacy and notification clicks.
- Review version/release notes, then authorize any commit, push or release step.

Published installation examples still refer to existing releases. Do not change
running deployments or use a 0.19.0 image tag until an image has actually been
reviewed, built, tested and published.
