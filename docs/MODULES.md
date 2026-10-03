# Modules

Settings → Modules has separate controls for each built-in module:

- **Order:** move a module up or down. The sidebar, the mobile bar and the More
  page follow this order. The mobile bar shows the first four module pages; the
  rest are listed on More.
- **Navigation:** show or hide its shortcuts. A hidden module can still be opened directly.
- **Features:** allow or pause its pages and API operations. Pausing keeps its data.
- **Background work:** allow or pause automatic mail sync/deletion and calendar reminders. Manual actions remain available when the module itself is enabled.

Calendar and ToDo share one module because they are two views of the same planning
data. Contacts and recordings have no automatic provider worker to pause.
Temporary-upload housekeeping continues to remove expired incomplete uploads.

Core account settings and Data Management remain available. Full backups include
all saved modules, including hidden or paused ones. Restoring settings also restores
module choices and their order. Search, `/api/stats` counts and new offline snapshots
omit paused modules. Module controls are personal preferences, not a replacement
for user ownership or access permissions.

Already-issued network operations may finish after a pause. Active mail scans are
asked to stop; remote deletion checks settings again immediately before sending a
command. Notifications waiting to be delivered retain their attempts while paused,
but expired notifications are not replayed on resume.

Turning off a module clears the current browser's offline snapshot. Refresh or
clear snapshots on other devices too; a server setting cannot erase an offline
copy remotely. New snapshots include the module choices used to create them.
Older snapshots retain their original offline behavior until refreshed.

## Implementation contract

The built-in module catalog defines page/API membership and worker capabilities.
The recovery catalog declares durable data and remains independent of visibility.
Settings are archived under `user_settings.module_preferences`; the order is a
separate `user_settings.module_order` JSON list of module IDs. `PUT /api/modules`
accepts `modules` (a preference patch), `order` (every current module ID exactly
once), or both. When reading a saved order, unknown or removed IDs and duplicates
are dropped and missing modules are appended in catalog order, so an order saved
by an older or newer version never hides a module.

Removed modules:

- **Games** (removed in 0.12.0). The `tetris_scores` table stays in the database
  but is no longer used, exported or restored.
- **Notes** (removed in 0.14.0). Migration 11 drops `notes`, `note_revisions`,
  `note_attachments` and `note_links`, deletes the files under the Notes upload
  folder and clears `notes` from saved module preferences and the start page.

Saved preferences, saved orders and older backups may still name a removed module.
It is ignored when read (`RETIRED_MODULE_IDS` in `module-catalog.js`) and rejected
in new updates. Older archives that contain removed data or request a removed
section import everything else with a warning.
