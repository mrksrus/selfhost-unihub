// Request and response shapes of the conversation (threaded) mail routes
// (F11). The frontend imports these as types only; the rule that groups
// messages into conversations is in services/mail-threading.ts.

/** One message row, as GET /api/mail/emails lists it (the body is a short preview, no HTML). */
export interface MailListRow {
  id: string;
  /** The account the message is filed under; the source account is source_mail_account_id. */
  mail_account_id: string;
  source_mail_account_id?: string | null;
  filing_account_id?: string | null;
  is_legacy: boolean;
  remote_missing: boolean;
  message_id: string | null;
  subject: string | null;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  body_text: string | null;
  body_html: null;
  folder: string;
  is_read: boolean;
  is_starred: boolean;
  read_sync_pending: boolean;
  star_sync_pending: boolean;
  is_draft: boolean;
  has_attachments: boolean;
  received_at: string;
  task_count: number;
  /** The conversation; null for older mail the background backfill has not reached yet (a conversation of its own). */
  thread_key: string | null;
  /** Until when the message is snoozed (only in the Snoozed view and search); null otherwise. */
  snoozed_until: string | null;
  /** When a snooze last brought it back; the list may mark it. */
  snooze_returned_at: string | null;
  /** Drafts: the scheduled send, if any (see ScheduledSend in contracts/mail.ts). */
  scheduled_send_at: string | null;
  scheduled_send_status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'unknown' | null;
}

/** GET /api/mail/threads: the same filters as GET /api/mail/emails. */
export interface MailThreadListQuery {
  folder?: string;
  account_id?: string;
  is_read?: 'true' | 'false';
  is_starred?: 'true' | 'false';
  search?: string;
  /** 1 to 100, default 50. */
  limit?: number;
  offset?: number;
  /** next_cursor of the previous page; when given, offset is ignored. */
  cursor?: string;
  /** 'true' counts the conversations of the whole view (a full scan of it); off by default, unlike the message list. */
  include_count?: 'true' | 'false';
}

export interface MailThreadParticipant {
  address: string;
  name: string | null;
}

/** One conversation of the view: the messages of the folder/account/filters that share a thread_key. */
export interface MailThreadSummary {
  thread_key: string | null;
  /** The newest message of the conversation in this view; open it, or the whole conversation by its id. */
  latest: MailListRow;
  /** Messages of the conversation in this view. */
  message_count: number;
  /** Unread messages of the conversation in this view. */
  unread_count: number;
  /** Messages of the conversation in the whole mailbox (every folder and account), drafts excluded. */
  total_count: number;
  has_attachments: boolean;
  is_starred: boolean;
  /** Senders of the conversation, most recent first, at most five. */
  participants: MailThreadParticipant[];
}

export interface MailThreadListResponse {
  threads: MailThreadSummary[];
  pagination: {
    /** Conversations in the view; null unless include_count=true. */
    total: number | null;
    limit: number;
    offset: number;
    page: number;
    totalPages: number | null;
    hasMore: boolean;
    /** Pass as cursor for the next page; stable when new mail arrives meanwhile. */
    next_cursor: string | null;
  };
}

/** GET /api/mail/emails/:id/thread: every message of the conversation that message belongs to, oldest first. */
export interface MailThreadResponse {
  thread_key: string | null;
  messages: MailListRow[];
  /** The conversation has more than 200 messages: only the newest 200 are listed. */
  truncated: boolean;
}
