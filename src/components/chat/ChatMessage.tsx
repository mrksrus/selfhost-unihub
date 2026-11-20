import { MoreHorizontal } from 'lucide-react';
import type { ChatThreadMessage } from '@/lib/chat/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PolicyMenuItem } from '@/components/ui/policy-note';
import { messageTime, textParts } from '@/components/chat/chat-state';

const DELIVERY = { sent: 'Sent', delivered: 'Delivered', read: 'Read' } as const;

interface Props {
  message: ChatThreadMessage;
  /** The message before it is the other person's: a little more room between the two. */
  turn: boolean;
  /** The last message that got this far (sent, delivered or read) says so; the ones before it do not repeat it. */
  showDelivery: boolean;
  /** Whether the other person can be written to now: no reply and no edit otherwise. */
  canWrite: boolean;
  /** Why deleting is not allowed, in the server's words. */
  deleteLock?: string;
  /** The message it answers is one's own: the quote says "You". */
  quotedOwn: boolean;
  onReply: () => void;
  onEdit: () => void;
  /** Deletes a stored message (the thread asks first) or discards one that was never sent. */
  onDelete: () => void;
  onRetry: () => void;
  /** Where the focus goes when the menu closes; the thread sends it to the composer after Reply and Edit. */
  onMenuCloseAutoFocus: (event: Event) => void;
}

/** One message: its bubble, what happened to it on the way, and its menu. */
export function ChatMessage({ message, turn, showDelivery, canWrite, deleteLock, quotedOwn, onReply, onEdit, onDelete, onRetry, onMenuCloseAutoFocus }: Props) {
  const mine = message.from_me;
  const gone = message.deleted || message.text === null;
  const time = messageTime(message.created_at);
  // Still in the outbox: the server does not know the message yet, so nothing can be done with it but sending it again.
  const stored = message.seq !== null;
  const failed = message.delivery === 'failed' || message.edit_state === 'failed';
  // Nothing to choose from is no menu: not sent yet and still trying, or the other person's message while they cannot be written to.
  const menu = !gone && (stored ? mine || canWrite : message.delivery === 'failed');
  const status = message.delivery === 'failed' ? 'Not sent'
    : message.edit_state === 'failed' ? 'The change was not saved'
    : message.delivery === 'sending' ? 'Sending…'
    : message.edit_state === 'sending' ? 'Saving the change…'
    : showDelivery && message.delivery ? DELIVERY[message.delivery] : null;

  return (
    <li className={cn('flex flex-col py-0.5', mine ? 'items-end' : 'items-start', turn && 'pt-2.5')}>
      <div className={cn('group flex max-w-full items-center gap-1', mine && 'flex-row-reverse')}>
        <div className={cn('min-w-0 max-w-[min(100%,36rem)] rounded-2xl px-3 py-2 text-sm', gone ? 'border border-border text-muted-foreground' : mine ? 'bg-accent/15' : 'bg-muted')}>
          <span className="sr-only">{mine ? 'You' : message.sender_name}: </span>
          {gone ? <p>{message.deleted ? 'Message deleted' : 'This message could not be read.'}</p> : <>
            {message.reply_to && (
              <p className="mb-1.5 border-l-2 border-accent pl-2 text-xs">
                <span className="block font-medium">{quotedOwn ? 'You' : message.reply_to.sender_name}</span>
                <span className="block truncate text-muted-foreground">{message.reply_to.text ?? 'Message deleted'}</span>
              </p>
            )}
            <p className="whitespace-pre-wrap break-words">
              {textParts(message.text!).map((part, index) => part.href
                ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="rounded-sm text-accent underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:-my-3 touch:py-3">{part.text}</a>
                : part.text)}
            </p>
          </>}
          <p className="mt-0.5 text-right text-[11px] tabular-nums text-muted-foreground">
            {message.edited && !gone && 'edited '}<time dateTime={message.created_at}>{time}</time>
          </p>
        </div>
        {menu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${mine ? 'your message' : `the message from ${message.sender_name}`} at ${time}`}
                className="shrink-0 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100">
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align={mine ? 'end' : 'start'} onCloseAutoFocus={onMenuCloseAutoFocus}>
              {!stored ? <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onDelete}>Discard</DropdownMenuItem> : <>
                <DropdownMenuItem disabled={!canWrite} onClick={onReply}>Reply</DropdownMenuItem>
                {mine && <DropdownMenuItem disabled={!canWrite} onClick={onEdit}>Edit</DropdownMenuItem>}
                {mine && <PolicyMenuItem lock={deleteLock} className="text-destructive focus:text-destructive" onClick={onDelete}>Delete</PolicyMenuItem>}
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {status && (
        <p className={cn('mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 px-1 text-xs', failed ? 'text-destructive' : 'text-muted-foreground')}>
          <span>{status}{failed && message.error ? `${/[.!?]$/.test(message.error) ? '.' : ':'} ${message.error}` : ''}</span>
          {failed && <Button variant="outline" size="sm" className="text-foreground" onClick={onRetry}>Try again</Button>}
        </p>
      )}
    </li>
  );
}
