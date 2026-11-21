# Chat

From 0.33.0, UniHub has a Chat module: chats between two people of the same
UniHub installation, on the web, in the installed web app and in the Android
app. Every chat is end-to-end encrypted. This page is the contract: what is
encrypted, what it protects and what it does not, how devices and history
work, and the routes and tables behind it. The other pages link here.

## What the server sees

Messages are encrypted on the sender's device and opened on the devices of
the two people in the chat. The server stores and passes on bytes it cannot
read. It never sees a message's text, a reply's quote, a notification's
preview or the history.

The server does see, and keeps:

- who has a chat with whom, and when each message was sent;
- how long a message is: the encrypted message is padded to 256 bytes, but
  its archive copy and its notification preview are not, so the server can
  tell a message's length in bytes;
- which message edits or deletes which (an edit and a deletion name the
  message they change);
- each person's devices that take part in Chat, and which device sent a
  message;
- each person's read and delivered marks, and who has a UniHub page open
  (presence);
- that a notification was sent to a device, and when.

## What the encryption protects

**It protects** chats against anyone who reads the server's database, a
backup, its disks or its logs, a curious administrator included. None of
them can read a message, now or later, without a device of one of the two
people or that person's chat passphrase.

**That rests on the passphrase.** The key backup is in the database. Someone
with a copy of the database or a backup can try passphrases offline, as fast
as their hardware allows: 600,000 rounds slow each guess but do not limit how
many. Chat accepts any passphrase of 12 characters, a weak one too, so choose
a long one of several unrelated words.

**It does not protect** against a server that someone has changed to attack
its users. Every UniHub client runs code the server hands it: the browser
and the installed web app load the page from the server, and the Android app
is a frame around the same page, also loaded from the server. A changed
server could serve a page that sends the text elsewhere, or list a device of
its own as one of a person's devices. UniHub does not verify devices between
people (no safety numbers, no "the key changed" warning), because a server
that can lie about devices can also change the code that would check them.
This holds for every client.

What follows from that:

- **The server's device list is trusted.** A person's chat devices are the
  ones the server lists. When a device joins a chat, the chat shows a line:
  "Blair added a device" (or "You added a device"), so a device nobody added
  can at least be noticed.
- **A device holds keys.** A device that has opened the history keeps the
  history key. Someone who has a removed device and a copy of the database
  can read that person's history, not only what the device had stored.
  Remove a lost device at once (below) and rely on the phone's own lock and
  encryption; the [app lock](APP_LOCK.md) is a gate, not encryption, and the
  chat store on the device is not encrypted by it.
- **Screenshots.** The Android app refuses screenshots while Chat is open.
  A browser cannot block them.

## MLS and the library

Chat uses **MLS** (Messaging Layer Security, RFC 9420), the IETF standard
for end-to-end encrypted messaging between groups of devices. Each device
has its own keys; the devices of a group share a secret that no one outside
the group can compute; every message is encrypted for exactly the devices in
the group.

UniHub uses [OpenMLS](https://github.com/openmls/openmls) 0.9.2 (MIT) with
one cipher suite, `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (the one
RFC 9420 makes mandatory), and pads every message to 256 bytes. A small
wrapper crate of UniHub's own (`crypto/chat-mls`, about 200 lines of Rust and its tests)
exposes the few calls Chat makes. It is built to WebAssembly and runs in the
page; the Android app runs the same file in its WebView. There is no native
MLS code. OpenMLS lists the WebAssembly target as unsupported but builds it
on every change; UniHub's CI builds the module from pinned versions and
tests it in Chromium and in the Android WebView.

**What the audit covers.** OpenMLS had an independent security audit by
SRLabs, paid by the Sovereign Tech Agency (report of March 2026). It covered
the protocol crates `openmls`, `openmls_traits` and
`openmls_basic_credential`. It did not cover the cryptographic provider
UniHub uses (`openmls_rust_crypto`, built on the RustCrypto libraries and
`hpke-rs`), the storage UniHub uses (`openmls_memory_storage`), the
WebAssembly build, or anything UniHub wrote: the wrapper crate, the loader,
the device store, the sealing and key backup code, and the server's rules.
UniHub itself has had no independent audit.

UniHub's own cryptography uses the browser's WebCrypto, no new primitive:

- **Sealing** (archive copies and notification previews) in the Web Push
  format of RFC 8291: P-256, HKDF and AES-GCM.
- **The key backup**: the history private key wrapped with AES-GCM under a
  key derived from the chat passphrase with PBKDF2-SHA-256, 600,000 rounds
  and a random salt.

The module's memory and the stored MLS state hold keys as bytes that the
page's JavaScript could read; no function hands a private key to the page.
Only the browser's preview key is a non-extractable WebCrypto key. Under
the limit above this changes nothing: code that could read the keys is code
the server served.

## Devices

A **chat device** is one of the person's devices (a browser profile, an
installed web app or an Android app installation, as listed under Settings ›
Security › Devices) that enrolled for Chat.

- **Enrolment is silent.** The first UniHub page that starts with Chat on
  makes the device's MLS keys, 100 key packages (one-time keys others use to
  add the device to a group) and one last-resort package (handed out when
  the others are used up, and reused), and in a browser a preview key. It
  sends the public parts. Nothing is asked. The device tops its packages up
  at every start. Its state lives in an IndexedDB database of the person
  (`unihub-chat:<user id>`), written one step at a time, each step in one
  transaction with the MLS state it changed. Several tabs share one device:
  one of them runs it, the others hand it what they send.
- **Who can be written to.** Any active person with Chat on who has opened
  UniHub once since the upgrade. Until then the chat says "<name> has not
  opened UniHub since the update."
- **A group never changes.** One MLS group holds the devices of the two
  people. When those devices change (a new browser, a removed phone), the
  next device that sends makes a new group with the current devices and
  posts its one Welcome (the message that lets each device join). The
  server makes it current only while the group the sender saw is still
  current; two devices making a group at once converge. No group is ever
  changed after it was made, so the server orders messages per conversation
  and nothing else.
- **A stale device list gets 409.** The server refuses a message with `409
  CHAT_GROUP_STALE` (with the current group's id) when its group is not the
  current one, or when the current group's devices are not exactly the
  valid devices of the two people. The client reads again, uses the current
  group if it is in it, otherwise makes a new one, and sends again from its
  outbox. So no message is encrypted for a device after it was removed.
- **Removing a device.** Signing a device out under Settings › Security ›
  Devices (yourself or an administrator), the hourly clean-up of devices
  unused for 30 days without a session, and an instance restore remove the
  device's record and with it its chat device. Its session ends at once, so
  the server serves it nothing more; the next message in each chat goes to
  a new group without it. The device list marks devices that hold chat keys
  "Chat", and the sign-out dialog says such a device also leaves the chats.
- **Signing out** removes the chat device and deletes the browser's chat
  store: messages, keys and the history key. A session that only expired
  keeps both, the device stays in its chats, and signing in again as the
  same person goes on. Another person signing in on that browser deletes
  the earlier person's store. Firefox before 126 cannot list a site's
  stores: there the store of the person who signs out is still deleted, but
  one left by a person whose session only ran out can stay until the site's
  data is cleared.
- **A device that was not in a group** (new, or away while the group was
  made) cannot read that group's messages through MLS. It reads them from
  the archive after the passphrase (below). That is the only case that needs
  the passphrase.

## History and the passphrase

MLS deletes old keys on purpose, so a new device cannot open old
ciphertext. Chat's history is a personal archive instead: each device seals
every message it sends or reads to its person's **history key** and uploads
that copy. The server stores the copies per person.

The history key's public half is on the server, so any device of the person
can seal to it. Its private half is on the server only in the **key
backup**, wrapped by the **chat passphrase**, and on every device where the
passphrase was chosen or entered. The passphrase never leaves the devices.

- **Choosing it.** Chat asks for a passphrase the first time it is opened,
  and cannot be used before: at least 12 characters (counted after Unicode
  normalisation), typed twice, with a hint at its strength. A weak one is
  accepted too, and can be guessed by someone who holds a copy of the
  database (above). It should not be the sign-in password, because the
  server sees that one at every sign-in; the screen says so and does not
  check it.
- **A new device** reads new messages at once, with nothing typed: the next
  message's sender includes it. "Enter your chat passphrase" brings the
  earlier messages; the chat list says how far they are. A wrong passphrase
  stays on the prompt with the reason. "Not now" opens the chats without
  the earlier messages, and the list keeps a line to enter it later. If the
  connection breaks while the earlier messages are fetched, the device
  fetches the rest at its next sync.
- **A new passphrase** is set under Settings › Chat on a device that holds
  the history, with the account password. The old passphrase is not needed,
  so a forgotten one loses nothing while one device still holds the history.
- **"Start a new key"**, for when the passphrase is forgotten and no device
  holds the history any more, asks for the account password and a new
  passphrase. Before it starts it says what is lost: the server drops every
  archive copy sealed to the old key; each device that still holds messages
  seals them again under the new key; a device that held the old key drops
  it and asks for the new passphrase. Messages no device holds cannot be read
  again, by anyone. The other person keeps their messages.
- **Nobody else can read or restore a chat.** There is no recovery key for
  the organisation and no administrator path to a person's messages or
  history. Without the passphrase and without another signed-in device, a
  lost device means lost history.
- **Archive copies are not signed.** A device checks that a copy's message
  and chat ids match the entry it is stored under, and drops it otherwise.
  Someone who can write to the database could still store a made-up copy for
  a message, because anyone with the public history key can seal to it.

## Messages

- **Text only**, up to 8,000 characters, plain text with line breaks; web
  addresses show as links. One chat per pair of people: starting it again
  opens the same one. A chat is started with **Message** on a colleague's
  entry in Contacts › Company, or on one of your contacts whose address is a
  colleague's.
- **Replies** quote the message they answer. The reference is inside the
  encrypted message.
- **Edits.** Only your own messages, at any time, marked "edited". An edit
  is a new message that names the one it replaces; the earlier text stays
  stored, encrypted, until the message is deleted. An edit sends no
  notification.
- **Deleting** is for the sender only and removes the message for both
  people. It is final: there is no bin. The message and its edits lose their
  ciphertext, their archive copies and any notification not yet sent are
  removed, and a deletion entry tells every device, which shows "Message
  deleted". While the administrator forbids deleting for good (`bin.delete`),
  Delete is greyed out with the reason and the server refuses it (`403
  POLICY_FORBIDS`); the ciphertext then stays, and reading it still needs a
  device or the passphrase of one of the two people. A message that was not
  sent can be discarded from its menu.
- **Unreadable messages** (damaged, changed, or one the encryption module
  stopped on) show "This message could not be read." and cost only
  themselves; the chat goes on.
- **Offline.** The Chat page reads the device's own store, so it opens
  without a connection. What you write waits in an outbox and goes out in
  order once online; a refused message shows "Not sent" with Try again.
- **A person who cannot be written to** (deactivated, deleted, Chat off for
  them, or no chat device yet) keeps the chat readable, with the reason in
  place of the composer. A deleted person's chats stay for the other side,
  shown as "Deleted person".

## Presence and read receipts

- **Presence** is "has a UniHub page open": a person counts as online while
  a page of theirs holds the live update stream. The Android app's
  background notification connection does not count. It is shown as a dot,
  only between people who share a chat, and only while both have it on. A
  change goes out at most once in ten seconds per person.
- **Delivery state** under your own messages: "Sent" once the server took
  it, "Delivered" once a device of the other person fetched it, "Read" once
  they opened the chat while the page was visible.
- **Read receipts.** "Read" shows only while both people have read receipts
  on. Opening a chat always stores the read mark, because it also clears the
  unread count on the reader's other devices. With receipts off for either
  person, the other person is told nothing about the reading itself: they
  see "Delivered" at most, and reading moves the delivered mark only if no
  device of the reader had fetched the message yet. The server knows when
  someone read a chat either way.
- **Settings › Chat** has the two switches ("Show when I have UniHub open",
  "Read receipts"); with either off you do not see the other person's
  either. An administrator can lock each on or off for everyone or a group
  (`chat.presence`, `chat.read_receipts`;
  [policies](AUTH_ADMIN_SETTINGS.md#data-safety-policies)). Neither value is
  stricter, so a group's lock holds for a person only when all their groups
  agree; otherwise the value for everyone holds.

## Notifications

A chat message sends one notification (kind `chat`) to the other person,
never to the sender and never for an edit. Its detail is the person's
"What a notification shows" under Settings › Chat, floored by the
administrator's `notifications.detail`:

| Detail | Title | Text |
| --- | --- | --- |
| Sender and message (`full`) | The sender's name | The start of the message, where the device can open it; otherwise "New message" |
| Sender only (`sender`) | The sender's name | "New message" |
| Nothing (`none`) | "New message" | none |

- **Previews are sealed per device.** The server cannot write the text, so
  the sender's device seals the first 160 characters for each of the other
  person's devices: in a browser to the preview key that browser made at
  enrolment, in the Android app to the app's notification key. The server
  sends each device only its own preview, and only at `full`.
- **The lock first.** A device whose app lock covers Chat and that is not
  unlocked now, or a person whose time to set up required two-factor
  sign-in has ended, gets the `none` text and no preview. The service worker
  and the Android app check the lock again before they open a preview.
- **Fallback.** A preview the device cannot open, and an app or browser
  that does not know previews, show "New message".
- **One per chat.** Each chat has one notification, replaced (and sounding
  again) by its newest message; tapping it opens the chat (`/chat?c=<id>`).
  A message read or deleted before its notification went out is not sent.
  A chat notification expires after a day; the queued notification with
  its sealed previews is cleaned up about a month later, or at once when the
  message is deleted. A message posted triggers a delivery pass at once.

Delivery details are in [PWA](PWA.md#enable-notifications) and
[Android app](ANDROID.md#notifications).

## The Android app

- **Screenshots are blocked while Chat is open**: the app's window is secure
  as soon as the page moves to `/chat`, for everyone, with no setting (a frame
  drawn in the moment of moving there from another page may still be
  captured). Android
  then refuses screenshots and screen recording and shows the app blank in
  recent apps. Leaving Chat releases it, unless the administrator forbids
  screenshots in the whole app. A notification in the shade is not part of
  the window.
- **Notifications** show the message text (at `full`), in a channel of their
  own, "Chat messages".
- **Chat in the app lock.** Chat is one of the modules the app lock covers.
- **An app from before 0.33** keeps working with Chat (the page is the
  server's) but shows "New message" without text, does not block
  screenshots in Chat and cannot lock Chat: it locks the other modules, and
  Settings and the lock prompt say "Update the UniHub app to lock Chat."
  Where the administrator requires a lock on Chat, such an app falls short
  of the requirement and the server refuses it what it refuses any device
  short of the lock ([App lock](APP_LOCK.md#required-by-the-administrator)).

## Limits of this version

- **Two people, text only.** No group chats, attachments, voice messages,
  search, reactions, formatting or typing indicator. Chats cannot be muted
  and people cannot be blocked. A chat is never deleted, only messages.
- **No personal backup.** Chats are in no personal backup: the server cannot
  write a copy that opens outside UniHub, and a chat names another person.
  Every backup says "Chats are not in this backup. They are restored with
  your chat passphrase." Settings › Delete data has no Chat entry, and an
  administrator has no way to read or delete single messages.
- **Instance backup and restore.** The instance backup carries every chat
  table as stored: ciphertext stays ciphertext, and the history key stays
  wrapped by each person's passphrase. A restore deletes every device, so
  every device enrols again at its next sign-in and the next message makes
  new groups. Each device keeps the messages it holds. Messages newer than
  the backup exist only on the devices that hold them; earlier ones come
  back from the archive with the passphrase ([Data
  recovery](DATA_RECOVERY.md#after-an-instance-restore)).
- **Browsers.** Chat needs WebAssembly and a browser that honours
  `'wasm-unsafe-eval'` in the security policy (Chrome and Edge 97, Firefox
  102, Safari 16 or later). Where WebAssembly is switched off (an iPhone in
  Lockdown Mode, some hardened settings), the page says "Chat needs
  WebAssembly, which this browser has switched off." The module is about
  half a megabyte compressed and is fetched only by a signed-in page with
  Chat on.
- **Offline copies.** The offline snapshot holds no chats, and the
  `offline.copies` policy does not remove the device's chat store: Chat
  keeps its messages on each device.

## Group chats (server)

A group chat has a name (1 to 80 characters, plain text on the server) and at
most 100 people (`400 CHAT_TOO_MANY_PEOPLE`). Its people are its grants:

- **Chosen people.** The creator manages it; a manager renames it and adds
  or removes people. A member adds only people who share an organisation
  group with them, or anyone while `chat.reach` is `organisation` for them;
  an administrator anyone (`403 CHAT_OUT_OF_REACH`). Anyone may leave.
- **Following a group.** Made by that group's manager or an administrator;
  only an administrator follows everyone. Its people are the group's, so it
  changes with the group, and nobody adds, removes or leaves by hand (`409
  CHAT_FOLLOWS_GROUP`). The group's managers and the administrators in it
  manage it: rename, or stop following, after which it is a chat of the
  people it has. Deleting the organisation group does the same. An
  administrator who makes one for a group they are not in does not see it.
  The limit of 100 is checked when it is made; a followed group that grows
  past 100 later keeps its chat.
- **No manager left.** A chat of chosen people whose managers are all gone
  or deactivated is managed by its longest-standing active member (of
  people added at the same moment, the one with the lowest id).
- **Joining and removal.** A person added reads from the first MLS group
  that holds their devices: their `joined_seq` is set then, and nothing
  older is served (before it, nothing at all). Adding or removing someone,
  or a change of the followed group, changes the chat's devices, so the next
  post is refused with `409 CHAT_GROUP_STALE` until a new group names
  exactly the valid devices of its people. Someone removed, or who left, is
  refused at once; their marks and their archive copies of that chat go. A
  member who cannot be written to does not block a group chat.
- **Mentions.** A post may name up to 20 of the chat's other people
  (`mentions`); the server keeps no list and uses it only for the
  notification. Not in a direct chat (`400 CHAT_MENTION_INVALID`).
- **Notifications.** Every other person of the chat, titled "Alex in
  Launch" or "Alex mentioned you in Launch" (the sender alone in a direct
  chat). Each person chooses per chat: everything, mentions only, or
  nothing (`notify`); the unread count stays.
- **What the server sees** in addition: a group chat's name, who follows
  what, and who was mentioned in each message.

| Route | What it does |
| --- | --- |
| `POST /api/chat/conversations` with `kind: 'group'` | A group chat of people (`user_ids`) or following a group (`follow`) |
| `PUT /api/chat/conversations/:id` | A manager renames it |
| `GET /api/chat/conversations/:id/members` | Its people with role, reason, marks and presence |
| `POST /api/chat/conversations/:id/members` | A manager adds people |
| `DELETE /api/chat/conversations/:id/members/:userId` | A manager removes someone |
| `POST /api/chat/conversations/:id/leave` | The caller leaves |
| `POST /api/chat/conversations/:id/unfollow` | A manager stops following the group |
| `PUT /api/chat/conversations/:id/notify` | `all`, `mentions` or `none` for the caller |
| `GET /api/chat/candidates?q=` | People within reach and the groups the caller may follow |

## Files and retention (server)

**Files.** The device encrypts a file (and a picture's small preview, a
second file) and uploads the ciphertext, one request per file of at most
101 MiB; the server checks the uploader's `chat.attachment_max_mb` (`413
CHAT_FILE_TOO_LARGE` with the limit) and stores it under
`chat/<conversation>/<id>` of the uploads volume. The post names up to 20 of
the sender's uploads to that chat that no message uses yet (`400
CHAT_ATTACHMENT_INVALID` otherwise; an edit names none). A file is served,
as stored and never cached, to a member of the chat who reads its message
(not to someone who joined after it), and to its uploader before it is
sent. It goes with its message; an upload no message names goes after a
day. A file belongs to its chat: deleting the uploader keeps it for the
others, and Server › Storage counts it toward its uploader (a deleted
one's under "former colleagues"). The server sees each file's size, chat
and uploader, never its name, type or content. A reverse proxy in front
must let a 101 MiB body through to this route
([Installation](INSTALLATION.md#1-prepare-your-server-and-browser-address)).

**Retention.** `chat.retention_days` deletes messages older than it. A chat
follows the shortest value among its active people; each conversation
answers `retention_days` and `retention_from` (when deleting under it
starts). The hourly job works the value out again: a shorter one starts 24
hours later, whatever made it shorter (a policy, or someone under a shorter
rule joining a group or the chat); a longer one, or none, holds at once and
never ends a wait early. Then it deletes, in the chats whose moment has
passed, the messages sent before the value (an edit does not renew one)
with their edits, deletion entries, archive copies, files and queued
notifications. Retention deletes even while `bin.delete` forbids deleting
for good. Before saving a shorter value an administrator sees what it would
delete (`GET /api/admin/chat/retention-preview`); a policy is saved with the
password and written to the activity log, as every policy is. Only the
owner starts the waiting chats at once, with their password (`POST
/api/admin/chat/retention/apply-now`, `admin.chat_retention_applied`);
"Undo" is saving the earlier value within the 24 hours. Devices delete their
own copies when next opened. Instance backups made before keep the deleted
messages, as ciphertext, for as long as they are kept.

The same job clears the Welcome of a group replaced 30 days ago, deletes
uploads never sent, and deletes a chat nobody is in any more (not one that
follows a group), with everything it holds; while deleting for good is
forbidden for everyone, such a chat stays until retention has emptied it.

**People who leave.** A deactivated person stays in their chats and comes
back when activated; `active` is false on their member entry, their
messages' sender and, in a direct chat, the `peer`. A deleted person's
messages and files stay, with the sender and the uploader emptied.

| Route | What it does |
| --- | --- |
| `POST /api/chat/conversations/:id/attachments?id=` | Upload a file's ciphertext (body kind `upload`) |
| `GET /api/chat/attachments/:id` | The ciphertext, `Cache-Control: no-store` |
| `GET /api/admin/chat/retention-preview?days=&group_id=` | Messages, files and chats a shorter value would delete; and how many chats wait to start deleting, and from when |
| `POST /api/admin/chat/retention/apply-now` | The owner ends the waits, with the password |

## Reference

### Routes

Every route is in the module `chat` and the app lock area `chat`, and none
is gated by a restore section. The request and response shapes are in
[`api/src/contracts/chat.ts`](../api/src/contracts/chat.ts). Shared
refusals: `403 MODULE_DISABLED` while Chat is off for the person, `403
APP_LOCK_REQUIRED` for a device short of a required lock on Chat, and `404
CONVERSATION_NOT_FOUND` for a chat the person is not in (a missing one
included).

| Route | What it does |
| --- | --- |
| `GET /api/chat/account` | The person's history public key and key backup; null before the first passphrase |
| `POST /api/chat/account` | The first passphrase (`409 CHAT_ACCOUNT_EXISTS` after) |
| `PUT /api/chat/account/key-backup` | A new passphrase for the same key, with the account password |
| `POST /api/chat/account/new-key` | A new key and passphrase, with the account password; drops the person's archive |
| `POST /api/chat/devices` | Enrol this device; an earlier chat device of it is removed |
| `GET /api/chat/devices/current` | This device's chat device (`404 CHAT_DEVICE_NOT_ENROLLED` without one) |
| `POST /api/chat/devices/current/key-packages` | More key packages, at most 100 unclaimed; a new last resort replaces the old one |
| `GET /api/chat/conversations` | The person's chats, latest first, with unread counts, marks, the other person's state and presence |
| `POST /api/chat/conversations` | Find or make the chat with a person |
| `GET /api/chat/conversations/:id/devices` | The valid chat devices of both people, with their preview keys |
| `POST /api/chat/conversations/:id/key-packages` | Claim one key package of every other device, for a new group |
| `POST /api/chat/conversations/:id/groups` | A new group and its Welcome; `409 CHAT_GROUP_STALE` when the chat moved on |
| `POST /api/chat/groups/:id/joined` | This device joined; the Welcome goes once every device has |
| `POST /api/chat/conversations/:id/messages` | A message or an edit, with the sender's archive copy and the previews; `409 CHAT_GROUP_STALE`, `403 CHAT_UNAVAILABLE` |
| `GET /api/chat/conversations/:id/messages` | Entries after a sequence number, with the Welcomes this device has not joined |
| `DELETE /api/chat/messages/:id` | Delete for both people; declares `bin.delete` |
| `PUT /api/chat/conversations/:id/marks` | Move the read and delivered marks forward |
| `POST /api/chat/archive`, `GET /api/chat/archive` | Store and list the person's own archive copies |

### Live hints

Two events on the existing live update stream (`GET /api/events`), withheld
from a page whose person has Chat off. They carry ids only; the page fetches
through the routes above. There is no WebSocket: messages travel only in
ordinary requests ([Architecture](ARCHITECTURE.md#live-status-events)).

- `chat.changed` (`conversation_id`): a chat has a new group, message,
  deletion or mark. A mark that only records reading, with receipts off, is
  told only to the reader.
- `chat.presence` (`user_id`, `online`): a person someone shares a chat with
  opened their first page or closed their last.

The page also fetches when the stream reconnects and when it becomes
visible. With the Android app in the background, a message arrives as its
notification over the app's own connection; the page fetches when opened.

### Tables

Upgrade step 31 adds nine tables. None is in a personal backup; the instance
backup carries each as stored. The manifest is `api/src/modules/chat.ts`.

| Table | Holds | Owner | Class |
| --- | --- | --- | --- |
| `chat_accounts` | The history public key and the passphrase-wrapped key backup | person | ciphertext |
| `chat_devices` | Chat devices and their preview keys; a removed one has no device | person | installation |
| `chat_key_packages` | Unclaimed key packages and last resorts | person | installation |
| `chat_conversations` | Chats, the current group and the last sequence number | organisation | org |
| `chat_members` | Each person's read, delivered and joined marks | person | org |
| `chat_groups` | Groups and their Welcome until every device joined | organisation | installation |
| `chat_group_devices` | Which chat devices are in which group, and whether they joined | organisation | installation |
| `chat_messages` | Messages, edits and deletions, ciphertext only | organisation | ciphertext |
| `chat_archive` | Each person's sealed archive copies | person | ciphertext |
| `chat_attachments` | A file's chat, message, uploader and size; its ciphertext under `chat/` (step 32) | organisation | ciphertext |

Membership of a chat is two grants of the access kind `conversation`. A
removed chat device stays as a row without a device while a current group
still names it, so the server knows the group is out of date; the hourly
clean-up deletes it after that. Deleting a person deletes their chat
account, devices and archive; their messages stay for the other person
without a sender.
