import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { fetchMailDetail, mailQueryKeys, type Email, type MailFlagKind, type MailListRow, type MailThreadResponse } from '@/lib/mail-api';
import { cn } from '@/lib/utils';
import { MailMessageView } from '@/components/mail/MailMessageView';
import { formatListDate } from '@/components/mail/mail-page-model';

interface Props {
  /** The message opened from the list: shown in full where it sits in the conversation. */
  open: Email;
  thread: MailThreadResponse;
  /** The open message as the reader renders it. */
  children: ReactNode;
  timezone: string | null;
  requestFlag: (email: Email, kind: MailFlagKind, value: boolean) => void;
}

/**
 * The conversation around the open message (Settings, Mail: threaded view):
 * its other messages collapsed to one line each, oldest first; one unfolds in
 * place and is marked read then. Each body still renders through
 * SafeEmailContent in MailMessageView.
 */
export function MailConversation({ open, thread, children, timezone, requestFlag }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Another conversation opens folded.
  useEffect(() => { setExpanded(new Set()); }, [thread.thread_key, open.id]);
  const others = thread.messages.filter(message => message.id !== open.id);
  if (others.length === 0) return <>{children}</>;
  const toggle = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <section aria-label={`Conversation, ${thread.messages.length} messages`} className="divide-y divide-border">
      {thread.truncated && <p className="pb-2 text-xs text-muted-foreground">Only the newest 200 messages of this conversation are shown.</p>}
      {thread.messages.map(message => message.id === open.id
        ? <div key={message.id} className="py-4 first:pt-0">{children}</div>
        : <CollapsedMessage key={message.id} row={message} expanded={expanded.has(message.id)} onToggle={() => toggle(message.id)}
          openFolder={open.folder} timezone={timezone} requestFlag={requestFlag} />)}
    </section>
  );
}

function CollapsedMessage({ row, expanded, onToggle, openFolder, timezone, requestFlag }: {
  row: MailListRow; expanded: boolean; onToggle: () => void; openFolder: string; timezone: string | null;
  requestFlag: (email: Email, kind: MailFlagKind, value: boolean) => void;
}) {
  const detail = useQuery({
    queryKey: mailQueryKeys.detail(row.id),
    queryFn: ({ signal }) => fetchMailDetail(row.id, signal),
    enabled: expanded,
  });
  // Unfolding reads the message, as opening one from the list does.
  useEffect(() => {
    if (expanded && detail.data && !detail.data.is_read && !detail.data.read_sync_pending) requestFlag(detail.data, 'read', true);
    // Once per load; the flag request itself updates what the row shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, detail.data?.id]);
  const unread = !(detail.data?.is_read ?? row.is_read);
  const snippet = row.body_text?.replace(/\s+/g, ' ').trim().slice(0, 140) || '';
  return (
    <div>
      <button type="button" aria-expanded={expanded} onClick={onToggle}
        className="flex w-full items-start gap-2 rounded-md px-2 py-2.5 text-left text-sm touch:py-3 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {expanded ? <ChevronDown aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn('min-w-0 truncate', unread ? 'font-semibold text-foreground' : 'text-foreground')}>{row.from_name || row.from_address}</span>
            {unread && <span className="sr-only">(unread)</span>}
            {row.folder !== openFolder && <span className="shrink-0 rounded border border-border px-1.5 text-xs text-muted-foreground">{row.folder}</span>}
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{formatListDate(row.received_at)}</span>
          </span>
          {!expanded && <span className="mt-0.5 block truncate text-muted-foreground">{snippet || row.subject || '(No content)'}</span>}
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-4 pt-1">
          {detail.isError ? <p className="text-sm text-destructive">{detail.error instanceof Error ? detail.error.message : 'Could not load the message'}</p>
            : detail.data ? <MailMessageView email={detail.data} timezone={timezone} compact />
            : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Loading message…</p>}
        </div>
      )}
    </div>
  );
}
