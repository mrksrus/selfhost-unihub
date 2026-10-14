import { CheckCircle2, CheckSquare, ChevronLeft, ChevronRight, Inbox, ListTodo, Mail, Paperclip, Plus, Square, Star, Trash2 } from 'lucide-react';
import type { Email, MailAccount, MailFlagKind } from '@/lib/mail-api';
import type { MailListView } from '@/hooks/use-mail-list-view';
import type { MailListSelection } from '@/hooks/use-mail-list-selection';
import type { MailBulkActions } from '@/hooks/use-mail-bulk-actions';
import { Button } from '@/components/ui/button';
import { EmptyState, LoadingState } from '@/components/ui/page-states';
import { cn } from '@/lib/utils';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import { MailPendingMark } from '@/components/mail/MailPendingMark';
import { ALL_ACCOUNTS, ALL_MAIL, formatListDate, type MailFolderItem } from '@/components/mail/mail-page-model';

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

function emptyText(list: MailListView, account: string | null, folder: string, folderLabel: string, accountLabel: string) {
  const search = list.searchQuery.trim();
  if (search) return { title: 'No search results', description: `Nothing matches "${list.searchQuery}"${list.showUnreadOnly ? ' among unread mail' : ''}.` };
  if (list.showUnreadOnly) return {
    title: 'No unread mail',
    description: folder === ALL_MAIL ? `Everything in ${accountLabel.toLowerCase()} is read.` : `Everything in ${folder === 'inbox' ? 'your inbox' : folderLabel} is read.`,
  };
  if (folder === 'inbox') return {
    title: 'Inbox is empty',
    description: account === ALL_ACCOUNTS ? 'New mail from every account appears here.' : 'Sync the account to fetch new mail.',
  };
  return { title: folder === ALL_MAIL ? `No mail in ${accountLabel}` : `No mail in ${folderLabel}`, description: undefined };
}

/** Message rows with loading/empty states, the filter summary and pagination. */
export function MailMessageList({ account, folder, folderLabel, accountLabel, list, selection, accounts, flagRequests, requestFlag,
  onOpen, onContextMenu, onAddAccount }: ListProps) {
  const { emails } = list;
  const empty = emptyText(list, account, folder, folderLabel, accountLabel);
  return (
    <div className="min-h-0 flex-1 overflow-auto pb-mobile-nav md:pb-0">
      {!account ? (
        <EmptyState icon={Mail} title="No mail account yet" description="Add the account you want to read here. UniHub keeps a copy and syncs with your provider."
          action={<Button onClick={onAddAccount}><Plus aria-hidden="true" />Add mail account</Button>} />
      ) : list.isLoading ? (
        <LoadingState label="Loading mail…" />
      ) : emails.length === 0 ? (
        <EmptyState icon={Inbox} title={empty.title} description={empty.description} />
      ) : (
        <ul aria-label={`${folderLabel}, ${accountLabel}`}>
          {emails.map((email) => {
            const selected = selection.selectedEmails.has(email.id);
            const unread = !email.is_read;
            const disconnected = accounts.find(entry => entry.id === email.mail_account_id)?.disconnected_at;
            return (
              <li
                key={email.id}
                className={cn('group flex items-start gap-1 border-b border-border py-2.5 pl-2 pr-4 transition-colors md:pl-4 md:pr-6',
                  selected ? 'bg-accent/10' : 'hover:bg-muted/40')}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContextMenu(email, e.clientX, e.clientY);
                }}
              >
                <div className="email-checkbox flex shrink-0 flex-col items-center touch:gap-1">
                  <Button variant="ghost" size="icon-sm" aria-pressed={selected}
                    aria-label={`Select ${email.subject || 'message'}`} onClick={(e) => selection.toggleEmail(email.id, e)}>
                    {selected ? <CheckSquare aria-hidden="true" className="text-accent" /> : <Square aria-hidden="true" className="text-muted-foreground/70" />}
                  </Button>
                  <Button variant="ghost" size="icon-sm"
                    onClick={(e) => { e.stopPropagation(); requestFlag(email, 'star', !email.is_starred); }}
                    aria-label={email.is_starred ? `Unstar ${email.subject || 'message'}` : `Star ${email.subject || 'message'}`}>
                    <Star aria-hidden="true" className={email.is_starred ? 'fill-warning text-warning' : 'text-muted-foreground/70'} />
                  </Button>
                </div>
                <button type="button" className="min-w-0 flex-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  onClick={() => { void onOpen(email.id); }}>
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 self-center rounded-full', unread ? 'bg-accent' : 'bg-transparent')} />
                    <span className={cn('min-w-0 truncate', unread ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                      {email.from_name || email.from_address}
                    </span>
                    {unread && <span className="sr-only">(unread)</span>}
                    <span className="ml-auto flex shrink-0 items-center gap-2 self-center pl-2">
                      <MailPendingMark email={email} saving={flagRequests.has(`read:${email.id}`) || flagRequests.has(`star:${email.id}`)} />
                      <span className="text-xs tabular-nums text-muted-foreground">{formatListDate(email.received_at)}</span>
                    </span>
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-2 pl-4">
                    <span className={cn('min-w-0 flex-1 truncate', unread ? 'text-foreground' : 'text-muted-foreground')}>{email.subject || '(No subject)'}</span>
                    {!!email.has_attachments && <Paperclip
 aria-label="Has attachments" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    {!!email.task_count && <ListTodo aria-label={email.task_count === 1 ? 'Has a task' : `Has ${email.task_count} tasks`} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                  </span>
                  <span className="mt-0.5 block truncate pl-4 text-sm text-muted-foreground/80">{email.body_text?.substring(0, 140) || '(No content)'}</span>
                  {(disconnected || email.remote_missing) && <span className="mt-1 flex flex-wrap gap-1.5 pl-4">
                    {disconnected && <span className="rounded border border-border px-1.5 text-xs text-muted-foreground" title="This account is disconnected; this mail is retained locally, not verified at the provider">Disconnected · local mail</span>}
                    {email.remote_missing && <span className="rounded border border-border px-1.5 text-xs text-muted-foreground" title="No currently verified provider occurrence; local copy retained">Local copy · provider presence unverified</span>}
                  </span>}
                </button>
              </li>
            );
          })}
        </ul>
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
  onAddTask: (email: Email) => void;
}

/** Right-click menu of a message row. */
export function MailContextMenu({ target, onClose, requestFlag, movableFolders, bulk, onDeleteDraft, onAddTask }: ContextMenuProps) {
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
        <button
          className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
          onClick={() => { onAddTask(target.email); onClose(); }}
        >
          <ListTodo className="h-4 w-4" />
          Add task
        </button>
        <div className="border-t border-border my-1" />
        {movableFolders
          .filter((folder) => folder.id !== target.email.folder)
          .map((folder) => (
            <button
              key={`context-move-${folder.id}`}
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2"
              onClick={() => {
                bulk.move([target.email.id], folder.id, undefined, folder.label);
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
