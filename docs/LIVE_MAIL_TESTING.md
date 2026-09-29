# Live mail acceptance testing

Unit tests and healthy containers do not establish that a real mailbox works.
The opt-in `scripts/live-mail-smoke.mjs` exercises the **public application API**
and independently reads the actual IMAP server. It does not import application
services, update the database, clear queues, or send replacement IMAP commands
when an application action fails.

## Safety and prerequisites

- Use a dedicated, regular (non-admin) UniHub test user with one connected test
  mailbox in **two-way sync** mode. Never point this at someone else's mailbox.
- Install the API dependencies with `npm ci --prefix api`. Use Node 24 or newer (the API's declared engine).
- The script sends one uniquely identified message **to the same test address**,
  requires it to arrive unread and unstarred, changes only that message, and
  creates/reuses the `UniHub Live Smoke` folder.
- Successful runs leave that message in Inbox, unread and unstarred. They keep
  the Sent copy and the dedicated folder. A failed run leaves evidence intact;
  inspect the reported phase before retrying.
- HTTPS and verified IMAP TLS are required; application HTTP is accepted only
  on loopback for an isolated staging deployment.
- Obtain credentials from a secret manager at runtime. Do not put passwords in
  command arguments, commit them, or paste them into a bug report.

## Environment

Required variables:

| Variable | Meaning |
| --- | --- |
| `UNIHUB_SMOKE_CONFIRM` | Exact opt-in value: `I own this test mailbox` |
| `UNIHUB_BASE_URL` | Application origin, e.g. `https://unihub.example.org` |
| `UNIHUB_TEST_EMAIL` | Regular test user's login and connected mailbox address |
| `UNIHUB_TEST_PASSWORD` | Test user's UniHub password |
| `UNIHUB_IMAP_HOST` | Same verified IMAP host as the configured account |
| `UNIHUB_IMAP_USER` | Same provider username as the configured account |
| `UNIHUB_IMAP_PASSWORD` | Provider password for independent verification |

Optional variables: `UNIHUB_IMAP_PORT` (993), `UNIHUB_TEST_ACCOUNT_ID` (select
one matching account), `UNIHUB_SMOKE_ACCEPT_MS` (2000 ms maximum HTTP acceptance
latency), `UNIHUB_SMOKE_TIMEOUT_MS` (180000 ms per convergence check), and
`UNIHUB_SMOKE_REPORT` (private output JSON path).

Run after supplying those variables securely:

```sh
node scripts/live-mail-smoke.mjs
```

To inspect/reuse a message from an interrupted run without sending another,
set `UNIHUB_SMOKE_SUBJECT` to the exact `UniHub live smoke <UUID>` value in its
report. The script verifies its sender, recipient and body before proceeding.
A message left outside Inbox requires manual inspection before reuse.

## What the script verifies

1. Normal password authentication, CSRF-protected HTTP actions, and matching
   regular-user/account/provider identities.
2. SMTP sending, real delivery, incoming synchronization and preserved content.
3. Prompt sync acceptance and independent read/star/list requests during sync.
4. Provider-confirmed read/star writes, rapid opposite intents, actual queued
   writeback completion (not just optimistic list flags), and persistence after
   another sync.
5. Incoming changes from a separate IMAP client. This explicit phase runs only
   **after** outbound application writes have passed; it never repairs them.
6. Folder creation and safe moves out/back, including distinct completed move
   writebacks, exact message-byte preservation, source disappearance,
   destination presence and UI/API folder state agreement.

Exit status is nonzero on a failed check. The JSON report includes measured
acceptance latency and the failing phase; an HTTP 200 or a pending overlay alone
is never sufficient to count a provider change as successful.

## Additional release checks

Run the full frontend/backend tests, the real-MySQL recovery gate, production
image build and container smoke tests before publication. After deployment,
repeat the live acceptance check and exercise the actual browser UI: open a
message, change read/star state, change views while syncing, watch progress and
completion, and confirm failures do not produce success notifications.

Use the regression suites for deterministic disconnected-provider, cancellation,
restart, cross-owner isolation and concurrent-intent cases. Do not manufacture a
production outage or change another user's mailbox to create these failures.
A passing live test does not prove every provider, every network failure, or all
unrelated application features; report those limits honestly.
