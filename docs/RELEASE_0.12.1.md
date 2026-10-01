# 0.12.1: Gmail sync fix

Fixes a Gmail sync stall introduced by 0.12.0 for mail imported with older versions. No database migration.

### Fixes

- **Gmail sync no longer stalls after updating to 0.12.0.** The new IMAP library
  reads Gmail's stable message id, which the old one never did. Mail imported
  before 0.12.0 was stored as one local copy per Gmail label, so the same id
  appeared on several copies and every sync window containing such a message
  failed with "Gmail identity belongs to another local item", leaving the Gmail
  queue to back up. Such copies now keep their own entry, as before 0.12.0, and
  the conflict is recorded for review instead of failing the sync. Nothing is
  merged or deleted.
- **Failed mail jobs are logged.** Each failed sync job now writes one
  `[MAIL JOB] <kind> failed for account <id>: <reason>` line to the container
  log (no addresses or mail content). Before, failures were only visible in the
  database.
