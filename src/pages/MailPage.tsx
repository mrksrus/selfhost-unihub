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
import { Textarea } from '@/components/ui/textarea';
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
  Search
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
  is_active: boolean;
  last_synced_at: string | null;
  unread_count?: number;
}

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

interface MailHostAssessment {
  host: string;
  port: number | null;
  knownProvider: boolean;
  allowlisted: boolean;
  unknownProvider: boolean;
  blocked: boolean;
  reasons: string[];
  resolvedAddresses: string[];
  privateAddresses: string[];
  resolveError: string | null;
}

interface MailCertificateInfo {
  subject: Record<string, unknown> | null;
  issuer: Record<string, unknown> | null;
  valid_from: string | null;
  valid_to: string | null;
  fingerprint: string | null;
  fingerprint256: string | null;
  serialNumber: string | null;
  authorized?: boolean;
  authorizationError?: string | null;
  selfSigned?: boolean;
  error?: string;
}

interface MailPreflightResult {
  requires_confirmation: boolean;
  requires_insecure_tls?: boolean;
  warnings: string[];
  host_assessments: {
    imap: MailHostAssessment;
    smtp: MailHostAssessment;
  };
  certificates: {
    imap: MailCertificateInfo | null;
    smtp: MailCertificateInfo | null;
  };
}

const mailProviders = [
  { value: 'gmail', label: 'Gmail', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', imapPort: 993, smtpPort: 587 },
  { value: 'yahoo', label: 'Yahoo Mail', imapHost: 'imap.mail.yahoo.com', smtpHost: 'smtp.mail.yahoo.com', imapPort: 993, smtpPort: 587 },
  { value: 'icloud', label: 'iCloud Mail', imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', imapPort: 993, smtpPort: 587 },
  { value: 'outlook', label: 'Outlook / Office 365', imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', imapPort: 993, smtpPort: 587 },
  { value: 'exchange', label: 'Exchange (On-Premise)', imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 587 },
  { value: 'custom', label: 'Other (Custom IMAP/SMTP)', imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 587 },
];

const folders = [
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'archive', label: 'Archive', icon: Archive },
  { id: 'trash', label: 'Trash', icon: Trash2 },
];

const MailPage = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [selectedFolder, setSelectedFolder] = useState('inbox');
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
  const [composeForm, setComposeForm] = useState({
    to: '',
    subject: '',
    body: '',
  });
  const [composeAttachments, setComposeAttachments] = useState<ComposeAttachment[]>([]);
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);
  const [pendingAccountConfirmation, setPendingAccountConfirmation] = useState<(typeof accountForm) | null>(null);
  const [unknownHostPrompt, setUnknownHostPrompt] = useState<MailPreflightResult | null>(null);
  const [accountForm, setAccountForm] = useState({
    email_address: '',
    display_name: '',
    provider: '',
    username: '',
    password: '',
    imap_host: '',
    smtp_host: '',
    imap_port: 993,
    smtp_port: 587,
  });

  // Open compose dialog if linked from dashboard
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'compose') {
      setIsComposeOpen(true);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Fetch mail accounts
  const { data: accounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: async () => {
      const response = await api.get<{ accounts: MailAccount[] }>('/mail/accounts');
      if (response.error) throw new Error(response.error);
      return response.data?.accounts || [];
    },
  });

  // Auto-select first account or remember last selected
  useEffect(() => {
    if (accounts.length > 0 && !selectedAccount) {
      // Try to restore last selected account from localStorage
      const lastAccountId = localStorage.getItem('mail_last_selected_account');
      const lastAccount = accounts.find(a => a.id === lastAccountId);
      
      if (lastAccount) {
        setSelectedAccount(lastAccount.id);
      } else {
        // Default to first account
        setSelectedAccount(accounts[0].id);
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
      const response = await api.get<{ emails: Email[]; pagination?: { total: number } }>(
        `/mail/emails?account_id=${selectedAccount}&folder=${folder}&limit=1&offset=0`
      );
      if (response.error) return { total: 0 };
      return { total: response.data?.pagination?.total || 0 };
    },
    enabled: !!selectedAccount,
    refetchInterval: 5000, // Check count every 5 seconds
    staleTime: 0,
  });

  // Request notification permission on mount and set up service worker listeners
  React.useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(console.error);
    }

    // Listen for service worker messages to trigger email checks
    const handleSWMessage = (event: MessageEvent) => {
      if (event.data?.type === 'CHECK_EMAILS') {
        console.log('[MailPage] Service worker requested email check');
        // Invalidate email count query to trigger refetch
        queryClient.invalidateQueries({ queryKey: ['email-count', selectedAccount] });
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSWMessage);
      return () => {
        navigator.serviceWorker.removeEventListener('message', handleSWMessage);
      };
    }
  }, [selectedAccount, queryClient]);

  // Track when count changes and invalidate emails query + show notification
  React.useEffect(() => {
    const currentCount = emailCountData?.total || 0;
    if (previousEmailCount.current !== null && currentCount !== previousEmailCount.current && currentCount > previousEmailCount.current) {
      // Count increased - new emails arrived
      const newEmailCount = currentCount - previousEmailCount.current;
      console.log(`[MailPage] Email count changed: ${previousEmailCount.current} -> ${currentCount}, invalidating emails query`);
      queryClient.invalidateQueries({ queryKey: ['emails', selectedAccount, selectedFolder] });
      
      // Show notification if permission granted and not on Mail page or different folder
      if ('Notification' in window && Notification.permission === 'granted') {
        // Only notify if we're not currently viewing inbox or if we're on a different folder
        if (selectedFolder !== 'inbox' || document.hidden) {
          // Use dynamic import to avoid circular dependencies
          import('@/utils/service-worker').then(({ showNotification }) => {
            showNotification(`New Email${newEmailCount > 1 ? 's' : ''}`, {
              body: `${newEmailCount} new email${newEmailCount > 1 ? 's' : ''} in your inbox`,
              icon: '/favicon.ico',
              tag: 'new-email',
              requireInteraction: false,
            });
          }).catch(() => {
            // Fallback to regular Notification if service worker not available
            if (document.visibilityState === 'visible') {
              new Notification(`New Email${newEmailCount > 1 ? 's' : ''}`, {
                body: `${newEmailCount} new email${newEmailCount > 1 ? 's' : ''} in your inbox`,
                icon: '/favicon.ico',
                tag: 'new-email',
                requireInteraction: false,
              });
            }
          });
        }
      }
    }
    previousEmailCount.current = currentCount;
  }, [emailCountData?.total, selectedAccount, selectedFolder, queryClient]);
  
  // Reset count when account or folder changes
  React.useEffect(() => {
    previousEmailCount.current = null;
  }, [selectedAccount, selectedFolder]);

  // Fetch emails for selected account
  // Always fetch the latest batch for the folder/account, then paginate & filter client-side
  const { data: emailsData, isLoading: emailsLoading } = useQuery({
    queryKey: ['emails', selectedAccount, selectedFolder],
    queryFn: async () => {
      if (!selectedAccount) return { emails: [] };
      
      const folder = selectedFolder === 'starred' ? 'inbox' : selectedFolder;
      // Fetch up to 100 most recent emails for this folder/account
      const limit = 100;
      const offset = 0;
      
      const response = await api.get<{ emails: Email[]; pagination?: { total: number; limit: number; offset: number; page: number; totalPages: number } }>(
        `/mail/emails?account_id=${selectedAccount}&folder=${folder}&limit=${limit}&offset=${offset}`
      );
      if (response.error) throw new Error(response.error);
      let emails = response.data?.emails || [];
      
      if (selectedFolder === 'starred') {
        emails = emails.filter(e => e.is_starred);
      }

      return { emails };
    },
    enabled: !!selectedAccount,
    staleTime: 60000, // Consider data fresh for 60 seconds (will be invalidated when count changes)
  });

  const allEmails = emailsData?.emails || [];
  
  // Debug logging
  React.useEffect(() => {
    if (selectedAccount && !emailsLoading) {
      console.log(`[MailPage] Emails loaded: ${allEmails.length} emails for account ${selectedAccount}, folder ${selectedFolder}`);
    }
  }, [allEmails.length, selectedAccount, selectedFolder, emailsLoading]);

  // Filter emails based on search query and unread filter
  const emails = React.useMemo(() => {
    let filteredEmails = allEmails;
    
    // Apply unread filter if enabled
    if (showUnreadOnly) {
      filteredEmails = filteredEmails.filter(email => !email.is_read);
    }
    
    // Apply search filter if query exists
    if (!searchQuery.trim()) return filteredEmails;
    
    const query = searchQuery.toLowerCase();
    return filteredEmails.filter(email => {
      const subject = (email.subject || '').toLowerCase();
      const fromName = (email.from_name || '').toLowerCase();
      const fromAddress = (email.from_address || '').toLowerCase();
      const bodyText = (email.body_text || '').toLowerCase();
      
      return subject.includes(query) || 
             fromName.includes(query) || 
             fromAddress.includes(query) ||
             bodyText.includes(query);
    });
  }, [allEmails, searchQuery, showUnreadOnly]);

  const totalPages = React.useMemo(() => {
    if (emails.length === 0) return 1;
    return Math.max(1, Math.ceil(emails.length / emailsPerPage));
  }, [emails.length, emailsPerPage]);

  const paginatedEmails = React.useMemo(() => {
    if (emails.length === 0) return [];
    const currentPage = Math.min(emailPage, totalPages);
    const start = (currentPage - 1) * emailsPerPage;
    return emails.slice(start, start + emailsPerPage);
  }, [emails, emailPage, totalPages, emailsPerPage]);

  // Keep current page in range when filters change
  useEffect(() => {
    setEmailPage(prev => {
      const maxPage = Math.max(1, Math.ceil(emails.length / emailsPerPage));
      return Math.min(prev, maxPage);
    });
  }, [emails.length, emailsPerPage]);

  // Add mail account mutation
  const addAccount = useMutation({
    mutationFn: async (account: (typeof accountForm) & { confirm_unknown_host?: boolean }) => {
      const response = await api.post('/mail/accounts', {
        ...account,
        encrypted_password: account.password, // Will be encrypted on server
      });
      if (response.error) {
        if (response.requires_confirmation) {
          const confirmationError = new Error(response.error) as Error & {
            requiresConfirmation?: boolean;
            confirmationData?: MailPreflightResult;
          };
          confirmationError.requiresConfirmation = true;
          confirmationError.confirmationData = {
            requires_confirmation: true,
            requires_insecure_tls: Boolean(response.requires_insecure_tls),
            warnings: Array.isArray(response.warnings) ? response.warnings : [],
            host_assessments: response.host_assessments as MailPreflightResult['host_assessments'],
            certificates: (response.certificates as MailPreflightResult['certificates']) || { imap: null, smtp: null },
          };
          throw confirmationError;
        }
        throw new Error(response.error);
      }
      return response.data;
    },
    onSuccess: (data: any) => {
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
      });
    },
    onError: (error: Error, variables) => {
      const confirmationError = error as Error & {
        requiresConfirmation?: boolean;
        confirmationData?: MailPreflightResult;
      };
      if (confirmationError.requiresConfirmation && confirmationError.confirmationData) {
        setPendingAccountConfirmation(variables);
        setUnknownHostPrompt(confirmationError.confirmationData);
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
    mutationFn: async ({ id, ...data }: { id: string } & Partial<typeof accountForm>) => {
      const response = await api.put(`/mail/accounts/${id}`, {
        ...data,
        encrypted_password: data.password || undefined,
      });
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
      });
    },
    onError: (error: Error) => {
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
      queryClient.invalidateQueries({ queryKey: ['unread-emails-count'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      queryClient.invalidateQueries({ queryKey: ['mail-accounts'] });
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
      queryClient.invalidateQueries({ queryKey: ['unread-emails-count'] });
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

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts if user is typing in an input/textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
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
        if (paginatedEmails.length > 0) {
          setSelectedEmails(new Set(paginatedEmails.map(e => e.id)));
        }
      }

      // Escape to deselect all
      if (e.key === 'Escape') {
        setSelectedEmails(new Set());
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedEmails, paginatedEmails, bulkDelete]);

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
    if (selectedEmails.size === paginatedEmails.length) {
      setSelectedEmails(new Set());
    } else {
      setSelectedEmails(new Set(paginatedEmails.map(e => e.id)));
    }
  };
  
  // Sync mail mutation
  const syncMail = useMutation({
    mutationFn: async (account_id: string) => {
      const response = await api.post('/mail/sync', { account_id });
      if (response.error) {
        throw new Error(response.error);
      }
      return response.data;
    },
    onSuccess: (data: any) => {
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
      const preflight = await api.post<MailPreflightResult>('/mail/accounts/preflight', {
        imap_host: accountForm.imap_host,
        imap_port: accountForm.imap_port,
        smtp_host: accountForm.smtp_host,
        smtp_port: accountForm.smtp_port,
      });

      if (preflight.error) {
        toast({
          title: 'Mail host check failed',
          description: preflight.error,
          variant: 'destructive',
        });
        return;
      }

      if (preflight.data?.requires_confirmation) {
        setPendingAccountConfirmation(accountForm);
        setUnknownHostPrompt(preflight.data);
        return;
      }

      addAccount.mutate(accountForm);
    }
  };
  
  const handleEditAccount = (account: MailAccount) => {
    setEditingAccount(account);
    setAccountForm({
      email_address: account.email_address,
      display_name: account.display_name || '',
      provider: account.provider,
      username: '', // Don't pre-fill for security
      password: '',
      imap_host: '', // Would need to fetch from backend or store in state
      smtp_host: '',
      imap_port: 993,
      smtp_port: 587,
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
    setComposeAttachments([]);
    setIsAttachmentDragOver(false);
    setIsReplying(false);
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
    if (!selectedAccount) {
      toast({ title: 'Please select an account', variant: 'destructive' });
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
  const hasSelfSignedCertificate = Boolean(
    unknownHostPrompt?.requires_insecure_tls ||
    unknownHostPrompt?.certificates?.imap?.selfSigned ||
    unknownHostPrompt?.certificates?.smtp?.selfSigned
  );

  const formatCertificateParty = (party: Record<string, unknown> | null | undefined) => {
    if (!party) return 'N/A';
    const cn = typeof party.CN === 'string' ? party.CN : '';
    const org = typeof party.O === 'string' ? party.O : '';
    const ou = typeof party.OU === 'string' ? party.OU : '';
    const summary = [cn, org, ou].filter(Boolean).join(' / ');
    return summary || JSON.stringify(party);
  };

  const getCertificateTrustLabel = (certificate: MailCertificateInfo | null | undefined) => {
    if (!certificate) return 'No certificate details';
    if (certificate.error) return `Certificate lookup failed: ${certificate.error}`;
    if (certificate.selfSigned || certificate.authorizationError) {
      return `Untrusted: ${certificate.authorizationError || 'Self-signed certificate'}`;
    }
    if (certificate.authorized === true) return 'Trusted by system CA';
    return 'Trust status unavailable';
  };

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
        <nav className="px-2 space-y-1">
          {folders.map((folder) => (
            <button
              key={folder.id}
              onClick={() => {
                setSelectedFolder(folder.id);
                if (isMobile) setMobileSidebarOpen(false);
              }}
              className={`w-full flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-lg text-sm transition-colors ${
                selectedFolder === folder.id
                  ? 'bg-accent/10 text-accent font-medium'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
              title={(sidebarCollapsed && !isMobile) ? folder.label : undefined}
            >
              <folder.icon className="h-4 w-4 shrink-0" />
              {(!sidebarCollapsed || isMobile) && <span>{folder.label}</span>}
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
                });
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
              accounts.map((account) => (
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
              ))
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
            {paginatedEmails.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSelectAll}
                title={selectedEmails.size === paginatedEmails.length ? 'Deselect all' : 'Select all'}
                className="shrink-0"
              >
                {selectedEmails.size === paginatedEmails.length ? (
                  <CheckSquare className="h-4 w-4" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
              </Button>
            )}
            <h2 className="font-semibold capitalize shrink-0">{selectedFolder}</h2>
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
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const folder = selectedFolder === 'inbox' ? 'archive' : 'inbox';
                    bulkMove.mutate({ emailIds: Array.from(selectedEmails), folder });
                  }}
                  disabled={bulkMove.isPending}
                >
                  <FolderOpen className="h-4 w-4 mr-2" />
                  Move
                </Button>
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
              onClick={() => selectedAccount && syncMail.mutate(selectedAccount)}
              disabled={!selectedAccount || syncMail.isPending}
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
                    : `No emails in ${selectedFolder}`
                }
              </h3>
              <p className="text-muted-foreground">
                {searchQuery.trim()
                  ? `No emails found matching "${searchQuery}"${showUnreadOnly ? ' in unread emails' : ''}`
                  : showUnreadOnly
                    ? `No unread emails in ${selectedFolder === 'inbox' ? 'your inbox' : `your ${selectedFolder} folder`}.`
                    : selectedFolder === 'inbox' 
                      ? 'Your inbox is empty. Sync your account to fetch emails.'
                      : `No emails in your ${selectedFolder} folder.`
                }
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              <AnimatePresence mode="popLayout">
                {paginatedEmails.map((email) => (
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
                      // Mark as read if unread
                      if (!email.is_read) {
                        markAsRead.mutate(email.id);
                      }
                      // Fetch full email and open reader
                      try {
                        const response = await api.get<{ email: Email }>(`/mail/emails/${email.id}`);
                        if (response.error) {
                          toast({ title: 'Failed to load email', description: response.error, variant: 'destructive' });
                          return;
                        }
                        if (response.data?.email) {
                          const fetchedEmail = response.data.email;
                          // Mark as read if it was unread (update local state)
                          if (!fetchedEmail.is_read) {
                            setSelectedEmail({ ...fetchedEmail, is_read: true });
                          } else {
                            setSelectedEmail(fetchedEmail);
                          }
                        } else {
                          // Fallback: use the email from list if full fetch fails
                          const fallbackEmail = email.is_read ? email : { ...email, is_read: true };
                          setSelectedEmail(fallbackEmail);
                        }
                      } catch (error) {
                        console.error('Error loading email:', error);
                        // Fallback: use the email from list
                        const fallbackEmail = email.is_read ? email : { ...email, is_read: true };
                        setSelectedEmail(fallbackEmail);
                      }
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
                <>Found {emails.length} result{emails.length !== 1 ? 's' : ''} for "{searchQuery}"{showUnreadOnly ? ' (unread only)' : ''}</>
              )}
              {!searchQuery.trim() && showUnreadOnly && (
                <>Showing {emails.length} unread email{emails.length !== 1 ? 's' : ''}</>
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
                Page {emailPage} of {totalPages} ({emails.length} email{emails.length !== 1 ? 's' : ''})
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
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
            onClick={() => {
              const targetFolder = selectedFolder === 'inbox' ? 'archive' : 'inbox';
              bulkMove.mutate({ emailIds: [contextMenuEmail.email.id], folder: targetFolder });
              setContextMenuEmail(null);
            }}
          >
            <FolderOpen className="h-4 w-4" />
            Move to {selectedFolder === 'inbox' ? 'Archive' : 'Inbox'}
          </button>
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
                      if (!selectedAccount) {
                        setSelectedAccount(selectedEmail.mail_account_id);
                      }
                      setComposeForm({
                        to: selectedEmail.from_address,
                        subject: `Re: ${selectedEmail.subject || ''}`,
                        body: `\n\n--- Original Message ---\nFrom: ${selectedEmail.from_name || selectedEmail.from_address}\nDate: ${format(new Date(selectedEmail.received_at), 'PPpp')}\n\n${selectedEmail.body_text || ''}`,
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
                      if (!selectedAccount) {
                        setSelectedAccount(selectedEmail.mail_account_id);
                      }
                      setComposeForm({
                        to: '',
                        subject: `Fwd: ${selectedEmail.subject || ''}`,
                        body: `\n\n--- Forwarded Message ---\nFrom: ${selectedEmail.from_name || selectedEmail.from_address}\nDate: ${format(new Date(selectedEmail.received_at), 'PPpp')}\n\n${selectedEmail.body_text || ''}`,
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
                    <div>
                      <span className="font-medium text-foreground">From:</span> {selectedEmail.from_name ? `${selectedEmail.from_name} <${selectedEmail.from_address}>` : selectedEmail.from_address}
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
                      <Input 
                        id="compose-to-inline"
                        type="email"
                        placeholder="recipient@example.com"
                        value={composeForm.to}
                        onChange={(e) => setComposeForm({ ...composeForm, to: e.target.value })}
                        required
                      />
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
                      <Textarea 
                        id="compose-body-inline"
                        className="min-h-[300px]"
                        placeholder="Write your message..."
                        value={composeForm.body}
                        onChange={(e) => setComposeForm({ ...composeForm, body: e.target.value })}
                        required
                      />
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
                <Select value={selectedAccount || ''} onValueChange={setSelectedAccount}>
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
                <Input 
                  id="compose-to"
                  type="email"
                  placeholder="recipient@example.com"
                  value={composeForm.to}
                  onChange={(e) => setComposeForm({ ...composeForm, to: e.target.value })}
                  required
                />
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
              <Textarea 
                id="compose-body"
                className={`${isMobile ? 'flex-1 min-h-[200px] resize-none' : 'min-h-[200px]'}`}
                placeholder="Write your message..."
                value={composeForm.body}
                onChange={(e) => setComposeForm({ ...composeForm, body: e.target.value })}
                required
              />
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

      <AlertDialog
        open={!!unknownHostPrompt}
        onOpenChange={(open) => {
          if (!open) {
            setUnknownHostPrompt(null);
            setPendingAccountConfirmation(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{hasSelfSignedCertificate ? 'Untrusted TLS certificate' : 'Unknown mail host'}</AlertDialogTitle>
            <AlertDialogDescription>
              {hasSelfSignedCertificate
                ? 'One or more mail servers present a self-signed or untrusted certificate. Review details before trusting.'
                : 'These server hosts are not recognized providers. Verify certificate details before trusting them.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 text-sm">
            {unknownHostPrompt?.warnings?.map((warning) => (
              <p key={warning} className="text-warning">{warning}</p>
            ))}
            {unknownHostPrompt?.host_assessments?.imap && (
              <div className="rounded border p-2">
                <p><strong>IMAP:</strong> {unknownHostPrompt.host_assessments.imap.host}:{unknownHostPrompt.host_assessments.imap.port}</p>
                <p className="text-muted-foreground">Resolved: {unknownHostPrompt.host_assessments.imap.resolvedAddresses.join(', ') || 'N/A'}</p>
                <p className="text-muted-foreground">Trust: {getCertificateTrustLabel(unknownHostPrompt.certificates?.imap)}</p>
                <p className="text-muted-foreground">Subject: {formatCertificateParty(unknownHostPrompt.certificates?.imap?.subject)}</p>
                <p className="text-muted-foreground">Issuer: {formatCertificateParty(unknownHostPrompt.certificates?.imap?.issuer)}</p>
                <p className="text-muted-foreground">Valid: {unknownHostPrompt.certificates?.imap?.valid_from || 'N/A'} to {unknownHostPrompt.certificates?.imap?.valid_to || 'N/A'}</p>
                <p className="text-muted-foreground">Fingerprint (SHA-256): {String(unknownHostPrompt.certificates?.imap?.fingerprint256 || 'N/A')}</p>
              </div>
            )}
            {unknownHostPrompt?.host_assessments?.smtp && (
              <div className="rounded border p-2">
                <p><strong>SMTP:</strong> {unknownHostPrompt.host_assessments.smtp.host}:{unknownHostPrompt.host_assessments.smtp.port}</p>
                <p className="text-muted-foreground">Resolved: {unknownHostPrompt.host_assessments.smtp.resolvedAddresses.join(', ') || 'N/A'}</p>
                <p className="text-muted-foreground">Trust: {getCertificateTrustLabel(unknownHostPrompt.certificates?.smtp)}</p>
                <p className="text-muted-foreground">Subject: {formatCertificateParty(unknownHostPrompt.certificates?.smtp?.subject)}</p>
                <p className="text-muted-foreground">Issuer: {formatCertificateParty(unknownHostPrompt.certificates?.smtp?.issuer)}</p>
                <p className="text-muted-foreground">Valid: {unknownHostPrompt.certificates?.smtp?.valid_from || 'N/A'} to {unknownHostPrompt.certificates?.smtp?.valid_to || 'N/A'}</p>
                <p className="text-muted-foreground">Fingerprint (SHA-256): {String(unknownHostPrompt.certificates?.smtp?.fingerprint256 || 'N/A')}</p>
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingAccountConfirmation) {
                  addAccount.mutate({ ...pendingAccountConfirmation, confirm_unknown_host: true });
                }
                setUnknownHostPrompt(null);
                setPendingAccountConfirmation(null);
              }}
            >
              Trust and Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default MailPage;
