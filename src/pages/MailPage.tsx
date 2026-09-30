import { MailAccountDialog } from '@/components/mail/MailAccountDialog';
import { useMailAccountEditor } from '@/hooks/use-mail-account-editor';
import { MailComposeDialog, MailComposeDialogs, MailInlineCompose } from '@/components/mail/MailCompose';
import { useMailCompose } from '@/hooks/use-mail-compose';
import { MailAccountRemovalDialogs } from '@/components/mail/MailAccountRemovalDialogs';
import { useMailAccountRemoval } from '@/hooks/use-mail-account-removal';
import { MailSyncAttentionLine, MailSyncControl, type SyncPanelFocus } from '@/components/mail/MailSyncControl';
import { useMailSyncJobs } from '@/hooks/use-mail-sync-jobs';
import { useMailWritebacks } from '@/hooks/use-mail-writebacks';
import { useMailAccountSelection } from '@/hooks/use-mail-account-selection';
import MailFolderNavigation from '@/components/mail/MailFolderNavigation';
import { plainTextToHtml, escapeHtml, sanitizeReturnTo, isComposeHtmlEmpty, isComposeMeaningful, validateComposeAttachments } from '@/lib/mail-compose';
import { useMailReader } from '@/hooks/use-mail-reader';
import { useMailFlags } from '@/hooks/use-mail-flags';
import { invalidateMailQueries, captureMailFlagReconciler, type MailAccount, type Email, type EmailAttachment, type MailFolder, type MailContact } from '@/lib/mail-api';
import { acceptMailCommand, newMailCommand, UnknownMailAcceptance } from '@/lib/mail-operations';
import { useMailAccounts, useMailFolders, useMailUnreadCounts, useMailList } from '@/hooks/use-mail-queries';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { contactsQueryOptions } from '@/lib/contacts-api';
import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
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
  DropdownMenuSeparator,
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
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToastAction } from '@/components/ui/toast';
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
  UserPlus,
  FileText
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { useIsMobile } from '@/hooks/use-mobile';
import { SafeEmailContent } from '@/components/mail/SafeEmailContent';

import {
  mailProviders, systemFolders, ALL_ACCOUNTS, LEGACY_ACCOUNT, ALL_MAIL, bulkKey, initialAccountForm,
  getContactDisplayName, formatRecipient, getActiveRecipientSearchTerm, deriveContactNameFromEmail, getServerDeleteStatus,
  formatAttachmentSize,
  type AccountFormState, type MailHostAssessment, type MailHostCertificate, type MailHostTrustResult, type PendingHostTrust,
  type MailHostTrustError, type ComposeAttachment, type AddMailAccountResponse, type ContactEmailSuggestion, type FolderMode,
  type MailPurgePreview,
} from '@/components/mail/mail-page-model';

const MailPage = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const { accountId: activeMailAccountId, queryAccount: selectedAccount, selectAccount: setSelectedAccount } = useMailAccountSelection();
  const [selectedFolder, setSelectedFolder] = useState<FolderMode>('inbox');
  const { selectedEmail, setSelectedEmail, isReaderLoading, closeReader, loadEmail } = useMailReader();
  const selectedEmailId = selectedEmail?.id;
  const { flagRequests, requestFlag } = useMailFlags(setSelectedEmail, (kind, message, unknown) => {
    toast({ title: unknown ? `${kind === 'read' ? 'Read' : 'Star'} request outcome unknown` : kind === 'read' ? 'Failed to update read status' : 'Failed to update star', description: message, variant: 'destructive' });
  });
  const detailRefreshRevision = React.useRef(0);
  useEffect(() => { ++detailRefreshRevision.current; }, [selectedEmailId]);

  const refreshSettledEmail = React.useCallback((emailIds: string[]) => {
    if (!selectedEmailId || !emailIds.includes(selectedEmailId)) return;
    const id = selectedEmailId;
    const revision = ++detailRefreshRevision.current;
    const reconcile = captureMailFlagReconciler(queryClient);
    void api.get<{ email: Email }>(`/mail/emails/${encodeURIComponent(id)}`).then(response => {
      const email = response.data?.email && reconcile(response.data.email);
      if (revision === detailRefreshRevision.current && !response.error && email?.id === id) {
        setSelectedEmail(current => current?.id === id ? {
          ...current, is_read: email.is_read, is_starred: email.is_starred,
          read_sync_pending: email.read_sync_pending, star_sync_pending: email.star_sync_pending,
          folder: email.folder, remote_missing: email.remote_missing,
        } : current);
      }
    }).catch(() => { /* A failed status refresh must not replace the current message. */ });
  }, [selectedEmailId, setSelectedEmail, queryClient]);
  const accountEditor = useMailAccountEditor();
  const compose = useMailCompose({ activeMailAccountId, selectedAccount, setSelectedAccount, isMobile });
  const accountRemoval = useMailAccountRemoval(() => setSelectedAccount(ALL_ACCOUNTS));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const bulkRequests = React.useRef(new Set<string>());
  const [bulkPending, setBulkPending] = useState(new Set<string>());

  const runBulk = React.useCallback(<T extends object,>(kind: string, payload: T, send: (value: T) => Promise<unknown>) => {
    const key = bulkKey(kind, payload);
    if (bulkRequests.current.has(key)) return;
    bulkRequests.current.add(key);
    setBulkPending(new Set(bulkRequests.current));
    void send(payload).catch(() => { /* Mutation onError displays the API error. */ }).finally(() => {
      bulkRequests.current.delete(key);
      setBulkPending(new Set(bulkRequests.current));
    });
  }, []);
  const [contextMenuEmail, setContextMenuEmail] = useState<{ email: Email; x: number; y: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebouncedValue(searchQuery.trim());
  const [emailPage, setEmailPage] = useState(1);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderToDelete, setFolderToDelete] = useState<MailFolder | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [recoveryAccount, setRecoveryAccount] = useState('');
  const [recoveryFolder, setRecoveryFolder] = useState('inbox');
  const [editingFolderSlug, setEditingFolderSlug] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState('');
  const { data: accounts = [], isLoading: accountsLoading } = useMailAccounts();
  const { jobs: syncJobs, requestSync, syncingAccountIds, requestCancel, cancellingAccountIds } = useMailSyncJobs(accounts);
  const writebacks = useMailWritebacks(refreshSettledEmail);
  const [syncPanel, setSyncPanel] = useState<SyncPanelFocus | null>(null);
  const { data: mailFolders = [] } = useMailFolders();

  const legacyCount = mailFolders.reduce((total, folder) => total + (folder.legacy_count || 0), 0);
  const visibleMailFolders = React.useMemo(() => mailFolders.filter(folder => {
    if (selectedAccount === LEGACY_ACCOUNT) return (folder.legacy_count || 0) > 0;
    if (folder.is_system) return true;
    const linked = folder.connected_account_ids || [];
    if (selectedAccount === ALL_ACCOUNTS) return !!folder.mail_account_id || linked.length > 0 || (folder.legacy_count || 0) > 0;
    return folder.mail_account_id === selectedAccount || linked.includes(selectedAccount || '');
  }), [mailFolders, selectedAccount]);

  const folders = React.useMemo(() => {
    const systemBySlug = new Map(systemFolders.map(folder => [folder.id, folder]));
    if (mailFolders.length === 0) return systemFolders.map(folder => ({ ...folder, legacy: false, accountId: null as string | null }));
    return visibleMailFolders.map((folder) => {
      const systemFolder = systemBySlug.get(folder.special_use || folder.slug);
      const account = accounts.find(account => account.id === folder.mail_account_id);
      return {
        id: folder.slug,
        label: selectedAccount === ALL_ACCOUNTS && account ? `${folder.display_name} · ${account.email_address}` : folder.display_name,
        icon: folder.special_use === 'junk' ? ShieldAlert : systemFolder?.icon || FolderOpen,
        legacy: false,
        accountId: folder.mail_account_id || null,
      };
    }).sort((a, b) => Number(a.legacy) - Number(b.legacy));
  }, [mailFolders, visibleMailFolders, selectedAccount, accounts]);

  useEffect(() => {
    if (mailFolders.length && selectedFolder !== ALL_MAIL && selectedFolder !== 'starred' && !visibleMailFolders.some(folder => folder.slug === selectedFolder)) {
      setSelectedFolder(selectedAccount === LEGACY_ACCOUNT ? ALL_MAIL : 'inbox');
    }
  }, [mailFolders, visibleMailFolders, selectedFolder, selectedAccount]);

  const folderFilters = React.useMemo(() => {
    // Starred is a virtual IMAP flag view, not a physical mailbox row.
    const starred = { ...systemFolders.find(folder => folder.id === 'starred')!, legacy: false, accountId: null };
    const listedFolders = folders.filter(folder => folder.id !== 'starred');
    const insertAfter = listedFolders.findIndex(folder => folder.id === 'drafts') + 1;
    const orderedFolders = [
      ...listedFolders.slice(0, Math.max(insertAfter, 0)),
      starred,
      ...listedFolders.slice(Math.max(insertAfter, 0)),
    ];
    return [{ id: ALL_MAIL, label: 'All mail', icon: Mail, legacy: false, accountId: null }, ...orderedFolders];
  }, [folders]);

  const movableFolderIds = React.useMemo(
    () => selectedAccount === LEGACY_ACCOUNT ? [] : folders.filter(folder => !folder.accountId || folder.accountId === selectedAccount).map(folder => folder.id).filter(folderId => folderId !== 'starred'),
    [folders, selectedAccount]
  );

  const { data: unreadCountsData } = useMailUnreadCounts(selectedAccount);

  const unreadByFolder = unreadCountsData?.unreadByFolder || {};

  // Auto-select first account or remember last selected
  useEffect(() => {
    if (accounts.length > 0 && !selectedAccount) {
      // Try to restore last selected account from localStorage
      const lastAccountId = localStorage.getItem('mail_last_selected_account');
      const lastAccount = accounts.find(a => a.id === lastAccountId);
      
      if (lastAccountId === LEGACY_ACCOUNT) {
        setSelectedAccount(LEGACY_ACCOUNT);
        setSelectedFolder(ALL_MAIL);
      } else if (lastAccountId === ALL_ACCOUNTS) {
        setSelectedAccount(ALL_ACCOUNTS);
      } else if (lastAccount) {
        setSelectedAccount(lastAccount.id);
      } else {
        // Default to all accounts
        setSelectedAccount(ALL_ACCOUNTS);
      }
    }
  }, [accounts, selectedAccount, setSelectedAccount]);

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
  }, [debouncedSearch, showUnreadOnly]);

  const { data: emailsData, isLoading: emailsLoading } = useMailList({
    account: selectedAccount, folder: selectedFolder, page: emailPage,
    search: debouncedSearch, unreadOnly: showUnreadOnly,
  });

  const emails = React.useMemo(() => emailsData?.emails ?? [], [emailsData?.emails]);
  const pagination = emailsData?.pagination;
  const totalMatchingEmails = pagination?.total ?? emails.length;
  const totalPages = pagination?.totalPages ?? 1;

  const loadEmailForReader = React.useCallback((emailId: string) => {
    ++detailRefreshRevision.current;
    return loadEmail(emailId, {
      onDraft: compose.openDraftForCompose,
      reconcileEmail: captureMailFlagReconciler(queryClient),
      onMarkRead: (email) => requestFlag(email, 'read', true),
      onError: (message) => toast({ title: 'Failed to load email', description: message, variant: 'destructive' }),
    });
  }, [loadEmail, compose.openDraftForCompose, requestFlag, queryClient, toast]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const emailId = params.get('email');
    if (!emailId) return;

    void loadEmailForReader(emailId);
    params.delete('email');
    navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, { replace: true });
  }, [loadEmailForReader, location.pathname, location.search, location.hash, navigate]);

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
    mutationFn: async ({ emailIds }: { emailIds: string[]; restoreFolders: Record<string, string> }) => {
      const response = await acceptMailCommand(newMailCommand('POST', '/mail/emails/bulk-delete', { email_ids: emailIds }));
      return { count: emailIds.length, pending: response.sync_pending !== false };
    },
    onSuccess: ({ count, pending }, variables) => {
      void invalidateMailQueries(queryClient);
      setSelectedEmails(new Set());
      toast({
        title: pending ? `Trash move saved for ${count} email(s)` : `Trash request accepted for ${count} email(s)`,
        description: pending ? 'Server changes are waiting to sync. The sync button shows their progress.' : undefined,
        action: pending ? undefined : (
          <ToastAction
            altText="Undo move to trash"
            onClick={() => {
              const byFolder = Object.entries(variables.restoreFolders).reduce<Record<string, string[]>>((acc, [emailId, folder]) => {
                if (!folder || folder === 'trash') return acc;
                acc[folder] = [...(acc[folder] || []), emailId];
                return acc;
              }, {});
              Object.entries(byFolder).forEach(([folder, emailIds]) => {
                runBulk('move', { emailIds, folder }, bulkMove.mutateAsync);
              });
            }}
          >
            Undo
          </ToastAction>
        ),
      });
    },
    onError: (error: Error) => {
      toast({ title: error instanceof UnknownMailAcceptance ? 'Trash request outcome unknown' : 'Trash request rejected', description: error.message, variant: 'destructive' });
    },
  });

  const bulkMove = useMutation({
    mutationFn: async ({ emailIds, folder, accountId }: { emailIds: string[]; folder: string; accountId?: string }) => {
      const response = await acceptMailCommand(newMailCommand('POST', '/mail/emails/bulk-move', { email_ids: emailIds, folder, account_id: accountId }));
      return response;
    },
    onSuccess: (data, variables) => {
      void invalidateMailQueries(queryClient);
      setSelectedEmails(new Set());
      toast({ title: `Move accepted for ${variables.emailIds.length} email(s)`,
        description: data?.sync_pending !== false ? 'Provider confirmation is pending. The sync button shows the outcome.' : 'The local request was accepted; provider confirmation is not implied.' });
    },
    onError: (error: Error) => {
      toast({ title: error instanceof UnknownMailAcceptance ? 'Move outcome unknown — do not resend' : 'Move request rejected', description: error.message, variant: 'destructive' });
    },
  });

  // Bulk flag controls use the same per-email/field admission lanes as row and
  // reader clicks. A slow batch must not overtake a later single-message click.
  const requestBulkFlags = (emailIds: string[], kind: 'read' | 'star', value: boolean) => {
    for (const id of emailIds) {
      const email = emails.find(item => item.id === id) || (selectedEmail?.id === id ? selectedEmail : null);
      if (email) requestFlag(email, kind, value);
    }
    setSelectedEmails(new Set());
    return Promise.resolve();
  };
  const bulkMarkRead = { mutateAsync: ({ emailIds, is_read }: { emailIds: string[]; is_read: boolean }) => requestBulkFlags(emailIds, 'read', is_read) };
  const bulkStar = { mutateAsync: ({ emailIds, is_starred }: { emailIds: string[]; is_starred: boolean }) => requestBulkFlags(emailIds, 'star', is_starred) };


  const createFolder = useMutation({
    mutationFn: async (displayName: string) => {
      const response = await api.post<{ folder: MailFolder; remoteFolder?: { status: string } }>('/mail/folders', { display_name: displayName, mail_account_id: activeMailAccountId });
      if (response.error) throw new Error(response.error);
      return response.data;
    },
    onSuccess: (result) => {
      const folder = result?.folder;
      queryClient.invalidateQueries({ queryKey: ['mail-folders'] });
      queryClient.invalidateQueries({ queryKey: ['mail-unread-counts'] });
      if (folder?.slug) setSelectedFolder(folder.slug);
      setNewFolderName('');
      toast({ title: 'Folder created for this account', description: result?.remoteFolder?.status === 'partial' ? 'Saved locally. The mail provider could not create the folder; provider sync is not established yet.' : undefined });
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
      void invalidateMailQueries(queryClient);
      if (selectedFolder === slug) setSelectedFolder('inbox');
      toast({ title: 'Folder deleted', description: 'Messages and rules were moved back to Inbox.' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to delete folder', description: error.message, variant: 'destructive' });
    },
  });

  const createTrashMovePayload = React.useCallback((emailIds: string[]) => {
    const restoreFolders: Record<string, string> = {};
    for (const id of emailIds) {
      const source = emails.find(email => email.id === id) || (selectedEmail?.id === id ? selectedEmail : null);
      restoreFolders[id] = source?.folder || selectedFolder || 'inbox';
    }
    return { emailIds, restoreFolders };
  }, [emails, selectedEmail, selectedFolder]);

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
        runBulk('delete', createTrashMovePayload(Array.from(selectedEmails)), bulkDelete.mutateAsync);
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
  }, [selectedEmails, emails, bulkDelete, createTrashMovePayload, runBulk]);

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


  const selectedAccountData = accounts.find(a => a.id === selectedAccount);
  const selectedFolderData = folders.find((folder) => folder.id === selectedFolder);
  const folderLabel = selectedFolder === ALL_MAIL ? 'All mail' : selectedFolderData?.label || selectedFolder;
  const accountLabel = selectedAccount === LEGACY_ACCOUNT ? 'Legacy — needs review' : selectedAccount === ALL_ACCOUNTS
    ? 'All accounts'
    : selectedAccountData?.display_name || selectedAccountData?.email_address || 'No account selected';
  const senderAlreadyInContacts = selectedEmail
    ? compose.contactEmailSuggestions.some((suggestion) => suggestion.email.toLowerCase() === selectedEmail.from_address.toLowerCase())
    : false;

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
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
          ? `fixed left-0 top-0 h-full min-h-0 w-56 z-50 transform overflow-hidden transition-transform duration-200 border-r border-border bg-card flex flex-col ${
              mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`
          : `${sidebarCollapsed ? 'w-16' : 'w-64'} shrink-0 h-full min-h-0 overflow-hidden border-r border-border bg-card flex flex-col transition-all duration-200`
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
              aria-label="Close account and folder navigation"
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
              aria-label={sidebarCollapsed ? 'Expand account and folder navigation' : 'Collapse account and folder navigation'}
            >
              {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </Button>
          )}
          <Button 
            className="w-full" 
            onClick={compose.openCompose}
            title={sidebarCollapsed && !isMobile ? 'Compose' : undefined}
          >
            <PenSquare className={`h-4 w-4 ${(sidebarCollapsed && !isMobile) ? '' : 'mr-2'}`} />
            {(!sidebarCollapsed || isMobile) && 'Compose'}
          </Button>
        </div>

        {/* Accounts */}
        <div role="region" aria-label="Mail accounts" className="shrink-0 max-h-[40%] overflow-y-auto">
          <div className={`px-4 pb-2 flex items-center ${(sidebarCollapsed && !isMobile) ? 'justify-center' : 'justify-between'}`}>
            {(!sidebarCollapsed || isMobile) && (
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Accounts
              </span>
            )}
            <MailAccountDialog editor={accountEditor} trigger={
              <Button variant="ghost" size="icon" className={`h-6 w-6 ${(sidebarCollapsed && !isMobile) ? 'mx-auto' : ''}`} title={(sidebarCollapsed && !isMobile) ? 'Add Account' : undefined}>
                <Plus className="h-4 w-4" />
              </Button>
            } />
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
                <button type="button"
                  onClick={() => { setSelectedAccount(LEGACY_ACCOUNT); setSelectedFolder(ALL_MAIL); if (isMobile) setMobileSidebarOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${selectedAccount === LEGACY_ACCOUNT ? 'bg-mail/10 text-mail' : 'text-muted-foreground hover:bg-muted'}`}
                  title="Legacy: unresolved mail and mail awaiting a successful server folder check">
                  <FolderOpen className="h-5 w-5 shrink-0" />
                  {(!sidebarCollapsed || isMobile) && <span>Legacy ({legacyCount})</span>}
                </button>
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
                          {(account.disconnected_at || !account.is_active) && <p className="text-xs text-warning">Disconnected · local mail retained</p>}
                          {getServerDeleteStatus(account) && (
                            <p className="text-xs text-destructive truncate">{getServerDeleteStatus(account)}</p>
                          )}
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
                            accountEditor.startEdit(account);
                          }}
                        >
                          <Edit className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          title={account.disconnected_at ? 'Preview permanent purge' : 'Disconnect account and retain mail'}
                          aria-label={account.disconnected_at ? `Preview purge for ${account.email_address}` : `Disconnect ${account.email_address}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (account.disconnected_at) void accountRemoval.openPurgePreview(account.id);
                            else accountRemoval.requestDisconnect(account.id);
                          }}
                        >
                          {account.disconnected_at ? <Trash2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <MailFolderNavigation
          folders={folderFilters}
          systemIds={systemFolders.map(folder => folder.id)}
          selectedFolder={selectedFolder}
          accountLabel={accountLabel}
          collapsed={sidebarCollapsed && !isMobile}
          unreadByFolder={unreadByFolder}
          onSelect={id => { setSelectedFolder(id); if (isMobile) setMobileSidebarOpen(false); }}
          onManage={() => setFolderDialogOpen(true)}
        />
      </div>

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {accounts.find(account => account.id === selectedAccount)?.sync_mode === 'sync' && (
          <div className="border-b border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Sync with server · {accounts.find(account => account.id === selectedAccount)?.sync_status || 'pending'}.
            {' '}Recent mail and older history have separate coverage. Pending read, star and connected-folder moves show your requested state while UniHub checks the provider; uncertain moves are not blindly repeated. Missing server messages stay as local copies.
          </div>
        )}
        <MailSyncAttentionLine operations={writebacks.data ?? []} onReview={() => setSyncPanel('attention')} />
        {selectedAccount === LEGACY_ACCOUNT && (
          <div className="border-b border-border p-3 space-y-2 text-sm">
            <p>These messages retain their original folders. Some need a receiving account; others await a successful server check. Select messages to recover them. Their original mail source is preserved.</p>
            {selectedEmails.size > 0 && <div className="flex flex-wrap gap-2">
              <Select value={recoveryAccount} onValueChange={value => { setRecoveryAccount(value); setRecoveryFolder('inbox'); }}>
                <SelectTrigger className="w-56"><SelectValue placeholder="Receiving account" /></SelectTrigger>
                <SelectContent>{accounts.map(account => <SelectItem key={account.id} value={account.id}>{account.email_address}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={recoveryFolder} onValueChange={setRecoveryFolder}>
                <SelectTrigger className="w-48"><SelectValue placeholder="Destination folder" /></SelectTrigger>
                <SelectContent>{mailFolders.filter(folder => folder.is_system || folder.mail_account_id === recoveryAccount || folder.connected_account_ids?.includes(recoveryAccount)).map(folder =>
                  <SelectItem key={folder.slug} value={folder.slug}>{folder.display_name}</SelectItem>)}</SelectContent>
              </Select>
              <Button disabled={!recoveryAccount} onClick={() => runBulk('move', { emailIds: Array.from(selectedEmails), folder: recoveryFolder, accountId: recoveryAccount }, bulkMove.mutateAsync)}>Recover selected mail</Button>
            </div>}
          </div>
        )}
        {/* Header */}
        <div className="min-h-14 border-b border-border flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {isMobile && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setMobileSidebarOpen(true)}
                title="Choose account and folder"
                aria-label="Choose account and folder"
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
              <span className="text-sm text-muted-foreground min-w-0 truncate">
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
                <div className="relative order-last w-full min-w-[180px] sm:order-none sm:ml-4 sm:max-w-md sm:flex-1">
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
            {selectedEmails.size > 0 && isMobile && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" title="Selection actions">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-[70vh] overflow-y-auto">
                  <DropdownMenuItem onClick={() => runBulk('read', { emailIds: Array.from(selectedEmails), is_read: true }, bulkMarkRead.mutateAsync)}>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Mark read
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => runBulk('read', { emailIds: Array.from(selectedEmails), is_read: false }, bulkMarkRead.mutateAsync)}>
                    <Mail className="h-4 w-4 mr-2" />
                    Mark unread
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => runBulk('star', { emailIds: Array.from(selectedEmails), is_starred: true }, bulkStar.mutateAsync)}>
                    <Star className="h-4 w-4 mr-2" />
                    Star
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {folders
                    .filter((folder) => movableFolderIds.includes(folder.id) && folder.id !== selectedFolder)
                    .map((folder) => (
                      <DropdownMenuItem
                        key={folder.id}
                        onClick={() => runBulk('move', { emailIds: Array.from(selectedEmails), folder: folder.id }, bulkMove.mutateAsync)}
                      >
                        <folder.icon className="h-4 w-4 mr-2" />
                        Move to {folder.label}
                      </DropdownMenuItem>
                    ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => runBulk('delete', createTrashMovePayload(Array.from(selectedEmails)), bulkDelete.mutateAsync)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {selectedEmails.size > 0 && !isMobile && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => runBulk('read', { emailIds: Array.from(selectedEmails), is_read: true }, bulkMarkRead.mutateAsync)}
                  disabled={bulkPending.has(bulkKey('read', { emailIds: Array.from(selectedEmails), is_read: true }))}
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Mark Read
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => runBulk('read', { emailIds: Array.from(selectedEmails), is_read: false }, bulkMarkRead.mutateAsync)}
                  disabled={bulkPending.has(bulkKey('read', { emailIds: Array.from(selectedEmails), is_read: false }))}
                >
                  <Mail className="h-4 w-4 mr-2" />
                  Mark Unread
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => runBulk('star', { emailIds: Array.from(selectedEmails), is_starred: true }, bulkStar.mutateAsync)}
                  disabled={bulkPending.has(bulkKey('star', { emailIds: Array.from(selectedEmails), is_starred: true }))}
                >
                  <Star className="h-4 w-4 mr-2" />
                  Star
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
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
                          onClick={() => runBulk('move', { emailIds: Array.from(selectedEmails), folder: folder.id }, bulkMove.mutateAsync)}
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
                  onClick={() => runBulk('delete', createTrashMovePayload(Array.from(selectedEmails)), bulkDelete.mutateAsync)}
                  disabled={bulkPending.has(bulkKey('delete', createTrashMovePayload(Array.from(selectedEmails))))}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </Button>
              </>
            )}
            <MailSyncControl accounts={accounts}
              viewAccountIds={activeMailAccountId ? [activeMailAccountId] : accounts.filter(account => account.is_active).map(account => account.id)}
              jobs={syncJobs.data ?? []} jobsError={syncJobs.isError} operations={writebacks.data ?? []} operationsError={writebacks.isError}
              syncing={syncingAccountIds} cancelling={cancellingAccountIds} onSync={requestSync} onCancel={requestCancel}
              panel={syncPanel} onPanelChange={setSyncPanel} touch={isMobile} />
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
              <Button onClick={() => accountEditor.openAdd()}>
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
                      await loadEmailForReader(email.id);
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
                        requestFlag(email, 'star', !email.is_starred);
                      }}
                      aria-label={email.is_starred ? `Unstar ${email.subject || 'message'}` : `Star ${email.subject || 'message'}`}
                    >
                      <Star className={`h-4 w-4 ${email.is_starred ? 'fill-warning text-warning' : 'text-muted-foreground'}`} />
                    </Button>
                    <div className="flex-1 min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          {!email.is_read && (
                            <span className="h-2 w-2 rounded-full bg-accent shrink-0" />
                          )}
                          <span className={`font-medium truncate ${!email.is_read ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}>
                            {email.from_name || email.from_address}
                          </span>
                          {(email.read_sync_pending || email.star_sync_pending) && <span className="shrink-0 text-xs text-muted-foreground">
                            {email.read_sync_pending && email.star_sync_pending ? 'Read and star changes awaiting provider' : email.read_sync_pending ? 'Read change awaiting provider' : 'Star change awaiting provider'}
                          </span>}
                          {(flagRequests.has(`read:${email.id}`) || flagRequests.has(`star:${email.id}`)) && <span className="shrink-0 text-xs text-muted-foreground">Saving change…</span>}
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {format(new Date(email.received_at), 'MMM d, yyyy')}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className={`truncate flex-1 ${!email.is_read ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                          {email.subject || '(No subject)'}
                        </p>
                        {accounts.find(account => account.id === email.mail_account_id)?.disconnected_at && <span className="shrink-0 rounded border border-border px-1 text-xs text-muted-foreground" title="This account is disconnected; this mail is retained locally, not verified at the provider">Disconnected · local mail</span>}
                        {email.remote_missing && <span className="shrink-0 rounded border border-border px-1 text-xs text-muted-foreground" title="No currently verified provider occurrence; local copy retained">Local copy · provider presence unverified</span>}
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

      {isReaderLoading && <div role="status" className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border bg-card p-3 shadow-lg"><Loader2 className="h-4 w-4 animate-spin" />Loading email…<Button size="sm" variant="ghost" onClick={closeReader}>Cancel</Button></div>}

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
                requestFlag(contextMenuEmail.email, 'read', true);
              } else {
                requestFlag(contextMenuEmail.email, 'read', false);
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
              requestFlag(contextMenuEmail.email, 'star', !contextMenuEmail.email.is_starred);
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
                  runBulk('move', { emailIds: [contextMenuEmail.email.id], folder: folder.id }, bulkMove.mutateAsync);
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
              if (contextMenuEmail.email.is_draft || contextMenuEmail.email.folder === 'drafts') {
                compose.setDraftToDelete(contextMenuEmail.email);
              } else {
                runBulk('delete', createTrashMovePayload([contextMenuEmail.email.id]), bulkDelete.mutateAsync);
              }
              setContextMenuEmail(null);
            }}
          >
            <Trash2 className="h-4 w-4" />
            {contextMenuEmail.email.is_draft || contextMenuEmail.email.folder === 'drafts' ? 'Delete draft' : 'Delete'}
          </button>
        </div>
        </>
      )}

      <MailAccountRemovalDialogs removal={accountRemoval} />

      {/* Email Reader */}
      {selectedEmail && (
        <div className="fixed inset-0 z-50 bg-background xl:relative xl:inset-auto xl:z-auto xl:h-full xl:w-[45%] xl:shrink-0 xl:border-l xl:border-border">
          <div className="flex flex-col h-full">
            {/* Header */}
            <div className="shrink-0 border-b border-border p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-2 sm:gap-4">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Back to ${accountLabel}, ${folderLabel}`}
                  title={`Back to ${accountLabel}, ${folderLabel}`}
                  onClick={() => {
                    if (compose.isReplying && compose.isDirty) {
                      compose.closeComposeFlow();
                      return;
                    }
                    closeReader();
                    compose.resetComposeState();
                  }}
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <span className="text-xs text-muted-foreground truncate max-w-64">{accountLabel} / {folderLabel}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => compose.startResponse(selectedEmail, 'reply')}
                  >
                    <Reply className="h-4 w-4 mr-2" />
                    Reply
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => compose.startResponse(selectedEmail, 'forward')}
                  >
                    <Forward className="h-4 w-4 mr-2" />
                    Forward
                  </Button>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2 ml-auto">
                {accounts.find(account => account.id === selectedEmail.mail_account_id)?.disconnected_at && <span className="text-xs text-muted-foreground">Disconnected · retained locally; provider presence unverified</span>}
                {selectedEmail.remote_missing && <span className="text-xs text-muted-foreground">Local copy · provider presence unverified</span>}
                {(selectedEmail.read_sync_pending || selectedEmail.star_sync_pending) && <span className="text-xs text-muted-foreground">
                  {selectedEmail.read_sync_pending && selectedEmail.star_sync_pending ? 'Read and star changes awaiting provider' : selectedEmail.read_sync_pending ? 'Read change awaiting provider' : 'Star change awaiting provider'}
                </span>}
                {(flagRequests.has(`read:${selectedEmail.id}`) || flagRequests.has(`star:${selectedEmail.id}`)) && <span className="text-xs text-muted-foreground">Saving change…</span>}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => requestFlag(selectedEmail, 'read', !selectedEmail.is_read)}
                >
                  {selectedEmail.is_read ? (
                    <>
                      <Mail className="h-4 w-4 mr-2" />
                      Mark unread
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                      Mark read
                    </>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={selectedEmail.is_starred ? 'Unstar message' : 'Star message'}
                  onClick={() => requestFlag(selectedEmail, 'star', !selectedEmail.is_starred)}
                >
                  <Star className={`h-5 w-5 ${selectedEmail.is_starred ? 'fill-warning text-warning' : 'text-muted-foreground'}`} />
                </Button>
              </div>
            </div>
            
            {/* Email Content */}
            <div className={`flex-1 overflow-auto p-6 ${!isMobile && compose.isReplying ? 'pb-0' : ''}`}>
              <div className="max-w-4xl mx-auto space-y-4">
                <div>
                  <h1 className="text-2xl font-bold mb-4">{selectedEmail.subject || '(No subject)'}</h1>
                  {selectedEmail.remote_missing && <p className="mb-4 rounded-md border border-border p-3 text-sm text-muted-foreground">Local copy: this email was not found on the server during the last complete sync. Its content and attachments are kept here.</p>}
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
            {!isMobile && compose.isReplying && <MailInlineCompose compose={compose} />}
          </div>
        </div>
      )}

      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Mail folders</DialogTitle>
            <DialogDescription>
              Select one mail account to create a folder on that account. In Sync mode, new moves to connected server folders also move mail on the server. Download mode, local copies and Legacy mail keep moves local. Existing server folders are connected during sync. Rename or delete provider folders at your mail provider.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {(!activeMailAccountId) && <p className="text-sm text-muted-foreground">Choose a mail account in the sidebar before adding a folder.</p>}
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
                disabled={createFolder.isPending || !newFolderName.trim() || !activeMailAccountId}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add
              </Button>
            </div>
            <div className="space-y-2 max-h-[360px] overflow-y-auto">
              {visibleMailFolders.map((folder) => (
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
                        {folder.total_count || 0} messages • {folder.is_system ? 'system' : folder.mail_account_id ? accounts.find(account => account.id === folder.mail_account_id)?.email_address : 'Shared server folder'}
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
                        disabled
                        title="Rename provider folders at your mail provider"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        onClick={() => setFolderToDelete(folder)}
                        disabled
                        title="Delete provider folders at your mail provider"
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

      <MailComposeDialogs compose={compose} />

      <AlertDialog open={!!folderToDelete} onOpenChange={(open) => !open && setFolderToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder?</AlertDialogTitle>
            <AlertDialogDescription>
              Messages and routing rules in {folderToDelete?.display_name || 'this folder'} will move back to Inbox.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (folderToDelete) {
                  deleteFolder.mutate(folderToDelete.slug);
                  setFolderToDelete(null);
                }
              }}
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <MailComposeDialog compose={compose} accounts={accounts} isMobile={isMobile} onSelectAccount={setSelectedAccount} />

    </div>
  );
};

export default MailPage;
