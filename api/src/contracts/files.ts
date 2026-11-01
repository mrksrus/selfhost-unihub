// Request and response shapes of the download-ticket routes (F9, F11). The
// frontend imports these as types only; the rules are in
// services/file-tickets.ts.

/**
 * What a ticket can fetch. Each kind names its module and restore section on
 * the server. 'backup-archive' (0.28): one of the person's ready backups; its
 * redemption opens a download grant that allows Range requests for an hour,
 * because archives are large and the download manager resumes them.
 */
export type FileTicketKind = 'mail-attachment' | 'backup-archive';

/** POST /api/files/tickets */
export interface FileTicketRequest {
  kind: FileTicketKind;
  /** The record's id, for example the attachment's. */
  id: string;
}

/**
 * The ticket for one download. `url` (GET, no cookie needed) answers once,
 * within `expires_at`; the file's name, type and size are those of that answer.
 */
export interface FileTicketResponse {
  url: string;
  expires_at: string;
  filename: string;
  content_type: string;
  size: number;
}
