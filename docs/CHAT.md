# Chat

UniHub's Chat module holds chats between the people of one UniHub
installation, on the web, in the installed web app and in the Android app:
1:1 chats since 0.33.0, and since 0.34.0 group chats, files, voice messages,
mentions, search and a retention rule. Every chat is end-to-end encrypted.
This page is the contract: what is encrypted, what it protects and what it
does not, how devices, groups, files and history work, and the routes and
tables behind it. The other pages link here.

## What the server sees

Messages and files are encrypted on the sender's device and opened on the
devices of the people in the chat. The server stores and passes on bytes it
cannot read. It never sees a message's text, a reply's quote, a file's name,
type or content, a picture's preview, a voice message, a notification's
preview or the history.

The server does see, and keeps:

- **who is in which chat**: who added whom, who manages a group chat, which
  organisation group (or everyone) a chat follows, and from which message on
  each person reads;
- **the name of a group chat.** It is plain text on the server, not
  encrypted, and it appears in notification titles;
- **when each message was sent, by whom and from which device**, and how
  long it is: the encrypted message is padded to 256 bytes, but its archive
  copies and its notification previews are not, so the server can tell a
  message's length in bytes;
- which message edits or deletes which (an edit and a deletion name the
  message they change);
- **who was mentioned in a message.** The device names them to the server so
  that it can notify them; the server keeps this in each person's queued
  notification until that is cleaned up;
- **files**: how many a message carries, each file's size, chat, uploader
  and upload time. The server cannot tell a picture's preview or a voice
  message from any other file, but a file's size hints at what it is, such
  as how long a recording is;
- each person's devices that take part in Chat, their read and delivered
  marks, and who has a UniHub page open (presence);
- **each person's notification choice per chat**, and that a notification
  was sent to a device, and when;
- each chat's retention time and the moment deleting under it starts, and
  how many archive copies each person has.

## What the encryption protects

**It protects** chats and their files against anyone who reads the server's
database, a backup, its disks or its logs, a curious administrator included.
None of them can read a message or open a file, now or later, without a
device of someone in the chat or that person's chat passphrase.

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

- **The server's lists are trusted.** A person's chat devices and a group
  chat's people are the ones the server lists. When a device or a person
  joins a chat, the chat shows a line ("Blair added a device", "Blair joined
  the chat"), so one nobody added can at least be noticed.
- **A device holds keys.** A device that has opened the history keeps the
  history key. Someone who has a removed device and a copy of the database
  can read that person's history, not only what the device had stored.
  Remove a lost device at once (below) and rely on the phone's own lock and
  encryption; the [app lock](APP_LOCK.md) is a gate, not encryption, and the
  chat store on the device is not encrypted by it.
- **Nobody outside a chat reads it.** There is no recovery key for the
  organisation and no administrator view of a chat's messages or files.
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
the device store, the sealing, file and key backup code, and the server's
rules. UniHub itself has had no independent audit.

UniHub's own cryptography uses the browser's WebCrypto, no new primitive:

- **Sealing** (archive copies and notification previews) in the Web Push
  format of RFC 8291: P-256, HKDF and AES-GCM. A page reuses one sender key
  pair for its previews while it is open, instead of making one per
  message, so a message to many devices does not cost a new key agreement
  for each; the format the devices open is unchanged.
- **Files** in the content coding of RFC 8188 (`aes128gcm`, the coding
  inside RFC 8291), in records of 64 kB, with a random 16-byte key per file
  ([Files](#files-and-voice-messages)).
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
  UniHub once since Chat arrived. Until then a 1:1 chat says "<name> has not
  opened UniHub since the update."
- **A group never changes.** One MLS group holds the devices of the chat's
  people. When those devices change (a new browser, a removed phone, a
  person added or removed), the next device that sends makes a new group
  with the current devices and posts its one Welcome (the message that lets
  each device join; every device fetches the same one). The server makes it
  current only while the group the sender saw is still current; two devices
  making a group at once converge. No group is ever changed after it was
  made, so the server orders messages per conversation and nothing else.
- **What that costs in a large chat.** Measured in Chromium by the project's
  tests for a group of 150 devices (50 people with three devices each):
  making it took 124 ms, joining it 30 ms, and its Welcome was about 50 kB.
  A phone is slower; that was not measured. Every sign-in on a new browser
  and every sign-out changes a chat's devices, so in a chat of many people
  the first message after such a change makes a new group, perhaps several
  times a day. A device that was away joins every group it missed, in order,
  before it shows their messages; the chat says "Catching up on the messages
  since you were last here…" meanwhile. A Welcome is deleted once every
  device of its group has joined, or 30 days after a newer group replaced
  it; a device unused for 30 days is removed anyway (below).
- **A stale device list gets 409.** The server refuses a message with `409
  CHAT_GROUP_STALE` (with the current group's id) when its group is not the
  current one, or when the current group's devices are not exactly the
  valid devices of the chat's people. The client reads again, uses the
  current group if it is in it, otherwise makes a new one, and sends again
  from its outbox. So no message is encrypted for a device after it was
  removed, or for a person after they left.
- **Removing a device.** Signing a device out under Settings › Security ›
  Devices (yourself or an administrator), the hourly clean-up of devices
  unused for 30 days without a session, and an instance restore remove the
  device's record and with it its chat device. Its session ends at once, so
  the server serves it nothing more; the next message in each chat goes to
  a new group without it. The device list marks devices that hold chat keys
  "Chat", and the sign-out dialog says such a device also leaves the chats.
- **Signing out** removes the chat device and deletes the browser's chat
  store: messages, picture previews, keys and the history key. A session
  that only expired keeps both, the device stays in its chats, and signing
  in again as the same person goes on. Another person signing in on that
  browser deletes the earlier person's store. Firefox before 126 cannot list
  a site's stores: there the store of the person who signs out is still
  deleted, but one left by a person whose session only ran out can stay
  until the site's data is cleared.
- **A device that was not in a group** (new, or away while the group was
  made) cannot read that group's messages through MLS. It reads them from
  the archive after the passphrase (below). That is the only case that needs
  the passphrase.

## History and the passphrase

MLS deletes old keys on purpose, so a new device cannot open old
ciphertext. Chat's history is a personal archive instead: each device seals
every message it sends or reads to its person's **history key** and uploads
that copy. The server stores one copy per person and message, so a message
in a chat of 50 people is stored once as the MLS message and 50 times as
archive copies, each sealed to one person. A copy holds the message's file
keys too, so the history also opens the files that are still on the server.

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
  again, by anyone. The other people keep their messages.
- **Nobody else can read or restore a chat.** There is no recovery key for
  the organisation and no administrator path to a person's messages or
  history. Without the passphrase and without another signed-in device, a
  lost device means lost history.
- **Archive copies are not signed.** A device checks that a copy's message
  and chat ids match the entry it is stored under, and drops it otherwise.
  Someone who can write to the database could still store a made-up copy for
  a message, because anyone with the public history key can seal to it.

## Group chats

A group chat has a name (1 to 80 characters, need not be unique, plain text
on the server) and at most **100 people**. "New group" in the chat list
starts one.

- **Chosen people.** Whoever starts it manages it. A member adds the people
  who share an organisation group with them, or anyone in the organisation
  while the administrator's rule `chat.reach` allows it for them; an
  administrator adds anyone. Each person added must be active and have Chat
  on. A 1:1 chat stays open between any two people.
- **Following a group.** A chat can follow one organisation group: made by
  one of that group's managers (also from Your groups › the group › "New
  group chat") or by an administrator. Only an administrator makes one that
  follows everyone. Its people are the group's people, so it changes with
  the group, and nobody adds, removes or leaves by hand. An administrator
  who makes one for a group they are not in does not see it.
- **The limit of 100** is checked when a chat is made and when people are
  added. A followed group that grows past 100 later keeps its chat.
- **Managers.** In a chat of chosen people the managers rename it, add
  people and remove them. In a followed chat the group's managers and the
  administrators who are in it manage it: they rename it, or stop
  following, after which it is a chat of the people it has at that moment,
  managed by whoever stopped it. Deleting the organisation group does the
  same, and leaves the chat without a manager of its own. A chat of chosen
  people whose managers are all
  gone or deactivated is managed by its longest-standing active member (of
  people added at the same moment, the one with the lowest id). There is no
  "make manager".
- **Leaving.** Anyone leaves a chat of chosen people, a manager too. Nobody
  leaves a followed chat; its people change with the group. A chat cannot
  be deleted for everyone: the hourly job removes a chat nobody is in any
  more ([Retention](#retention)).
- **Joining.** Someone added sees the chat at once, empty: "You were added
  by Alex. Messages appear from now on." They read from the first group
  that holds their devices, never older messages or files: the server sets
  their place (`joined_seq`) when that group is made and serves nothing
  before it. Someone removed and added again counts as new. The chat shows
  "<name> joined the chat".
- **Removal and leaving.** A person removed, or who left, is refused on
  every route of the chat at once, and the next message goes to a new group
  without their devices. Their marks and their archive copies of the chat
  are deleted on the server: at once when a manager removes them or they
  leave, and when the next group is made for someone who left the
  organisation group a chat follows. Their devices drop the chat, its messages and its
  outbox at their next sync. A device that never syncs again keeps what it
  has; the remove dialog says "They keep nothing in UniHub. A copy they made
  elsewhere cannot be taken back." The chat shows "<name> left the chat"
  (also for a removal: a device cannot tell them apart).
- **People without a device.** Someone who has not opened UniHub since Chat
  arrived, or is deactivated, has no device in the chat. They do not block
  it: the people panel lists them with the reason, and they read from the
  first group that holds a device of theirs. What was written before stays
  unreadable for them: end-to-end encryption gives them no key for it,
  although they were in the chat on paper. Someone for whom Chat is off
  stays in its groups with the devices they had and is listed with "Chat is
  off for <name>"; they get no notifications and read the chat when Chat is
  on again.
- **Receipts and presence.** A group message shows "Read by 3 of 7", which
  opens the names, counting only the other people who share read receipts
  (both the reader and the sender have them on). The people panel shows the
  online dots under the same rules as a 1:1 chat.

## Messages

- **Text and files.** Text up to 8,000 characters, plain with line breaks;
  web addresses show as links. A message can carry up to ten files (below),
  or be files alone. One 1:1 chat per pair of people: starting it again
  opens the same one. A 1:1 chat is started with **Message** on a
  colleague's entry in Contacts › Company, or on one of your contacts whose
  address is a colleague's.
- **Replies** quote the message they answer. The reference is inside the
  encrypted message.
- **Edits.** Only your own messages, at any time, marked "edited". An edit
  is a new message that names the one it replaces; the earlier text stays
  stored, encrypted, until the message is deleted. An edit changes no files
  and mentions nobody, and sends no notification.
- **Deleting** is for the sender only and removes the message for everyone
  in the chat. It is final: there is no bin. The message and its edits lose
  their ciphertext, their files, their archive copies and any notification
  not yet sent, and a deletion entry tells every device, which shows
  "Message deleted". While the administrator forbids deleting for good
  (`bin.delete`), Delete is greyed out with the reason and the server
  refuses it (`403 POLICY_FORBIDS`); the ciphertext and the files then stay,
  and reading them still needs a device or the passphrase of someone in the
  chat. Nobody, an administrator or a chat's manager included, can delete
  or read someone else's message. A message that was not sent can be
  discarded from its menu.
- **Mentions.** In a group chat, "@" offers the chat's active people. A
  mention is the "@Name" in the text, so a name typed by hand counts as
  well; the device names the people mentioned (at most 20) to the server
  for the notification. A mention is highlighted, the reader's own more
  strongly, and the chat shows "@" in the list while it is unread. A mail
  address mentions nobody. There is no "@everyone".
- **Unreadable messages** (damaged, changed, or one the encryption module
  stopped on) show "This message could not be read." and cost only
  themselves; the chat goes on.
- **Offline.** The Chat page reads the device's own store, so it opens
  without a connection. What you write waits in an outbox and goes out in
  order once online: a message's files are uploaded first, and the message
  is posted when every upload is done. A refused message shows "Not sent"
  with Try again.
- **A person who cannot be written to** (deactivated, deleted, Chat off for
  them, or no chat device yet) keeps a 1:1 chat readable, with the reason in
  place of the composer.

## Files and voice messages

- **Encrypted on the device.** The page encrypts each file with a random
  key in the standard content coding RFC 8188 (`aes128gcm`, 64 kB records),
  so a file cut off, reordered or missing a record is refused. The key
  travels inside the encrypted message, with the file's name, type and
  size. A picture the browser can draw (JPEG, PNG, WebP, or a GIF's first
  frame) gets a small preview, at most 320 px, as a second encrypted file
  with its own key.
- **Uploads.** One request per file, at most 101 MiB of ciphertext. The
  server checks the sender's limit, `chat.attachment_max_mb` (10, 25, 50 or
  100 MB; 50 unless the administrator changed it), against the encrypted
  file, which is a little larger than the original, and refuses a larger one
  with "Files in a chat can be at most 50 MB." The app itself refuses a file
  above 100 MB. A message carries at most ten files; their previews come on
  top. The upload shows its progress in the tab that sends it, and Cancel
  takes the message back. An upload no message names is deleted after a
  day, so the app uploads a file again, under a new id, when its message
  is still waiting 12 hours after the upload.
- **Fetched when opened.** Pictures show their preview; nothing else is
  downloaded until it is tapped. The page fetches the ciphertext with its
  own session and decrypts it in the page. Files are not kept on the device,
  only the previews: a file is fetched again whenever it is opened. The
  server serves a file to someone in the chat who reads its message (not to
  someone who joined after it), and to its uploader before it is sent.
- **What a received file's type means.** A file's name and type are chosen
  by its sender, so UniHub never trusts them to draw a file. It shows only
  JPEG, PNG, WebP and GIF pictures (the preview in the chat, the picture in
  a viewer), PDFs through its own reader (the one Mail uses, drawn on a
  canvas) and voice
  messages through the browser's audio player under a type from a fixed
  list. Everything else, an SVG or HTML file included, is only saved, never
  opened in the page. A saved file is whatever the sender sent: treat it as
  you would an email attachment. In the Android app, Save puts the file in
  Downloads.
- **Voice messages.** The microphone beside the field records with the
  browser's own recorder, up to 10 minutes; the recording then stops by
  itself and waits among the files to send. The browser asks for the
  microphone the first time, and the Android app through Android's prompt,
  as for recordings. The recording's type depends on the browser that
  records it: Opus in WebM where the browser offers it, otherwise AAC in
  MP4. The other person sees its length and plays it with a tap, which
  fetches it; a browser that cannot play the type says so and offers Save.
  The project's tests record and play voice messages in Chromium; whether
  another browser records or plays them depends on that browser.
- **Deleting.** A file goes with its message. Retention deletes the files of
  the messages it deletes. A file stays when its uploader is deleted
  ([People who leave](#people-who-leave)). Rows go first and files after,
  through the file removal gate ([Data recovery](DATA_RECOVERY.md)).
- **Storage.** Server › Storage counts each file toward its uploader under
  "Chat files"; a deleted person's files count as "former colleagues".
  There is no quota.
- **A reverse proxy** in front of UniHub must let 101 MB bodies through on
  the upload route ([Installation](INSTALLATION.md#1-prepare-your-server-and-browser-address)).

## Search

"Search chats and messages" above the chat list finds chats by name and
messages by their text and file names, the newest first, and opens a chat
at the message found. It looks only through what this device holds: the
server cannot read the chats, so it cannot search them. A new device finds
the messages it received since it enrolled; once the chat passphrase is
entered it finds the earlier ones too. It never finds what retention
deleted on this device.

## Retention

An administrator can have chat messages deleted after a time: the policy
`chat.retention_days` (kept, the default, or 365, 180, 90 or 30 days), for
everyone and per organisation group on Server › Policies
([policies](AUTH_ADMIN_SETTINGS.md#data-safety-policies)). Shorter is
stricter, so a group's rule holds for its members when it is shorter.
Settings › Chat tells each person how long their messages are kept.

- **One time per chat.** A message is one row for all its readers, so a chat
  follows the shortest time among its active people. A message's age counts
  from when it was sent; an edit does not renew it.
- **Deleting starts 24 hours later.** Whenever a chat's time gets shorter,
  deleting under the new time starts 24 hours later: after a rule is saved,
  after someone under a shorter rule joins an organisation group, and when
  someone under a shorter rule is added to a chat (counted from the hourly
  pass that first sees it, so up to an hour later). A longer time, or
  "Never", holds at once. "Never" ends a wait and deletes nothing; a longer
  time set during a wait keeps the wait's date and then deletes only what is
  older than the longer time.
- **The warnings.** Before a shorter rule is saved, the Policies page shows
  how many messages and files are older than it, in how many chats; saving
  needs the typed word DELETE and the administrator's password. Everyone the
  rule reaches gets the rules notice. While the 24 hours run, each affected
  chat says under its header "From 19 November at 14:00, messages older
  than 30 days are deleted here" (afterwards "Messages older than 30 days
  are deleted here"), and the Policies page shows the change that waits;
  right after the save it offers "Undo", which saves the earlier value
  again. Adding someone under a shorter rule to a chat says so in the add
  dialog before it is confirmed. The change is written to the activity log,
  as every policy change is.
- **Only the owner skips the wait**, with "Apply now…" and their password
  (`admin.chat_retention_applied` in the activity log). Deleting then
  happens at the next hourly pass, within the hour.
- **What goes.** Every hour, in each chat whose moment has passed, the
  messages older than its time, with their edits, deletion entries, archive
  copies, files and queued notifications. It deletes even while people may
  not delete for good (`bin.delete`): retention is the administrator's way
  to delete chat messages.
- **Devices** delete their own copies older than the chat's time at each
  sync once the chat's moment has passed. A device that is switched off
  keeps them until it is next opened.
- **Backups.** An instance backup made earlier still holds the deleted
  messages and files, as ciphertext, for as long as the backup is kept.
- **The same hourly job** clears the Welcome of a group replaced 30 days
  ago, deletes uploads never sent, and deletes a chat nobody is in any more
  (not one that follows a group) with everything it holds; while the rule
  for everyone forbids deleting for good, such a chat stays until retention
  has emptied it.

## People who leave

- **Deactivated.** Their devices stop counting, so the next group of each
  chat leaves them out. They stay in their chats on paper, are left out of
  each chat's retention, and come back when activated. They cannot read
  what was written while they were away.
- **Deleted.** Their grants, marks, chat devices, chat account and archive
  go with them. Their messages stay for the others, with the sender
  emptied; their files stay, with the uploader emptied. Nothing is asked of
  the administrator at deactivation or deletion.
- **Shown.** Every message carries its sender's name inside the
  encryption. A message whose sender is deactivated or deleted shows that
  name with "former colleague". A 1:1 chat with such a person is read-only,
  with the reason in place of the composer; a deleted person's 1:1 chats
  show them as "Deleted person".

## Presence and read receipts

- **Presence** is "has a UniHub page open": a person counts as online while
  a page of theirs holds the live update stream. The Android app's
  background notification connection does not count. It is shown as a dot,
  only between people who share a chat, and only while both have it on. A
  change goes out at most once in ten seconds per person.
- **Delivery state** under your own messages: "Sent" once the server took
  it, "Delivered" once a device of another person fetched it, "Read" once
  they opened the chat while the page was visible; in a group chat, "Read
  by N of M" ([Group chats](#group-chats)).
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

A chat message sends one notification (kind `chat`) to each other person in
the chat, never to the sender and never for an edit. Its detail is the
person's "What a notification shows" under Settings › Chat, floored by the
administrator's `notifications.detail`:

| Detail | Title | Text |
| --- | --- | --- |
| Sender and message (`full`) | The sender's name; in a group chat "Alex in Launch", or "Alex mentioned you in Launch" | The start of the message, where the device can open it; otherwise "New message" |
| Sender only (`sender`) | As above | "New message" |
| Nothing (`none`) | "New message" | none |

- **Each person chooses per chat** from the bell in the chat's header: all
  messages, mentions only (group chats) or nothing. The server leaves the
  notification out accordingly; the unread count is not affected.
- **Previews are sealed per device.** The server cannot write the text, so
  the sender's device seals the first 160 characters for each device of the
  other people: in a browser to the preview key that browser made at
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
- **Files.** The page decrypts a chat file and hands it to the app, which
  saves it to Downloads; nothing outside the page fetches it.
- **An app from before 0.33** keeps working with Chat (the page is the
  server's) but shows "New message" without text, does not block
  screenshots in Chat and cannot lock Chat: it locks the other modules, and
  Settings and the lock prompt say "Update the UniHub app to lock Chat."
  Where the administrator requires a lock on Chat, such an app falls short
  of the requirement and the server refuses it what it refuses any device
  short of the lock ([App lock](APP_LOCK.md#required-by-the-administrator)).

## Backups

- **No personal backup.** Chats are in no personal backup: the server cannot
  write a copy that opens outside UniHub, and a chat names other people.
  Every backup says "Chats are not in this backup. They are restored with
  your chat passphrase." Settings › Delete data has no Chat entry.
- **Instance backup and restore.** The instance backup carries every chat
  table as stored, and the chat files (its file root `chat`): ciphertext
  stays ciphertext, and the history key stays wrapped by each person's
  passphrase. A restore deletes every device, so every device enrols again
  at its next sign-in and the next message makes new groups. Each device
  keeps the messages it holds. Messages newer than the backup exist only on
  the devices that hold them; earlier ones come back from the archive with
  the passphrase ([Data recovery](DATA_RECOVERY.md#after-an-instance-restore)).
  A backup keeps what retention deleted after it was made.

## Limits and known behaviours

- **Not built.** Reactions, formatting, a typing indicator, blocking people,
  forwarding a file to another chat (attach it again), recording video,
  making pictures smaller before sending, and deleting a whole chat for
  everyone.
- **One large upload holds back later messages.** The outbox sends in order,
  so a message written after a large file waits until that file is through.
- **Upload progress** shows only in the tab that sends; the device's other
  tabs show "Sending…".
- **A deleted person in a group chat.** Their earlier messages can lose the
  "former colleague" mark after a reload; the name stays.
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

## Reference

### Routes

Every route under `/api/chat/` is in the module `chat` and the app lock area
`chat`, and none is gated by a restore section. The request and response
shapes are in [`api/src/contracts/chat.ts`](../api/src/contracts/chat.ts).
Shared refusals: `403 MODULE_DISABLED` while Chat is off for the person,
`403 APP_LOCK_REQUIRED` for a device short of a required lock on Chat, and
`404 CONVERSATION_NOT_FOUND` for a chat the person is not in (a missing one
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
| `GET /api/chat/conversations` | The person's chats, latest first, with unread counts, marks, the notification choice, the retention, the other person's or the group's state and presence |
| `POST /api/chat/conversations` | Find or make the 1:1 chat with a person; with `kind: 'group'`, a group chat of people (`user_ids`) or following a group or everyone (`follow`); `400 CHAT_TOO_MANY_PEOPLE`, `403 CHAT_OUT_OF_REACH` |
| `PUT /api/chat/conversations/:id` | A manager renames a group chat |
| `GET /api/chat/conversations/:id/members` | Its people with role, reason, marks and presence |
| `POST /api/chat/conversations/:id/members` | A manager adds people |
| `DELETE /api/chat/conversations/:id/members/:userId` | A manager removes someone |
| `POST /api/chat/conversations/:id/leave` | The caller leaves |
| `POST /api/chat/conversations/:id/unfollow` | A manager stops following the group |
| `PUT /api/chat/conversations/:id/notify` | `all`, `mentions` or `none` for the caller |
| `GET /api/chat/candidates?q=` | People within reach with their retention, and the groups the caller may follow |
| `GET /api/chat/conversations/:id/devices` | The valid chat devices of the chat's people, with their preview keys |
| `POST /api/chat/conversations/:id/key-packages` | Claim one key package of every other device, for a new group |
| `POST /api/chat/conversations/:id/groups` | A new group and its Welcome; `409 CHAT_GROUP_STALE` when the chat moved on |
| `POST /api/chat/groups/:id/joined` | This device joined; the Welcome goes once every device has |
| `POST /api/chat/conversations/:id/attachments?id=` | Upload a file's ciphertext (body kind `upload`, at most 101 MiB); `413 CHAT_FILE_TOO_LARGE` with the limit |
| `GET /api/chat/attachments/:id` | A file's ciphertext, `Cache-Control: no-store` |
| `POST /api/chat/conversations/:id/messages` | A message or an edit, with the sender's archive copy, the previews, the mentions (at most 20) and the files (at most 20 uploads); `409 CHAT_GROUP_STALE`, `403 CHAT_UNAVAILABLE`, `400 CHAT_MENTION_INVALID`, `400 CHAT_ATTACHMENT_INVALID` |
| `GET /api/chat/conversations/:id/messages` | Entries after a sequence number (never before the caller's place), with the Welcomes this device has not joined |
| `DELETE /api/chat/messages/:id` | Delete for everyone in the chat; declares `bin.delete` |
| `PUT /api/chat/conversations/:id/marks` | Move the read and delivered marks forward |
| `POST /api/chat/archive`, `GET /api/chat/archive` | Store and list the person's own archive copies |

Two administrator routes need `server.settings` and no module:

| Route | What it does |
| --- | --- |
| `GET /api/admin/chat/retention-preview?days=&group_id=` | Messages, files and chats a shorter value would delete; and how many chats wait to start deleting, and from when |
| `POST /api/admin/chat/retention/apply-now` | The owner ends the waits, with the password (`403 OWNER_REQUIRED` for anyone else) |

A group chat's people change only through these routes and the
organisation group a chat follows. A direct chat answers `400
CHAT_NOT_GROUP` to rename, add, remove and stop following, and a followed
chat `409 CHAT_FOLLOWS_GROUP` to add, remove and leave.

### Live hints

Two events on the existing live update stream (`GET /api/events`), withheld
from a page whose person has Chat off. They carry ids only; the page fetches
through the routes above. There is no WebSocket: messages and files travel
only in ordinary requests ([Architecture](ARCHITECTURE.md#live-status-events)).

- `chat.changed` (`conversation_id`): a chat has a new group, message,
  deletion, mark, name or people. A mark that only records reading, with
  receipts off, is told only to the reader.
- `chat.presence` (`user_id`, `online`): a person someone shares a chat with
  opened their first page or closed their last.

The page also fetches when the stream reconnects and when it becomes
visible. With the Android app in the background, a message arrives as its
notification over the app's own connection; the page fetches when opened.

### Tables

Upgrade step 31 adds nine tables; step 32 adds `chat_attachments`, and to
`chat_conversations` the name and the retention columns and to
`chat_members` the notification choice. None is in a personal backup; the
instance backup carries each as stored. The manifest is
`api/src/modules/chat.ts`.

| Table | Holds | Owner | Class |
| --- | --- | --- | --- |
| `chat_accounts` | The history public key and the passphrase-wrapped key backup | person | ciphertext |
| `chat_devices` | Chat devices and their preview keys; a removed one has no device | person | installation |
| `chat_key_packages` | Unclaimed key packages and last resorts | person | installation |
| `chat_conversations` | Chats, a group chat's name, the current group, the last sequence number, and the retention in force with the moment deleting starts | organisation | org |
| `chat_members` | Each person's read, delivered and joined marks and notification choice | person | org |
| `chat_groups` | Groups and their Welcome until every device joined | organisation | installation |
| `chat_group_devices` | Which chat devices are in which group, and whether they joined | organisation | installation |
| `chat_messages` | Messages, edits and deletions, ciphertext only | organisation | ciphertext |
| `chat_archive` | Each person's sealed archive copies | person | ciphertext |
| `chat_attachments` | A file's chat, message, uploader and size; its ciphertext under `chat/<conversation>/<id>` of the uploads volume | organisation | ciphertext |

Membership of a chat is grants of the access kind `conversation`: one per
person (`member` or `manage`), or for a followed chat one to the
organisation group or to everyone. A removed chat device stays as a row
without a device while a current group still names it, so the server knows
the group is out of date; the hourly clean-up deletes it after that.
Deleting a person deletes their chat account, devices, marks and archive;
their messages and files stay for the others without a sender or uploader.
