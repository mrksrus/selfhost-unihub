import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import type { ChatConversationSummary, ChatEngine, ChatSearchResult } from '@/lib/chat/types';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { Input } from '@/components/ui/input';
import { PeerAvatar } from '@/components/chat/ConversationList';
import { chatHref, listTime } from '@/components/chat/chat-state';

const ROW = 'flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring touch:py-2.5';

/** The line of a hit with the match marked; a long line starts shortly before it. */
function Line({ result: { line, match: [from, to] } }: { result: ChatSearchResult }) {
  const start = from > 30 ? from - 24 : 0;
  return <>{start > 0 && '…'}{line.slice(start, from)}<mark className="rounded-sm bg-accent/25 text-foreground">{line.slice(from, to)}</mark>{line.slice(to, to + 120)}</>;
}

/**
 * The field above the chats. While something is typed, what it finds on this
 * device stands in place of the chats (`children`): chats by name, then
 * messages by their text and file names, the newest first. A message opens
 * its chat at that message. Escape empties the field; the arrows move between
 * the field and the results.
 */
export function ChatSearch({ engine, conversations, children }: { engine: ChatEngine; conversations: ChatConversationSummary[]; children: ReactNode }) {
  const [query, setQuery] = useState('');
  const needle = useDebouncedValue(query.trim(), 200);
  // Searched again when a chat changes: `conversations` is new then.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const results = useMemo(() => (needle ? engine.search(needle) : []), [engine, needle, conversations]);
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const searching = !!query.trim() && !!needle;
  const chats = results.filter(result => result.message_id === null);
  const messages = results.filter(result => result.message_id !== null);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); field.current?.focus(); return; }
    if (!searching || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    const links = [...box.current?.querySelectorAll('a') ?? []];
    const at = links.indexOf(event.target as HTMLAnchorElement);
    const next = event.key === 'ArrowDown' ? links[at + 1] : at > 0 ? links[at - 1] : field.current;
    if (!next || next === event.target) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <>
      <div role="search" className="relative shrink-0 border-b border-border p-2" onKeyDown={onKeyDown}>
        <Search aria-hidden="true" className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input ref={field} type="search" autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search chats and messages" aria-label="Search chats and messages" className="h-9 pl-9 touch:h-10" />
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-y-auto pb-mobile-nav md:pb-0" onKeyDown={onKeyDown}>
        {!searching ? children : (
          <div role="region" aria-label="Search results" className="p-2">
            {results.length === 0 && <p role="status" className="px-2 py-3 text-sm text-muted-foreground">Nothing in your chats matches.</p>}
            {chats.length > 0 && <>
              <h3 className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">Chats</h3>
              <ul aria-label="Chats found">
                {chats.map(result => {
                  const conversation = conversations.find(item => item.id === result.conversation_id);
                  return (
                    <li key={result.conversation_id}>
                      <Link to={chatHref(result.conversation_id)} className={ROW}>
                        <PeerAvatar peer={conversation?.peer ?? { name: result.chat_name }} group={!!conversation?.group} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium"><Line result={result} /></span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>}
            {messages.length > 0 && <>
              <h3 className="px-2 pb-1 pt-3 text-xs font-medium text-muted-foreground">Messages</h3>
              <ul aria-label="Messages found">
                {messages.map(result => (
                  <li key={result.message_id}>
                    <Link to={`${chatHref(result.conversation_id)}&m=${encodeURIComponent(result.message_id!)}`} className={ROW}>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{result.chat_name}</span>
                          <time dateTime={result.created_at!} className="shrink-0 text-xs tabular-nums text-muted-foreground">{listTime(result.created_at!)}</time>
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">{result.sender_name}: <span className="text-foreground"><Line result={result} /></span></span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>}
            <p className="px-2 pb-2 pt-4 text-xs text-muted-foreground">Search looks through the chats on this device. The server cannot read them.</p>
          </div>
        )}
      </div>
    </>
  );
}
