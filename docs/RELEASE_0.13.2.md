# 0.13.2: Large messages no longer block downloads

Fixes messages that stayed at "Loading message" behind a few large messages. No
database migration.

### Fixes

- **A large message no longer blocks every message behind it.** A message had
  30 seconds to download in full, which large Gmail messages often missed;
  since contents download newest first, the same message was tried again in
  every job and the messages behind it stayed at "Loading message". A message
  now has up to 5 minutes, and a download that stops sending data is still cut
  off after 30 seconds. A message that misses the deadline is set aside so the
  rest continue; **Sync now** tries it again.
- **Messages up to 50 MiB are downloaded** (previously 32 MiB), the largest
  message Gmail accepts.

### After updating

Nothing to do. Within five minutes of the first folder check, waiting messages
download again; a message that was stuck either completes or is set aside. A
50 MiB message is held in memory while it is imported, so a container with a
tight memory limit may need a little more headroom. See
[mail sync](MAIL_SYNC.md#one-job-runner) for the details.
