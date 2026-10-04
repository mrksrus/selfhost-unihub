import type { ComponentType } from 'react';
import { format } from 'date-fns';
import {
  Inbox,
  Send,
  Trash2,
  Star,
  Archive,
  CheckCircle2,
  ShieldAlert,
  Bell,
  CircleHelp,
  Megaphone,
  FileText,
} from 'lucide-react';
import { DEFAULT_SYNC_WINDOW_DAYS, DEFAULT_TRASH_WINDOW_DAYS, type Email, type MailAccount, type MailContact, type MailWindowDays } from '@/lib/mail-api';

export interface AccountFormState {
  email_address: string;
  display_name: string;
  provider: string;
  username: string;
  password: string;
  imap_host: string;
  smtp_host: string;
  imap_port: number;
  smtp_port: number;
  sync_fetch_limit: string;
  sync_mode: 'download' | 'sync';
  sync_window_days: MailWindowDays;
  trash_window_days: MailWindowDays;
  delete_emails_on_server: boolean;
  try_calendar_sync: boolean;
  caldav_url: string;
}

export interface MailHostCertificate {
  subject?: Record<string, string> | null;
  issuer?: Record<string, string> | null;
  valid_from?: string | null;
  valid_to?: string | null;
  fingerprint256?: string | null;
  authorizationError?: string | null;
  authorized?: boolean;
  error?: string;
}

export interface MailHostAssessment {
  host: string;
  port: number | null;
  knownProvider: boolean;
  allowlisted: boolean;
  blocked: boolean;
  resolvedAddresses?: string[];
}

export interface MailHostTrustResult {
  blocked: boolean;
  requiresConfirmation: boolean;
  requiresInsecureTls: boolean;
  warnings: string[];
  assessments: {
    imap: MailHostAssessment;
    smtp: MailHostAssessment;
  };
  certificates: {
    imap?: MailHostCertificate;
    smtp?: MailHostCertificate;
  };
}

export type PendingHostTrust = {
  mode: 'add' | 'edit';
  accountId?: string;
  account: AccountFormState & { is_active?: boolean };
  trust: MailHostTrustResult;
};

export type MailHostTrustError = Error & {
  requiresHostTrustConfirmation?: boolean;
  mailHostTrust?: MailHostTrustResult;
};

export interface ComposeAttachment {
  id: string;
  file: File;
}

export interface ComposeForm {
  to: string;
  subject: string;
  body: string;
}

export type ComposeMode = 'new' | 'reply' | 'forward';

export interface AddMailAccountResponse {
  syncInProgress?: boolean;
  message?: string;
  calendarSync?: {
    attempted: boolean;
    success?: boolean;
    code?: string;
    warning?: string;
    /** Number of calendars found on the server. */
    calendars?: number;
    server?: { url: string; source: string; label: string } | null;
    hint?: string | null;
  };
}

export interface MailPurgePreview {
  account_id: string;
  email_count: number;
  attachment_count: number;
  raw_count: number;
  unresolved_operations: number;
  calendar_accounts?: number;
  calendar_events?: number;
  blocked: boolean;
  reason?: string | null;
}

export interface ContactEmailSuggestion {
  key: string;
  name: string;
  email: string;
}

/** A folder entry as shown in navigation and move menus. */
export interface MailFolderItem {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  legacy: boolean;
  accountId: string | null;
}

export type FolderMode = string;

export const mailProviders = [
  { value: 'gmail', label: 'Gmail', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', imapPort: 993, smtpPort: 587 },
  { value: 'yahoo', label: 'Yahoo Mail', imapHost: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com', imapPort: 993, smtpPort: 587 },
  { value: 'icloud', label: 'iCloud Mail', imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', imapPort: 993, smtpPort: 587 },
  { value: 'outlook', label: 'Outlook / Office 365', imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', imapPort: 993, smtpPort: 587 },
  { value: 'exchange', label: 'Exchange (On-Premise)', imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 587 },
  { value: 'custom', label: 'Other (Custom IMAP/SMTP)', imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 587 },
];

/**
 * Providers whose calendars need OAuth or a server-side setup for CalDAV. UniHub can still show them read-only
 * through the calendar's published or secret iCal address.
 */
export const calendarSubscriptionHints: Record<string, string> = {
  gmail: 'Google calendars need OAuth for CalDAV. To see them read-only, paste the secret iCal address from Google Calendar → Settings → your calendar → Integrate calendar.',
  outlook: 'Outlook and Office 365 have no CalDAV. To see a calendar read-only, publish it in Outlook on the web (Settings → Calendar → Shared calendars) and paste the ICS link.',
  exchange: 'Exchange has no CalDAV. To see a calendar read-only, publish it in Outlook on the web (Settings → Calendar → Shared calendars) and paste the ICS link.',
};

export const systemFolders = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'drafts', label: 'Drafts', icon: FileText },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
  { id: 'important', label: 'Important', icon: CheckCircle2 },
  { id: 'marketing', label: 'Marketing', icon: Megaphone },
  { id: 'scam', label: 'Scam', icon: ShieldAlert },
  { id: 'unknown', label: 'Unknown', icon: CircleHelp },
  { id: 'twofactor_notifications', label: '2FA / Notifications', icon: Bell },
];

export const ALL_ACCOUNTS = 'all';
export const LEGACY_ACCOUNT = 'legacy';
export const ALL_MAIL: FolderMode = 'all';
export const bulkKey = (kind: string, payload: object) => `${kind}:${JSON.stringify(kind === 'delete' ? (payload as { emailIds: string[] }).emailIds : payload)}`;

export const initialAccountForm: AccountFormState = {
  email_address: '',
  display_name: '',
  provider: '',
  username: '',
  password: '',
  imap_host: '',
  smtp_host: '',
  imap_port: 993,
  smtp_port: 587,
  sync_fetch_limit: 'all',
  sync_mode: 'download',
  sync_window_days: DEFAULT_SYNC_WINDOW_DAYS,
  trash_window_days: DEFAULT_TRASH_WINDOW_DAYS,
  delete_emails_on_server: false,
  try_calendar_sync: true,
  caldav_url: '',
};

export const getContactDisplayName = (contact: MailContact) =>
  [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();

export const formatRecipient = (suggestion: ContactEmailSuggestion) =>
  suggestion.name ? `${suggestion.name} <${suggestion.email}>` : suggestion.email;

export const getActiveRecipientSearchTerm = (value: string) => {
  const parts = value.split(',');
  return (parts[parts.length - 1] || '').trim().toLowerCase();
};

export const deriveContactNameFromEmail = (email: Email) => {
  const cleanedName = (email.from_name || '').replace(/^["']|["']$/g, '').trim();
  const localPart = email.from_address.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
  const source = cleanedName || localPart || email.from_address;
  const parts = source.split(/\s+/).filter(Boolean);

  return {
    first_name: parts[0] || email.from_address,
    last_name: parts.slice(1).join(' ') || '',
  };
};

export const getServerDeleteStatus = (account: MailAccount) => {
  if (!account.delete_emails_on_server) return null;
  const counts = account.server_delete_counts;
  if (account.server_delete_running) return 'Server delete running';
  if (account.server_delete_grace_until) {
    const graceUntil = new Date(account.server_delete_grace_until);
    if (Number.isFinite(graceUntil.getTime()) && graceUntil.getTime() > Date.now()) {
      return `Server delete queued until ${format(graceUntil, 'MMM d, HH:mm')}`;
    }
  }
  if ((counts?.failed || 0) > 0) return `${counts?.failed || 0} server delete failed`;
  if ((counts?.pending || 0) > 0) return `${counts?.pending || 0} server deletes pending`;
  return 'Server delete enabled';
};

export const formatAttachmentSize = (bytes: number) => {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const flagPendingLabel = (email: Pick<Email, 'read_sync_pending' | 'star_sync_pending'>) =>
  email.read_sync_pending && email.star_sync_pending ? 'Read and star changes awaiting provider'
    : email.read_sync_pending ? 'Read change awaiting provider' : 'Star change awaiting provider';
