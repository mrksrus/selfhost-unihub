# Backup format and compatibility

**ALPHA: account backup, import and restore are experimental. Do not rely on them as your only copy of important data. Keep an independent, consistent backup of the database, uploads, deployment configuration and secrets, especially before deleting mail from your email provider.**

0.27.0 and later write account backups with data schema 6 and retain readers for schemas 1–5
(0.26.x wrote schema 5, 0.10.13 to 0.25.x schema 4).
`manifest.json` is the version file. Users do not select conversion scripts.

## Independent version fields

| Field | Current value | Meaning |
| --- | --- | --- |
| Data `version` | 6 | Meaning and shape of exported records |
| ZIP `format` | `unihub-restorable-backup` | Identifies a restorable archive |
| ZIP `format_version` | 1 | Archive layout |
| Encrypted container | 1 | Authenticated encryption framing |
| `producer` | UniHub name and app version | Build provenance, not reader selection |

Database upgrade IDs in `schema_migrations` are separate from these fields.
Both manifest and data payload must agree on supported format/version values.
The manifest includes selected sections, row counts and file count. Checksums
cover metadata and stored files. Encrypted archives retain streaming AES-256-GCM
framing and a password-wrapped data key.

## Readers and data coverage

| Data schema | Current reader | Notes |
| --- | --- | --- |
| 1 | Automatic | Historical provider-folder mappings were not included |
| 2 | Automatic | Provider mappings included; newer filing/recovery data may be absent |
| 3 | Automatic | Filing/recovery data, transcripts and server scores included |
| 4 | Automatic | Adds durable mail intents, receipts and quarantined provider evidence |
| 5 | Automatic | Contacts in the vCard model: values, kept properties, photos, merged-away UIDs and dismissed duplicates |
| 6 | Automatic | The hand order of tasks (`task_order`) and the default task list and calendar settings |
| Unknown version | Rejected before restore | Requires a compatible reader |

Schema 3 preserves account-scoped folder metadata, source and filing identities,
Legacy state, per-account sender-rule overrides, recovery journals and translated
completion markers. Completed recording transcripts
are included. Server-side Tetris scores were included until 0.12.0 removed
Games; they are now skipped on import with a warning. Mail mode, separate current provider bindings and the remote-missing
marker are included. Hidden or disabled modules are included. Module
preferences and module order are archived with settings. Notes data from
archives made before 0.14.0 is skipped on import with a warning. Old archives default to Download; Sync restores as pending.
Automatic deletion is always reset off. Different provider mailbox identities
cannot be merged.

The reader registry is `api/src/services/backup-format.ts`, with dedicated readers
in `backup-formats/`. Original archive checksums are validated before converting
historical metadata into the current restore model. Stored files remain
file-backed. Old archives cannot supply data they never contained; defaults and
warnings are explicit. Old inline JSON schema-1 data still uses its historical
internal reader; the upload UI accepts ZIP and encrypted archives.

Current validation rejects unknown tables/fields/file kinds and missing
required content. Unknown selected sections are errors, not a request for a full
restore. Conflicting folder scopes and merges that would hide newly restored
mail roll back. The original archive remains the historical record; optional
journal references to deleted accounts become null with a warning. Actual live
account references must resolve to owned records.

Schema 4 adds the durable mail engine. Account-scoped operations and request receipts
are retained and remapped through restore; imported provider attempts, identities and
mapping evidence are quarantined history, not executable commands. Runtime leases
and queued jobs are not restored as authority to write to a provider. Restored mail
accounts remain paused, server deletion stays off, and explicit provider validation
is required before reconnection. Existing accepted work is not silently discarded
or converted into a fresh remote mutation. Restored receipt results include a
recovery warning rather than an unqualified replay of the old HTTP response.

0.13.0 adds three mail account fields to schema 4 without changing its version:
`sync_window_days` and `trash_window_days` (restored as they are; archives
without them restore as all mail and 30 days) and `sync_policy_confirmed_at`
(exported for inspection, never restored: every restore leaves Sync accounts
unconfirmed, so restored local copies are not removed before the user confirms
again). Provider occurrences carry `internal_date` as quarantined evidence. An
account backup started from a mail account (`POST
/api/mail/accounts/:id/backup-export`) is an ordinary mail-section archive
restricted to that account; messages filed in another account restore under
their own account.

0.24.0 adds to schema 4, again without changing its version: the settings
of each mail account and calendar (`mail_account_settings`,
`calendar_settings`; folder references and setting references are remapped to
the restored records, values the registry no longer accepts are skipped),
templates (`mail_templates`, matched by name, so restoring twice does not
duplicate them), the account signature (`mail_accounts.signature_html`,
`signature_text`) and each message's threading headers, conversation key and
snooze state. Archives without them restore without them; conversations of
older mail are built again by the background threading. Installation policies
(`setting_policies`) and scheduled sends (`mail_scheduled_sends`) are never
archived: a restore must not send mail again, so a restored draft is not
scheduled.

0.26.0 introduces schema 5 for the contacts model (upgrade steps 22 and 23).
The contacts section exports `contacts` (with `uid`, the name parts,
department, birthday and anniversary; without the fixed email/phone fields),
`contact_values` (every labelled email, phone, address, web address, chat
handle, relation, nickname and category in its position), `contact_properties`
(vCard properties UniHub keeps without showing them; `source_version` is
opaque), `contact_photos`, `contact_uid_aliases` (UIDs of merged-away
contacts) and `contact_duplicate_dismissals`. Photos are the file kind
`contact_photo`: each converted JPEG and thumbnail is archived once under
`files/contact-photos/<sha256>.jpg`, its entry id is that SHA-256, and a
restore refuses a file whose bytes do not match its name, that is not a JPEG
or that is larger than 2 MiB. Export leaves out, with a warning, a photo
whose stored file is missing or damaged; the contact itself is archived.
Not archived: the merge records and the bin of merged-away contacts (a restore
brings back contacts, not their 30-day undo; 0.28 decides the bin) and staged
contact imports (temporary).

The schema 5 reader converts an archive of schema 1 to 4 before restore,
after its checksums and fields were validated against that archive's own
version: a schema 4 archive may carry the fixed `email`…`phone3` and
`avatar_url` fields but none of the schema 5 fields or tables, and a schema 5
archive the reverse. Each contact's non-empty fixed fields become values as
upgrade step 22 copies them (verbatim, in slot order, repeats kept, no label)
with UUIDv5 ids from the contact id, kind and position, so converting the same
archive again gives the same rows; `avatar_url`, never filled, is dropped and a
missing `uid` becomes `urn:uuid:<id>`. A restored contact is matched by id,
then UID or merged-away UID, then an email over its values, then the same name
with a phone in common. Replace matching replaces a matched contact's values,
kept properties and photo with the archived ones; from a schema 1–4 archive it
is applied as an old app's whole 3+3 update instead, so values beyond the
three places, labels, other fields, kept properties and the photo stay. Keep
both writes a copy with new ids and, when the UID is taken, a new UID.
Restoring the same archive twice adds nothing.

0.27.0 introduces schema 6 (upgrade step 24). The calendar section exports
`task_order`, the hand order of tasks: one row per task placed by hand, with
its rank (`sort_rank`). A task UniHub holds is named by `event_id`; a task in
a server calendar by `calendar_id`, `remote_uid` and `recurrence_id` (the
provider's identity), because the sync rebuilds its event rows. The restore
remaps `calendar_id` and `event_id`, computes `item_key` again from them, and
lets an existing row win unless Replace is chosen; a synced task's order
applies again once the next sync links its UID. Events keep their
`created_at` (a task without a date is ordered by it). A task that was never
placed by hand is ordered by its date with a small tiebreak from its id; a
restored UniHub task gets a new id, so the restore keeps its archived date
rank as a row with `auto_basis` (the second that rank was computed from). Such
a row does not count as placed by hand and stops applying once the task's
date changes. The order therefore comes back exactly as saved, also on
another installation. A synced task's tiebreak comes from its UID and
recurrence id, so it needs no such row. Every row must name a task
(or a calendar) of the same archive. The settings section may carry
`default_task_list_id` and `default_calendar_id`, which are remapped with the
restored calendars. The move journal (`calendar_event_moves`) is never
archived: a restore must not replay calendar server writes. Archives of
schemas 1 to 5 carry no order, so every task keeps its date's place; a schema
5 archive that carries `task_order` is refused as not made by UniHub.

Applications that read only schemas 1–5 (0.26.x and older) refuse a schema 6
backup before restoring anything: "Unsupported backup data version: 6. This
UniHub version reads versions 1, 2, 3, 4 and 5; a newer backup may need a
newer UniHub release."

Applications that read only schemas 1–4 (0.25.x and older) refuse a schema 5
backup before restoring anything: "Unsupported backup data version: 5. This
UniHub version reads versions 1, 2, 3 and 4; a newer backup may need a newer
UniHub release." Older applications that read only schemas 1–3 cannot import schema-4 backups.
Downgrading an image is not a database rollback. Preserve a matching full server
snapshot before upgrading. Future changes must retain supported readers and
frozen fixtures; see [Recovery contracts](DATA_RECOVERY.md).

## Account settings backups

Since 0.18.0 a backup can carry `account_only_sections`, a list with `mail`
and/or `calendar`, in both `data/backup.json` and `manifest.json`. Those
sections contain only `mail_accounts`, or `calendar_accounts` with provider
`caldav` or `ics`, and no files. Validation rejects any other rows or files in
them. Schema and backup versions are unchanged.

UniHub 0.18.0 and later restore these accounts as new sign-ins and start sync.
Older versions ignore the field and restore the accounts like a normal mail or
calendar restore: mail accounts stay paused until the Sync policy is confirmed.

## Limits and exclusions

The writer uses stored ZIP32 entries without compression or ZIP64:

| Limit | Maximum |
| --- | --- |
| Uploaded archive, including encryption overhead | 3900 MiB |
| ZIP entry size and ZIP size/offsets | 4 GiB minus one byte |
| ZIP entries, including metadata | 65,534 |
| `manifest.json` | 16 MiB |
| `checksums.json` | 64 MiB |
| `data/backup.json` | 512 MiB |

Export rejects output exceeding import limits. Section backups may fit where a
full archive does not. Splitting within one section is not implemented.

An account archive does not include other users, authentication sessions, server
configuration, temporary uploads/jobs, pending notifications or provider deletion
queues. Completed transcripts are data; pending transcription attempts are not
restored as work. Credential restoration uses existing encrypted portability
rules. Server deletion stays disabled on restored mail accounts.

## Compatibility evidence

Frozen plain/encrypted archives from the actual `v0.9.23.0` exporter live under
`api/tests/fixtures/backups/v1-0.9.23.0`. The frozen plain archive from the actual
`v0.10.3` exporter is under `v2-0.10.3`, and the frozen schema 4 contacts
archive from the actual `v0.25.1` exporter (fixed 3+3 fields with unicode,
empty slots and repeated values) under `v4-0.25.1`. Their provenance and hashes are recorded.
They contain invented data, not the owner's mailbox. Do not regenerate them just
to accommodate a changed reader.

Focused MariaDB recovery tests verify current exports, automatic old readers,
relationships and file bytes, restored account/folder meaning, conflicts,
interruption and ownership. They establish the covered cases at the tested
revision, not every old release or every live installation.
