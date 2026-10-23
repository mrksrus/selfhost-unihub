import { useQuery } from '@tanstack/react-query';
import { AlarmClock, AlarmClockOff, CheckCircle2, CheckSquare, ChevronLeft, ChevronRight, Inbox, ListTodo, Loader2, Mail, Paperclip, Plus, Square, Star, Trash2 } from 'lucide-react';
import type { Email, MailAccount, MailFlagKind, MailThreadSummary } from '@/lib/mail-api';
import type { MailListView } from '@/hooks/use-mail-list-view';
import type { MailListSelection } from '@/hooks/use-mail-list-selection';
import type { MailBulkActions } from '@/hooks/use-mail-bulk-actions';
import type { MailSnooze } from '@/hooks/use-mail-snooze';
import type { MailSchedule } from '@/hooks/use-mail-schedule';
import { Button } from '@/components/ui/button';
import { EmptyState, LoadingState } from '@/components/ui/page-states';
import { cn } from '@/lib/utils';
import { selectUserSetting, userSettingsQueryOptions } from '@/lib/settings-api';
import { formatWhen } from '@/lib/mail-times';
import { Pagination, PaginationContent, PaginationItem } from '@/components/ui/pagination';
import { MailPendingMark } from '@/components/mail/MailPendingMark';
import { ALL_ACCOUNTS, ALL_MAIL, SNOOZED, formatListDate, isBackFromSnooze, isSnoozed, type MailFolderItem } from '@/components/mail/mail-page-model';

// Lines of body text under each message (Settings, Mail): 0 to 5.
const PREVIEW_CLAMP = ['', 'truncate', 'line-clamp-2', 'line-clamp-3', 'line-clamp-4', 'line-clamp-5'];

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
  /** Snooze state and actions; absent where the list has none (tests of other behaviour). */
  snooze?: MailSnooze;
  /** The scheduled sends of Drafts rows. */
  schedule?: MailSchedule;
  /** Offline is read-only: snooze and schedule actions are disabled. */
  readOnly?: boolean;
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
  if (folder === SNOOZED) return { title: 'Nothing snoozed', description: 'A snoozed message waits here and returns to its folder at the chosen time.' };
  return { title: folder === ALL_MAIL ? `No mail in ${accountLabel}` : `No mail in ${folderLabel}`, description: undefined };
}

const chip = 'rounded border border-border px-1.5 text-xs text-muted-foreground';

/** A draft's scheduled send, as the server last reported it, with what can be done about it. */
function ScheduledSendState({ email, schedule, readOnly }: { email: Email; schedule?: MailSchedule; readOnly: boolean }) {
  const status = email.scheduled_send_status;
  if (!status) return null;
  const busy = schedule?.isBusy(email.id) ?? false;
  const disabled = !schedule || readOnly || busy;
  const action = (label: string, onClick: () => void) => (
    <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-xs touch:h-9" disabled={disabled} onClick={onClick}>{label}</Button>
  );
  const text = status === 'scheduled' ? `Scheduled for ${formatWhen(email.scheduled_send_at ?? '')}`
    : status === 'sending' ? 'Sending…'
    : status === 'failed' ? 'Not sent'
    : status === 'unknown' ? 'May have been sent: check Sent'
    : 'Sent';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 pl-4" data-scheduled-send={status}>
      <span className={cn('inline-flex items-center gap-1 text-xs', status === 'failed' ? 'text-destructive' : status === 'unknown' ? 'text-warning' : 'text-muted-foreground')}>
        {status === 'sending' || busy ? <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" /> : <AlarmClock aria-hidden="true" className="h-3 w-3" />}
        {text}
      </span>
      {schedule && status === 'scheduled' && <>
        {action('Cancel schedule', () => void schedule.cancel(email))}
        {action('Edit time', () => schedule.setPicking(email))}
      </>}
      {schedule && status === 'failed' && <>
        {action('Send now', () => void schedule.sendNow(email))}
        {action('Reschedule', () => schedule.setPicking(email))}
      </>}
      {schedule && (status === 'unknown' || status === 'sent') && action('Clear', () => void schedule.cancel(email))}
    </div>
  );
}

/** Message rows with loading/empty states, the filter summary and pagination. */
export function MailMessageList({ account, folder, folderLabel, accountLabel, list, selection, accounts, flagRequests, requestFlag,
  onOpen, onContextMenu, onAddAccount, snooze, schedule, readOnly = false }: ListProps) {
  const { emails, threads } = list;
  const previewLines = useQuery({ ...userSettingsQueryOptions, select: selectUserSetting('mail_preview_lines') }).data ?? 1;
  const empty = emptyText(list, account, folder, folderLabel, accountLabel);
  const byLatest = new Map((threads ?? []).map(thread => [thread.latest.id, thread]));
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
        <ul aria-label={`${folderLabel}, ${accountLabel}${threads ? ', conversations' : ''}`}>
          {emails.map((email) => {
            const thread = byLatest.get(email.id);
            const selected = selection.selectedEmails.has(email.id);
            const unread = thread ? thread.unread_count > 0 : !email.is_read;
            const starred = thread ? thread.is_starred : email.is_starred;
            const disconnected = accounts.find(entry => entry.id === email.mail_account_id)?.disconnected_at;
            const name = email.subject || 'message';
            const snoozed = folder === SNOOZED && isSnoozed(email);
            const backFromSnooze = isBackFromSnooze(email);
            // Who took part, most recent first: names, or the part of the address before the @.
            const participants = thread?.participants.map(person => person.name || person.address.split('@')[0]).join(', ');
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
                    aria-label={`Select ${name}`} onClick={(e) => selection.toggleEmail(email.id, e)}>
                    {selected ? <CheckSquare aria-hidden="true" className="text-accent" /> : <Square aria-hidden="true" className="text-muted-foreground/70" />}
                  </Button>
                  <Button variant="ghost" size="icon-sm"
                    onClick={(e) => { e.stopPropagation(); requestFlag(email, 'star', !starred); }}
                    aria-label={starred ? `Unstar ${name}` : `Star ${name}`}>
                    <Star aria-hidden="true" className={starred ? 'fill-warning text-warning' : 'text-muted-foreground/70'} />
                  </Button>
                </div>
                <div className="min-w-0 flex-1">
                  <button type="button" className="block min-w-0 w-full py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                    onClick={() => { void onOpen(email.id); }}>
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span aria-hidden="true" className={cn('h-2 w-2 shrink-0 self-center rounded-full', unread ? 'bg-accent' : 'bg-transparent')} />
                      <span className={cn('min-w-0 truncate', unread ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                        {thread ? participants || email.from_name || email.from_address : email.from_name || email.from_address}
                      </span>
                      {thread && thread.message_count > 1 && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground" aria-label={`${thread.message_count} messages`}>{thread.message_count}</span>
                      )}
                      {unread && <span className="sr-only">{thread && thread.unread_count > 1 ? `(${thread.unread_count} unread)` : '(unread)'}</span>}
                      <span className="ml-auto flex shrink-0 items-center gap-2 self-center pl-2">
                        <MailPendingMark email={email} saving={flagRequests.has(`read:${email.id}`) || flagRequests.has(`star:${email.id}`)} />
                        <span className="text-xs tabular-nums text-muted-foreground">{formatListDate(email.received_at)}</span>
                      </span>
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-2 pl-4">
                      <span className={cn('min-w-0 flex-1 truncate', unread ? 'text-foreground' : 'text-muted-foreground')}>{email.subject || '(No subject)'}</span>
                      {!!(thread ? thread.has_attachments : email.has_attachments) && <Paperclip
 aria-label="Has attachments" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      {!!email.task_count && <ListTodo aria-label={email.task_count === 1 ? 'Has a task' : `Has ${email.task_count} tasks`} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    </span>
                    {previewLines > 0 && <span className={cn('mt-0.5 block break-words pl-4 text-sm text-muted-foreground/80', PREVIEW_CLAMP[previewLines])}>
                      {email.body_text?.replace(/\s+/g, ' ').trim().substring(0, 140 * previewLines) || '(No content)'}
                    </span>}
                    {(disconnected || email.remote_missing || snoozed || backFromSnooze) && <span className="mt-1 flex flex-wrap gap-1.5 pl-4">
                      {snoozed && <span className={cn(chip, 'inline-flex items-center gap-1')}><AlarmClock aria-hidden="true" className="h-3 w-3" />Until {formatWhen(email.snoozed_until!)}</span>}
                      {backFromSnooze && <span className={cn(chip, 'inline-flex items-center gap-1 text-accent')} title="This message came back from a snooze"><AlarmClockOff aria-hidden="true" className="h-3 w-3" />Back from snooze</span>}
                      {disconnected && <span className={chip} title="This account is disconnected; this mail is retained locally, not verified at the provider">Disconnected · local mail</span>}
                      {email.remote_missing && <span className={chip} title="No currently verified provider occurrence; local copy retained">Local copy · provider presence unverified</span>}
                    </span>}
                  </button>
                  <ScheduledSendState email={email} schedule={schedule} readOnly={readOnly} />
                </div>
                {snoozed && snooze && (
                  <div className="shrink-0 self-center">
                    <Button type="button" variant="outline" size="sm" disabled={readOnly || snooze.isPending(email.id)}
                      title={readOnly ? 'Not available offline' : undefined} onClick={() => snooze.unsnooze(email)}>
                      {snooze.isPending(email.id) ? <Loader2 aria-hidden="true" className="animate-spin" /> : <AlarmClockOff aria-hidden="true" />}
                      Unsnooze
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Search / filter results indicator */}
      {(list.searchQuery.trim() || list.showUnreadOnly) && emails.length > 0 && !threads && (
        <div className="border-t border-border p-4 text-center text-sm text-muted-foreground">
          {list.searchQuery.trim() && (
            <>Found {list.totalMatching} result{list.totalMatching !== 1 ? 's' : ''} for "{list.searchQuery}"{list.showUnreadOnly ? ' (unread only)' : ''}</>
          )}
          {!list.searchQuery.trim() && list.showUnreadOnly && (
            <>Showing {list.totalMatching} unread email{list.totalMatching !== 1 ? 's' : ''}</>
          )}
        </div>
      )}

      {/* Conversation pages follow the cursor each page returns; their total is not counted. */}
      {threads && (list.page > 1 || list.hasNextPage) && (
        <nav aria-label="Conversation pages" className="flex items-center justify-between gap-2 border-t border-border p-4">
          <Button variant="ghost" size="sm" className="gap-1" onClick={list.previousPage} disabled={list.page === 1}>
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />Previous
          </Button>
          <span className="text-sm text-muted-foreground">Page {list.page}</span>
          <Button variant="ghost" size="sm" className="gap-1" onClick={list.nextPage} disabled={!list.hasNextPage}>
            Next<ChevronRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        </nav>
      )}

      {/* Pagination */}
      {!threads && list.totalPages > 1 && (
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
  /** Opens the snooze time picker for the message. */
  onSnooze?: (email: Email) => void;
  onUnsnooze?: (email: Email) => void;
  /** Offline is read-only: the snooze entries stay visible but disabled. */
  readOnly?: boolean;
}

/** Right-click menu of a message row. */
export function MailContextMenu({ target, onClose, requestFlag, movableFolders, bulk, onDeleteDraft, onAddTask, onSnooze, onUnsnooze, readOnly = false }: ContextMenuProps) {
  const draft = target.email.is_draft || target.email.folder === 'drafts';
  const offline = readOnly ? { disabled: true, title: 'Not available offline' } : {};
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
        {!draft && (isSnoozed(target.email) ? onUnsnooze && (
          <button className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2 disabled:opacity-50 disabled:pointer-events-none" {...offline}
            onClick={() => { onUnsnooze(target.email); onClose(); }}>
            <AlarmClockOff className="h-4 w-4" />
            Unsnooze
          </button>
        ) : onSnooze && (
          <button className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-sm flex items-center gap-2 disabled:opacity-50 disabled:pointer-events-none" {...offline}
            onClick={() => { onSnooze(target.email); onClose(); }}>
            <AlarmClock className="h-4 w-4" />
            Snooze…
          </button>
        ))}
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
            if (draft) {
              onDeleteDraft(target.email);
            } else {
              bulk.trash([target.email.id]);
            }
            onClose();
          }}
        >
          <Trash2 className="h-4 w-4" />
          {draft ? 'Delete draft' : 'Delete'}
        </button>
    </div>
    </>
  );
}

export type { MailThreadSummary };
