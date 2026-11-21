import { MoreHorizontal } from 'lucide-react';
import type { ChatThreadMessage } from '@/lib/chat/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PolicyMenuItem } from '@/components/ui/policy-note';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { PeerAvatar } from '@/components/chat/ConversationList';
import { deliveryLabel, messageTime, textParts } from '@/components/chat/chat-state';

interface Props {
  message: ChatThreadMessage;
  /** The message before it is the other person's: a little more room between the two. */
  turn: boolean;
  /** The sender's name stands over it: the first of someone's messages in a group chat, and a former colleague's anywhere. */
  named: boolean;
  /** A group chat: the sender's initials beside their first message, and room for them beside the others. */
  avatar: boolean;
  /** The people the message mentions, by the name its text has them under; `me` for the reader. */
  mentions?: { name: string; me: boolean }[];
  /** The last message that got this far (sent, delivered, read, or read by so many) says so; the ones before it do not repeat it. */
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
export function ChatMessage({ message, turn, named, avatar, mentions, showDelivery, canWrite, deleteLock, quotedOwn, onReply, onEdit, onDelete, onRetry, onMenuCloseAutoFocus }: Props) {
  const mine = message.from_me;
  const gone = message.deleted || message.text === null;
  const time = messageTime(message.created_at);
  // Still in the outbox: the server does not know the message yet, so nothing can be done with it but sending it again.
  const stored = message.seq !== null;
  const failed = message.delivery === 'failed' || message.edit_state === 'failed';
  // Nothing to choose from is no menu: not sent yet and still trying, or the other person's message while they cannot be written to.
  const menu = !gone && (stored ? mine || canWrite : message.delivery === 'failed');
  const onItsWay = message.delivery === 'failed' ? 'Not sent'
    : message.edit_state === 'failed' ? 'The change was not saved'
    : message.delivery === 'sending' ? 'Sending…'
    : message.edit_state === 'sending' ? 'Saving the change…' : null;
  const status = onItsWay ?? (showDelivery ? deliveryLabel(message) : null);
  // "Read by 3 of 7" opens the names.
  const readers = !onItsWay && showDelivery ? message.read_by : null;

  return (
    <li className={cn('relative flex flex-col py-0.5', mine ? 'items-end' : 'items-start', turn && 'pt-2.5', avatar && !mine && 'pl-9')}>
      {named && !mine && (
        // Read out with the message instead, so each message says once whose it is.
        <p aria-hidden="true" className="flex max-w-full items-baseline gap-1.5 px-1 pb-0.5 text-xs">
          {avatar && <PeerAvatar small peer={{ name: message.sender_name }} className={cn('absolute left-0', turn ? 'top-3' : 'top-1')} />}
          <span className="truncate font-medium">{message.sender_name}</span>
          {message.former_colleague && <span className="shrink-0 text-muted-foreground">former colleague</span>}
        </p>
      )}
      <div className={cn('group flex max-w-full items-center gap-1', mine && 'flex-row-reverse')}>
        <div className={cn('min-w-0 max-w-[min(100%,36rem)] rounded-2xl px-3 py-2 text-sm', gone ? 'border border-border text-muted-foreground' : mine ? 'bg-accent/15' : 'bg-muted', message.mentions_me && !gone && 'ring-1 ring-inset ring-accent')}>
          <span className="sr-only">{mine ? 'You' : `${message.sender_name}${message.former_colleague ? ', former colleague' : ''}`}: </span>
          {gone ? <p>{message.deleted ? 'Message deleted' : 'This message could not be read.'}</p> : <>
            {message.reply_to && (
              <p className="mb-1.5 border-l-2 border-accent pl-2 text-xs">
                <span className="block font-medium">{quotedOwn ? 'You' : message.reply_to.sender_name}</span>
                <span className="block truncate text-muted-foreground">{message.reply_to.text ?? 'Message deleted'}</span>
              </p>
            )}
            <p className="whitespace-pre-wrap break-words">
              {textParts(message.text!, mentions).map((part, index) => part.mention
                ? part.mention.me ? <mark key={index} className="rounded-sm bg-accent px-1 font-medium text-accent-foreground">{part.text}</mark>
                  : <span key={index} className="font-medium text-accent">{part.text}</span>
                : part.href
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
          {readers?.people.length ? (
            <Popover>
              <PopoverTrigger className="rounded-sm underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch:-my-3 touch:py-3">{status}</PopoverTrigger>
              <PopoverContent align="end" className="w-60 p-3 text-sm">
                <ul aria-label="Read by" className="space-y-1">{readers.people.map(person => <li key={person.user_id} className="truncate">{person.name}</li>)}</ul>
                <p className="mt-2 text-xs text-muted-foreground">Out of the {readers.of} other people who share read receipts.</p>
              </PopoverContent>
            </Popover>
          ) : <span>{status}{failed && message.error ? `${/[.!?]$/.test(message.error) ? '.' : ':'} ${message.error}` : ''}</span>}
          {failed && <Button variant="outline" size="sm" className="text-foreground" onClick={onRetry}>Try again</Button>}
        </p>
      )}
    </li>
  );
}
