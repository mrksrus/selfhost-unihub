# Contacts Technical Documentation

## Overview

Contacts are records in MariaDB, modelled on vCard 4.0 (RFC 6350) since
0.26.0. A contact belongs to one person, or since 0.31.0 to a [shared address
book](#shared-address-books) of the organisation. A contact holds:

- name parts (given, family, middle, prefix, suffix) and a display name
- organisation, department and job title
- birthday and anniversary, with or without a year
- any number of labelled emails, phone numbers, postal addresses, websites,
  messaging addresses, related people and nicknames, and categories
- a photo, notes and the favourite mark
- every other vCard property of an import, kept and written back on export
  ("other details kept from imports")

Import reads vCard 4.0, 3.0 and 2.1 and Google and Outlook CSV, and shows what
it would do before anything is written. Export writes vCard 4.0 or 3.0 and
Google or Outlook CSV. Duplicates are found on the server and merged only
after a review (or "Merge all" for the certain ones); a merge keeps every
value and can be undone for 30 days.

The shapes are in `api/src/contracts/contacts.ts`; the rules live in
`api/src/services/contacts.ts` (the store and the input contract),
`contacts-vcard-*.ts`, `contacts-csv.ts`, `contacts-import.ts`,
`contacts-export.ts`, `contact-photos.ts`, `contact-duplicates.ts` and
`contact-merge.ts`. Shared books are `services/address-books.ts` and
`contracts/address-books.ts`; the company directory is
`services/directory.ts` and `contracts/directory.ts`.

## Data model

| Table | Holds |
| --- | --- |
| `contacts` | One row per contact: `uid` (vCard UID; `urn:uuid:<id>` unless an import brought its own), `version` (raised on every write), name parts, `display_name` (written FN, `NULL` when derived), `company`, `department`, `job_title`, `birthday` and `anniversary` (`YYYY-MM-DD` or `--MM-DD`), `notes`, `is_favorite`, `name_key` (for duplicate search) |
| `contact_values` | One row per labelled value: `kind` (email, phone, address, url, impp, related, nickname, category), `position`, `is_preferred`, `label` and `custom_label`, `value` and its normalised `value_key`, the address parts, the original vCard parameters and group, and `legacy_slot` (the old Android apps' place, see below) |
| `contact_properties` | The kept properties: every vCard property UniHub has no field for (X-…, KEY, GEO, TZ, a second TITLE or NOTE, a PHOTO given as a link, …), with its group, parameters and value |
| `contact_photos` | The photo of a contact: the content hashes of the full picture and the thumbnail, size and source |
| `contact_uid_aliases` | The UIDs of contacts merged into another one, so an import of their old card finds the survivor |
| `contact_duplicate_dismissals` | "Not the same person" pairs |
| `contact_merges` | Merges of the last 30 days, with the survivor as it was, for undo |
| `bin_items` | Deleted and merged-away contacts in the [bin](#the-bin), shared with the other modules |
| `contact_imports` | Staged and running imports (temporary; never in a backup) |
| `address_books` | Shared address books: name, description, creator, `deleted_at` (upgrade step 29) |
| `grants` | Who may read, edit or manage a shared resource: a person, a group or Everyone (upgrade step 29) |
| `directory_entries` | The phone, job title and department a person shows in the company directory (upgrade step 29) |

Upgrade step 22 copied the 0.25 columns `email`, `email2`, `email3`, `phone`,
`phone2` and `phone3` into `contact_values` verbatim, at positions 0 to 2 and
without a label, gave every contact a UID and checked the count of values per
contact; step 23 removed those columns and `avatar_url`. Every table is
declared in `data-inventory.ts`. Step 29 gave `contacts`, `contact_values`,
`contact_properties`, `contact_photos` and `bin_items` an `address_book_id`:
each row has either `user_id` (a person's) or `address_book_id` (a book's),
never both. A person's queries stay scoped by `user_id`, so a book's rows
never appear in them.

## API

All routes need a signed-in session, are gated by the Contacts module and
refuse writes (409) while a restore of contacts runs. State-changing requests
need `X-CSRF-Token`. Another person's contact, photo, merge or import answers
404.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/contacts` | List: `q`, `group` (`all`, `name_only`, `number_or_email_only`), `limit` (1 to 2000), `offset`, `include=merged` |
| GET | `/api/contacts/:id` | One contact with its kept properties listed (`properties`) |
| POST | `/api/contacts` | Create |
| PUT | `/api/contacts/:id` | Replace (full body) or apply an old app's flat body as a change |
| DELETE | `/api/contacts/:id` | Move to the bin |
| PUT | `/api/contacts/:id/favorite` | Favourite on or off |
| POST | `/api/contacts/bulk-delete` | Move up to 5,000 to the bin, as one group |
| POST | `/api/contacts/bulk-update` | Set `company`, `department` or `job_title` on many; `null` clears |
| GET, PUT, DELETE | `/api/contacts/:id/photo` | The photo (`?size=full` or `thumb`), set it (the picture as the raw body), remove it for good (policy `bin.delete`) |
| POST | `/api/contacts/imports` | Stage a file (the raw body) and answer the preview |
| GET | `/api/contacts/imports/:id` | The import's state and result |
| POST | `/api/contacts/imports/:id/commit` | Write it with per-group decisions |
| GET | `/api/contacts/export?format=` | Every contact as `vcard4` (default), `vcard3`, `google-csv` or `outlook-csv` |
| POST | `/api/contacts/export` | The contacts named in `ids`, in `format` |
| GET | `/api/contacts/duplicates?min=` | Duplicate groups of at least `low`, `medium` (default) or `high` confidence |
| POST | `/api/contacts/duplicates/dismiss` | "Not the same person" for every pair of `contact_ids` |
| POST | `/api/contacts/merges` | Merge 2 to 50 contacts; the merged-away contacts go to the bin |
| POST | `/api/contacts/merges/auto` | "Merge all high-confidence": up to 500 groups |
| GET | `/api/contacts/merges` | "Recently merged" |
| POST | `/api/contacts/merges/:id/undo` | Undo a merge |

The bin's own routes (`/api/bin`) list, restore and delete contacts there
for good; see [the bin](#the-bin).

0.26.0 removed `POST /api/contacts/merge-duplicates`, its `/preview` and the
JSON `POST /api/contacts/import`. A page of an older version still open in a
browser gets 404 there and offers its update; it can no longer run the old
merge, which deleted for good without undo.

A list row and a written contact carry the model (`name`, `organization`,
`emails`, `phones`, `addresses`, …, `photo`, `version`, `kept_properties`) and
the deprecated 3+3 fields that the Android apps up to 0.25.1 read
(`first_name`, `last_name`, `email` to `email3`, `phone` to `phone3`,
`company`). `display_name` is the written display name, else the name parts,
else the organisation, an email or a number.

### Search

`q` matches the name parts and the whole name, the display name, organisation,
department, emails, phone numbers, nicknames and categories; accents and case
follow the column collation. A query of digits and phone punctuation also
matches numbers by digits without leading zeros, so "0171 12" finds
"+49 171 12…". `%`, `_` and `\` match literally. Global search uses the same
condition. Results are ordered by favourite, then first name, last name and id.

### Writing a contact (input contract, D17)

A **full body** has any of `name`, `organization`, `emails`, `phones`,
`addresses`, `urls`, `impp`, `related`, `nicknames`, `categories`,
`birthday`, `anniversary` or `version`. It replaces the contact's content: a
field or list it leaves out is empty afterwards. `is_favorite` and the kept
properties stay as they are unless given (`kept_properties: 'clear'` removes
the kept properties; the page never sends it).

- **Version.** A full `PUT` needs `version` (or `If-Match: "<version>"`). When
  the contact changed since, it answers 409 `VERSION_CONFLICT` with the
  contact as it is now; the editor then keeps the person's edits and offers
  "Load their version" or "Save mine anyway". A photo change, a favourite
  change and a merge raise the version too.
- **Value ids.** A list value may carry the `id` it was read with. A value
  sent back with its id keeps its row: its import details (vCard parameters
  and group) and its place for the old apps. A value without an id, or with
  an id that is not one of this contact's values of that kind, is new.
- **Text.** Absent or `null` is empty. A string is trimmed; notes keep their
  inner whitespace, but notes of only whitespace are empty. An empty result
  is no value; an empty list item is dropped. A finite number is stored as
  its decimal text (`0` becomes `"0"`); `NaN` and `Infinity` are refused.
  `true`, `false`, an object or an array where text is expected answers 400
  `<Field> must be text`; an unpaired UTF-16 surrogate answers 400
  `<Field> contains invalid characters`.
- **Lengths.** Too long answers 400 `<Field> is too long (at most N
  characters|bytes)`:

  | Field | Limit |
  | --- | --- |
  | Name parts, display name, organisation, department, job title, email, nickname, category | 255 characters |
  | Phone | 64 characters |
  | Website, messaging address, related person | 2048 characters |
  | Address part | 255 characters; street 1000 |
  | Custom label | 100 characters |
  | Notes | 65535 bytes |
  | Values of one kind | 100 |
  | Kept properties | 500, 256 KB together |

  An import cuts an over-long value for its field instead, keeps the whole
  value as an other detail and reports it.
- **Labels.** `label` is one of the kind's labels (see the contract), `''`
  for none, or `custom` with a `custom_label`. A plain string in a list is a
  value without a label. `is_favorite` and `preferred` must be JSON booleans
  (the favourite route keeps accepting `1` and `"true"`).
- **Dates.** `YYYY-MM-DD`, `--MM-DD` or `{ year?, month, day }`, a real
  calendar date (`--02-29` is allowed).
- **Identity.** A new contact needs one of: a name part, the display name,
  the organisation, an email or a phone number. Emails and phone numbers get
  no format check, so contacts from phones and vCards keep syncing.
- Unknown top-level keys are ignored. The route id comes from the path, so a
  query string never becomes part of it.

Three cases behave differently from 0.22.4 since 0.23.0, on purpose: a value
of only whitespace is empty, a number is stored as its text, and `true`,
`false`, objects and arrays are refused.

### The old Android apps (3+3 bridge)

The Android apps 0.24.3 to 0.25.1 know three emails and three phone numbers
per contact and send the whole contact back on every change. 0.26.0 keeps
them working (P-21) without letting them remove what they cannot see:

- Each contact has up to three places per kind for them (`legacy_slot`). The
  list's `email` to `email3` and `phone` to `phone3` show the values in those
  places. Upgrade step 22 put the three 0.25 values there; a value added
  later takes a free place when an old app can hold it (a phone number of at
  most 50 UTF-16 units, an email of at most 255, not equal to one it already
  holds by the app's own key: digits and `+` for numbers, trimmed lower case
  for emails).
- A **flat body** (only `first_name`, `last_name`, `email`…`phone3`,
  `company`, `job_title`, `notes`) is applied as a change, never as a
  replacement. Names, company, title and notes are set as given (company sets
  the organisation and keeps the department). Emails and phones change only
  through the places: a value sent back as the app shows it, or as the app
  formats or cuts it, stays as stored with its label; a place the body no
  longer names is removed; a new value is added there without a label.
  Values outside the places (the fourth and later, those an old app cannot
  hold) and every label are never changed or removed by an old app. Sending
  the same body again changes nothing. A body mixing the flat and the full
  shape is refused; a flat create still needs a first name.
- **Known limitations, as in 0.25.1.** An old app writes without a version,
  so an edit made in UniHub in the few seconds between its listing and its
  write can still be overwritten. A value an old app cannot hold but that
  0.25.1 had already shown it in its three fields keeps its place; the app's
  next whole write clears it, as it did on 0.25.1. Labels, addresses,
  birthdays and photos stay on the phone for those apps, as before. The 0.26
  app uses the full API with versions (see [Android](ANDROID.md)).

The flat fields are deprecated. The last 3+3 app (0.25.1) left the support
window with 0.28.0; the server keeps the 3+3 projection and the flat writes
until a separate compatibility decision retires them ([Android
compatibility](ANDROID_COMPATIBILITY.md)).

## Import

`POST /api/contacts/imports` takes the file as the raw request body (up to
64 MiB, 20,000 cards, 500 properties per card, a decoded photo of up to
20 MiB) and answers what would happen, writing nothing:

- the format, the number of cards and of new, already present (same UID, a
  UID merged into a contact, or identical content) and likely duplicate cards.
  Identical means every field, every kept detail as the export writes it and
  the same photo; a card that changed only a kept detail or its picture is
  merged by default instead of skipped
- the groups: cards that belong together with the contacts they match (two
  cards whose UIDs name two different contacts never belong together), the
  reasons, the confidence, the single values that differ (with a summary of
  each card, for "Review conflicts") and a default decision (add, merge or
  skip)
- warnings, naming the card number and the property or CSV column, never a
  value (for example `PHOTO_UNREADABLE`, `PHOTO_TOO_LARGE`, `TOO_MANY_VALUES`,
  and `VALUE_CUT` or `NOTE_CUT` for a CSV name, organisation, title or note
  longer than its field: it is cut for the field and kept whole as an
  `X-CSV-FIELD` detail labelled with its column, so an export carries it)
- the first names of the file, so a wrong character set shows before
  anything is written

The person decides per group (with "For all" defaults) and commits. The
commit is a durable job in chunks of about 200 cards, each in one
transaction with its progress: polling `GET /api/contacts/imports/:id`
reports `state` (`staged`, `committing`, `committed`, `failed`, `expired`),
`progress` and the result. Committing again after a lost answer changes
nothing; a failed import (a restore started, the module was turned off)
continues where it stopped when committed again. A staged import expires
after 24 hours.

A merge decision makes the card a contact and merges it into the existing
one: the existing contact's single values win (they are counted as "kept
UniHub's value"), every list value is added, and the merge appears under
"Recently merged" with Undo. If the merged contact would hold more than 100
values of a kind, the card is added as its own contact with a warning.

### Formats

- **Encoding.** A byte order mark selects UTF-8 or UTF-16; otherwise the file
  is UTF-8 when it decodes cleanly, else windows-1252. vCard 2.1 and 3.0
  `CHARSET=` applies per property, after quoted-printable or base64 decoding.
- **vCard 4.0, 3.0 and 2.1.** Folding, escaping, groups and parameters are
  read per version (2.1 bare types such as `TEL;CELL;HOME`, 3.0
  `TYPE=a,b`, 4.0 `PREF`). N, FN, NICKNAME, ORG, TITLE, BDAY, ANNIVERSARY
  (also Apple's, Android's and Evolution's forms), ADR, TEL, EMAIL, IMPP (also
  3.0 `X-JABBER` and similar), URL, RELATED (also Apple's related names with
  their `X-ABLabel`), CATEGORIES, NOTE, UID and an inline PHOTO become
  fields. Apple's `itemN.X-ABLabel` custom labels are kept. A PHOTO given as a
  link is never fetched; it stays a kept property. Everything else is kept.
- **Google CSV** (the current layout and the older "Given Name" one): names,
  nickname, organisation, title, department, birthday, notes, labels
  (`* starred` is the favourite and `* myContacts` is dropped; the others are
  categories), and the numbered email, phone, address, website, relation,
  event and IM columns, including several values in one cell (`:::`).
- **Outlook CSV** in English or German (comma or semicolon): its fixed
  columns map to labelled values. Other languages are refused plainly.

Lossless means the same meaning, not the same bytes: folding, escaping,
parameter order and the vCard version may change. The photo is the one
exception; the stored photo is the converted one.

## Export

vCard 4.0 is the default and keeps every field, the photo and the kept
properties; vCard 3.0 is for older apps and phones (`TYPE=JPEG` photos).
Google CSV holds every value; Outlook CSV has fixed columns (three emails,
fixed phone types, three addresses) and puts what does not fit into the
notes under "More from UniHub". A vCard export is streamed in slices of 200
contacts with their photos. `GET` exports every contact, `POST` the ids given
(at most 20,000; ids that are not the person's are left out). Re-importing a
vCard export adds nothing: every card is found by its UID.

## Photos

`PUT /api/contacts/:id/photo` takes a JPEG, PNG, WebP, AVIF, GIF or HEIC/HEIF
picture of up to 20 MB as the raw body. The server turns it into one upright
square JPEG of at most 512 pixels and a 96-pixel thumbnail, without the
original's metadata (no location); nobody crops anything. The original bytes
are not kept. Errors are inline in the editor: `PHOTO_UNREADABLE` (not a
picture it can read, an SVG, a truncated file), `PHOTO_TOO_LARGE` (over 20 MB
or too many pixels), `PHOTO_TIMEOUT`. The files are content-addressed under
the uploads root; `GET …/photo?size=thumb|full&v=<etag>` answers them with
`Cache-Control: private, no-cache` and an ETag, so the browser keeps them
but asks each time. The list loads thumbnails lazily. Unreferenced files are
swept daily, never one a merge's undo may need.

## Duplicates

`GET /api/contacts/duplicates` computes the groups on request from the
contacts as they are; the browser keeps no rules of its own. Two contacts
are:

- **high**: the same UID (one merged into the other), a shared email or
  number with compatible names, or the same full name with the same
  organisation or a shared email or number
- **medium**: the same full name alone, or a shared email or number under
  different names (a shared office address)
- **low**: an equal single-word name, a middle name or an initial

Names are compared without accents and case, ignoring order ("Müller,
Jürgen" and "jurgen muller") and titles. A group's confidence is its weakest
link; low matches are shown as pairs. A group over 10 contacts is "large,
check carefully". Each reason names the shared value as written, never a
note. `auto_merge` marks what "Merge all" takes: high, not large, no single
value to choose, no "Not the same person" pair inside. "Not the same person"
is stored per pair and survives reloads and devices.

## Merge, undo and the bin

`POST /api/contacts/merges` sends the contacts, the version of each as shown
(409 `VERSION_CONFLICT` with the contacts as they are now when one changed),
the survivor (which keeps its id, UID and place on phones) and a choice per
single value that differs (400 `CHOICE_REQUIRED` with the fields when one is
missing). A merge never drops a value:

- every email, phone, address and other list value of every member is kept,
  de-duplicated by its normalised key (an equal value keeps the survivor's
  label)
- the chosen name (with all its parts), organisation, department, title,
  dates and photo; the values not chosen stay in the bin with the merged-away
  contacts
- unique notes one after the other, every category and kept property; the
  favourite if any member was
- a merge that would give the contact more than 100 values of a kind or more
  than 500 kept properties (256 KB) is refused with 400 `TOO_MANY_VALUES`;
  nothing is cut

The merged-away contacts go to the bin (`bin_items`) for at least 30 days
(the person's bin retention when longer) and their UIDs become aliases of
the survivor. `POST /api/contacts/merges/auto` merges
each listed group in its own transaction and answers `merged`, `changed`
(the group is no longer the same), `needs_choice` or `too_many_values` per
group.

Undo (`POST /api/contacts/merges/:id/undo`, from the notice after merging or
from "Recently merged") brings the merged contacts back as they were, with
their ids, UIDs, values, labels, kept properties, photo and version. The
survivor returns to its state before the merge when it has not changed
since; otherwise it keeps its later changes and the values it gained, and
the answer's `message` says so. Restoring a merged-away contact from the bin
within those 30 days is the same undo, for the whole merge. After 30 days
the undo expires; the merged-away contacts stay in the bin for the rest of
the person's retention, and restoring one then brings it back on its own:
it takes its UIDs back from the survivor, which keeps its values.

### The bin

Since 0.28.0 deleting a contact (also from the phone, which uses the same
route) moves it to the bin, the one of every module (D13, P-31; the
[architecture](ARCHITECTURE.md) and `services/bin.ts`). The bin item holds
the contact as stored, with its values, kept properties, photo, the UIDs it
answered to and its "Not the same person" pairs; its photo files stay on
disk while it is there. Several contacts deleted at once are one group and
come back together. Restoring brings the contact back under its id and UID
unless another contact took them meanwhile (then new ones); the phone gets
it again with its next sync, like any new contact. The contact leaves every
list, search, the offline snapshot and the phone as before.

How long the bin keeps items is the person's `bin_retention` setting (7,
30 or 90 days or forever; 30 by default). Deleting from the bin for good and
emptying it are refused while the `bin.delete` policy forbids them. The
hourly `bin.purge` deletes what is past its time, never while Contacts is
off or being restored, and never what the retention in force then (an
administrator's minimum included) still keeps.

## Shared address books

A shared address book (0.31.0) holds contacts of the organisation that
several people use. Books belong to the organisation, not to the person who
made them, and stay when that person leaves. A book's contacts have the same
model, input contract, version checks and photos as a person's own, without
the favourite. Duplicates, merges and export stay personal.
The request and response shapes, with every error code, are in
`api/src/contracts/address-books.ts`.

### Who may do what

A person's permission on a book is **read**, **edit** or **manage**; each
includes the one before. The access service (`services/access.ts`, kind
`address_book`) answers it from the grants to the person, to their groups and
to Everyone.

- **Anyone** signed in creates a book and manages it from then on.
- **Readers** see the book and its contacts. **Editors** also add, change and
  delete contacts, copy and import into the book and see its bin.
  **Managers** also rename, describe, share and delete the book.
- **Administrators** (the permission `contacts.books.manage`: administrators
  and the owner) manage every book without a grant. Their Contacts page lists
  only the books shared with them or made by them; every other book is under
  Server › Shared books ([Auth and admin](AUTH_ADMIN_SETTINGS.md#shared-books-and-the-directory)).
- **Sharing.** A manager gives a person, a group or Everyone read or edit.
  An administrator shares with anyone. A member shares only with the groups
  they belong to and the active people in those groups, never with
  Everyone (`403 SHARE_OUT_OF_REACH`); raising a share counts as sharing.
  Any manager may lower or remove any share. The creator's own management is
  not a share and does not change (`400 SHARE_IS_CREATOR`). Group managers
  have no extra rights on books.
- **Revocation.** Access is asked on every request and again inside every
  write's transaction, after the book's row is locked, so a share removed
  while a write waits refuses the write. A book the person cannot see
  answers `404 BOOK_NOT_FOUND` (also a deleted one); one they see but may not
  change that way answers `403 BOOK_FORBIDDEN`. After a share changes, a
  membership of a group holding a share changes, a book is deleted or
  restored, or someone is deactivated or activated, the people concerned
  get the hint `contacts.books` and their pages refetch.
- **People leaving.** A deactivated creator's grant is dormant until they
  are activated again. Deleting a person removes their grants; deleting a
  group removes the group's grants. The book stays, and administrators
  manage it. Before deactivating or deleting someone, the dialog names the
  books they manage. Changes to books write no activity-log entry.

### Getting contacts into a book

A contact is added one at a time in the book, or many at once:

- **Copy to a shared book** (`POST /api/address-books/:id/copy`, edit, at
  most 1000): each of the person's own contacts is copied with a new id and
  UID, its kept properties and its photo. The copy is not linked to the
  original, which stays as it was.
- **Import** (`POST /api/address-books/:id/imports`, edit): a vCard or CSV
  file is staged and matched against the book's contacts, with the
  [usual review](#import). Status and commit are the person's own import's
  routes; a merge is neither offered nor accepted, because a book's contacts
  are never merged. The commit checks the person may still edit the book
  before and inside every chunk.

Moving a contact between a person and a book, and exporting a book, are not
offered.

### Deleting a book, and each book's bin

**Deleting a book** (manage) hides it everywhere at once and deletes
nothing for good. Administrators restore it, with its contacts and shares,
under Server › Shared books › Deleted.

**A contact deleted from a book** goes to that book's own bin, never to a
person's. Everyone who may edit the book lists it (`GET /api/bin?book=<id>`;
`403` for a reader), restores items, deletes them for good and empties it
(`POST /api/bin/empty` with `{ "book": "<id>" }`) through the bin's usual
routes. Each action is checked against the book again inside its
transaction and follows the acting person's own Contacts switch, restore
lock and `bin.delete` rule. The administrator's path for a person never
reaches a book's items.

**How long a book's bin keeps items.** A book belongs to no one person, so
no personal `bin_retention` applies: a book's bin keeps items 30 days. While
deleting for good is forbidden for Everyone or for any group, it keeps them
at least for the strictest bin minimum among those rules (30 or 90 days, or,
by default, until someone restores or deletes them), as a personal bin keeps
its person's minimum. The hourly purge deletes a book's items past
that time, and a book deleted that long ago with its contacts, photos, bin
and shares, book by book, reading the minimum again under the book's lock.
It does not follow anyone's module switch or restore lock, since nobody
owns the book. The daily photo sweep removes the files under
`books/<book id>/`.

## The company directory

**Company** is a read-only book with the id `company`, listed first. It is
computed on each read, not stored as contacts: every active account
(including someone who has not used their setup link yet) with the name and
email of the account, the phone (64 characters), job title and department
(255 each) they fill in, and their groups. A deactivated person leaves it at
once; a deleted person is gone. An entry's `version` changes whenever a field
it shows changes. The shapes are in `api/src/contracts/directory.ts`.

- A person reads and edits their own entry under Settings › Profile
  (`GET` and `PUT /api/directory/me`), also with Contacts off.
- An administrator (`users.manage`) corrects anyone's entry on the person's
  page under Server › People (`GET` and `PUT /api/admin/users/:id/directory`),
  recorded in the activity log as `admin.directory_changed`.
- Nobody writes through the book: every write route answers
  `403 BOOK_FORBIDDEN` for `company`.
- A directory edit sends no hint; open pages show it when they next fetch.

## Where shared books appear

Company and the books shared with a person (directly, through a group or
Everyone) or made by them appear in:

- **Contacts**, in the panel's Shared group.
- **Search** (`/api/search`): each result names its book.
- **Recipient suggestions** in the composer: one entry per address, the
  person's own contact first, then Company, then the books.
- **"Also in"** on a person's own contact (`also_in` of `GET
  /api/contacts/:id`): the visible books and Company that hold an entry with
  one of its email or phone keys. Nothing is merged across them.
- **The offline copy** ([Offline](#offline)).
- **The phone.** Android apps that see the feature `contacts-books` in
  `GET /api/version` read `GET /api/address-books/phone` and each listed
  book's contacts and photos, and keep them read-only
  ([Android](ANDROID.md)). The list leaves out what the person switched off
  with "On my phones" on the book (the user setting
  `contacts_phone_books_off`: book ids and `company`, default empty, unknown
  ids ignored). Under the phone-contacts rule (`contacts.phone_sync`
  forbidden) the phone's requests get `403 MODULE_DISABLED`. `/api/contacts`
  never lists or accepts a book's contact, so older apps see only personal
  contacts.

### API

All routes need a signed-in session and the Contacts module, except the
administrator's and `/api/directory/me`. No personal restore touches a book,
so no restore of contacts blocks them. Writes need `X-CSRF-Token`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET, POST | `/api/address-books` | Company and the person's books; create one |
| GET | `/api/address-books/phone` | The books for the person's phones (also with `X-Background-Sync: 1`) |
| GET, PUT, DELETE | `/api/address-books/:id` | Read (read); rename and describe, delete (manage) |
| GET, PUT | `/api/address-books/:id/shares` | The shares; give, change or remove one (manage) |
| GET | `/api/address-books/:id/share-candidates?q=` | People and groups within the manager's reach, at most 20 each |
| GET, POST | `/api/address-books/:id/contacts` | List with `q`, `limit` (1 to 2000), `offset` (read); create (edit) |
| GET, PUT, DELETE | `/api/address-books/:id/contacts/:contactId` | Read; replace, version-checked; to the book's bin (edit) |
| POST | `/api/address-books/:id/contacts/bulk-delete` | Up to 5,000 to the book's bin (edit) |
| GET, PUT, DELETE | `/api/address-books/:id/contacts/:contactId/photo` | As a person's contact photo; removing it is `bin.delete` (edit) |
| POST | `/api/address-books/:id/copy`, `/api/address-books/:id/imports` | [Copy and import](#getting-contacts-into-a-book) (edit) |
| GET, PUT | `/api/directory/me` | The person's own directory entry |
| GET | `/api/directory` | Every directory entry |
| GET, PUT | `/api/admin/users/:id/directory` | An administrator's correction (`users.manage`) |
| GET | `/api/admin/address-books` | Every book, deleted ones too, with its creator (`contacts.books.manage`) |
| POST | `/api/admin/address-books/:id/restore` | Restore a deleted book (`contacts.books.manage`) |

## Offline

The offline snapshot holds the contacts with their lists and without photos
(the page shows initials), and Company and the shared books the person sees
then, each with its contacts, also without photos. A book shared no longer
leaves at the next refresh. The offline search reads every email and number
(see [Offline](OFFLINE.md)). A snapshot saved before 0.26.0 (the 3+3
columns) is read in the same model until it is refreshed.

## Backup and restore (ALPHA)

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

Data schema 5 carries the contacts with their values, kept properties,
photos (as archive files), UID aliases and "Not the same person" pairs;
restore remaps the ids. A shared book's contacts, its bin and the company
directory are organisation data: only the instance backup carries them
([Data recovery](DATA_RECOVERY.md#backup-versions-and-restore-behavior)).
Merges are not in a backup: a restore brings back
contacts, not a 30-day undo. From data schema 7 the bin's contacts are
archived with the contacts section (`restoreBinItems` in `services/bin.ts`);
a merged-away contact comes back as an ordinary deleted one. A backup made by 0.26.0 cannot be
read by an older UniHub; 0.26.0 reads the older archives. See
[Backup format](BACKUP_FORMAT.md) and [Backup and restore](BACKUP_RESTORE.md).

## The page

The contacts page lists contacts with their photo or initials and the
preferred number or email, and offers favourites, "Missing a name", "Name
only", "Possible duplicates" and "Recently merged". The detail groups
numbers, emails, addresses, dates, websites, messaging and related people
with copy buttons, shows categories and notes, and lists the details kept
from imports read-only. The editor (a dialog, full screen on phones) has
repeatable labelled rows with a preferred star, structured addresses, dates
with an optional year, categories as chips (each a whole name, commas
included; a stored category is never rewritten), the photo and "Add field"
for the rarer fields. The
selection offers "Set company…", "Copy to book…", "Export selected" and
Delete. The panel's Shared group lists Company and the shared books; a
book's page offers what the person's permission allows and says why
otherwise. The mail composer suggests every email of every contact, the
preferred one first, then those of Company and the shared books.

`email_link_behavior` decides whether email links open the system mail
client (`mailto`) or UniHub's composer (`internal`).
