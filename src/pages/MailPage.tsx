import { MailAccountDialog } from '@/components/mail/MailAccountDialog';
import { useMailAccountEditor } from '@/hooks/use-mail-account-editor';
import { MailComposeDialog, MailComposeDialogs, MailInlineCompose } from '@/components/mail/MailCompose';
import { useMailCompose } from '@/hooks/use-mail-compose';
import { MailFolderDialogs } from '@/components/mail/MailFolderDialogs';
import { MailReader } from '@/components/mail/MailReader';
import { MailAccountList, MailSidebar } from '@/components/mail/MailSidebar';
import { MailAccountRemovalDialogs } from '@/components/mail/MailAccountRemovalDialogs';
import { useMailAccountRemoval } from '@/hooks/use-mail-account-removal';
import { MailSyncAttentionLine, MailSyncControl, type SyncPanelFocus } from '@/components/mail/MailSyncControl';
import { useMailSyncJobs } from '@/hooks/use-mail-sync-jobs';
import { useMailWritebacks } from '@/hooks/use-mail-writebacks';
import { useMailAccountSelection, useRememberedMailAccount } from '@/hooks/use-mail-account-selection';
import { useMailFolderView } from '@/hooks/use-mail-folder-view';
import { useMailListView } from '@/hooks/use-mail-list-view';
import { useMailListSelection, useMailListShortcuts } from '@/hooks/use-mail-list-selection';
import { useMailBulkActions } from '@/hooks/use-mail-bulk-actions';
import MailFolderNavigation from '@/components/mail/MailFolderNavigation';
import { plainTextToHtml, escapeHtml, sanitizeReturnTo, isComposeHtmlEmpty, isComposeMeaningful, validateComposeAttachments } from '@/lib/mail-compose';
import { useMailReader, useMailReaderRefresh } from '@/hooks/use-mail-reader';
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
  const { data: accounts = [], isLoading: accountsLoading } = useMailAccounts();
  const folderView = useMailFolderView(selectedAccount, accounts);
  const { selectedFolder, setSelectedFolder, folders, movableFolderIds, mailFolders, visibleMailFolders, folderFilters, legacyCount, unreadByFolder } = folderView;
  useRememberedMailAccount(accounts, selectedAccount, setSelectedAccount, setSelectedFolder);

  const { selectedEmail, setSelectedEmail, isReaderLoading, closeReader, loadEmail } = useMailReader(selectedAccount);
  const { flagRequests, requestFlag } = useMailFlags(setSelectedEmail, (kind, message, unknown) => {
    toast({ title: unknown ? `${kind === 'read' ? 'Read' : 'Star'} request outcome unknown` : kind === 'read' ? 'Failed to update read status' : 'Failed to update star', description: message, variant: 'destructive' });
  });
  const { refreshSettledEmail, supersedeRefresh } = useMailReaderRefresh(selectedEmail?.id, setSelectedEmail);
  const accountEditor = useMailAccountEditor();
  const compose = useMailCompose({ activeMailAccountId, selectedAccount, setSelectedAccount, isMobile });
  const accountRemoval = useMailAccountRemoval(() => setSelectedAccount(ALL_ACCOUNTS));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [contextMenuEmail, setContextMenuEmail] = useState<{ email: Email; x: number; y: number } | null>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [recoveryAccount, setRecoveryAccount] = useState('');
  const [recoveryFolder, setRecoveryFolder] = useState('inbox');
  const { jobs: syncJobs, requestSync, syncingAccountIds, requestCancel, cancellingAccountIds } = useMailSyncJobs(accounts);
  const writebacks = useMailWritebacks(refreshSettledEmail);
  const [syncPanel, setSyncPanel] = useState<SyncPanelFocus | null>(null);

  const list = useMailListView(selectedAccount, selectedFolder);
  const { searchQuery, setSearchQuery, showUnreadOnly, setShowUnreadOnly, emails } = list;
  const selection = useMailListSelection(`${selectedAccount ?? ''}\n${selectedFolder}`, emails);
  const { selectedEmails, selectedIds } = selection;
  const bulk = useMailBulkActions({ emails, selectedEmail, selectedFolder, requestFlag, clearSelection: selection.clearSelection });
  useMailListShortcuts(selection, emails, bulk.trash);

  const loadEmailForReader = React.useCallback((emailId: string) => {
    supersedeRefresh();
    return loadEmail(emailId, {
      onDraft: compose.openDraftForCompose,
      reconcileEmail: captureMailFlagReconciler(queryClient),
      onMarkRead: (email) => requestFlag(email, 'read', true),
      onError: (message) => toast({ title: 'Failed to load email', description: message, variant: 'destructive' }),
    });
  }, [loadEmail, supersedeRefresh, compose.openDraftForCompose, requestFlag, queryClient, toast]);

  // Open a message linked from a notification or search, then drop the parameter.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const emailId = params.get('email');
    if (!emailId) return;

    void loadEmailForReader(emailId);
    params.delete('email');
    navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, { replace: true });
  }, [loadEmailForReader, location.pathname, location.search, location.hash, navigate]);

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
      <MailSidebar isMobile={isMobile} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed(!sidebarCollapsed)}
        mobileOpen={mobileSidebarOpen} onMobileOpenChange={setMobileSidebarOpen} onCompose={compose.openCompose}>
        <MailAccountList accounts={accounts} loading={accountsLoading} selectedAccount={selectedAccount} legacyCount={legacyCount}
          compact={sidebarCollapsed && !isMobile}
          addAccount={<MailAccountDialog editor={accountEditor} trigger={
            <Button variant="ghost" size="icon" className={`h-6 w-6 ${(sidebarCollapsed && !isMobile) ? 'mx-auto' : ''}`} title={(sidebarCollapsed && !isMobile) ? 'Add Account' : undefined}>
              <Plus className="h-4 w-4" />
            </Button>
          } />}
          onSelect={id => {
            setSelectedAccount(id);
            if (id === LEGACY_ACCOUNT) setSelectedFolder(ALL_MAIL);
            if (isMobile) setMobileSidebarOpen(false);
          }}
          onEdit={accountEditor.startEdit}
          onRemove={account => {
            if (account.disconnected_at) void accountRemoval.openPurgePreview(account.id);
            else accountRemoval.requestDisconnect(account.id);
          }} />
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
      </MailSidebar>

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
              <Button disabled={!recoveryAccount} onClick={() => bulk.move(selectedIds, recoveryFolder, recoveryAccount)}>Recover selected mail</Button>
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
                onClick={selection.toggleAll}
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
                  <DropdownMenuItem onClick={() => bulk.setRead(selectedIds, true)}>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Mark read
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => bulk.setRead(selectedIds, false)}>
                    <Mail className="h-4 w-4 mr-2" />
                    Mark unread
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => bulk.star(selectedIds)}>
                    <Star className="h-4 w-4 mr-2" />
                    Star
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {folders
                    .filter((folder) => movableFolderIds.includes(folder.id) && folder.id !== selectedFolder)
                    .map((folder) => (
                      <DropdownMenuItem
                        key={folder.id}
                        onClick={() => bulk.move(selectedIds, folder.id)}
                      >
                        <folder.icon className="h-4 w-4 mr-2" />
                        Move to {folder.label}
                      </DropdownMenuItem>
                    ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => bulk.trash(selectedIds)}
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
                  onClick={() => bulk.setRead(selectedIds, true)}
                  disabled={bulk.readPending(selectedIds, true)}
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Mark Read
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => bulk.setRead(selectedIds, false)}
                  disabled={bulk.readPending(selectedIds, false)}
                >
                  <Mail className="h-4 w-4 mr-2" />
                  Mark Unread
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => bulk.star(selectedIds)}
                  disabled={bulk.starPending(selectedIds)}
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
                          onClick={() => bulk.move(selectedIds, folder.id)}
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
                  onClick={() => bulk.trash(selectedIds)}
                  disabled={bulk.trashPending(selectedIds)}
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
          ) : list.isLoading ? (
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
                        onClick={(e) => selection.toggleEmail(email.id, e)}
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
                <>Found {list.totalMatching} result{list.totalMatching !== 1 ? 's' : ''} for "{searchQuery}"{showUnreadOnly ? ' (unread only)' : ''}</>
              )}
              {!searchQuery.trim() && showUnreadOnly && (
                <>Showing {list.totalMatching} unread email{list.totalMatching !== 1 ? 's' : ''}</>
              )}
            </div>
          )}
          
          {/* Pagination */}
          {list.totalPages > 1 && (
            <div className="border-t border-border p-4">
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => list.setPage(p => Math.max(1, p - 1))}
                      disabled={list.page === 1}
                      className="gap-1"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </Button>
                  </PaginationItem>
                  {Array.from({ length: Math.min(5, list.totalPages) }, (_, i) => {
                    let pageNum;
                    if (list.totalPages <= 5) {
                      pageNum = i + 1;
                    } else if (list.page <= 3) {
                      pageNum = i + 1;
                    } else if (list.page >= list.totalPages - 2) {
                      pageNum = list.totalPages - 4 + i;
                    } else {
                      pageNum = list.page - 2 + i;
                    }
                    return (
                      <PaginationItem key={pageNum}>
                        <Button
                          variant={list.page === pageNum ? 'outline' : 'ghost'}
                          size="icon"
                          onClick={() => list.setPage(pageNum)}
                          className={list.page === pageNum ? 'font-semibold' : ''}
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
                      onClick={() => list.setPage(p => Math.min(list.totalPages, p + 1))}
                      disabled={list.page === list.totalPages}
                      className="gap-1"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
              <div className="text-center text-sm text-muted-foreground mt-2">
                Page {list.pagination?.page || list.page} of {list.totalPages} ({list.totalMatching} email{list.totalMatching !== 1 ? 's' : ''})
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
                  bulk.move([contextMenuEmail.email.id], folder.id);
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
                bulk.trash([contextMenuEmail.email.id]);
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

      {selectedEmail && (
        <MailReader email={selectedEmail} accounts={accounts} location={`${accountLabel} / ${folderLabel}`}
          backLabel={`Back to ${accountLabel}, ${folderLabel}`} isMobile={isMobile} isReplying={compose.isReplying}
          flagRequests={flagRequests} requestFlag={requestFlag} senderInContacts={senderAlreadyInContacts}
          onBack={() => {
            if (compose.isReplying && compose.isDirty) {
              compose.closeComposeFlow();
              return;
            }
            closeReader();
            compose.resetComposeState();
          }}
          onReply={() => compose.startResponse(selectedEmail, 'reply')}
          onForward={() => compose.startResponse(selectedEmail, 'forward')}
          inlineCompose={!isMobile && compose.isReplying && <MailInlineCompose compose={compose} />} />
      )}

      <MailFolderDialogs open={folderDialogOpen} onOpenChange={setFolderDialogOpen} activeMailAccountId={activeMailAccountId}
        folders={visibleMailFolders} accounts={accounts} selectedFolder={selectedFolder} onSelectFolder={setSelectedFolder} />

      <MailComposeDialogs compose={compose} />

      <MailComposeDialog compose={compose} accounts={accounts} isMobile={isMobile} onSelectAccount={setSelectedAccount} />

    </div>
  );
};

export default MailPage;
