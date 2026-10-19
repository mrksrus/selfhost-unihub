// Files allowed to break a layering rule because they did before the rule
// existed. The lists only shrink: scripts/import-graph.mts fails when a listed
// file no longer needs its entry or when a list grows past its ceiling. A new
// file follows the rule (docs/ARCHITECTURE.md, Layering).

// Route files that still run SQL through `db` from ../state instead of a
// service. The ceiling is the count when the rule was introduced.
export const ROUTES_USING_DB = {
  ceiling: 15,
  files: [
    "api/src/routes/admin.ts",
    "api/src/routes/auth.ts",
    "api/src/routes/backup.ts",
    "api/src/routes/calendar.ts",
    "api/src/routes/contacts.ts",
    "api/src/routes/mail-accounts.ts",
    "api/src/routes/mail-drafts.ts",
    "api/src/routes/mail-folders.ts",
    "api/src/routes/mail-messages.ts",
    "api/src/routes/mail-operations.ts",
    "api/src/routes/mail-route-helpers.ts",
    "api/src/routes/mail-sync.ts",
    "api/src/routes/search.ts",
    "api/src/routes/settings.ts",
    "api/src/routes/system.ts",
  ],
};

// Frontend views and hooks that call the raw API client instead of a feature
// module in src/lib/ (calendar-api.ts, mail-api.ts, ...).
export const VIEWS_USING_API_CLIENT = {
  ceiling: 28,
  files: [
    "src/components/GlobalCommandPalette.tsx",
    "src/components/mail/AttachmentViewer.tsx",
    "src/components/mail/MailFolderDialogs.tsx",
    "src/components/mail/MailPeek.tsx",
    "src/components/mail/MailPendingChanges.tsx",
    "src/components/offline/OfflineBanner.tsx",
    "src/components/offline/OfflineSettings.tsx",
    "src/components/pwa/NotificationSettings.tsx",
    "src/components/settings/AccountSettings.tsx",
    "src/components/settings/BackupSettings.tsx",
    "src/components/settings/DeleteDataSettings.tsx",
    "src/components/settings/SecuritySettings.tsx",
    "src/hooks/use-attachment-download.ts",
    "src/hooks/use-mail-account-backup.ts",
    "src/hooks/use-mail-account-editor.ts",
    "src/hooks/use-mail-account-removal.ts",
    "src/hooks/use-mail-compose.ts",
    "src/hooks/use-mail-queries.ts",
    "src/hooks/use-mail-reader.ts",
    "src/hooks/use-mail-sync-jobs.ts",
    "src/hooks/use-mail-writebacks.ts",
    "src/hooks/use-modules.ts",
    "src/hooks/use-recording-uploads.ts",
    "src/pages/AdminSettings.tsx",
    "src/pages/AdminUsers.tsx",
    "src/pages/Auth.tsx",
    "src/pages/Dashboard.tsx",
    "src/pages/Recordings.tsx",
  ],
};
