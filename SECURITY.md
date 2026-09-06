# Security

UniHub is AI-written software maintained by its project owner using OpenAI models, primarily **GPT 6 Astra**. AI models also perform security-focused code reviews as part of development and release preparation.

The project treats security findings as engineering work: review the affected paths, implement a focused correction, and verify the behavior with appropriate tests. Feedback and reproducible reports are welcome.

## Review and verification

The 0.10 refactor and 0.10.2 security update included AI review of authentication and user isolation, request parsing, mail/CalDAV host validation, notification subscriptions and delivery, offline storage ownership, and backup/import consistency.

Release CI runs API and frontend tests, lint, TypeScript checks and a production build. MySQL integration tests exercise the database, and the built-container smoke test covers startup, authentication cookies and CSRF, user isolation, file upload/download/ranges and recording conversion. Regression coverage includes two-user backup restores, checked outbound connection targets, CalDAV origin boundaries, proxy/account login limits, atomic 2FA sessions and supervised service shutdown. Release notes identify checks performed and device behavior that still needs validation.

## Reporting a vulnerability

Email **[smrus@rus.family](mailto:smrus@rus.family)** with the affected version, a description of the issue, reproduction steps and its impact. Use a private report for exploitable issues so a correction can be prepared before public disclosure.

Use sample data in reports. Keep passwords, session cookies, encryption keys, mail content and other personal data out of public issues.

## Operating UniHub

Use the latest stable release and follow the [upgrade guide](docs/UPGRADING.md). Serve browser traffic over HTTPS, configure the actual allowed origin, and keep the deployment's database credentials and encryption keys private and persistent.

UniHub stores sensitive mail and account data. Maintain recoverable backups of both the database and uploads, together with the keys needed to restore them. Offline reading stores a user-approved copy on that device; clearing the saved copy is available in Settings.

Operational settings and current feature limits are documented in the [README](README.md), [authentication guide](docs/AUTH_ADMIN_SETTINGS.md), [PWA guide](docs/PWA.md), and [backup restore guide](docs/BACKUP_RESTORE.md).
