import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from '@/components/ui/dialog';
import { 
  AlertDialog, 
  AlertDialogAction, 
  AlertDialogCancel, 
  AlertDialogContent, 
  AlertDialogDescription, 
  AlertDialogFooter, 
  AlertDialogHeader, 
  AlertDialogTitle 
} from '@/components/ui/alert-dialog';
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { 
  Plus, 
  Inbox, 
  Send, 
  Trash2, 
  Star, 
  Archive,
  Mail,
  Loader2,
  RefreshCw,
  PenSquare,
  MoreVertical,
  X,
  Edit,
  Reply,
  Forward,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Menu,
  CheckSquare,
  Square,
  FolderOpen,
  CheckCircle2,
  Paperclip,
  Download,
  Search,
  ShieldAlert,
  Bell,
  CircleHelp,
  Megaphone,
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link as LinkIcon,
  Image as ImageIcon,
  Palette,
  UserPlus
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { useIsMobile } from '@/hooks/use-mobile';
import { SafeEmailContent } from '@/components/mail/SafeEmailContent';

interface MailAccount {
  id: string;
  email_address: string;
  display_name: string | null;
  provider: string;
  username?: string | null;
  imap_host?: string | null;
  imap_port?: number | null;
  smtp_host?: string | null;
  smtp_port?: number | null;
  is_active: boolean;
  last_synced_at: string | null;
  sync_fetch_limit?: string;
  unread_count?: number;
}

interface AccountFormState {
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
}

interface MailHostCertificate {
  subject?: Record<string, string> | null;
  issuer?: Record<string, string> | null;
  valid_from?: string | null;
  valid_to?: string | null;
  fingerprint256?: string | null;
  authorizationError?: string | null;
  authorized?: boolean;
  error?: string;
}

interface MailHostAssessment {
  host: string;
  port: number | null;
  knownProvider: boolean;
  allowlisted: boolean;
  blocked: boolean;
  resolvedAddresses?: string[];
}

interface MailHostTrustResult {
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

type PendingHostTrust = {
  mode: 'add' | 'edit';
  accountId?: string;
  account: AccountFormState;
  trust: MailHostTrustResult;
};

type MailHostTrustError = Error & {
  requiresHostTrustConfirmation?: boolean;
  mailHostTrust?: MailHostTrustResult;
};

interface EmailAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

interface Email {
  id: string;
  mail_account_id: string;
  subject: string | null;
  from_address: string;
  from_name: string | null;
  to_addresses: string[];
  body_text: string | null;
  body_html: string | null;
  folder: string;
  is_read: boolean;
  is_starred: boolean;
  received_at: string;
  has_attachments?: boolean;
  attachments?: EmailAttachment[];
}

interface ComposeAttachment {
  id: string;
  file: File;
}

interface AddMailAccountResponse {
  syncInProgress?: boolean;
  message?: string;
}

interface MailSyncResponse {
  message?: string;
  newEmails?: number;
}

interface MailUnreadCountsResponse {
  unreadByFolder?: Record<string, number>;
  unreadByFolderAccount?: Record<string, Record<string, number>>;
}

interface MailFolder {
  id: string;
  slug: string;
  display_name: string;
  is_system: boolean;
  position: number;
  total_count?: number;
  unread_count?: number;
}

interface MailContact {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  email2: string | null;
  email3: string | null;
}

interface ContactEmailSuggestion {
  key: string;
  name: string;
  email: string;
}

const mailProviders = [
  { value: 'gmail', label: 'Gmail', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', imapPort: 993, smtpPort: 587 },
  { value: 'yahoo', label: 'Yahoo Mail', imapHost: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com', imapPort: 993, smtpPort: 587 },
  { value: 'icloud', label: 'iCloud Mail', imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', imapPort: 993, smtpPort: 587 },
  { value: 'outlook', label: 'Outlook / Office 365', imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', imapPort: 993, smtpPort: 587 },
  { value: 'exchange', label: 'Exchange (On-Premise)', imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 587 },
  { value: 'custom', label: 'Other (Custom IMAP/SMTP)', imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 587 },
];

const systemFolders = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
  { id: 'important', label: 'Important', icon: CheckCircle2 },
  { id: 'marketing', label: 'Marketing', icon: Megaphone },
  { id: 'scam', label: 'Scam', icon: ShieldAlert },
  { id: 'unknown', label: 'Unknown', icon: CircleHelp },
  { id: 'twofactor_notifications', label: '2FA / Notifications', icon: Bell },
];

type AccountMode = MailAccount['id'] | 'all';
type FolderMode = string;

const ALL_ACCOUNTS: AccountMode = 'all';
const ALL_MAIL: FolderMode = 'all';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const plainTextToHtml = (value: string) =>
  escapeHtml(value || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, '<br>'))
    .map((paragraph) => `<p>${paragraph || '<br>'}</p>`)
    .join('');

const getContactDisplayName = (contact: MailContact) =>
  [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();

const formatRecipient = (suggestion: ContactEmailSuggestion) =>
  suggestion.name ? `${suggestion.name} <${suggestion.email}>` : suggestion.email;

const getActiveRecipientSearchTerm = (value: string) => {
  const parts = value.split(',');
  return (parts[parts.length - 1] || '').trim().toLowerCase();
};

const deriveContactNameFromEmail = (email: Email) => {
  const cleanedName = (email.from_name || '').replace(/^["']|["']$/g, '').trim();
  const localPart = email.from_address.split('@')[0]?.replace(/[._-]+/g, ' ').trim();
  const source = cleanedName || localPart || email.from_address;
  const parts = source.split(/\s+/).filter(Boolean);

  return {
    first_name: parts[0] || email.from_address,
    last_name: parts.slice(1).join(' ') || '',
  };
};

const isComposeHtmlEmpty = (value: string) =>
  !value
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

const MailPage = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [selectedAccount, setSelectedAccount] = useState<AccountMode | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<FolderMode>('inbox');
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<'new' | 'reply' | 'forward'>('new');
  const [isReplying, setIsReplying] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<string | null>(null);
  const [editingAccount, setEditingAccount] = useState<MailAccount | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [contextMenuEmail, setContextMenuEmail] = useState<{ email: Email; x: number; y: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [emailPage, setEmailPage] = useState(1);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [pendingHostTrust, setPendingHostTrust] = useState<PendingHostTrust | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [editingFolderSlug, setEditingFolderSlug] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState('');
  const [composeForm, setComposeForm] = useState({
    to: '',
    subject: '',
    body: '',
  });
  const [focusedRecipientInput, setFocusedRecipientInput] = useState<string | null>(null);
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachment[]>([]);
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);
  const inlineComposeEditorRef = React.useRef<HTMLDivElement | null>(null);
  const dialogComposeEditorRef = React.useRef<HTMLDivElement | null>(null);
  const [accountForm, setAccountForm] = useState<AccountFormState>({
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
  });

  // Open compose dialog if linked from dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'compose') {
      setIsComposeOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    for (const editorRef of [inlineComposeEditorRef, dialogComposeEditorRef]) {
      if (editorRef.current && editorRef.current.innerHTML !== composeForm.body) {
        editorRef.current.innerHTML = composeForm.body;
      }
    }
  }, [composeForm.body, isComposeOpen, isReplying]);

  // Fetch mail accounts
  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: async () => {
      const response = await api.get<{ accounts: MailAccount[] }>('/mail/accounts');
      if (response.error) throw new Error(response.error);
      return response.data?.accounts || [];
    },
  });

  const { data: contactsForCompose = [] } = useQuery({
    queryKey: ['contacts', 'mail-autocomplete'],
    queryFn: async () => {
      const response = await api.get<{ contacts: MailContact[] }>('/contacts?limit=2000');
      if (response.error) throw new Error(response.error);
      return response.data?.contacts || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: mailFolders = [] } = useQuery({
    queryKey: ['mail-folders'],
    queryFn: async () => {
      const response = await api.get<{ folders: MailFolder[] }>('/mail/folders');
      if (response.error) throw new Error(response.error);
      return response.data?.folders || [];
    },
  });

  const folders = React.useMemo(() => {
    const systemBySlug = new Map(systemFolders.map(folder => [folder.id, folder]));
    if (mailFolders.length === 0) return systemFolders;
    return mailFolders.map((folder) => {
      const systemFolder = systemBySlug.get(folder.slug);
      return {
        id: folder.slug,
        label: folder.display_name,
        icon: systemFolder?.icon || FolderOpen,
        isSystem: folder.is_system,
      };
    });
  }, [mailFolders]);

  const folderFilters = React.useMemo(
    () => [{ id: ALL_MAIL, label: 'All mail', icon: Mail }, ...folders],
    [folders]
  );

  const movableFolderIds = React.useMemo(
    () => folders.map(folder => folder.id).filter(folderId => folderId !== 'starred'),
    [folders]
  );

  const { data: unreadCountsData } = useQuery({
    queryKey: ['mail-unread-counts', selectedAccount],
    queryFn: async () => {
      if (!selectedAccount) return { unreadByFolder: {} } as MailUnreadCountsResponse;

      const params = new URLSearchParams();
      if (selectedAccount !== ALL_ACCOUNTS) {
        params.set('account_id', selectedAccount);
      }
      params.set('include_by_account', 'true');

      const query = params.toString();
      const response = await api.get<MailUnreadCountsResponse>(
        `/mail/unread-counts${query ? `?${query}` : ''}`
      );
      if (response.error) throw new Error(response.error);
      return response.data || { unreadByFolder: {} };
    },
    enabled: !!selectedAccount,
  });

  const unreadByFolder = unreadCountsData?.unreadByFolder || {};

  // Auto-select first account or remember last selected
  useEffect(() => {
    if (accounts.length > 0 && !selectedAccount) {
      // Try to restore last selected account from localStorage
      const lastAccountId = localStorage.getItem('mail_last_selected_account');
      const lastAccount = accounts.find(a => a.id === lastAccountId);
      
      if (lastAccountId === ALL_ACCOUNTS) {
        setSelectedAccount(ALL_ACCOUNTS);
      } else if (lastAccount) {
        setSelectedAccount(lastAccount.id);
      } else {
        // Default to all accounts
        setSelectedAccount(ALL_ACCOUNTS);
      }
    }
  }, [accounts, selectedAccount]);

  // Remember selected account
  useEffect(() => {
    if (selectedAccount) {
      localStorage.setItem('mail_last_selected_account', selectedAccount);
    }
  }, [selectedAccount]);

  // Clear selection and reset page when folder or account changes
  useEffect(() => {
    setSelectedEmails(new Set());
    setEmailPage(1);
    setShowUnreadOnly(false); // Reset unread filter when changing folder/account
  }, [selectedFolder, selectedAccount]);

  // Reset to page 1 when search query or unread filter changes
  useEffect(() => {
    setEmailPage(1);
  }, [searchQuery, showUnreadOnly]);

  // Fetch email count for smart refresh (only refetch emails when count changes)
  const emailsPerPage = 50;
  const previousEmailCount = React.useRef<number | null>(null);
  
  const { data: emailCountData } = useQuery({
    queryKey: ['email-count', selectedAccount, selectedFolder],
    queryFn: async () => {
      if (!selectedAccount) return { total: 0 };

      const folder = selectedFolder === 'starred' ? 'inbox' : selectedFolder;
      const params = new URLSearchParams({
        limit: '1',
        offset: '0',
      });

      if (selectedAccount !== ALL_ACCOUNTS) {
        params.set('account_id', selectedAccount);
      }
      if (folder !== ALL_MAIL) {
        params.set('folder', folder);
      }
      if (selectedFolder === 'starred') {
        params.set('is_starred', 'true');
      }

      const response = await api.get<{ emails: Email[]; pagination?: { total: number } }>(
        `/mail/emails?${params.toString()}`
      );
      if (response.error) return { total: 0 };
      return { total: response.data?.pagination?.total || 0 };
    },
    enabled: !!selectedAccount,
    refetchInterval: 5000, // Check count every 5 seconds
    staleTime: 0,
  });

  // Track when count changes and invalidate emails query
  React.useEffect(() => {
    const currentCount = emailCountData?.total || 0;
    if (previousEmailCount.current !== null && currentCount !== previousEmailCount.current && currentCount > previousEmailCount.current) {
      console.log(`[MailPage] Email count changed: ${previousEmailCount.current} -> ${currentCount}, invalidating emails query`);
      queryClient.invalidateQueries({ queryKey: ['emails', selectedAccount, selectedFolder] });
    }
    previousEmailCount.current = currentCount;
  }, [emailCountData?.total, selectedAccount, selectedFolder, queryClient]);
  
  // Reset count when account or folder changes
  React.useEffect(() => {
    previousEmailCount.current = null;
  }, [selectedAccount, selectedFolder]);

  // Fetch paginated emails with server-side filters
  const { data: emailsData, isLoading: emailsLoading } = useQuery({
    queryKey: ['emails', selectedAccount, selectedFolder, emailPage, searchQuery, showUnreadOnly],
    queryFn: async () => {
      if (!selectedAccount) return { emails: [], pagination: null };
      
      const folder = selectedFolder === 'starred' ? 'inbox' : selectedFolder;
      const offset = (emailPage - 1) * emailsPerPage;
      const params = new URLSearchParams({
        limit: String(emailsPerPage),
        offset: String(offset),
      });

      if (selectedAccount !== ALL_ACCOUNTS) {
        params.set('account_id', selectedAccount);
      }
      if (folder !== ALL_MAIL) {
        params.set('folder', folder);
      }

      if (showUnreadOnly) {
        params.set('is_read', 'false');
      }

      if (selectedFolder === 'starred') {
        params.set('is_starred', 'true');
      }

      const trimmedSearch = searchQuery.trim();
      if (trimmedSearch) {
        params.set('search', trimmedSearch);
      }
      
      const response = await api.get<{ emails: Email[]; pagination?: { total: number; limit: number; offset: number; page: number; totalPages: number } }>(
        `/mail/emails?${params.toString()}`
      );
      if (response.error) throw new Error(response.error);

      return {
        emails: response.data?.emails || [],
        pagination: response.data?.pagination || null,
      };
    },
    enabled: !!selectedAccount,
    staleTime: 60000, // Consider data fresh for 60 seconds (will be invalidated when count changes)
  });

  const emails = React.useMemo(() => emailsData?.emails ?? [], [emailsData?.emails]);
  const pagination = emailsData?.pagination;
  const totalMatchingEmails = pagination?.total ?? emails.length;
  const totalPages = pagination?.totalPages ?? 1;

  const contactEmailSuggestions = React.useMemo<ContactEmailSuggestion[]>(() => {
    return contactsForCompose.flatMap((contact) => {
      const name = getContactDisplayName(contact);
      return [contact.email, contact.email2, contact.email3]
        .filter((email): email is string => Boolean(email?.trim()))
        .map((email, index) => ({
          key: `${contact.id}-${index}-${email}`,
          name,
          email,
        }));
    });
  }, [contactsForCompose]);

  const createHostTrustError = (message: string, mailHostTrust?: unknown) => {
    const error = new Error(message) as MailHostTrustError;
    error.requiresHostTrustConfirmation = true;
    error.mailHostTrust = mailHostTrust as MailHostTrustResult | undefined;
    return error;
  };

  const isHostTrustError = (error: Error): error is MailHostTrustError => (
    Boolean((error as MailHostTrustError).requiresHostTrustConfirmation && (error as MailHostTrustError).mailHostTrust)
  );
  
  // Debug logging
  React.useEffect(() => {
    if (selectedAccount && !emailsLoading) {
      console.log(`[MailPage] Emails loaded: ${emails.length} emails for account ${selectedAccount}, folder ${selectedFolder}`);
      console.log(`[MailPage] Pagination:`, pagination);
    }
  }, [emails.length, selectedAccount, selectedFolder, emailsLoading, pagination]);

  // Add mail account mutation (backend verifies host safety, certificate trust, then IMAP auth)
  const addAccount = useMutation({
    mutationFn: async (account: AccountFormState & { accept_host_trust?: boolean }) => {
      const response = await api.post<AddMailAccountResponse>('/mail/accounts', {
        ...account,
        encrypted_password: account.password, // Will be encrypted on server
      });
      if (response.status === 409 && response.requiresHostTrustConfirmation) {
        throw createHostTrustError(response.error || 'Review mail server authenticity before continuing.', response.mailHostTrust);
      }
      if (response.error) throw new Error(response.error);
      return response.data ?? {};
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts-count'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      
      // Show success immediately with green checkmark
      const syncMsg = data?.syncInProgress 
        ? data.message || 'Syncing emails in the background. First sync will take a long time.'
        : 'Account connected successfully';
      
      toast({ 
        title: '✓ Account connected successfully',
        description: syncMsg,
        duration: 10000,
      });
      
      setIsAddAccountOpen(false);
      setAccountForm({
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
      });
    },
    onError: (error: Error, variables) => {
      if (isHostTrustError(error)) {
        setPendingHostTrust({ mode: 'add', account: variables, trust: error.mailHostTrust! });
        return;
      }
      toast({ 
        title: 'Failed to add mail account', 
        description: error.message,
        variant: 'destructive',
        duration: 8000,
      });
    },
  });

  // Update account mutation
  const updateAccount = useMutation({
    mutationFn: async ({ id, ...data }: { id: string } & Partial<AccountFormState> & { accept_host_trust?: boolean }) => {
      const response = await api.put(`/mail/accounts/${id}`, {
        ...data,
        encrypted_password: data.password || undefined,
      });
      if (response.status === 409 && response.requiresHostTrustConfirmation) {
        throw createHostTrustError(response.error || 'Review mail server authenticity before continuing.', response.mailHostTrust);
      }
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      toast({ title: '✓ Account updated successfully' });
      setEditingAccount(null);
      setIsAddAccountOpen(false);
      setAccountForm({
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
      });
    },
    onError: (error: Error, variables) => {
      if (isHostTrustError(error)) {
        setPendingHostTrust({ mode: 'edit', accountId: variables.id, account: { ...accountForm, ...variables }, trust: error.mailHostTrust! });
        return;
      }
      toast({ 
        title: 'Failed to update account', 
        description: error.message,
        variant: 'destructive' 
      });
    },
  });

  // Delete account mutation
  const deleteAccount = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.delete(`/mail/accounts/${id}`);
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts-count'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      setSelectedAccount(null);
      setAccountToDelete(null);
      toast({ title: 'Mail account and all associated emails deleted' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete account', description: error.message, variant: 'destructive' });
    },
  });

  // Toggle star mutation
  const toggleStar = useMutation({
    mutationFn: async ({ id, is_starred }: { id: string; is_starred: boolean }) => {
      const response = await api.put(`/mail/emails/${id}/star`, { is_starred });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: (_, variables) => {
      // Update local selectedEmail state immediately
      if (selectedEmail && selectedEmail.id === variables.id) {
        setSelectedEmail({ ...selectedEmail, is_starred: variables.is_starred });
      }
      queryClient.invalidateQueries({ queryKey: ['emails'] });
    },
  });

  // Mark as read mutation
  const markAsRead = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.put(`/mail/emails/${id}/read`, { is_read: true });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['mail-unread-counts'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
    },
  });

  const loadEmailForReader = React.useCallback(async (emailId: string, fallbackEmail?: Email) => {
    if (fallbackEmail && !fallbackEmail.is_read) {
      markAsRead.mutate(fallbackEmail.id);
    }

    try {
      const response = await api.get<{ email: Email }>(`/mail/emails/${emailId}`);
      if (response.error) {
        toast({ title: 'Failed to load email', description: response.error, variant: 'destructive' });
        return;
      }

      if (response.data?.email) {
        const fetchedEmail = response.data.email;
        if (!fetchedEmail.is_read) {
          markAsRead.mutate(fetchedEmail.id);
          setSelectedEmail({ ...fetchedEmail, is_read: true });
        } else {
          setSelectedEmail(fetchedEmail);
        }
        return;
      }

      if (fallbackEmail) {
        setSelectedEmail(fallbackEmail.is_read ? fallbackEmail : { ...fallbackEmail, is_read: true });
      }
    } catch (error) {
      console.error('Error loading email:', error);
      if (fallbackEmail) {
        setSelectedEmail(fallbackEmail.is_read ? fallbackEmail : { ...fallbackEmail, is_read: true });
      } else {
        toast({ title: 'Failed to load email', variant: 'destructive' });
      }
    }
  }, [markAsRead, toast]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const emailId = params.get('email');
    if (!emailId) return;

    void loadEmailForReader(emailId);
    params.delete('email');
    const nextQuery = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`);
  }, [loadEmailForReader]);

  const createContactFromEmail = useMutation({
    mutationFn: async (email: Email) => {
      const derivedName = deriveContactNameFromEmail(email);
      const response = await api.post('/contacts', {
        ...derivedName,
        email: email.from_address,
      });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast({ title: 'Contact added' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to add contact', description: error.message, variant: 'destructive' });
    },
  });

  // Bulk operations mutations
  const bulkDelete = useMutation({
    mutationFn: async (emailIds: string[]) => {
      const response = await api.post('/mail/emails/bulk-delete', { email_ids: emailIds });
      if (response.error) throw new Error(response.error);
      return emailIds.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['mail-unread-counts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      setSelectedEmails(new Set());
      toast({ title: `✓ Moved ${count} email(s) to trash` });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete emails', description: error.message, variant: 'destructive' });
    },
  });

  const bulkMove = useMutation({
    mutationFn: async ({ emailIds, folder }: { emailIds: string[]; folder: string }) => {
      const response = await api.post('/mail/emails/bulk-move', { email_ids: emailIds, folder });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['mail-unread-counts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      setSelectedEmails(new Set());
      toast({ title: `✓ Moved ${variables.emailIds.length} email(s) to ${variables.folder}` });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to move emails', description: error.message, variant: 'destructive' });
    },
  });

  const bulkMarkRead = useMutation({
    mutationFn: async ({ emailIds, is_read }: { emailIds: string[]; is_read: boolean }) => {
      const response = await api.post('/mail/emails/bulk-update', { email_ids: emailIds, is_read });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['mail-unread-counts'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      setSelectedEmails(new Set());
      toast({ 
        title: `✓ Marked ${variables.emailIds.length} email(s) as ${variables.is_read ? 'read' : 'unread'}`,
        duration: 3000,
      });
    },
    onError: (error: Error) => {
      toast({ 
        title: 'Failed to mark emails as read', 
        description: error.message, 
        variant: 'destructive' 
      });
    },
  });

  const bulkStar = useMutation({
    mutationFn: async ({ emailIds, is_starred }: { emailIds: string[]; is_starred: boolean }) => {
      const response = await api.post('/mail/emails/bulk-update', { email_ids: emailIds, is_starred });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      setSelectedEmails(new Set());
    },
  });

  const createFolder = useMutation({
    mutationFn: async (displayName: string) => {
      const response = await api.post<{ folder: MailFolder }>('/mail/folders', { display_name: displayName });
      if (response.error) throw new Error(response.error);
      return response.data?.folder;
    },
    onSuccess: (folder) => {
      queryClient.invalidateQueries({ queryKey: ['mail-folders'] });
      queryClient.invalidateQueries({ queryKey: ['mail-unread-counts'] });
      if (folder?.slug) setSelectedFolder(folder.slug);
      setNewFolderName('');
      toast({ title: 'Folder created' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to create folder', description: error.message, variant: 'destructive' });
    },
  });

  const updateFolder = useMutation({
    mutationFn: async ({ slug, displayName }: { slug: string; displayName: string }) => {
      const response = await api.put(`/mail/folders/${encodeURIComponent(slug)}`, { display_name: displayName });
      if (response.error) throw new Error(response.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mail-folders'] });
      setEditingFolderSlug(null);
      setEditingFolderName('');
      toast({ title: 'Folder updated' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to update folder', description: error.message, variant: 'destructive' });
    },
  });

  const deleteFolder = useMutation({
    mutationFn: async (slug: string) => {
      const response = await api.delete(`/mail/folders/${encodeURIComponent(slug)}`);
      if (response.error) throw new Error(response.error);
      return slug;
    },
    onSuccess: (slug) => {
      queryClient.invalidateQueries({ queryKey: ['mail-folders'] });
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['mail-unread-counts'] });
      if (selectedFolder === slug) setSelectedFolder('inbox');
      toast({ title: 'Folder deleted', description: 'Messages and rules were moved back to Inbox.' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete folder', description: error.message, variant: 'destructive' });
    },
  });

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts if user is typing in an input/textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      // Delete selected emails
      if (e.key === 'Delete' && selectedEmails.size > 0) {
        e.preventDefault();
        bulkDelete.mutate(Array.from(selectedEmails));
      }

      // Select all (Ctrl+A or Cmd+A)
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        if (emails.length > 0) {
          setSelectedEmails(new Set(emails.map(e => e.id)));
        }
      }

      // Escape to deselect all
      if (e.key === 'Escape') {
        setSelectedEmails(new Set());
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedEmails, emails, bulkDelete]);

  // Handle email selection
  const handleEmailSelect = (emailId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSelected = new Set(selectedEmails);
    if (newSelected.has(emailId)) {
      // Already selected: deselect it
      newSelected.delete(emailId);
    } else {
      if (e.shiftKey && selectedEmails.size > 0) {
        // Shift+Click: select range
        const emailIds = emails.map(e => e.id);
        const startIdx = emailIds.findIndex(id => selectedEmails.has(id));
        const endIdx = emailIds.findIndex(id => id === emailId);
        if (startIdx !== -1 && endIdx !== -1) {
          const start = Math.min(startIdx, endIdx);
          const end = Math.max(startIdx, endIdx);
          for (let i = start; i <= end; i++) {
            newSelected.add(emailIds[i]);
          }
        } else {
          newSelected.add(emailId);
        }
      } else {
        // Regular click or Ctrl+Click: toggle selection (add to existing selection)
        newSelected.add(emailId);
      }
    }
    setSelectedEmails(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedEmails.size === emails.length) {
      setSelectedEmails(new Set());
    } else {
      setSelectedEmails(new Set(emails.map(e => e.id)));
    }
  };
  
  // Sync mail mutation
  const syncMail = useMutation({
    mutationFn: async (account_id: string) => {
      const response = await api.post<MailSyncResponse>('/mail/sync', { account_id });
      if (response.error) {
        throw new Error(response.error);
      }
      return response.data ?? {};
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      
      const msg = data.message || `${data.newEmails || 0} new emails`;
      toast({ 
        title: '✓ Sync complete', 
        description: msg
      });
    },
    onError: (error: Error) => {
      toast({ 
        title: 'Sync failed', 
        description: error.message,
        variant: 'destructive',
        duration: 8000,
      });
    },
  });
  
  // Send email mutation
  const sendEmailMutation = useMutation({
    mutationFn: async (data: {
      account_id: string;
      to: string;
      subject: string;
      body: string;
      isHtml?: boolean;
      attachments?: Array<{
        filename: string;
        contentType: string;
        size: number;
        dataBase64: string;
      }>;
    }) => {
      const response = await api.post('/mail/send', data);
      if (response.error) {
        throw new Error(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      toast({ title: '✓ Email sent successfully' });
      setIsComposeOpen(false);
      setIsReplying(false);
      resetComposeState();
    },
    onError: (error: Error) => {
      toast({ 
        title: 'Failed to send email', 
        description: error.message,
        variant: 'destructive',
        duration: 8000,
      });
    },
  });

  const handleProviderChange = (provider: string) => {
    const providerConfig = mailProviders.find(p => p.value === provider);
    setAccountForm({
      ...accountForm,
      provider,
      imap_host: providerConfig?.imapHost || '',
      smtp_host: providerConfig?.smtpHost || '',
      imap_port: providerConfig?.imapPort || 993,
      smtp_port: providerConfig?.smtpPort || 587,
    });
  };

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingAccount) {
      updateAccount.mutate({ id: editingAccount.id, ...accountForm });
    } else {
      addAccount.mutate(accountForm);
    }
  };

  const handleConfirmHostTrust = () => {
    if (!pendingHostTrust) return;
    if (pendingHostTrust.mode === 'edit' && pendingHostTrust.accountId) {
      updateAccount.mutate({
        id: pendingHostTrust.accountId,
        ...pendingHostTrust.account,
        accept_host_trust: true,
      });
    } else {
      addAccount.mutate({
        ...pendingHostTrust.account,
        accept_host_trust: true,
      });
    }
    setPendingHostTrust(null);
  };

  const formatCertificateName = (value?: Record<string, string> | null) => {
    if (!value) return 'Unknown';
    return value.CN || Object.entries(value).map(([key, item]) => `${key}=${item}`).join(', ') || 'Unknown';
  };

  const renderTrustSection = (label: 'IMAP' | 'SMTP', assessment?: MailHostAssessment, certificate?: MailHostCertificate) => (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">{label} server</p>
        <span className={certificate?.authorized ? 'text-success text-xs' : 'text-warning text-xs'}>
          {certificate?.authorized ? 'Verified certificate' : 'Needs review'}
        </span>
      </div>
      <p className="text-sm text-muted-foreground break-all">
        {assessment?.host || 'Unknown host'}:{assessment?.port || 'unknown'}
      </p>
      <p className="text-xs text-muted-foreground">
        Provider: {assessment?.knownProvider ? 'known provider' : assessment?.allowlisted ? 'hoster allowlisted' : 'unknown/custom'}
      </p>
      {assessment?.resolvedAddresses && assessment.resolvedAddresses.length > 0 && (
        <p className="text-xs text-muted-foreground break-all">
          IPs: {assessment.resolvedAddresses.join(', ')}
        </p>
      )}
      <div className="text-xs text-muted-foreground space-y-1">
        <p>Certificate owner: {formatCertificateName(certificate?.subject)}</p>
        <p>Certificate issuer: {formatCertificateName(certificate?.issuer)}</p>
        {certificate?.valid_to && <p>Valid until: {certificate.valid_to}</p>}
        {certificate?.fingerprint256 && <p className="break-all">SHA-256 fingerprint: {certificate.fingerprint256}</p>}
        {(certificate?.authorizationError || certificate?.error) && (
          <p className="text-warning">Verification message: {certificate.authorizationError || certificate.error}</p>
        )}
      </div>
    </div>
  );
  
  const handleEditAccount = (account: MailAccount) => {
    setEditingAccount(account);
    setAccountForm({
      email_address: account.email_address,
      display_name: account.display_name || '',
      provider: account.provider,
      username: account.username || account.email_address,
      password: '',
      imap_host: account.imap_host || '',
      smtp_host: account.smtp_host || '',
      imap_port: account.imap_port || 993,
      smtp_port: account.smtp_port || 587,
      sync_fetch_limit: account.sync_fetch_limit || 'all',
    });
    setIsAddAccountOpen(true);
  };
  
  const addComposeFiles = (files: FileList | File[]) => {
    const incomingFiles = Array.from(files || []);
    if (incomingFiles.length === 0) return;

    setComposeAttachments(prev => {
      const existingKeys = new Set(prev.map(a => `${a.file.name}:${a.file.size}:${a.file.lastModified}`));
      const next = [...prev];

      for (const file of incomingFiles) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (existingKeys.has(key)) continue;
        next.push({ id: crypto.randomUUID(), file });
        existingKeys.add(key);
      }

      return next;
    });
  };

  const removeComposeAttachment = (attachmentId: string) => {
    setComposeAttachments(prev => prev.filter(att => att.id !== attachmentId));
  };

  const resetComposeState = () => {
    setComposeMode('new');
    setComposeForm({ to: '', subject: '', body: '' });
    setFocusedRecipientInput(null);
    setComposeAttachments([]);
    setIsAttachmentDragOver(false);
    setIsReplying(false);
  };

  const replaceActiveRecipient = (suggestion: ContactEmailSuggestion) => {
    setComposeForm(prev => {
      const parts = prev.to.split(',');
      parts[parts.length - 1] = ` ${formatRecipient(suggestion)}`;
      const nextValue = parts
        .map((part, index) => (index === 0 ? part.trimStart() : part.trim()))
        .filter(Boolean)
        .join(', ');
      return { ...prev, to: `${nextValue}, ` };
    });
  };

  const renderRecipientInput = (inputId: string) => {
    const searchTerm = getActiveRecipientSearchTerm(composeForm.to);
    const suggestions = contactEmailSuggestions
      .filter((suggestion) => {
        const haystack = `${suggestion.name} ${suggestion.email}`.toLowerCase();
        return !searchTerm || haystack.includes(searchTerm);
      })
      .slice(0, 8);
    const showSuggestions = focusedRecipientInput === inputId && suggestions.length > 0;

    return (
      <div className="relative">
        <Input
          id={inputId}
          type="text"
          placeholder="recipient@example.com"
          value={composeForm.to}
          onChange={(e) => setComposeForm({ ...composeForm, to: e.target.value })}
          onFocus={() => setFocusedRecipientInput(inputId)}
          onBlur={() => window.setTimeout(() => setFocusedRecipientInput((current) => current === inputId ? null : current), 100)}
          autoComplete="off"
          required
        />
        {showSuggestions && (
          <div className="absolute left-0 right-0 top-full z-[80] mt-1 max-h-64 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.key}
                type="button"
                className="flex w-full flex-col rounded-sm px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onMouseDown={(event) => {
                  event.preventDefault();
                  replaceActiveRecipient(suggestion);
                  setFocusedRecipientInput(inputId);
                }}
              >
                <span className="font-medium truncate">{suggestion.name || suggestion.email}</span>
                {suggestion.name && (
                  <span className="text-xs text-muted-foreground truncate">{suggestion.email}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const fileToBase64 = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error('Failed to read attachment'));
          return;
        }
        const base64 = reader.result.split(',')[1] || '';
        resolve(base64);
      };
      reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
      reader.readAsDataURL(file);
    });

  const handleComposeAttachmentInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addComposeFiles(e.target.files);
    }
    // Allow re-selecting the same file later
    e.target.value = '';
  };

  const formatAttachmentSize = (bytes: number) => {
    if (!bytes || bytes < 1024) return `${bytes || 0} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const updateComposeBodyFromEditor = (editorRef: React.RefObject<HTMLDivElement>) => {
    setComposeForm(prev => ({ ...prev, body: editorRef.current?.innerHTML || '' }));
  };

  const applyComposeCommand = (editorRef: React.RefObject<HTMLDivElement>, command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    updateComposeBodyFromEditor(editorRef);
  };

  const renderRichComposeEditor = (
    editorId: string,
    editorRef: React.RefObject<HTMLDivElement>,
    editorClassName = ''
  ) => (
    <div className={`rounded-md border border-input bg-background overflow-hidden ${editorClassName.includes('flex-1') ? 'flex flex-col min-h-0' : ''}`}>
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => applyComposeCommand(editorRef, 'bold')}>
          <Bold className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => applyComposeCommand(editorRef, 'italic')}>
          <Italic className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => applyComposeCommand(editorRef, 'underline')}>
          <Underline className="h-4 w-4" />
        </Button>
        <div className="h-5 w-px bg-border mx-1" />
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Bullet list" onMouseDown={(e) => e.preventDefault()} onClick={() => applyComposeCommand(editorRef, 'insertUnorderedList')}>
          <List className="h-4 w-4" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Numbered list" onMouseDown={(e) => e.preventDefault()} onClick={() => applyComposeCommand(editorRef, 'insertOrderedList')}>
          <ListOrdered className="h-4 w-4" />
        </Button>
        <div className="h-5 w-px bg-border mx-1" />
        <label className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" title="Text color">
          <Palette className="h-4 w-4" />
          <input
            type="color"
            className="sr-only"
            onChange={(event) => applyComposeCommand(editorRef, 'foreColor', event.target.value)}
          />
        </label>
        <select
          aria-label="Text size"
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          defaultValue=""
          onChange={(event) => {
            if (event.target.value) applyComposeCommand(editorRef, 'fontSize', event.target.value);
            event.target.value = '';
          }}
        >
          <option value="" disabled>Size</option>
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="6">Huge</option>
        </select>
        <div className="h-5 w-px bg-border mx-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Insert link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = window.prompt('Link URL');
            if (url?.trim()) applyComposeCommand(editorRef, 'createLink', url.trim());
          }}
        >
          <LinkIcon className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Insert image URL"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = window.prompt('Image URL');
            if (url?.trim()) applyComposeCommand(editorRef, 'insertImage', url.trim());
          }}
        >
          <ImageIcon className="h-4 w-4" />
        </Button>
      </div>
      <div
        id={editorId}
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Write your message..."
        className={`p-3 text-sm outline-none [&:empty:before]:content-[attr(data-placeholder)] [&:empty:before]:text-muted-foreground [&_a]:text-accent [&_a]:underline [&_img]:max-w-full [&_img]:rounded-md [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 ${editorClassName}`}
        onInput={() => updateComposeBodyFromEditor(editorRef)}
        onBlur={() => updateComposeBodyFromEditor(editorRef)}
      />
    </div>
  );

  const renderComposeAttachmentsSection = (inputId: string) => (
    <div className="space-y-2">
      <Label>Attachments</Label>
      <input
        id={inputId}
        type="file"
        multiple
        className="hidden"
        onChange={handleComposeAttachmentInput}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsAttachmentDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsAttachmentDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsAttachmentDragOver(false);
          if (e.dataTransfer?.files?.length) {
            addComposeFiles(e.dataTransfer.files);
          }
        }}
        className={`rounded-lg border border-dashed p-3 transition-colors ${
          isAttachmentDragOver ? 'border-accent bg-accent/5' : 'border-border'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Drag and drop files here, or</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              const input = document.getElementById(inputId) as HTMLInputElement | null;
              input?.click();
            }}
          >
            <Paperclip className="h-4 w-4 mr-2" />
            Add attachments
          </Button>
        </div>
      </div>

      {composeAttachments.length > 0 && (
        <div className="space-y-2">
          {composeAttachments.map(({ id, file }) => (
            <div key={id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatAttachmentSize(file.size)}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => removeComposeAttachment(id)}
                title="Remove attachment"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccount || selectedAccount === ALL_ACCOUNTS) {
      toast({ title: 'Please select an account', variant: 'destructive' });
      return;
    }
    if (isComposeHtmlEmpty(composeForm.body) && composeAttachments.length === 0) {
      toast({ title: 'Please enter a message or add an attachment', variant: 'destructive' });
      return;
    }

    try {
      const attachmentPayload = await Promise.all(
        composeAttachments.map(async ({ file }) => ({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          size: file.size,
          dataBase64: await fileToBase64(file),
        }))
      );

      sendEmailMutation.mutate({
        account_id: selectedAccount,
        ...composeForm,
        body: composeForm.body || '<p></p>',
        isHtml: true,
        attachments: attachmentPayload,
      });
    } catch (error) {
      toast({
        title: 'Attachment error',
        description: error instanceof Error ? error.message : 'Failed to prepare attachments',
        variant: 'destructive',
      });
    }
  };

  const selectedAccountData = accounts.find(a => a.id === selectedAccount);
  const selectedFolderData = folders.find((folder) => folder.id === selectedFolder);
  const folderLabel = selectedFolder === ALL_MAIL ? 'All mail' : selectedFolderData?.label || selectedFolder;
  const accountLabel = selectedAccount === ALL_ACCOUNTS
    ? 'All accounts'
    : selectedAccountData?.display_name || selectedAccountData?.email_address || 'No account selected';
  const senderAlreadyInContacts = selectedEmail
    ? contactEmailSuggestions.some((suggestion) => suggestion.email.toLowerCase() === selectedEmail.from_address.toLowerCase())
    : false;

  return (
    <div className="flex h-[calc(100vh-0px)] overflow-hidden relative">
      {/* Mobile Sidebar Overlay */}
      {isMobile && mobileSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      
      {/* Sidebar */}
      <div className={
        isMobile
          ? `fixed left-0 top-0 h-full w-56 z-50 transform transition-transform duration-200 border-r border-border bg-card flex flex-col ${
              mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`
          : `${sidebarCollapsed ? 'w-16' : 'w-64'} border-r border-border bg-card flex flex-col transition-all duration-200`
      }>
        {/* Compose Button */}
        <div className={`p-4 flex items-center gap-2 ${(sidebarCollapsed && !isMobile) ? 'flex-col' : ''}`}>
          {isMobile ? (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => setMobileSidebarOpen(false)}
              title="Close sidebar"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </Button>
          )}
          <Button 
            className="w-full" 
            onClick={() => setIsComposeOpen(true)}
            title={sidebarCollapsed && !isMobile ? 'Compose' : undefined}
          >
            <PenSquare className={`h-4 w-4 ${(sidebarCollapsed && !isMobile) ? '' : 'mr-2'}`} />
            {(!sidebarCollapsed || isMobile) && 'Compose'}
          </Button>
        </div>

        {/* Folders */}
        <div className={`px-4 pb-2 flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'justify-between'}`}>
          {(!sidebarCollapsed || isMobile) && (
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Folders
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={`h-6 w-6 ${(sidebarCollapsed && !isMobile) ? 'mx-auto' : ''}`}
            onClick={() => setFolderDialogOpen(true)}
            title="Manage folders"
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
        </div>
        <nav className="px-2 space-y-1">
          {folderFilters.map((folder) => (
            <button
              key={folder.id}
              onClick={() => {
                setSelectedFolder(folder.id);
                if (isMobile) setMobileSidebarOpen(false);
              }}
              className={`relative w-full flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg text-sm transition-colors ${
                selectedFolder === folder.id
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
              title={(sidebarCollapsed && !isMobile) ? folder.label : undefined}
            >
              <folder.icon className="h-4 w-4 shrink-0" />
              {(!sidebarCollapsed || isMobile) && (
                <>
                  <span className="flex-1 text-left">{folder.label}</span>
                  {folder.id !== ALL_MAIL && (unreadByFolder[folder.id] || 0) > 0 && (
                    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-accent/10 px-1.5 py-0.5 text-xs font-semibold text-accent">
                      {unreadByFolder[folder.id]}
                    </span>
                  )}
                </>
              )}
              {(sidebarCollapsed && !isMobile) && folder.id !== ALL_MAIL && (unreadByFolder[folder.id] || 0) > 0 && (
                <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" />
              )}
            </button>
          ))}
        </nav>

        {/* Accounts */}
        <div className="flex-1 overflow-auto mt-6">
          <div className={`px-4 pb-2 flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'justify-between'}`}>
            {(!sidebarCollapsed || isMobile) && (
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Accounts
              </span>
            )}
            <Dialog open={isAddAccountOpen} onOpenChange={(open) => {
              setIsAddAccountOpen(open);
              if (!open) {
                setEditingAccount(null);
                setAccountForm({
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
                });
                setPendingHostTrust(null);
              }
            }}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className={`h-6 w-6 ${(sidebarCollapsed && !isMobile) ? 'mx-auto' : ''}`} title={(sidebarCollapsed && !isMobile) ? 'Add Account' : undefined}>
                  <Plus className="h-4 w-4" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{editingAccount ? 'Edit Mail Account' : 'Add Mail Account'}</DialogTitle>
                  <DialogDescription>
                    Connect an email account to view and manage your mail.
                  </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleAddAccount} className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="provider">Email Provider</Label>
                    <Select 
                      value={accountForm.provider} 
                      onValueChange={handleProviderChange}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {mailProviders.map((provider) => (
                          <SelectItem key={provider.value} value={provider.value}>
                            {provider.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email_address">Email Address</Label>
                    <Input
                      id="email_address"
                      type="email"
                      value={accountForm.email_address}
                      onChange={(e) => setAccountForm({ ...accountForm, email_address: e.target.value })}
                      placeholder="you@example.com"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="display_name">Display Name</Label>
                    <Input
                      id="display_name"
                      value={accountForm.display_name}
                      onChange={(e) => setAccountForm({ ...accountForm, display_name: e.target.value })}
                      placeholder="John Doe"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input
                      id="username"
                      value={accountForm.username}
                      onChange={(e) => setAccountForm({ ...accountForm, username: e.target.value })}
                      placeholder={accountForm.provider === 'gmail' ? 'Usually your email' : 'IMAP/SMTP username'}
                      required
                    />
                    {(accountForm.provider === 'gmail' || accountForm.provider === 'yahoo') && (
                      <p className="text-xs text-muted-foreground">
                        {accountForm.provider === 'gmail' ? 'Use an App Password (not your regular password). Generate one at myaccount.google.com/apppasswords' : 'You may need an App Password for Yahoo Mail'}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password {editingAccount && '(leave blank to keep current)'}</Label>
                    <Input
                      id="password"
                      type="password"
                      value={accountForm.password}
                      onChange={(e) => setAccountForm({ ...accountForm, password: e.target.value })}
                      placeholder="Password or App Password"
                      required={!editingAccount}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Server details are filled from the provider; you can change any value.
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="imap_host">IMAP Server</Label>
                    <Input
                      id="imap_host"
                      value={accountForm.imap_host}
                      onChange={(e) => setAccountForm({ ...accountForm, imap_host: e.target.value })}
                      placeholder="e.g. imap.gmail.com"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="imap_port">IMAP Port</Label>
                    <Input
                      id="imap_port"
                      type="number"
                      value={accountForm.imap_port}
                      onChange={(e) => setAccountForm({ ...accountForm, imap_port: parseInt(e.target.value) || 993 })}
                      placeholder="993"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="smtp_host">SMTP Server</Label>
                    <Input
                      id="smtp_host"
                      value={accountForm.smtp_host}
                      onChange={(e) => setAccountForm({ ...accountForm, smtp_host: e.target.value })}
                      placeholder="e.g. smtp.gmail.com"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="smtp_port">SMTP Port</Label>
                    <Input
                      id="smtp_port"
                      type="number"
                      value={accountForm.smtp_port}
                      onChange={(e) => setAccountForm({ ...accountForm, smtp_port: parseInt(e.target.value) || 587 })}
                      placeholder="587"
                    />
                  </div>
                  <div className="flex justify-end gap-3 pt-2">
                    <Button type="button" variant="outline" onClick={() => setIsAddAccountOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={addAccount.isPending || updateAccount.isPending}>
                      {(addAccount.isPending || updateAccount.isPending) && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                      {editingAccount ? 'Save Changes' : 'Add Account'}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
          
          <div className="px-2 space-y-1">
            {accountsLoading ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : accounts.length === 0 ? (
              <div className="px-3 py-4 text-center">
                <Mail className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
                <p className="text-sm text-muted-foreground">No accounts yet</p>
              </div>
            ) : (
              <>
                <div className={`relative group ${(sidebarCollapsed && !isMobile) ? 'flex justify-center' : ''}`}>
                  <button
                    onClick={() => {
                      setSelectedAccount(ALL_ACCOUNTS);
                      if (isMobile) setMobileSidebarOpen(false);
                    }}
                    className={`w-full flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg text-sm transition-colors ${
                      selectedAccount === ALL_ACCOUNTS
                        ? 'bg-mail/10 text-mail font-medium'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                    title={(sidebarCollapsed && !isMobile) ? 'All accounts' : undefined}
                  >
                    <div className="w-8 h-8 rounded-full bg-mail/10 flex items-center justify-center text-mail text-xs font-medium shrink-0">
                      A
                    </div>
                    {(!sidebarCollapsed || isMobile) && (
                      <div className="flex-1 min-w-0 text-left">
                        <p className="truncate">All accounts</p>
                        <p className="text-xs text-muted-foreground truncate">Combined mailbox</p>
                      </div>
                    )}
                  </button>
                </div>
                {accounts.map((account) => (
                  <div key={account.id} className={`relative group ${(sidebarCollapsed && !isMobile) ? 'flex justify-center' : ''}`}>
                    <button
                      onClick={() => {
                        setSelectedAccount(account.id);
                        if (isMobile) setMobileSidebarOpen(false);
                      }}
                      className={`w-full flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg text-sm transition-colors ${
                        selectedAccount === account.id
                          ? 'bg-mail/10 text-mail font-medium'
                          : 'text-muted-foreground hover:bg-muted'
                      }`}
                      title={(sidebarCollapsed && !isMobile) ? (account.display_name || account.email_address) : undefined}
                    >
                      <div className="w-8 h-8 rounded-full bg-mail/10 flex items-center justify-center text-mail text-xs font-medium shrink-0">
                        {account.unread_count && account.unread_count > 0 && (
                          <motion.span
                            className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-mail"
                            animate={{ opacity: [0.4, 1, 0.4], scale: [0.9, 1.2, 0.9] }}
                            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                          />
                        )}
                        {account.email_address[0].toUpperCase()}
                      </div>
                      {(!sidebarCollapsed || isMobile) && (
                        <div className="flex-1 min-w-0 text-left">
                          <p className="truncate">{account.display_name || account.email_address}</p>
                          <p className="text-xs text-muted-foreground truncate">{account.email_address}</p>
                        </div>
                      )}
                    </button>
                    {(!sidebarCollapsed || isMobile) && (
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleEditAccount(account);
                          }}
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAccountToDelete(account.id);
                          }}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="h-14 border-b border-border flex items-center justify-between px-4 gap-4">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {isMobile && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileSidebarOpen(true)}
                title="Open sidebar"
                className="shrink-0"
              >
                <Menu className="h-5 w-5" />
              </Button>
            )}
            {emails.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSelectAll}
                title={selectedEmails.size === emails.length ? 'Deselect all' : 'Select all'}
                className="shrink-0"
              >
                {selectedEmails.size === emails.length ? (
                  <CheckSquare className="h-4 w-4" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </Button>
            )}
            <h2 className="font-semibold shrink-0">{folderLabel}</h2>
            {!selectedEmails.size && selectedAccount && (
              <span className="text-sm text-muted-foreground shrink-0 hidden sm:inline">
                {accountLabel}
              </span>
            )}
            {selectedEmails.size > 0 && (
              <span className="text-sm text-muted-foreground shrink-0">
                ({selectedEmails.size} selected)
              </span>
            )}
            {selectedAccount && !selectedEmails.size && (
              <>
                <Button
                  variant={showUnreadOnly ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowUnreadOnly(!showUnreadOnly)}
                  className="shrink-0"
                  title={showUnreadOnly ? "Show all emails" : "Show only unread emails"}
                >
                  <Mail className="h-4 w-4 mr-2" />
                  {showUnreadOnly ? 'Unread Only' : 'All'}
                </Button>
                <div className="relative flex-1 max-w-md ml-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="text"
                    placeholder="Search emails..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 h-9"
                  />
                  {searchQuery && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                      onClick={() => setSearchQuery('')}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {selectedEmails.size > 0 && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => bulkMarkRead.mutate({ emailIds: Array.from(selectedEmails), is_read: true })}
                  disabled={bulkMarkRead.isPending}
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Mark Read
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => bulkStar.mutate({ emailIds: Array.from(selectedEmails), is_starred: true })}
                  disabled={bulkStar.isPending}
                >
                  <Star className="h-4 w-4 mr-2" />
                  Star
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={bulkMove.isPending}
                    >
                      <FolderOpen className="h-4 w-4 mr-2" />
                      Move
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {folders
                      .filter((folder) => movableFolderIds.includes(folder.id) && folder.id !== selectedFolder)
                      .map((folder) => (
                        <DropdownMenuItem
                          key={folder.id}
                          onClick={() => bulkMove.mutate({ emailIds: Array.from(selectedEmails), folder: folder.id })}
                        >
                          <folder.icon className="h-4 w-4 mr-2" />
                          Move to {folder.label}
                        </DropdownMenuItem>
                      ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => bulkDelete.mutate(Array.from(selectedEmails))}
                  disabled={bulkDelete.isPending}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </>
            )}
            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => selectedAccount && selectedAccount !== ALL_ACCOUNTS && syncMail.mutate(selectedAccount)}
              disabled={!selectedAccount || selectedAccount === ALL_ACCOUNTS || syncMail.isPending}
              title="Refresh emails"
            >
              <RefreshCw className={`h-4 w-4 ${syncMail.isPending ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* Email List */}
        <div className="flex-1 overflow-auto">
          {!selectedAccount ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <Mail className="h-16 w-16 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">No account selected</h3>
              <p className="text-muted-foreground mb-4 max-w-sm">
                Select an email account from the sidebar or add a new one to get started.
              </p>
              <Button onClick={() => setIsAddAccountOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Mail Account
              </Button>
            </div>
          ) : emailsLoading ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="h-8 w-8 animate-spin text-accent" />
            </div>
          ) : emails.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center p-8">
              <Inbox className="h-16 w-16 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">
                {searchQuery.trim() 
                  ? 'No search results' 
                  : showUnreadOnly 
                    ? 'No unread emails' 
                    : selectedFolder === ALL_MAIL
                      ? `No emails in ${accountLabel}`
                      : `No emails in ${folderLabel}`
                }
              </h3>
              <p className="text-muted-foreground">
                {searchQuery.trim()
                  ? `No emails found matching "${searchQuery}"${showUnreadOnly ? ' in unread emails' : ''}`
                  : showUnreadOnly
                    ? selectedFolder === ALL_MAIL
                      ? `No unread emails across ${accountLabel.toLowerCase()}.`
                      : `No unread emails in ${selectedFolder === 'inbox' ? 'your inbox' : `your ${folderLabel.toLowerCase()} folder`}.`
                    : selectedFolder === 'inbox'
                      ? selectedAccount === ALL_ACCOUNTS
                        ? 'All inboxes are empty. Select a specific account to sync.'
                        : 'Your inbox is empty. Sync your account to fetch emails.'
                      : selectedFolder === ALL_MAIL
                        ? `No emails available across ${accountLabel.toLowerCase()}.`
                        : `No emails in your ${folderLabel.toLowerCase()} folder.`
                }
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              <AnimatePresence mode="popLayout">
                {emails.map((email) => (
                  <motion.div
                    key={email.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className={`flex items-start gap-4 p-4 hover:bg-muted/50 cursor-pointer transition-colors ${
                      !email.is_read ? 'bg-accent/5' : ''
                    } ${selectedEmails.has(email.id) ? 'bg-accent/10 ring-2 ring-accent' : ''}`}
                    onClick={async (e) => {
                      // If clicking checkbox area, don't open email
                      if ((e.target as HTMLElement).closest('.email-checkbox')) {
                        return;
                      }
                      await loadEmailForReader(email.id, email);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenuEmail({ email, x: e.clientX, y: e.clientY });
                    }}
                  >
                    <div className="email-checkbox shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={(e) => handleEmailSelect(email.id, e)}
                      >
                        {selectedEmails.has(email.id) ? (
                          <CheckSquare className="h-4 w-4 text-accent" />
                        ) : (
                          <Square className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 h-8 w-8"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStar.mutate({ id: email.id, is_starred: !email.is_starred });
                      }}
                    >
                      <Star className={`h-4 w-4 ${email.is_starred ? 'fill-warning text-warning' : 'text-muted-foreground'}`} />
                    </Button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          {!email.is_read && (
                            <span className="h-2 w-2 rounded-full bg-accent shrink-0" />
                          )}
                          <span className={`font-medium truncate ${!email.is_read ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>
                            {email.from_name || email.from_address}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {format(new Date(email.received_at), 'MMM d, yyyy')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className={`truncate flex-1 ${!email.is_read ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                          {email.subject || '(No subject)'}
                        </p>
                        {email.has_attachments && (
                          <span title="Has attachments" className="shrink-0">
                            <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground truncate mt-0.5">
                        {email.body_text?.substring(0, 100) || '(No content)'}
                      </p>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
          
          {/* Search / filter results indicator */}
          {(searchQuery.trim() || showUnreadOnly) && emails.length > 0 && (
            <div className="border-t border-border p-4 text-center text-sm text-muted-foreground">
              {searchQuery.trim() && (
                <>Found {totalMatchingEmails} result{totalMatchingEmails !== 1 ? 's' : ''} for "{searchQuery}"{showUnreadOnly ? ' (unread only)' : ''}</>
              )}
              {!searchQuery.trim() && showUnreadOnly && (
                <>Showing {totalMatchingEmails} unread email{totalMatchingEmails !== 1 ? 's' : ''}</>
              )}
            </div>
          )}
          
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="border-t border-border p-4">
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEmailPage(p => Math.max(1, p - 1))}
                      disabled={emailPage === 1}
                      className="gap-1"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                  </PaginationItem>
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let pageNum;
                    if (totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (emailPage <= 3) {
                      pageNum = i + 1;
                    } else if (emailPage >= totalPages - 2) {
                      pageNum = totalPages - 4 + i;
                    } else {
                      pageNum = emailPage - 2 + i;
                    }
                    return (
                      <PaginationItem key={pageNum}>
                        <Button
                          variant={emailPage === pageNum ? 'outline' : 'ghost'}
                          size="icon"
                          onClick={() => setEmailPage(pageNum)}
                          className={emailPage === pageNum ? 'font-semibold' : ''}
                        >
                          {pageNum}
                        </Button>
                      </PaginationItem>
                    );
                  })}
                  <PaginationItem>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEmailPage(p => Math.min(totalPages, p + 1))}
                      disabled={emailPage === totalPages}
                      className="gap-1"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
              <div className="text-center text-sm text-muted-foreground mt-2">
                Page {pagination?.page || emailPage} of {totalPages} ({totalMatchingEmails} email{totalMatchingEmails !== 1 ? 's' : ''})
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenuEmail && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenuEmail(null)}
          />
          <div
            className="fixed z-50 bg-popover border border-border rounded-md shadow-lg p-1 min-w-[200px]"
            style={{ left: contextMenuEmail.x, top: contextMenuEmail.y }}
          >
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
            onClick={() => {
              if (!contextMenuEmail.email.is_read) {
                markAsRead.mutate(contextMenuEmail.email.id);
              } else {
                bulkMarkRead.mutate({ emailIds: [contextMenuEmail.email.id], is_read: false });
              }
              setContextMenuEmail(null);
            }}
          >
            <CheckCircle2 className="h-4 w-4" />
            {contextMenuEmail.email.is_read ? 'Mark as Unread' : 'Mark as Read'}
          </button>
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
            onClick={() => {
              toggleStar.mutate({ id: contextMenuEmail.email.id, is_starred: !contextMenuEmail.email.is_starred });
              setContextMenuEmail(null);
            }}
          >
            <Star className={`h-4 w-4 ${contextMenuEmail.email.is_starred ? 'fill-warning text-warning' : ''}`} />
            {contextMenuEmail.email.is_starred ? 'Unstar' : 'Star'}
          </button>
          <div className="border-t border-border my-1" />
          {folders
            .filter((folder) => movableFolderIds.includes(folder.id) && folder.id !== contextMenuEmail.email.folder)
            .map((folder) => (
              <button
                key={`context-move-${folder.id}`}
                className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
                onClick={() => {
                  bulkMove.mutate({ emailIds: [contextMenuEmail.email.id], folder: folder.id });
                  setContextMenuEmail(null);
                }}
              >
                <folder.icon className="h-4 w-4" />
                Move to {folder.label}
              </button>
            ))}
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2 text-destructive"
            onClick={() => {
              bulkDelete.mutate([contextMenuEmail.email.id]);
              setContextMenuEmail(null);
            }}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
        </>
      )}

      {/* Delete Account Confirmation */}
      <AlertDialog open={!!accountToDelete} onOpenChange={(open) => !open && setAccountToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Mail Account?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the account and all associated emails from the database. 
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => accountToDelete && deleteAccount.mutate(accountToDelete)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mail Host Trust Confirmation */}
      <AlertDialog open={!!pendingHostTrust} onOpenChange={(open) => !open && setPendingHostTrust(null)}>
        <AlertDialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Mail Server Authenticity</AlertDialogTitle>
            <AlertDialogDescription>
              Review the server and certificate details below. Continue only if you trust this mail server.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingHostTrust && (
            <div className="space-y-4">
              {pendingHostTrust.trust.warnings.length > 0 && (
                <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                  <p className="font-medium text-warning mb-2">Warnings</p>
                  <ul className="list-disc pl-5 space-y-1">
                    {pendingHostTrust.trust.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              {renderTrustSection('IMAP', pendingHostTrust.trust.assessments.imap, pendingHostTrust.trust.certificates.imap)}
              {renderTrustSection('SMTP', pendingHostTrust.trust.assessments.smtp, pendingHostTrust.trust.certificates.smtp)}
              {pendingHostTrust.trust.requiresInsecureTls && (
                <p className="text-sm text-muted-foreground">
                  If you continue, this account will allow the shown untrusted certificate. This is useful for self-hosted mail, but unsafe if you do not recognize the server.
                </p>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Deny</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmHostTrust}>
              Continue and Trust Server
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Email Reader */}
      {selectedEmail && (
        <div className="fixed inset-0 z-50 bg-background">
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="border-b border-border p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setSelectedEmail(null);
                    resetComposeState();
                  }}
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setComposeMode('reply');
                      setComposeAttachments([]);
                      if (!selectedAccount || selectedAccount === ALL_ACCOUNTS) {
                        setSelectedAccount(selectedEmail.mail_account_id);
                      }
                      setComposeForm({
                        to: selectedEmail.from_address,
                        subject: `Re: ${selectedEmail.subject || ''}`,
                        body: `<p><br></p><hr><p><strong>Original Message</strong><br>From: ${escapeHtml(selectedEmail.from_name || selectedEmail.from_address)}<br>Date: ${escapeHtml(format(new Date(selectedEmail.received_at), 'PPpp'))}</p><blockquote>${plainTextToHtml(selectedEmail.body_text || '')}</blockquote>`,
                      });
                      if (isMobile) {
                        setIsComposeOpen(true);
                      } else {
                        setIsReplying(true);
                      }
                    }}
                  >
                    <Reply className="h-4 w-4 mr-2" />
                    Reply
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setComposeMode('forward');
                      setComposeAttachments([]);
                      if (!selectedAccount || selectedAccount === ALL_ACCOUNTS) {
                        setSelectedAccount(selectedEmail.mail_account_id);
                      }
                      setComposeForm({
                        to: '',
                        subject: `Fwd: ${selectedEmail.subject || ''}`,
                        body: `<p><br></p><hr><p><strong>Forwarded Message</strong><br>From: ${escapeHtml(selectedEmail.from_name || selectedEmail.from_address)}<br>Date: ${escapeHtml(format(new Date(selectedEmail.received_at), 'PPpp'))}</p><blockquote>${plainTextToHtml(selectedEmail.body_text || '')}</blockquote>`,
                      });
                      if (isMobile) {
                        setIsComposeOpen(true);
                      } else {
                        setIsReplying(true);
                      }
                    }}
                  >
                    <Forward className="h-4 w-4 mr-2" />
                    Forward
                  </Button>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => toggleStar.mutate({ id: selectedEmail.id, is_starred: !selectedEmail.is_starred })}
              >
                <Star className={`h-5 w-5 ${selectedEmail.is_starred ? 'fill-warning text-warning' : 'text-muted-foreground'}`} />
              </Button>
            </div>
            
            {/* Email Content */}
            <div className={`flex-1 overflow-auto p-6 ${!isMobile && isReplying ? 'pb-0' : ''}`}>
              <div className="max-w-4xl mx-auto space-y-4">
                <div>
                  <h1 className="text-2xl font-bold mb-4">{selectedEmail.subject || '(No subject)'}</h1>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 break-all">
                        <span className="font-medium text-foreground">From:</span> {selectedEmail.from_name ? `${selectedEmail.from_name} <${selectedEmail.from_address}>` : selectedEmail.from_address}
                      </span>
                      {!senderAlreadyInContacts && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5"
                          onClick={() => createContactFromEmail.mutate(selectedEmail)}
                          disabled={createContactFromEmail.isPending}
                        >
                          {createContactFromEmail.isPending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <UserPlus className="h-3.5 w-3.5" />
                          )}
                          Add contact
                        </Button>
                      )}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">To:</span> {selectedEmail.to_addresses?.join(', ') || 'N/A'}
                    </div>
                    <div>
                      <span className="font-medium text-foreground">Date:</span> {format(new Date(selectedEmail.received_at), 'PPpp')}
                    </div>
                  </div>
                </div>

                {/* Attachments */}
                {selectedEmail.attachments && selectedEmail.attachments.length > 0 && (
                  <div className="border-t border-border pt-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Paperclip className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium text-foreground">
                        Attachments ({selectedEmail.attachments.length})
                      </span>
                    </div>
                    <div className="space-y-2">
                      {selectedEmail.attachments.map((attachment) => {
                        const sizeKB = attachment.size_bytes ? (attachment.size_bytes / 1024).toFixed(1) : '?';
                        const handleDownload = async (e: React.MouseEvent) => {
                          e.preventDefault();
                          try {
                            const { blob, filename } = await api.getBlob(`/mail/attachments/${attachment.id}`);
                            const blobUrl = window.URL.createObjectURL(blob);
                            const link = document.createElement('a');
                            link.href = blobUrl;
                            link.download = filename || attachment.filename || 'attachment';
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                            window.URL.revokeObjectURL(blobUrl);
                          } catch (error) {
                            console.error('Download failed:', error);
                            const errorWithStatus = error as Error & { status?: number };
                            let description = 'Could not download attachment. Please try again.';

                            if (errorWithStatus.status === 401) {
                              description = 'Session expired. Please sign in again and retry.';
                            } else if (errorWithStatus.status === 404) {
                              description = 'Attachment not found (it may not be available on disk).';
                            } else if (errorWithStatus.status && errorWithStatus.status >= 500) {
                              description = 'Server error while downloading attachment.';
                            } else if (errorWithStatus.message) {
                              description = errorWithStatus.message;
                            }

                            toast({ 
                              title: 'Download failed', 
                              description,
                              variant: 'destructive' 
                            });
                          }
                        };
                        
                        return (
                          <button
                            key={attachment.id}
                            onClick={handleDownload}
                            className="w-full flex items-center gap-3 p-3 border border-border rounded-lg hover:bg-muted/50 transition-colors group text-left"
                          >
                            <Paperclip className="h-5 w-5 text-muted-foreground shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">
                                {attachment.filename}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {attachment.content_type} • {sizeKB} KB
                              </p>
                            </div>
                            <Download className="h-4 w-4 text-muted-foreground group-hover:text-accent transition-colors shrink-0" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                
                <div className="border-t border-border pt-4">
                  <SafeEmailContent
                    emailId={selectedEmail.id}
                    bodyHtml={selectedEmail.body_html}
                    bodyText={selectedEmail.body_text}
                  />
                </div>
              </div>
            </div>

            {/* Desktop: Inline Compose Editor */}
            {!isMobile && isReplying && (
              <div className="border-t border-border bg-card">
                <div className="p-4 max-w-4xl mx-auto">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-lg font-semibold">
                      {composeMode === 'reply' ? 'Reply' : composeMode === 'forward' ? 'Forward' : 'Compose'}
                    </h2>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        resetComposeState();
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  <form onSubmit={handleSendEmail} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="compose-to-inline">To</Label>
                      {renderRecipientInput('compose-to-inline')}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="compose-subject-inline">Subject</Label>
                      <Input 
                        id="compose-subject-inline"
                        placeholder="Enter subject"
                        value={composeForm.subject}
                        onChange={(e) => setComposeForm({ ...composeForm, subject: e.target.value })}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="compose-body-inline">Message</Label>
                      {renderRichComposeEditor('compose-body-inline', inlineComposeEditorRef, 'min-h-[300px]')}
                    </div>
                    {renderComposeAttachmentsSection('compose-attachments-inline')}
                    <div className="flex justify-end gap-3">
                      <Button 
                        type="button" 
                        variant="outline" 
                        onClick={() => {
                          resetComposeState();
                        }}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={sendEmailMutation.isPending}>
                        {sendEmailMutation.isPending ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            Sending...
                          </>
                        ) : (
                          <>
                            <Send className="h-4 w-4 mr-2" />
                            Send
                          </>
                        )}
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Mail folders</DialogTitle>
            <DialogDescription>
              Create custom folders and manage where local messages are grouped. Deleting a custom folder moves its messages and routing rules back to Inbox.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Input
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder="New folder name"
              />
              <Button
                type="button"
                onClick={() => {
                  const name = newFolderName.trim();
                  if (name) createFolder.mutate(name);
                }}
                disabled={createFolder.isPending || !newFolderName.trim()}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add
              </Button>
            </div>
            <div className="space-y-2 max-h-[360px] overflow-y-auto">
              {mailFolders.map((folder) => (
                <div key={folder.slug} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                  {editingFolderSlug === folder.slug ? (
                    <Input
                      value={editingFolderName}
                      onChange={(event) => setEditingFolderName(event.target.value)}
                      className="h-8"
                    />
                  ) : (
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">{folder.display_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {folder.total_count || 0} messages{folder.is_system ? ' • system' : ''}
                      </p>
                    </div>
                  )}
                  {editingFolderSlug === folder.slug ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => updateFolder.mutate({ slug: folder.slug, displayName: editingFolderName.trim() })}
                        disabled={!editingFolderName.trim() || updateFolder.isPending}
                      >
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setEditingFolderSlug(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => {
                          setEditingFolderSlug(folder.slug);
                          setEditingFolderName(folder.display_name);
                        }}
                        disabled={folder.is_system}
                        title="Rename folder"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteFolder.mutate(folder.slug)}
                        disabled={folder.is_system || deleteFolder.isPending}
                        title="Delete folder"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Compose Dialog - Mobile or New Message */}
      <Dialog open={isComposeOpen} onOpenChange={(open) => {
        setIsComposeOpen(open);
        if (!open) {
          resetComposeState();
        }
      }}>
        <DialogContent className={`${isMobile ? 'max-w-full h-[95vh] max-h-[95vh] flex flex-col p-4 translate-y-[-47.5%] top-[47.5%] rounded-t-lg rounded-b-none' : 'sm:max-w-2xl'}`}>
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {composeMode === 'reply' ? 'Reply' : composeMode === 'forward' ? 'Forward' : 'New Message'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSendEmail} className={`space-y-4 mt-4 ${isMobile ? 'flex-1 flex flex-col min-h-0 overflow-hidden' : ''}`}>
            <div className={`space-y-4 ${isMobile ? 'shrink-0' : ''}`}>
              <div className="space-y-2">
                <Label>From</Label>
                <Select
                  value={selectedAccount && selectedAccount !== ALL_ACCOUNTS ? selectedAccount : ''}
                  onValueChange={(value) => setSelectedAccount(value as AccountMode)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.email_address}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="compose-to">To</Label>
                {renderRecipientInput('compose-to')}
              </div>
              <div className="space-y-2">
                <Label htmlFor="compose-subject">Subject</Label>
                <Input 
                  id="compose-subject"
                  placeholder="Enter subject"
                  value={composeForm.subject}
                  onChange={(e) => setComposeForm({ ...composeForm, subject: e.target.value })}
                  required
                />
              </div>
            </div>
            <div className={`space-y-2 ${isMobile ? 'flex-1 flex flex-col min-h-0' : ''}`}>
              <Label htmlFor="compose-body">Message</Label>
              {renderRichComposeEditor('compose-body', dialogComposeEditorRef, isMobile ? 'flex-1 min-h-[200px]' : 'min-h-[200px]')}
            </div>
            {renderComposeAttachmentsSection('compose-attachments-dialog')}
            <div className={`flex justify-end gap-3 ${isMobile ? 'shrink-0 pt-4 border-t border-border' : ''}`}>
              <Button type="button" variant="outline" onClick={() => {
                setIsComposeOpen(false);
                resetComposeState();
              }}>
                Cancel
              </Button>
              <Button type="submit" disabled={sendEmailMutation.isPending}>
                {sendEmailMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Send
                  </>
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

    </div>
  );
};

export default MailPage;
