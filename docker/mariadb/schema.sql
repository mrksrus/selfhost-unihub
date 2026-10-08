-- UniHub MariaDB schema after all startup upgrades. GENERATED, do not edit.
-- Regenerate with: scripts/local-db.sh schema-dump (api/scripts/dump-schema.cts).
-- Schema changes are numbered migrations in api/src/services/database.js; the app
-- creates and upgrades its own schema on startup. This file is a reviewable
-- reference, and a database test fails when it differs from a freshly migrated database.

CREATE TABLE `backup_archive_keys` (
  `backup_uuid` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `export_job_id` char(36) DEFAULT NULL,
  `restore_job_id` char(36) DEFAULT NULL,
  `server_wrapped_key` longtext NOT NULL,
  `recovery_password_ciphertext` longtext DEFAULT NULL,
  `recovery_password_revealed_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`backup_uuid`,`user_id`),
  KEY `user_id` (`user_id`),
  KEY `idx_backup_archive_keys_export` (`export_job_id`),
  KEY `idx_backup_archive_keys_restore` (`restore_job_id`),
  KEY `idx_backup_archive_keys_expiry` (`expires_at`),
  CONSTRAINT `backup_archive_keys_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `backup_restore_jobs` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `source_type` varchar(32) NOT NULL DEFAULT 'upload',
  `source_export_job_id` char(36) DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'uploaded',
  `operation` varchar(32) NOT NULL DEFAULT 'validate',
  `phase` varchar(32) NOT NULL DEFAULT 'uploaded',
  `progress` int(11) NOT NULL DEFAULT 0,
  `cancel_requested` tinyint(1) NOT NULL DEFAULT 0,
  `requested_sections` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`requested_sections`)),
  `conflict_mode` varchar(32) NOT NULL DEFAULT 'keep_existing',
  `calendar_mode` varchar(32) NOT NULL DEFAULT 'merge_same_name',
  `credentials_mode` varchar(32) NOT NULL DEFAULT 'keep_existing',
  `archive_path` text DEFAULT NULL,
  `archive_size` bigint(20) DEFAULT NULL,
  `archive_sha256` char(64) DEFAULT NULL,
  `backup_uuid` char(36) DEFAULT NULL,
  `is_encrypted` tinyint(1) NOT NULL DEFAULT 0,
  `validation_result` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`validation_result`)),
  `result_counts` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`result_counts`)),
  `error` text DEFAULT NULL,
  `attempt_count` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `started_at` timestamp NULL DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_backup_restore_jobs_user_created` (`user_id`,`created_at` DESC),
  KEY `idx_backup_restore_jobs_status` (`status`),
  KEY `idx_backup_restore_jobs_backup_uuid` (`backup_uuid`),
  KEY `idx_backup_restore_jobs_user_backup` (`user_id`,`backup_uuid`),
  CONSTRAINT `backup_restore_jobs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `calendar_accounts` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `provider` varchar(32) NOT NULL COMMENT 'local',
  `account_email` varchar(255) DEFAULT NULL,
  `display_name` varchar(255) DEFAULT NULL,
  `username` varchar(255) DEFAULT NULL,
  `encrypted_password` text DEFAULT NULL,
  `discovery_url` text DEFAULT NULL,
  `base_url` text DEFAULT NULL,
  `encrypted_access_token` text DEFAULT NULL,
  `encrypted_refresh_token` text DEFAULT NULL,
  `token_expires_at` datetime DEFAULT NULL,
  `provider_config` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'account configuration' CHECK (json_valid(`provider_config`)),
  `capabilities` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'feature flags/capabilities for this account' CHECK (json_valid(`capabilities`)),
  `is_active` tinyint(1) DEFAULT 1,
  `sync_status` varchar(32) DEFAULT NULL,
  `sync_error` text DEFAULT NULL,
  `last_synced_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `mail_account_id` char(36) DEFAULT NULL,
  `next_sync_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_calendar_accounts_user` (`user_id`),
  KEY `idx_calendar_accounts_provider` (`provider`),
  KEY `idx_calendar_accounts_active` (`user_id`,`is_active`),
  KEY `idx_calendar_accounts_mail` (`user_id`,`mail_account_id`),
  CONSTRAINT `calendar_accounts_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `calendar_calendars` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `account_id` char(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `external_id` varchar(500) DEFAULT NULL,
  `color` varchar(20) DEFAULT '#2563eb',
  `is_visible` tinyint(1) DEFAULT 1,
  `auto_todo_enabled` tinyint(1) DEFAULT 1,
  `read_only` tinyint(1) DEFAULT 0,
  `is_primary` tinyint(1) DEFAULT 0,
  `sync_token` text DEFAULT NULL COMMENT 'provider incremental sync token',
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `remote_ctag` varchar(255) DEFAULT NULL,
  `remote_expanded_on` date DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_calendar_external` (`account_id`,`external_id`),
  KEY `idx_calendar_calendars_user` (`user_id`),
  KEY `idx_calendar_calendars_account` (`account_id`),
  CONSTRAINT `calendar_calendars_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `calendar_calendars_ibfk_2` FOREIGN KEY (`account_id`) REFERENCES `calendar_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `calendar_event_attendees` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `event_id` char(36) NOT NULL,
  `email` varchar(255) NOT NULL,
  `display_name` varchar(255) DEFAULT NULL,
  `response_status` varchar(32) DEFAULT 'needsAction' COMMENT 'needsAction, accepted, tentative, declined',
  `is_organizer` tinyint(1) DEFAULT 0,
  `optional_attendee` tinyint(1) DEFAULT 0,
  `comment` text DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_event_attendee_email` (`event_id`,`email`),
  KEY `idx_event_attendees_user` (`user_id`),
  KEY `idx_event_attendees_event` (`event_id`),
  CONSTRAINT `calendar_event_attendees_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `calendar_event_attendees_ibfk_2` FOREIGN KEY (`event_id`) REFERENCES `calendar_events` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `calendar_event_external_refs` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `event_id` char(36) NOT NULL,
  `calendar_id` char(36) NOT NULL,
  `account_id` char(36) NOT NULL,
  `provider` varchar(32) NOT NULL,
  `external_event_id` varchar(500) NOT NULL,
  `external_etag` varchar(255) DEFAULT NULL,
  `external_updated_at` datetime DEFAULT NULL,
  `last_synced_at` timestamp NULL DEFAULT current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `remote_object_id` char(36) DEFAULT NULL,
  `recurrence_id` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_provider_event` (`account_id`,`external_event_id`),
  KEY `calendar_id` (`calendar_id`),
  KEY `idx_event_refs_user` (`user_id`),
  KEY `idx_event_refs_event` (`event_id`),
  KEY `idx_event_refs_remote_object` (`remote_object_id`),
  CONSTRAINT `calendar_event_external_refs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `calendar_event_external_refs_ibfk_2` FOREIGN KEY (`event_id`) REFERENCES `calendar_events` (`id`) ON DELETE CASCADE,
  CONSTRAINT `calendar_event_external_refs_ibfk_3` FOREIGN KEY (`calendar_id`) REFERENCES `calendar_calendars` (`id`) ON DELETE CASCADE,
  CONSTRAINT `calendar_event_external_refs_ibfk_4` FOREIGN KEY (`account_id`) REFERENCES `calendar_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `calendar_event_subtasks` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `event_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `is_done` tinyint(1) DEFAULT 0,
  `position` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_subtasks_event` (`event_id`),
  KEY `idx_subtasks_user` (`user_id`),
  KEY `idx_subtasks_order` (`event_id`,`position`),
  CONSTRAINT `calendar_event_subtasks_ibfk_1` FOREIGN KEY (`event_id`) REFERENCES `calendar_events` (`id`) ON DELETE CASCADE,
  CONSTRAINT `calendar_event_subtasks_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `calendar_events` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `calendar_id` char(36) DEFAULT NULL,
  `title` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `start_time` datetime NOT NULL,
  `end_time` datetime NOT NULL,
  `all_day` tinyint(1) DEFAULT 0,
  `location` varchar(500) DEFAULT NULL,
  `color` varchar(20) DEFAULT '#2563eb',
  `recurrence` varchar(100) DEFAULT NULL,
  `reminder_minutes` int(11) DEFAULT NULL,
  `reminders` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Array of reminder minutes before event: [0, 15, 60] for default + 15min + 1hr before' CHECK (json_valid(`reminders`)),
  `todo_status` varchar(20) DEFAULT NULL COMMENT 'done, changed, time_moved, cancelled',
  `is_todo_only` tinyint(1) DEFAULT 0 COMMENT 'True for standalone todos without calendar dates',
  `done_at` datetime DEFAULT NULL COMMENT 'Timestamp when task was marked as done',
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_events_user` (`user_id`),
  KEY `idx_events_start` (`start_time`),
  KEY `idx_events_user_time` (`user_id`,`start_time`,`end_time`),
  KEY `idx_events_calendar` (`calendar_id`),
  KEY `idx_events_notification_scan` (`updated_at`,`start_time`),
  CONSTRAINT `calendar_events_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_calendar_events_calendar_id` FOREIGN KEY (`calendar_id`) REFERENCES `calendar_calendars` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `calendar_remote_objects` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `account_id` char(36) NOT NULL,
  `calendar_id` char(36) NOT NULL,
  `href` text NOT NULL,
  `href_hash` char(64) NOT NULL,
  `etag` varchar(255) DEFAULT NULL,
  `uid` varchar(500) DEFAULT NULL,
  `ics` mediumtext NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_calendar_remote_object` (`calendar_id`,`href_hash`),
  KEY `user_id` (`user_id`),
  KEY `idx_calendar_remote_objects_account` (`account_id`),
  CONSTRAINT `calendar_remote_objects_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `calendar_remote_objects_ibfk_2` FOREIGN KEY (`account_id`) REFERENCES `calendar_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `calendar_remote_objects_ibfk_3` FOREIGN KEY (`calendar_id`) REFERENCES `calendar_calendars` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `contacts` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `email2` varchar(255) DEFAULT NULL,
  `email3` varchar(255) DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `phone2` varchar(50) DEFAULT NULL,
  `phone3` varchar(50) DEFAULT NULL,
  `company` varchar(255) DEFAULT NULL,
  `job_title` varchar(255) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `avatar_url` text DEFAULT NULL,
  `is_favorite` tinyint(1) DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_contacts_user` (`user_id`),
  KEY `idx_contacts_name` (`first_name`,`last_name`),
  KEY `idx_contacts_email` (`email`),
  KEY `idx_contacts_favorite` (`user_id`,`is_favorite`),
  KEY `idx_contacts_user_fav_name` (`user_id`,`is_favorite`,`first_name`,`last_name`),
  CONSTRAINT `contacts_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `data_export_jobs` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `scope` varchar(32) NOT NULL DEFAULT 'full',
  `status` varchar(32) NOT NULL DEFAULT 'queued',
  `phase` varchar(32) NOT NULL DEFAULT 'queued',
  `progress` int(11) NOT NULL DEFAULT 0,
  `cancel_requested` tinyint(1) NOT NULL DEFAULT 0,
  `requested_sections` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`requested_sections`)),
  `file_path` text DEFAULT NULL,
  `file_size` bigint(20) DEFAULT NULL,
  `file_sha256` char(64) DEFAULT NULL,
  `content_type` varchar(128) DEFAULT NULL,
  `encryption_enabled` tinyint(1) NOT NULL DEFAULT 1,
  `backup_uuid` char(36) DEFAULT NULL,
  `error` text DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `started_at` timestamp NULL DEFAULT NULL,
  `completed_at` timestamp NULL DEFAULT NULL,
  `downloaded_at` timestamp NULL DEFAULT NULL,
  `mail_account_id` char(36) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_data_export_jobs_user_created` (`user_id`,`created_at` DESC),
  KEY `idx_data_export_jobs_status` (`status`),
  KEY `idx_data_export_jobs_user_backup` (`user_id`,`backup_uuid`),
  CONSTRAINT `data_export_jobs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `email_attachments` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `email_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `filename` varchar(255) NOT NULL,
  `content_type` varchar(100) DEFAULT NULL,
  `size_bytes` bigint(20) DEFAULT NULL,
  `storage_path` text DEFAULT NULL,
  `content_id` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_attachments_email` (`email_id`),
  KEY `idx_attachments_user` (`user_id`),
  KEY `idx_attachments_content_id` (`content_id`),
  CONSTRAINT `email_attachments_ibfk_1` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE,
  CONSTRAINT `email_attachments_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `emails` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `message_id` varchar(500) DEFAULT NULL,
  `subject` text DEFAULT NULL,
  `from_address` varchar(255) NOT NULL,
  `from_name` varchar(255) DEFAULT NULL,
  `to_addresses` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`to_addresses`)),
  `cc_addresses` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`cc_addresses`)),
  `bcc_addresses` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`bcc_addresses`)),
  `body_text` longtext DEFAULT NULL,
  `body_html` longtext DEFAULT NULL,
  `folder` varchar(64) DEFAULT 'inbox',
  `source_folder` varchar(255) DEFAULT NULL,
  `imap_uid` bigint(20) DEFAULT NULL,
  `imap_uidvalidity` bigint(20) DEFAULT NULL,
  `raw_storage_path` text DEFAULT NULL,
  `raw_sha256` char(64) DEFAULT NULL,
  `is_read` tinyint(1) DEFAULT 0,
  `is_starred` tinyint(1) DEFAULT 0,
  `is_draft` tinyint(1) DEFAULT 0,
  `has_attachments` tinyint(1) DEFAULT 0,
  `received_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `filing_account_id` char(36) DEFAULT NULL,
  `is_legacy` tinyint(1) NOT NULL DEFAULT 0,
  `import_complete` tinyint(1) NOT NULL DEFAULT 0,
  `remote_folder` varchar(255) DEFAULT NULL,
  `remote_uid` bigint(20) DEFAULT NULL,
  `remote_uidvalidity` bigint(20) DEFAULT NULL,
  `remote_missing` tinyint(1) NOT NULL DEFAULT 0,
  `observation_revision` bigint(20) NOT NULL DEFAULT 0,
  `observed_modseq` varchar(32) DEFAULT NULL,
  `raw_format` varchar(24) NOT NULL DEFAULT 'legacy_normalized',
  `raw_bytes` bigint(20) DEFAULT NULL,
  `raw_verified` tinyint(1) NOT NULL DEFAULT 0,
  `content_state` varchar(24) NOT NULL DEFAULT 'legacy',
  PRIMARY KEY (`id`),
  KEY `idx_emails_user` (`user_id`),
  KEY `idx_emails_account` (`mail_account_id`),
  KEY `idx_emails_folder` (`mail_account_id`,`folder`),
  KEY `idx_emails_imap_uid` (`mail_account_id`,`source_folder`,`imap_uid`),
  KEY `idx_emails_date` (`received_at` DESC),
  KEY `idx_emails_unread` (`user_id`,`is_read`,`received_at` DESC),
  KEY `idx_emails_user_date` (`user_id`,`received_at` DESC,`id`),
  KEY `idx_emails_user_account_date` (`user_id`,`mail_account_id`,`received_at` DESC,`id`),
  KEY `idx_emails_user_folder_date` (`user_id`,`folder`,`received_at` DESC,`id`),
  KEY `idx_emails_user_account_folder_date` (`user_id`,`mail_account_id`,`folder`,`received_at` DESC,`id`),
  KEY `idx_emails_user_starred_date` (`user_id`,`is_starred`,`received_at` DESC),
  KEY `idx_emails_user_read_folder_account` (`user_id`,`is_read`,`folder`,`mail_account_id`),
  KEY `fk_emails_filing_account` (`filing_account_id`),
  FULLTEXT KEY `ft_emails_search` (`subject`,`body_text`),
  CONSTRAINT `emails_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `emails_ibfk_2` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_emails_filing_account` FOREIGN KEY (`filing_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_accounts` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `email_address` varchar(255) NOT NULL,
  `display_name` varchar(255) DEFAULT NULL,
  `provider` varchar(50) NOT NULL,
  `username` varchar(255) DEFAULT NULL,
  `imap_host` varchar(255) DEFAULT NULL,
  `imap_port` int(11) DEFAULT 993,
  `smtp_host` varchar(255) DEFAULT NULL,
  `smtp_port` int(11) DEFAULT 587,
  `encrypted_password` text DEFAULT NULL,
  `sync_fetch_limit` varchar(16) NOT NULL DEFAULT 'all',
  `delete_emails_on_server` tinyint(1) DEFAULT 0,
  `server_delete_enabled_at` timestamp NULL DEFAULT NULL,
  `server_delete_grace_until` timestamp NULL DEFAULT NULL,
  `server_delete_last_run_at` timestamp NULL DEFAULT NULL,
  `allow_self_signed` tinyint(1) DEFAULT 0,
  `trusted_imap_fingerprint256` varchar(128) DEFAULT NULL,
  `trusted_smtp_fingerprint256` varchar(128) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `last_synced_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `sync_mode` varchar(16) NOT NULL DEFAULT 'download',
  `sync_status` varchar(16) NOT NULL DEFAULT 'idle',
  `disconnected_at` datetime DEFAULT NULL,
  `engine_version` int(11) NOT NULL DEFAULT 11,
  `sync_window_days` int(11) DEFAULT NULL,
  `trash_window_days` int(11) DEFAULT 30,
  `sync_policy_confirmed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_user_email` (`user_id`,`email_address`),
  KEY `idx_mail_accounts_user` (`user_id`),
  KEY `idx_mail_accounts_email` (`email_address`),
  CONSTRAINT `mail_accounts_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_command_receipts` (
  `user_id` char(36) NOT NULL,
  `client_key` varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `request_hash` char(64) NOT NULL,
  `response_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`response_json`)),
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`user_id`,`client_key`),
  CONSTRAINT `mail_command_receipts_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_email_scores` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `email_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `score_version` varchar(32) NOT NULL DEFAULT 'v1',
  `total_score` decimal(6,2) NOT NULL DEFAULT 0.00,
  `risk_level` varchar(32) DEFAULT NULL,
  `spf_result` varchar(64) DEFAULT NULL,
  `dkim_result` varchar(64) DEFAULT NULL,
  `dmarc_result` varchar(64) DEFAULT NULL,
  `language_risk_score` decimal(6,2) DEFAULT NULL,
  `sender_reputation_score` decimal(6,2) DEFAULT NULL,
  `source_risk_score` decimal(6,2) DEFAULT NULL,
  `classifier_confidence` decimal(6,2) DEFAULT NULL,
  `reasons` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`reasons`)),
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `scored_at` timestamp NULL DEFAULT current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_mail_email_score` (`email_id`,`score_version`),
  KEY `idx_mail_email_scores_user` (`user_id`,`scored_at` DESC),
  KEY `idx_mail_email_scores_risk` (`risk_level`),
  KEY `idx_mail_email_scores_total` (`total_score` DESC),
  CONSTRAINT `mail_email_scores_ibfk_1` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_email_scores_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_engine_accounts` (
  `mail_account_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `generation` bigint(20) NOT NULL DEFAULT 0,
  `lease_owner` varchar(128) DEFAULT NULL,
  `lease_until` datetime DEFAULT NULL,
  `paused_reason` varchar(255) DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`mail_account_id`),
  KEY `user_id` (`user_id`),
  KEY `idx_engine_account_lease` (`lease_until`),
  CONSTRAINT `mail_engine_accounts_ibfk_1` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_engine_accounts_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_engine_cursors` (
  `mailbox_id` char(36) NOT NULL,
  `stream` varchar(16) NOT NULL,
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `uidvalidity` bigint(20) unsigned NOT NULL,
  `window_start` bigint(20) unsigned NOT NULL DEFAULT 0,
  `window_end` bigint(20) unsigned NOT NULL DEFAULT 0,
  `covered_through` bigint(20) unsigned NOT NULL DEFAULT 0,
  `checkpoint` varchar(32) DEFAULT NULL,
  `sweep_generation` bigint(20) unsigned NOT NULL DEFAULT 0,
  `coverage_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`coverage_json`)),
  `last_covered_at` datetime DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`mailbox_id`,`stream`),
  KEY `user_id` (`user_id`),
  KEY `mail_account_id` (`mail_account_id`),
  CONSTRAINT `mail_engine_cursors_ibfk_1` FOREIGN KEY (`mailbox_id`) REFERENCES `mail_remote_mailboxes` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_engine_cursors_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_engine_cursors_ibfk_3` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_engine_jobs` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `mailbox_id` char(36) DEFAULT NULL,
  `operation_id` char(36) DEFAULT NULL,
  `kind` varchar(32) NOT NULL,
  `priority` int(11) NOT NULL DEFAULT 50,
  `state` varchar(24) NOT NULL DEFAULT 'queued',
  `phase` varchar(64) DEFAULT NULL,
  `due_at` datetime NOT NULL DEFAULT current_timestamp(),
  `lease_owner` varchar(128) DEFAULT NULL,
  `lease_until` datetime DEFAULT NULL,
  `worker_generation` bigint(20) DEFAULT NULL,
  `cancellation_requested` tinyint(1) NOT NULL DEFAULT 0,
  `processed` bigint(20) NOT NULL DEFAULT 0,
  `total` bigint(20) DEFAULT NULL,
  `coverage_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`coverage_json`)),
  `error` varchar(255) DEFAULT NULL,
  `started_at` datetime DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  `heartbeat_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `manual_refresh` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `mail_account_id` (`mail_account_id`),
  KEY `mailbox_id` (`mailbox_id`),
  KEY `operation_id` (`operation_id`),
  KEY `idx_job_due` (`state`,`due_at`,`priority`,`mail_account_id`),
  KEY `idx_job_lease` (`state`,`lease_until`),
  KEY `idx_job_account` (`user_id`,`mail_account_id`,`state`,`created_at`),
  CONSTRAINT `mail_engine_jobs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_engine_jobs_ibfk_2` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_engine_jobs_ibfk_3` FOREIGN KEY (`mailbox_id`) REFERENCES `mail_remote_mailboxes` (`id`) ON DELETE SET NULL,
  CONSTRAINT `mail_engine_jobs_ibfk_4` FOREIGN KEY (`operation_id`) REFERENCES `mail_writebacks` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_engine_migration_progress` (
  `source_table` varchar(32) NOT NULL,
  `last_id` char(36) NOT NULL DEFAULT '',
  `processed` bigint(20) NOT NULL DEFAULT 0,
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`source_table`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_engine_quarantine` (
  `source_table` varchar(32) NOT NULL,
  `source_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `reason` varchar(64) NOT NULL,
  `evidence_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`evidence_json`)),
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`source_table`,`source_id`,`reason`),
  KEY `idx_quarantine_account` (`user_id`,`mail_account_id`,`reason`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_folder_reconciliations` (
  `mail_account_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `inventory` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`inventory`)),
  `previous_mappings` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`previous_mappings`)),
  `completed_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`mail_account_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `mail_folder_reconciliations_ibfk_1` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_folder_reconciliations_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_folder_recovery_items` (
  `email_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `source_account_id` char(36) NOT NULL,
  `original_folder` varchar(64) NOT NULL,
  `original_filing_account_id` char(36) DEFAULT NULL,
  `target_folder` varchar(64) NOT NULL,
  `target_account_id` char(36) DEFAULT NULL,
  `action` varchar(32) NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`email_id`),
  KEY `idx_folder_recovery_user` (`user_id`),
  CONSTRAINT `mail_folder_recovery_items_ibfk_1` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_folder_recovery_items_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_folder_remote_boxes` (
  `folder_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `remote_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`folder_id`,`mail_account_id`),
  UNIQUE KEY `unique_mail_folder_remote_box` (`mail_account_id`,`remote_name`),
  KEY `idx_mail_folder_remote_boxes_account` (`mail_account_id`),
  CONSTRAINT `mail_folder_remote_boxes_ibfk_1` FOREIGN KEY (`folder_id`) REFERENCES `mail_folders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_folder_remote_boxes_ibfk_2` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_folder_rule_overrides` (
  `rule_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `target_folder` varchar(64) NOT NULL,
  PRIMARY KEY (`rule_id`,`mail_account_id`),
  KEY `mail_account_id` (`mail_account_id`),
  CONSTRAINT `mail_folder_rule_overrides_ibfk_1` FOREIGN KEY (`rule_id`) REFERENCES `mail_sender_rules` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_folder_rule_overrides_ibfk_2` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_folders` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `slug` varchar(64) NOT NULL,
  `display_name` varchar(128) NOT NULL,
  `is_system` tinyint(1) DEFAULT 1,
  `position` int(11) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `mail_account_id` char(36) DEFAULT NULL,
  `special_use` varchar(32) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_mail_folder_user_slug` (`user_id`,`slug`),
  KEY `idx_mail_folders_user` (`user_id`),
  KEY `idx_mail_folders_order` (`user_id`,`position`),
  KEY `fk_mail_folders_account` (`mail_account_id`),
  CONSTRAINT `fk_mail_folders_account` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_folders_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_gmail_messages` (
  `mail_account_id` char(36) NOT NULL,
  `gmail_msgid` varchar(32) NOT NULL,
  `user_id` char(36) NOT NULL,
  `email_id` char(36) NOT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`mail_account_id`,`gmail_msgid`),
  KEY `user_id` (`user_id`),
  KEY `email_id` (`email_id`),
  CONSTRAINT `mail_gmail_messages_ibfk_1` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_gmail_messages_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_gmail_messages_ibfk_3` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_operation_attempts` (
  `id` char(36) NOT NULL,
  `operation_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `worker_generation` bigint(20) NOT NULL,
  `dispatch_fence` char(36) NOT NULL,
  `outcome` varchar(32) NOT NULL DEFAULT 'prepared',
  `transmission` varchar(32) NOT NULL DEFAULT 'unknown',
  `evidence_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`evidence_json`)),
  `started_at` datetime NOT NULL DEFAULT current_timestamp(),
  `dispatched_at` datetime DEFAULT NULL,
  `completed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `idx_attempt_operation` (`operation_id`,`started_at`),
  KEY `idx_attempt_account` (`mail_account_id`,`outcome`),
  CONSTRAINT `mail_operation_attempts_ibfk_1` FOREIGN KEY (`operation_id`) REFERENCES `mail_writebacks` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_operation_attempts_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_operation_attempts_ibfk_3` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_remote_mailboxes` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `remote_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL,
  `delimiter` varchar(16) DEFAULT NULL,
  `special_use` varchar(64) DEFAULT NULL,
  `provider_mailbox_id` varchar(255) DEFAULT NULL,
  `uidvalidity` bigint(20) unsigned DEFAULT NULL,
  `state` varchar(24) NOT NULL DEFAULT 'active',
  `epoch_revision` bigint(20) NOT NULL DEFAULT 0,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_remote_mailbox` (`mail_account_id`,`remote_name`),
  KEY `idx_remote_mailbox_owner` (`user_id`,`mail_account_id`),
  CONSTRAINT `mail_remote_mailboxes_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_remote_mailboxes_ibfk_2` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_remote_occurrences` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `mailbox_id` char(36) NOT NULL,
  `uidvalidity` bigint(20) unsigned NOT NULL,
  `uid` bigint(20) unsigned NOT NULL,
  `email_id` char(36) NOT NULL,
  `observed_flags` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`observed_flags`)),
  `observed_modseq` varchar(32) DEFAULT NULL,
  `gmail_msgid` varchar(32) DEFAULT NULL,
  `presence` varchar(24) NOT NULL DEFAULT 'present',
  `observation_revision` bigint(20) NOT NULL DEFAULT 0,
  `observed_at` datetime DEFAULT NULL,
  `absent_at` datetime DEFAULT NULL,
  `quarantine_reason` varchar(64) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `updated_at` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `internal_date` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_occurrence_tuple` (`mailbox_id`,`uidvalidity`,`uid`),
  KEY `email_id` (`email_id`),
  KEY `idx_occurrence_owner_item` (`user_id`,`mail_account_id`,`email_id`,`presence`),
  KEY `idx_occurrence_window` (`mailbox_id`,`uidvalidity`,`uid`,`presence`),
  KEY `idx_occurrence_gmail` (`mail_account_id`,`gmail_msgid`),
  CONSTRAINT `mail_remote_occurrences_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_remote_occurrences_ibfk_2` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_remote_occurrences_ibfk_3` FOREIGN KEY (`mailbox_id`) REFERENCES `mail_remote_mailboxes` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_remote_occurrences_ibfk_4` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_sender_rules` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) DEFAULT NULL,
  `match_type` enum('domain','email') NOT NULL,
  `match_value` varchar(255) NOT NULL,
  `target_folder` varchar(64) NOT NULL,
  `priority` int(11) NOT NULL DEFAULT 100,
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_mail_sender_rules_user` (`user_id`,`is_active`),
  KEY `idx_mail_sender_rules_account` (`mail_account_id`,`is_active`),
  KEY `idx_mail_sender_rules_match` (`match_type`,`match_value`),
  KEY `idx_mail_sender_rules_target` (`target_folder`),
  KEY `idx_mail_sender_rules_priority` (`priority`),
  CONSTRAINT `mail_sender_rules_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_sender_rules_ibfk_2` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_server_messages` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `email_id` char(36) NOT NULL,
  `source_folder` varchar(255) NOT NULL,
  `imap_uid` bigint(20) NOT NULL,
  `imap_uidvalidity` bigint(20) DEFAULT NULL,
  `delete_status` enum('pending','deleted','missing','failed','skipped') NOT NULL DEFAULT 'pending',
  `delete_attempts` int(11) NOT NULL DEFAULT 0,
  `delete_error` text DEFAULT NULL,
  `deleted_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_mail_server_message_location` (`mail_account_id`,`source_folder`,`imap_uid`),
  KEY `idx_mail_server_messages_account_status` (`mail_account_id`,`delete_status`,`created_at`),
  KEY `idx_mail_server_messages_user_status` (`user_id`,`delete_status`),
  KEY `idx_mail_server_messages_email` (`email_id`),
  CONSTRAINT `mail_server_messages_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_server_messages_ibfk_2` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_server_messages_ibfk_3` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_sync_state` (
  `mail_account_id` char(36) NOT NULL,
  `source_folder` varchar(255) NOT NULL,
  `uidvalidity` bigint(20) DEFAULT NULL,
  `last_uid` bigint(20) NOT NULL DEFAULT 0,
  `initialized` tinyint(1) NOT NULL DEFAULT 0,
  `last_synced_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`mail_account_id`,`source_folder`),
  CONSTRAINT `mail_sync_state_ibfk_1` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `mail_writebacks` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `mail_account_id` char(36) NOT NULL,
  `email_id` char(36) NOT NULL,
  `action` varchar(16) NOT NULL,
  `target_value` varchar(255) NOT NULL,
  `base_value` varchar(255) NOT NULL,
  `target_folder` varchar(255) DEFAULT NULL,
  `remote_folder` varchar(255) NOT NULL,
  `remote_uid` bigint(20) NOT NULL,
  `remote_uidvalidity` bigint(20) NOT NULL,
  `status` varchar(16) NOT NULL DEFAULT 'pending',
  `attempts` int(11) NOT NULL DEFAULT 0,
  `dispatched` tinyint(1) NOT NULL DEFAULT 0,
  `dispatch_modseq` varchar(32) DEFAULT NULL,
  `error` varchar(255) DEFAULT NULL,
  `available_at` datetime NOT NULL DEFAULT current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `state` varchar(24) DEFAULT NULL,
  `is_current` tinyint(1) NOT NULL DEFAULT 0,
  `intent_revision` bigint(20) NOT NULL DEFAULT 0,
  `client_key` varchar(128) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `source_occurrence_id` char(36) DEFAULT NULL,
  `evidence_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`evidence_json`)),
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `idx_mail_writeback_pending` (`mail_account_id`,`status`,`available_at`),
  KEY `idx_mail_writeback_email_action` (`email_id`,`action`,`is_current`,`created_at`),
  KEY `idx_mail_writeback_state` (`state`,`mail_account_id`,`available_at`),
  CONSTRAINT `mail_writebacks_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_writebacks_ibfk_2` FOREIGN KEY (`mail_account_id`) REFERENCES `mail_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `mail_writebacks_ibfk_3` FOREIGN KEY (`email_id`) REFERENCES `emails` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `notification_config` (
  `id` tinyint(4) NOT NULL,
  `public_key` varchar(128) NOT NULL,
  `encrypted_private_key` text NOT NULL,
  `subject` varchar(320) NOT NULL,
  `last_reminder_scan_at` datetime DEFAULT NULL,
  `reminder_revision` bigint(20) NOT NULL DEFAULT 0,
  `scanned_revision` bigint(20) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `notification_deliveries` (
  `event_id` char(36) NOT NULL,
  `subscription_id` char(36) NOT NULL,
  `status` varchar(12) NOT NULL DEFAULT 'pending',
  `attempts` int(11) NOT NULL DEFAULT 0,
  `available_at` datetime NOT NULL,
  `delivered_at` datetime DEFAULT NULL,
  `last_error` varchar(120) DEFAULT NULL,
  PRIMARY KEY (`event_id`,`subscription_id`),
  KEY `subscription_id` (`subscription_id`),
  KEY `idx_notification_due` (`status`,`available_at`),
  CONSTRAINT `notification_deliveries_ibfk_1` FOREIGN KEY (`event_id`) REFERENCES `notification_events` (`id`) ON DELETE CASCADE,
  CONSTRAINT `notification_deliveries_ibfk_2` FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `notification_events` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `event_key` char(64) NOT NULL,
  `kind` varchar(24) NOT NULL,
  `source_id` char(36) DEFAULT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`payload`)),
  `expires_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_notification_event` (`user_id`,`event_key`),
  KEY `idx_notification_event_expiry` (`expires_at`),
  CONSTRAINT `notification_events_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `notification_reminders` (
  `event_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `minutes` int(11) NOT NULL,
  `due_at` datetime NOT NULL,
  `queued_at` datetime DEFAULT NULL,
  PRIMARY KEY (`event_id`,`minutes`),
  KEY `user_id` (`user_id`),
  KEY `idx_reminder_due` (`queued_at`,`due_at`),
  CONSTRAINT `notification_reminders_ibfk_1` FOREIGN KEY (`event_id`) REFERENCES `calendar_events` (`id`) ON DELETE CASCADE,
  CONSTRAINT `notification_reminders_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `push_subscriptions` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `session_id` char(36) NOT NULL,
  `endpoint` text NOT NULL,
  `endpoint_hash` char(64) NOT NULL,
  `p256dh` varchar(128) NOT NULL,
  `auth` varchar(64) NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `endpoint_hash` (`endpoint_hash`),
  KEY `session_id` (`session_id`),
  KEY `idx_push_user` (`user_id`),
  CONSTRAINT `push_subscriptions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `push_subscriptions_ibfk_2` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `recording_tag_links` (
  `recording_id` char(36) NOT NULL,
  `tag_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`recording_id`,`tag_id`),
  KEY `idx_recording_tag_links_user` (`user_id`),
  KEY `idx_recording_tag_links_tag` (`tag_id`),
  CONSTRAINT `recording_tag_links_ibfk_1` FOREIGN KEY (`recording_id`) REFERENCES `recordings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `recording_tag_links_ibfk_2` FOREIGN KEY (`tag_id`) REFERENCES `recording_tags` (`id`) ON DELETE CASCADE,
  CONSTRAINT `recording_tag_links_ibfk_3` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `recording_tags` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `name` varchar(80) NOT NULL,
  `color` varchar(20) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_recording_tag_user_name` (`user_id`,`name`),
  KEY `idx_recording_tags_user` (`user_id`),
  CONSTRAINT `recording_tags_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `recording_transcription_jobs` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `recording_id` char(36) NOT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'queued',
  `provider` varchar(64) DEFAULT NULL,
  `model` varchar(128) DEFAULT NULL,
  `language` varchar(32) DEFAULT NULL,
  `transcript_text` longtext DEFAULT NULL,
  `error` text DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_recording_transcription_jobs_user` (`user_id`),
  KEY `idx_recording_transcription_jobs_recording` (`recording_id`),
  KEY `idx_recording_transcription_jobs_status` (`status`),
  CONSTRAINT `recording_transcription_jobs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `recording_transcription_jobs_ibfk_2` FOREIGN KEY (`recording_id`) REFERENCES `recordings` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `recording_uploads` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `original_filename` varchar(255) DEFAULT NULL,
  `content_type` varchar(128) NOT NULL,
  `total_bytes` bigint(20) NOT NULL,
  `bytes_received` bigint(20) NOT NULL DEFAULT 0,
  `duration_seconds` decimal(12,3) DEFAULT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'imported',
  `category` varchar(32) NOT NULL DEFAULT 'none',
  `recorded_at` datetime DEFAULT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `tags` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`tags`)),
  `temp_path` text NOT NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_recording_uploads_user` (`user_id`),
  KEY `idx_recording_uploads_expires` (`expires_at`),
  CONSTRAINT `recording_uploads_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `recordings` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `original_filename` varchar(255) DEFAULT NULL,
  `content_type` varchar(128) NOT NULL,
  `size_bytes` bigint(20) NOT NULL DEFAULT 0,
  `duration_seconds` decimal(12,3) DEFAULT NULL,
  `storage_path` text NOT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'imported',
  `category` varchar(32) NOT NULL DEFAULT 'none',
  `recorded_at` datetime DEFAULT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_recordings_user_created` (`user_id`,`created_at` DESC),
  KEY `idx_recordings_user_category_created` (`user_id`,`category`,`created_at` DESC),
  KEY `idx_recordings_user_title` (`user_id`,`title`),
  CONSTRAINT `recordings_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `schema_migrations` (
  `id` int(10) unsigned NOT NULL,
  `name` varchar(128) NOT NULL,
  `completed_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `sessions` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `token` varchar(512) NOT NULL,
  `expires_at` timestamp NOT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` text DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `token` (`token`),
  KEY `idx_sessions_token` (`token`),
  KEY `idx_sessions_user` (`user_id`),
  KEY `idx_sessions_expires` (`expires_at`),
  CONSTRAINT `sessions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `system_settings` (
  `setting_key` varchar(100) NOT NULL,
  `setting_value` text NOT NULL,
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `tetris_scores` (
  `user_id` char(36) NOT NULL,
  `score` int(10) unsigned NOT NULL DEFAULT 0,
  `lines` int(10) unsigned NOT NULL DEFAULT 0,
  `level` int(10) unsigned NOT NULL DEFAULT 1,
  `achieved_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`user_id`),
  KEY `idx_tetris_scores_ranking` (`score` DESC,`lines` DESC,`achieved_at`),
  CONSTRAINT `tetris_scores_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `two_factor_challenges` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `user_id` char(36) NOT NULL,
  `token_hash` char(64) NOT NULL,
  `expires_at` timestamp NOT NULL,
  `ip_address` varchar(45) DEFAULT NULL,
  `user_agent` text DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `token_hash` (`token_hash`),
  KEY `idx_2fa_challenges_token` (`token_hash`),
  KEY `idx_2fa_challenges_user` (`user_id`),
  KEY `idx_2fa_challenges_expires` (`expires_at`),
  CONSTRAINT `two_factor_challenges_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `user_settings` (
  `user_id` char(36) NOT NULL,
  `setting_key` varchar(100) NOT NULL,
  `setting_value` text NOT NULL,
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`user_id`,`setting_key`),
  KEY `idx_user_settings_key` (`setting_key`),
  CONSTRAINT `user_settings_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `users` (
  `id` char(36) NOT NULL DEFAULT uuid(),
  `email` varchar(255) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `full_name` varchar(255) DEFAULT NULL,
  `avatar_url` text DEFAULT NULL,
  `role` enum('user','admin') NOT NULL DEFAULT 'user',
  `is_active` tinyint(1) DEFAULT 1,
  `email_verified` tinyint(1) DEFAULT 0,
  `timezone` varchar(64) DEFAULT NULL,
  `two_factor_enabled` tinyint(1) DEFAULT 0,
  `encrypted_two_factor_secret` text DEFAULT NULL,
  `two_factor_recovery_codes` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`two_factor_recovery_codes`)),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_users_email` (`email`),
  KEY `idx_users_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
