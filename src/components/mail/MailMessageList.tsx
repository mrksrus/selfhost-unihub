import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { format } from 'date-fns';
import { CheckCircle2, CheckSquare, ChevronLeft, ChevronRight, FolderOpen, Inbox, Loader2, Mail, Menu, MoreVertical, Paperclip, Plus, Search, Square, Star, Trash2, X } from 'lucide-react';
import type { Email, MailAccount, MailFlagKind, MailFolder } from '@/lib/mail-api';
import type { MailListView } from '@/hooks/use-mail-list-view';
import type { MailListSelection } from '@/hooks/use-mail-list-selection';
import type { MailBulkActions } from '@/hooks/use-mail-bulk-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import { ALL_ACCOUNTS, ALL_MAIL, flagPendingLabel, type MailFolderItem } from '@/components/mail/mail-page-model';

/** Legacy view: recover checked messages into a receiving account and folder. */
export function MailLegacyRecovery({ accounts, folders, selectedIds, onRecover }: {
  accounts: MailAccount[]; folders: MailFolder[]; selectedIds: string[]; onRecover: (accountId: string, folder: string) => void;
}) {
  const [recoveryAccount, setRecoveryAccount] = useState('');
  const [recoveryFolder, setRecoveryFolder] = useState('inbox');
  return (
    <div className="border-b border-border p-3 space-y-2 text-sm">
      <p>These messages retain their original folders. Some need a receiving account; others await a successful server check. Select messages to recover them. Their original mail source is preserved.</p>
      {selectedIds.length > 0 && <div className="flex flex-wrap gap-2">
        <Select value={recoveryAccount} onValueChange={value => { setRecoveryAccount(value); setRecoveryFolder('inbox'); }}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Receiving account" /></SelectTrigger>
          <SelectContent>{accounts.map(account => <SelectItem key={account.id} value={account.id}>{account.email_address}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={recoveryFolder} onValueChange={setRecoveryFolder}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Destination folder" /></SelectTrigger>
          <SelectContent>{folders.filter(folder => folder.is_system || folder.mail_account_id === recoveryAccount || folder.connected_account_ids?.includes(recoveryAccount)).map(folder =>
            <SelectItem key={folder.slug} value={folder.slug}>{folder.display_name}</SelectItem>)}</SelectContent>
        </Select>
        <Button disabled={!recoveryAccount} onClick={() => onRecover(recoveryAccount, recoveryFolder)}>Recover selected mail</Button>
      </div>}
    </div>
  );
}

interface ToolbarProps {
  isMobile: boolean;
  onOpenSidebar: () => void;
  emailCount: number;
  selection: MailListSelection;
  folderLabel: string;
  accountLabel: string;
  /** The selected account view; filters and search appear once there is one. */
  account: string | null;
  list: MailListView;
  bulk: MailBulkActions;
  /** Folders the checked messages can move to. */
  moveTargets: MailFolderItem[];
  syncControl: ReactNode;
}

/** List header: folder and account, unread filter, search, selection actions and the sync control. */
export function MailListToolbar({ isMobile, onOpenSidebar, emailCount, selection, folderLabel, accountLabel, account, list, bulk,
  moveTargets, syncControl }: ToolbarProps) {
  const { selectedEmails, selectedIds } = selection;
  return (
    <div className="min-h-14 border-b border-border flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenSidebar}
            title="Choose account and folder"
            aria-label="Choose account and folder"
            className="shrink-0"
          >
            <Menu className="h-5 w-5" />
          </Button>
        )}
        {emailCount > 0 && (
          <Button
            variant="ghost"
            size="icon"
            onClick={selection.toggleAll}
            title={selectedEmails.size === emailCount ? 'Deselect all' : 'Select all'}
            className="shrink-0"
          >
            {selectedEmails.size === emailCount ? (
              <CheckSquare className="h-4 w-4" />
            ) : (
              <Square className="h-4 w-4" />
            )}
          </Button>
        )}
        <h2 className="font-semibold shrink-0">{folderLabel}</h2>
        {!selectedEmails.size && account && (
          <span className="text-sm text-muted-foreground min-w-0 truncate">
            {accountLabel}
          </span>
        )}
        {selectedEmails.size > 0 && (
          <span className="text-sm text-muted-foreground shrink-0">
            ({selectedEmails.size} selected)
          </span>
        )}
        {account && !selectedEmails.size && (
          <>
            <Button
              variant={list.showUnreadOnly ? "default" : "outline"}
              size="sm"
              onClick={() => list.setShowUnreadOnly(!list.showUnreadOnly)}
              className="shrink-0"
              title={list.showUnreadOnly ? "Show all emails" : "Show only unread emails"}
            >
              <Mail className="h-4 w-4 mr-2" />
              {list.showUnreadOnly ? 'Unread Only' : 'All'}
            </Button>
            <div className="relative order-last w-full min-w-[180px] sm:order-none sm:ml-4 sm:max-w-md sm:flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search emails..."
                value={list.searchQuery}
                onChange={(e) => list.setSearchQuery(e.target.value)}
                className="pl-9 h-9"
              />
              {list.searchQuery && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                  onClick={() => list.setSearchQuery('')}
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
              {moveTargets
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
                {moveTargets
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
        {syncControl}
      </div>
    </div>
  );
}

interface ListProps {
  account: string | null;
  folder: string;
  folderLabel: string;
  accountLabel: string;
  list: MailListView;
  selection: MailListSelection;
  accounts: MailAccount[];
  flagRequests: Set<string>;
  requestFlag: (email: Email, kind: MailFlagKind, value: boolean) => void;
  onOpen: (emailId: string) => Promise<void> | void;
  onContextMenu: (email: Email, x: number, y: number) => void;
  onAddAccount: () => void;
}

/** Message rows with loading/empty states, the filter summary and pagination. */
export function MailMessageList({ account, folder, folderLabel, accountLabel, list, selection, accounts, flagRequests, requestFlag,
  onOpen, onContextMenu, onAddAccount }: ListProps) {
  const { emails } = list;
  return (
    <div className="flex-1 overflow-auto">
      {!account ? (
        <div className="flex flex-col items-center justify-center h-full text-center p-8">
          <Mail className="h-16 w-16 text-muted-foreground/30 mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">No account selected</h3>
          <p className="text-muted-foreground mb-4 max-w-sm">
            Select an email account from the sidebar or add a new one to get started.
          </p>
          <Button onClick={onAddAccount}>
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
            {list.searchQuery.trim() 
              ? 'No search results' 
              : list.showUnreadOnly 
                ? 'No unread emails' 
                : folder === ALL_MAIL
                  ? `No emails in ${accountLabel}`
                  : `No emails in ${folderLabel}`
            }
          </h3>
          <p className="text-muted-foreground">
            {list.searchQuery.trim()
              ? `No emails found matching "${list.searchQuery}"${list.showUnreadOnly ? ' in unread emails' : ''}`
              : list.showUnreadOnly
                ? folder === ALL_MAIL
                  ? `No unread emails across ${accountLabel.toLowerCase()}.`
                  : `No unread emails in ${folder === 'inbox' ? 'your inbox' : `your ${folderLabel.toLowerCase()} folder`}.`
                : folder === 'inbox'
                  ? account === ALL_ACCOUNTS
                    ? 'All inboxes are empty. Select a specific account to sync.'
                    : 'Your inbox is empty. Sync your account to fetch emails.'
                  : folder === ALL_MAIL
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
                } ${selection.selectedEmails.has(email.id) ? 'bg-accent/10 ring-2 ring-accent' : ''}`}
                onClick={async (e) => {
                  // If clicking checkbox area, don't open email
                  if ((e.target as HTMLElement).closest('.email-checkbox')) {
                    return;
                  }
                  await onOpen(email.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu(email, e.clientX, e.clientY);
                }}
              >
                <div className="email-checkbox shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={(e) => selection.toggleEmail(email.id, e)}
                  >
                    {selection.selectedEmails.has(email.id) ? (
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
                        {flagPendingLabel(email)}
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
      {(list.searchQuery.trim() || list.showUnreadOnly) && emails.length > 0 && (
        <div className="border-t border-border p-4 text-center text-sm text-muted-foreground">
          {list.searchQuery.trim() && (
            <>Found {list.totalMatching} result{list.totalMatching !== 1 ? 's' : ''} for "{list.searchQuery}"{list.showUnreadOnly ? ' (unread only)' : ''}</>
          )}
          {!list.searchQuery.trim() && list.showUnreadOnly && (
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
  );
}

interface ContextMenuProps {
  target: { email: Email; x: number; y: number };
  onClose: () => void;
  requestFlag: (email: Email, kind: MailFlagKind, value: boolean) => void;
  /** Folders of the current view that accept moves; the message's own folder is left out. */
  movableFolders: MailFolderItem[];
  bulk: MailBulkActions;
  onDeleteDraft: (draft: Email) => void;
}

/** Right-click menu of a message row. */
export function MailContextMenu({ target, onClose, requestFlag, movableFolders, bulk, onDeleteDraft }: ContextMenuProps) {
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={() => onClose()}
      />
      <div
        className="fixed z-50 bg-popover border border-border rounded-md shadow-lg p-1 min-w-[200px]"
        style={{ left: target.x, top: target.y }}
      >
        <button
          className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
          onClick={() => {
            if (!target.email.is_read) {
              requestFlag(target.email, 'read', true);
            } else {
              requestFlag(target.email, 'read', false);
            }
            onClose();
          }}
        >
          <CheckCircle2 className="h-4 w-4" />
          {target.email.is_read ? 'Mark as Unread' : 'Mark as Read'}
        </button>
        <button
          className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
          onClick={() => {
            requestFlag(target.email, 'star', !target.email.is_starred);
            onClose();
          }}
        >
          <Star className={`h-4 w-4 ${target.email.is_starred ? 'fill-warning text-warning' : ''}`} />
          {target.email.is_starred ? 'Unstar' : 'Star'}
        </button>
        <div className="border-t border-border my-1" />
        {movableFolders
          .filter((folder) => folder.id !== target.email.folder)
          .map((folder) => (
            <button
              key={`context-move-${folder.id}`}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
              onClick={() => {
                bulk.move([target.email.id], folder.id);
                onClose();
              }}
            >
              <folder.icon className="h-4 w-4" />
              Move to {folder.label}
            </button>
          ))}
        <button
          className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2 text-destructive"
          onClick={() => {
            if (target.email.is_draft || target.email.folder === 'drafts') {
              onDeleteDraft(target.email);
            } else {
              bulk.trash([target.email.id]);
            }
            onClose();
          }}
        >
          <Trash2 className="h-4 w-4" />
          {target.email.is_draft || target.email.folder === 'drafts' ? 'Delete draft' : 'Delete'}
        </button>
    </div>
    </>
  );
}
