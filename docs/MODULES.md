# Modules

Settings → Modules has two lists.

**Pages** controls the navigation. Each page has its own entry: Mail, Calendar,
ToDo, Contacts, Recordings, Music and Today.

- **Order:** move a page up or down. The navigation rail, the mobile bar and the More
  page follow this order. The mobile bar shows the first four pages; the rest
  are listed on More.
- **Show in navigation:** show or hide the page's shortcuts. A hidden page can
  still be opened from a link, a search result or the start page setting.

**Modules** controls what works:

- **Enabled:** allow or pause the module's pages and API operations. Pausing keeps its data.
- **Background work:** allow or pause automatic mail sync/deletion and calendar reminders. Manual actions remain available when the module itself is enabled.

Some modules have more than one page. Calendar and ToDo are two views of the
same planning data, and Music is the chord and lyrics view of recordings. Their
pages are shown, hidden and ordered one by one, but the module still turns them
on and off together: with **Calendar and ToDo** disabled, neither page opens.
Today belongs to no module and can only be hidden.

Contacts and recordings have no automatic provider worker to pause.
Temporary-upload housekeeping continues to remove expired incomplete uploads.
The contacts housekeeping (merged contacts past their 30-day undo, expired
imports and unused photo files) waits while Contacts is off or a restore of
contacts runs, and catches up when the module is on again.

Core account settings and Backup and restore remain available. Full backups include
all saved modules, including hidden or paused ones. Restoring settings also restores
module and page choices and their order. Search, `/api/stats` counts and new offline snapshots
omit paused modules. Module controls are personal preferences, not a replacement
for user ownership or access permissions.

Already-issued network operations may finish after a pause. Active mail scans are
asked to stop; remote deletion checks settings again immediately before sending a
command. Notifications waiting to be delivered retain their attempts while paused,
but expired notifications are not replayed on resume. Scheduled sends and snoozed
messages wait while Mail or its background work is off and catch up on resume:
a due scheduled send then goes out, and a snoozed message comes back with its
notification.

Turning off a module clears the current browser's offline snapshot. Refresh or
clear snapshots on other devices too; a server setting cannot erase an offline
copy remotely. New snapshots include the module choices used to create them.
Older snapshots retain their original offline behavior until refreshed.

## Implementation contract

The built-in module catalog defines page/API membership and worker capabilities.
Each route declares the module that gates it on its spec (`module` in
`api/src/http/route.ts`; routes under `/api/<module>/` must name that module,
and the destructive settings actions name theirs), and the boundary refuses a
disabled module's routes before anything else. Workers ask
`canRunModule(userId, moduleId, { background })` in `services/access-policy.ts`
(module enabled, background allowed when unattended, no restore of its section)
or take the per-user map from `blockedBackgroundModulesByUser` when they scan
every user in one pass; services that report the module and restore causes
differently keep their own two checks.
The recovery catalog declares durable data and remains independent of visibility.
Settings are archived under `user_settings.module_preferences`; the order is a
separate `user_settings.module_order` JSON list of module IDs. `PUT /api/modules`
accepts `modules` (a preference patch), `order` (every current module ID exactly
once), or both. After saving, the route calls
`services/module-lifecycle.ts::applyModuleChange(userId, previous, next)`, which
updates the open event streams' module filter and runs the hook of every module
whose `enabled` or `background` choice changed; the mail hook
(`mail-sync-control.ts::onMailModuleChanged`) stops the accounts when the
module is disabled, and otherwise resumes user pauses, drops queued background
read work and closes or starts the IDLE sessions according to the background
choice. A new module with background work adds its hook there. When reading a saved order, unknown or removed IDs and duplicates
are dropped and missing modules are appended in catalog order, so an order saved
by an older or newer version never hides a module.

Pages (0.17.4) are listed in `PAGE_CATALOG` in `module-catalog.ts`, each with
the module it belongs to (`null` for Today). Their choices are kept apart from
the module choices, in `user_settings.page_preferences` (`{"todo": {"visible":
false}}`, merged like module preferences) and `user_settings.page_order` (every
page ID once). `GET /api/modules` and `PUT /api/modules` answer with `modules`
and `pages`; `PUT` also accepts `pages` and `page_order`. A page without its
own choice follows its module's older `visible` choice, so a module hidden
before 0.17.4 keeps all its pages hidden. Without a saved page order, pages
follow the module order with Today last. Page choices only change the
navigation, so unreadable or unknown entries are ignored when read instead of
failing the request. Since 0.17.4 the client no longer changes `module_order`
or a module's `visible`; the API still accepts both from older clients.

Removed modules:

- **Games** (removed in 0.12.0). The `tetris_scores` table stays in the database
  but is no longer used, exported or restored.
- **Notes** (removed in 0.14.0). Migration 11 drops `notes`, `note_revisions`,
  `note_attachments` and `note_links`, deletes the files under the Notes upload
  folder and clears `notes` from saved module preferences and the start page.

Saved preferences, saved orders and older backups may still name a removed module.
It is ignored when read (`RETIRED_MODULE_IDS` in `module-catalog.ts`) and rejected
in new updates. Older archives that contain removed data or request a removed
section import everything else with a warning.
