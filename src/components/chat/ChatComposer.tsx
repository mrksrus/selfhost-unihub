import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { Check, SendHorizontal, X } from 'lucide-react';
import type { ChatMember, ChatThreadMessage } from '@/lib/chat/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MAX_MESSAGE_LENGTH, textParts } from '@/components/chat/chat-state';

// The people a message can name for a notification.
const MAX_MENTIONS = 20;

/** What the next text is: an answer to a message, or a new text for one's own. */
export type ComposerMode = { kind: 'reply' | 'edit'; message: ChatThreadMessage } | null;

interface Props {
  peerName: string;
  mode: ComposerMode;
  /** The text typed and not sent, kept by the page while another chat is open. */
  draft: string;
  onDraft: (text: string) => void;
  /** The other people of a group chat: typing "@" offers them. */
  people?: ChatMember[];
  /** `mentions`: the people whose "@name" the text has. */
  onSend: (text: string, mentions: string[]) => void;
  /** Leaves reply or edit without sending. */
  onCancel: () => void;
  fieldRef: RefObject<HTMLTextAreaElement>;
}

/**
 * The line a message is written on. It grows with the text up to a few
 * lines. Enter sends with a keyboard; on a touch screen Enter is a new line
 * and the button sends. Escape leaves a reply or an edit. In a group chat
 * "@" opens the people to mention: the arrows choose, Enter, Tab or a tap
 * takes one, Escape closes the list.
 */
export function ChatComposer({ peerName, mode, draft, people, onDraft, onSend, onCancel, fieldRef }: Props) {
  const [text, setText] = useState(draft);
  const [caret, setCaret] = useState(draft.length);
  const [chosen, setChosen] = useState(0);
  // Where the "@" stands whose list Escape closed.
  const [closedAt, setClosedAt] = useState(-1);
  const caretAfter = useRef<number | null>(null);
  const editing = mode?.kind === 'edit' ? mode.message : null;
  // An edit borrows the field; the unsent draft comes back after it.
  const beforeEdit = useRef(draft);
  useEffect(() => {
    if (editing) setText(editing.text ?? '');
    else setText(beforeEdit.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);
  const change = (next: string) => {
    setText(next);
    if (!editing) { beforeEdit.current = next; onDraft(next); }
  };

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight + 2}px`;
    if (caretAfter.current !== null) field.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [text, fieldRef]);

  // The "@" being typed: at the start of a word, on the caret's line, with the people its letters match.
  const typed = people?.length && !editing ? /(^|\s)@([^@\n]{0,40})$/.exec(text.slice(0, caret)) : null;
  const at = typed ? typed.index + typed[1].length : -1;
  const offered = typed && at !== closedAt ? people!.filter(person => person.name.toLowerCase().includes(typed[2].toLowerCase())).slice(0, 8) : [];
  const active = Math.min(chosen, offered.length - 1);
  const mention = (person: ChatMember) => {
    caretAfter.current = at + person.name.length + 2;
    setCaret(caretAfter.current);
    change(`${text.slice(0, at)}@${person.name} ${text.slice(caret)}`);
  };

  const value = text.trim();
  const ready = !!value && value !== editing?.text;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready) return;
    if (!editing) change('');
    onSend(value, editing || !people ? [] : [...new Set(textParts(value, people).flatMap(part => (part.mention ? [part.mention.user_id] : [])))].slice(0, MAX_MENTIONS));
    fieldRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (offered.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') setClosedAt(at);
      else if (event.key.startsWith('Arrow')) setChosen((active + (event.key === 'ArrowDown' ? 1 : offered.length - 1)) % offered.length);
      else mention(offered[active]);
      return;
    }
    if (event.key === 'Escape' && mode) { event.stopPropagation(); onCancel(); return; }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || window.matchMedia('(pointer: coarse)').matches) return;
    event.preventDefault();
    submit();
  };

  return (
    <form onSubmit={submit} className="shrink-0 border-t border-border px-3 py-2 max-md:pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))] md:px-4">
      <div className="mx-auto max-w-3xl">
      {mode && (
        <div className="mb-2 flex items-center gap-2 border-l-2 border-accent pl-3 text-xs">
          <p className="min-w-0 flex-1">
            <span className="block font-medium">{editing ? 'Editing your message' : `Replying to ${mode.message.from_me ? 'yourself' : mode.message.sender_name}`}</span>
            <span className="block truncate text-muted-foreground">{mode.message.text}</span>
          </p>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={editing ? 'Cancel editing' : 'Cancel reply'} onClick={() => { onCancel(); fieldRef.current?.focus(); }}>
            <X aria-hidden="true" />
          </Button>
        </div>
      )}
      <div className="relative flex items-end gap-2">
        {offered.length > 0 && (
          <ul id="chat-mention-list" role="listbox" aria-label="People to mention" className="absolute bottom-full left-0 z-10 mb-1 max-h-56 w-72 max-w-full overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
            {offered.map((person, index) => (
              // The field keeps the focus: a tap takes the person without closing the keyboard.
              <li key={person.user_id} id={`chat-mention-${index}`} role="option" aria-selected={index === active} onPointerDown={event => event.preventDefault()} onClick={() => mention(person)}
                className={cn('flex min-h-9 cursor-pointer items-center rounded-sm px-2 text-sm touch:min-h-11', index === active && 'bg-accent text-accent-foreground')}>
                <span className="truncate">{person.name}</span>
              </li>
            ))}
          </ul>
        )}
        <Textarea ref={fieldRef} rows={1} value={text} maxLength={MAX_MESSAGE_LENGTH} onKeyDown={onKeyDown}
          onChange={event => { setCaret(event.target.selectionStart); setChosen(0); change(event.target.value); }} onSelect={event => setCaret(event.currentTarget.selectionStart)}
          aria-controls={offered.length ? 'chat-mention-list' : undefined} aria-activedescendant={offered.length ? `chat-mention-${active}` : undefined}
          aria-label={`Message to ${peerName}`} placeholder="Write a message" className="max-h-40 min-h-10 resize-none touch:min-h-11" />
        <Button type="submit" size="icon" className="shrink-0" disabled={!ready} aria-label={editing ? 'Save change' : 'Send'}>
          {editing ? <Check aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}
        </Button>
      </div>
      {text.length >= MAX_MESSAGE_LENGTH - 500 && (
        <p className="mt-1 text-right text-xs tabular-nums text-muted-foreground">
          {text.length.toLocaleString('en')} of {MAX_MESSAGE_LENGTH.toLocaleString('en')} characters
          {/* Announced once, at the limit, not at every keystroke. */}
          <span role="status" className="sr-only">{text.length >= MAX_MESSAGE_LENGTH ? 'The message cannot get longer.' : ''}</span>
        </p>
      )}
      </div>
    </form>
  );
}
