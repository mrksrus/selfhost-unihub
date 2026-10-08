// Narrow shared contracts for newly converted modules. External values remain
// unknown until their existing runtime validation has checked them.
import type { IncomingMessage } from 'node:http';
import type { PoolConnection } from 'mysql2/promise';

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}
export type SqlExecutor = Pick<PoolConnection, 'execute' | 'query'>;
export type ApiError = Error & { status?: number; code?: string };
export type StoredFlag = boolean | number | string | null | undefined;
export interface MailAccountIdentity {
  email_address?: string | null;
  username?: string | null;
  imap_host?: string | null;
  imap_port?: number | string | null;
  sync_mode?: string | null;
  delete_emails_on_server?: StoredFlag;
}

// Historical format readers normalize rows without claiming validated values.
export interface BackupPayload {
  data: {
    mail_accounts?: BackupRow[];
    mail_folders?: BackupRow[];
    email_attachments?: BackupRow[];
    emails?: BackupRow[];
    mail_folder_remote_boxes?: BackupRow[];
    contacts?: BackupRow[];
    calendar_calendars?: BackupRow[];
    recordings?: BackupRow[];
    user_settings?: BackupRow[];
    [table: string]: unknown;
  };
}

export interface ComposerAttachment {
  filename?: string;
  content: Buffer;
  contentType?: string;
  contentId?: string;
  cid?: string;
}
export interface StagedAttachment {
  id: string;
  email_id: string;
  user_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_path: string;
  content_id: string | null;
}

export interface AuthRequest extends IncomingMessage { sessionRenewed?: string }

export interface BackupFile {
  id?: string;
  kind?: string;
  filename?: string;
  archive_path?: string;
  data_base64?: string | null;
  sha256?: string | null;
  missing?: boolean;
  [key: string]: unknown;
}
export interface ArchiveEnvelope extends BackupPayload {
  app?: unknown;
  version: number;
  format?: unknown;
  format_version?: unknown;
  files: BackupFile[];
  source_backup_version?: number;
  manifest_sha256?: string | null;
  [key: string]: unknown;
}
export interface FileRangeSource { filePath: string; start: number; size: number }
export type BackupFileSource = Buffer | FileRangeSource;

export interface RouteRequest extends AuthRequest { params?: Record<string, string | null> }
export interface RouteResponse extends Record<string, unknown> {
  status?: number;
  __handled?: boolean;
  __redirect?: string;
  __html?: string;
  __raw?: string | Buffer;
  __filename?: string;
  __disposition?: string;
  __contentType?: string;
  __streamPath?: string;
  __contentLength?: number | string | null;
}

export interface BackupRow extends Record<string, unknown> { id?: string; email_address?: string }
