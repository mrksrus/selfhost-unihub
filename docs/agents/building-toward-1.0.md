# Building toward 1.0

Part of the [agent guide](../../AGENTS.md). Read it before adding a table, route, setting, policy, notification, shared resource, device behaviour, export or dependency.


Architecture and security rules for new work, so each version fits the 1.0 end state without rework. The F numbers refer to the foundations listed in [docs/ROADMAP.md](../ROADMAP.md#foundations); the private `ARCHITECTURE-AND-SECURITY.md` (see [the version flow](version-flow.md)) explains them in detail. Design a foundation for its later users, and build only the slice the current version needs, together with its first feature, never as a refactor-only change. Until a foundation lands, the contracts in the agent guide apply.

- **Declare data, don't infer it.** A new table states five things, and the recovery catalog and data inventory carry them:
  - its owner: user, organisation or installation
  - whether it can be shared (grants)
  - its data class
  - its module
  - what restore does with it

  The data classes (F2) are:
  - `local`: only UniHub holds it
  - `local-by-policy`: Download-mode mail
  - `mirror`: a provider holds it; it is re-synced, not backed up per user
  - `org`
  - `config`
  - `installation`: never restored
  - `ciphertext`

  UniHub's own additions to a mirrored item (subtasks, ToDo state, manual order, links) are a `local` overlay keyed by the provider identity.
- **The server decides, the client shows.** Permissions, admin policies, privacy levels and module gates are enforced in the API and workers before side effects. The web page and the Android shell only reflect them: a locked control is greyed out with its reason. A rule that lives only in the client is a defect.
- **One owner per concern,** each called from routes and workers, never re-implemented beside it:
  - settings and policies (F1)
  - access and grants (F4)
  - devices (F5)
  - notifications (F6)
  - realtime (F7)
  - the platform boundary in `src/lib/platform.ts` (F8)

  Lint fences keep these boundaries, as they keep the 0.23 ones.
- **Settings and policies (F1).** A new option is one typed registry entry with a scope (user, mail account, calendar, device) and, where an admin may set a minimum or lock it, a policy. Policies resolve as user → group (strictest wins) → installation → default. A setting that points at a record is typed as a reference and remapped on restore. Identity-bound values such as signatures are columns of their record, not settings.
- **Destructive actions are policy-checked (F13).** A route that deletes or resets data names its policy key on its route spec. The boundary refuses it with `POLICY_FORBIDS` and a plain reason when the policy forbids it, and the policy test covers it. An admin path remains, with re-authentication and an activity-log entry. Changing a policy never deletes data by itself, with one exception: chat retention (`chat.retention_days`) is the policy whose purpose is to delete, so a shorter value starts deleting only 24 hours after a chat's time got shorter, with a count before saving, a typed confirmation, the rules notice, a line in each affected chat and an owner-only skip ([Chat](../CHAT.md#retention)).
- **Sharing goes through principals and grants (F3, F4).** Access is stored for principals (user, group, everyone), never as lists of user ids. Shareable resources carry `owner_kind` (user or organisation). Every shared read and write asks the access service. Revoking access reaches live streams, offline snapshots, Android copies and pending notifications. Test access with an owner, a grantee, a stranger and a revoked member through the real request handler and database.
- **Devices are records (F5).** Behaviour that differs per device (push channel, app lock, capabilities, chat keys, ringing) is keyed by device id, never by session token or push endpoint.
- **One notification pipeline (F6).** A new notification kind declares its source, its renderings per privacy level and its expiry, and uses the existing filters and per-device delivery. The server renders content at the resolved privacy level before encryption, except for end-to-end encrypted chat, which the device renders.
- **Live updates are hints (F7).** Every state a client can see is a row it can fetch again; an event only says what to refetch. There is no WebSocket: chat sends hints on the existing live stream and everything else as ordinary requests. If calls add a socket, it goes through the same request boundary and is bound to the session, so revocation closes it.
- **Files leave the page only through tickets (F9).** Android's open, save and share actions, external downloads and backup downloads use short-lived, single-use tickets bound to user and device. The session cookie is never handed to another app. The exception is an end-to-end encrypted chat file: the server holds only ciphertext, so the page decrypts it and hands the plain file to the Android app through the bridge, and nothing outside the page fetches it.
- **Identifiers and contracts are stable.** Anything exported, synced or shared carries a UID or UUID that survives other installations; auto-increment ids never leave the server. New routes get shared request and response schemas (F11), and a new module is added through a module manifest. Expand, then contract: old apps and archives keep working within their windows.
- **Keys and encryption (F10, F14).**
  - Every secret can be given as a file (`*_FILE`) or an environment variable.
  - Every ciphertext carries a key version.
  - No key is stored in a backup it protects, and the instance backup has its own key.
  - Encryption at rest is the volume's job, documented as an installation requirement.
  - End-to-end encryption is reserved for chat and calls: MLS through OpenMLS, compiled to WebAssembly from a small crate of our own and run in the page (the Android WebView runs the same module; no native bindings), and WebRTC media; key backups are passphrase-protected. The server's device list is trusted, so this protects against a read of the server's data, not against a changed server ([Chat](../CHAT.md#what-the-encryption-protects)). What the server needs to route and notify stays metadata it can read, and the documents say so: who is in a chat, a group chat's name, who was mentioned, file sizes ([Chat](../CHAT.md#what-the-server-sees)).
- **Dependencies fit the licence.** New libraries must be compatible with PolyForm Noncommercial plus the paid commercial licence; AGPL or GPL code (for example libsignal) is not linked in.
- **The deployment stays small.** One app container plus MariaDB, one API process (the worker owner runs background work), and the thin Android shell with native code only where the web cannot do the job. Calls add coturn and a media server as optional containers only.
