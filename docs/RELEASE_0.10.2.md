# UniHub 0.10.2

This release corrects backup ownership, outbound network validation, login and
two-factor authentication, and request/service failure handling. It also reduces
recording overhead and limits simultaneous audio conversion on older hardware.

## Security corrections

- **Backup ownership:** newly restored objects receive fresh IDs unless matched
  to existing data owned by the restoring user. Updates always include the owner;
  linked records are remapped and checked. A restore cannot overwrite another
  user's data by supplying its IDs. Keep existing, Replace and Keep both remain
  supported. Unexpected foreign or inconsistent relationships reject the restore.
- **Mail and calendar connections:** DNS is checked immediately before each
  connection, including background workers. Connections use the checked address
  while preserving the original hostname for TLS certificate verification.
  DNS failures and private/special-use address tricks fail closed. The existing
  administrator-controlled `TRUSTED_MAIL_HOSTS` exception still supports private
  mail/CalDAV servers.
- **Calendar credentials:** CalDAV requires HTTPS and validates every redirect
  and discovered URL. Credentials stay within the explicitly configured server
  origin. Responses and connection time are bounded. Restored account settings
  that fail network policy remain inactive with an explanatory warning.
- **Request handling and recovery:** malformed request addresses return a client
  error instead of escaping the request error handler. A service supervisor
  terminates the container if the API or nginx stops, allowing the existing
  Docker restart policy to recover it. Shutdown signals reach both services.
- **Login protection:** separate user and short IP attempt budgets replace the
  five-hour shared-IP lockout. Successful authentication never resets counters.
  Trusted proxies are resolved from the actual connection through a configured
  `X-Forwarded-For` chain; untrusted forwarded values are ignored. See the
  [authentication guide](AUTH_ADMIN_SETTINGS.md#rate-limiting) for exact limits.
- **Two-factor login:** session creation uses the user's ID, and challenge
  consumption, recovery-code removal and session insertion are atomic. Recovery
  codes and challenges cannot be reused concurrently. Session cookies are sent
  only after commit. New JWTs include random identifiers so simultaneous logins
  cannot collide; existing sessions remain compatible.
- **Audio input:** uploads/restores identify supported audio from file signatures
  instead of trusting its supplied content type. HTML/playlists cannot be served
  as restored recordings. MP3 conversion uses an explicit supported demuxer and
  file-only input protocols.
- **Dependencies:** patched mail parsing, MySQL client and other dependencies.
  React Router moves to the patched v7 declarative router; application routes
  and deployment requirements stay the same. Dependency audits and the full
  application checks are rerun with the locked versions used for this image.

## Recording efficiency

Microphone recording remains uncompressed mono PCM WAV. Original audio remains
the normal playback source; saving a recording does not automatically convert it.
MP3 export remains optional, with a user-triggered playback fallback if the
browser cannot decode the original format.

The capture worklet batches 4,096 samples per transfer instead of sending every
128-sample render block: 32 times fewer messages for full batches, while retaining
the same PCM samples. Capture uses the microphone's reported sample rate where
available instead of forcing 44.1 kHz. Uploads read and verify 512 KiB chunks rather
than copying and hashing a complete recording in browser memory.

One MP3 conversion runs at a time, with one decoder/encoder thread, bounded queue,
15-minute conversion deadline and 500 MiB output ceiling. A busy queue asks the
user to retry. Existing cached exports remain usable; originals are retained.
This reduces avoidable overhead but does not establish that Linux microphone or
driver-related popping is resolved on every device.

## Upgrade and configuration notes

**Existing 0.10.x installations can update in place using the same database,
uploads and keys. This patch adds no database migration.** Existing data IDs and
stored audio are not rewritten. Legacy restorable ZIP and encrypted backup
formats remain supported, subject to the new ownership and media validation.

**0.9.23.0 remains the tested in-place upgrade baseline for 0.10.x.** Earlier
0.9.x and customized schemas need a rehearsal on a copy; they are not all verified.
Keep a consistent backup of MySQL, uploads and configuration before upgrading.
An image-only downgrade is not a verified rollback. See [Upgrading](UPGRADING.md).

There are intentional compatibility restrictions:

- For an extra HTTPS reverse proxy, configure `UNIHUB_TRUSTED_PROXY_CIDRS` in the
  supplied Compose `.env` (runtime variable: `TRUSTED_PROXY_CIDRS`) to include the
  bundled loopback proxy and only your actual proxy addresses. See the
  [configuration example](AUTH_ADMIN_SETTINGS.md#trusted-proxies). An image pull
  alone cannot add this environment variable to an existing container.
- Private mail/calendar hosts require the administrator's existing allowlist.
  Cross-origin CalDAV discovery now requires explicitly configuring the final
  server URL rather than silently forwarding credentials there.
- New audio uploads/restores accept recognized WAV, MP3, M4A/MP4 audio, Ogg, WebM,
  FLAC, AAC and AIFF files. Files merely labeled as audio are rejected. Existing
  original files remain available, but MP3 conversion requires a supported format.
- Imported records get fresh IDs when no same-owner match exists. Backups with
  missing, foreign or inconsistent parent references fail instead of linking to
  unrelated data. Invalid network settings are restored inactive with warnings.

The **300-second maximum MySQL wait** is unchanged and ends immediately after an
authenticated connection succeeds. The **360-second health startup grace** is
unchanged. The only Compose addition is explicit proxy trust configuration;
service supervision is implemented inside the image.

## Validation

Release checks include API and frontend tests, lint, TypeScript and production
build, MySQL 8 two-user restore and authentication regressions, the populated
0.9.23.0 migration/restart test, and a built-container smoke test. The container
smoke checks production authentication, file handling, audio conversion,
malformed-request handling and container exit after an essential service dies.
CI results accompany the published release.

Synthetic audio tests cover PCM sample preservation, chunk integrity, queue
limits and supported-format conversion. Actual microphone behavior and background
PWA notification delivery still require checking on the intended device.
