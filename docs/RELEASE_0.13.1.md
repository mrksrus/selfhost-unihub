# 0.13.1: Message contents catch up

Fixes messages that stayed at "Loading message" on large accounts. No database
migration.

### Fixes

- **Messages no longer stay at "Loading message" on large accounts.** Message
  contents were downloaded one at a time at the lowest priority, behind
  read/star and presence checks that on large Gmail accounts run almost
  continuously, so thousands of messages could wait for days. Contents now
  download in batches of up to 25, newest first, ahead of those background
  checks. Messages whose download stopped after an error resume within five
  minutes instead of only when new mail arrives.

### After updating

Nothing to do. Within five minutes of the first folder check, every folder with
waiting messages gets a download job, and the backlog drains in the background
while new mail keeps arriving first. See [mail sync](MAIL_SYNC.md#one-job-runner)
for the priorities.
