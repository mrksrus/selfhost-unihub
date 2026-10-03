# 0.13.3: Messages without a server link

Fixes bulk actions that failed in Sync accounts because of a message that was
never linked to the server. No database migration.

### Fixes

- **Marking mail read no longer fails for messages without a server link.** In
  a Sync account, UniHub's own copy of sent mail and mail kept from before the
  account used Sync are not linked to a server message. Changing such a message
  failed with "Sync this account before changing this message on the provider",
  and a bulk action that included one (for example marking all unread mail
  read) failed for every selected message. Read, star, move and delete on these
  messages now change only UniHub, and the rest of the selection is sent to the
  server as usual.
- **Extra local copies are cleaned up.** When such a local copy is the same
  message as one downloaded from the server (same Message-ID header, sender and
  subject, dated within a day), Sync removes the local copy and keeps the
  downloaded one, after the account's Sync confirmation. Local copies without
  a downloaded twin are kept. The mode-switch preview counts them.
- A message whose server link is damaged now says so, with the number of
  affected messages, instead of asking you to sync the account.

### After updating

Nothing to do. Confirmed Sync accounts remove the extra local copies in the
next background clean-up; unconfirmed accounts show them in the count of
messages confirmation would remove. See [Download and Sync](MAIL_MODES.md#sync)
for the rules.
