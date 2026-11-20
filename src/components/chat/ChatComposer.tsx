import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { Check, SendHorizontal, X } from 'lucide-react';
import type { ChatThreadMessage } from '@/lib/chat/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MAX_MESSAGE_LENGTH } from '@/components/chat/chat-state';

/** What the next text is: an answer to a message, or a new text for one's own. */
export type ComposerMode = { kind: 'reply' | 'edit'; message: ChatThreadMessage } | null;

interface Props {
  peerName: string;
  mode: ComposerMode;
  /** The text typed and not sent, kept by the page while another chat is open. */
  draft: string;
  onDraft: (text: string) => void;
  onSend: (text: string) => void;
  /** Leaves reply or edit without sending. */
  onCancel: () => void;
  fieldRef: RefObject<HTMLTextAreaElement>;
}

/**
 * The line a message is written on. It grows with the text up to a few
 * lines. Enter sends with a keyboard; on a touch screen Enter is a new line
 * and the button sends. Escape leaves a reply or an edit.
 */
export function ChatComposer({ peerName, mode, draft, onDraft, onSend, onCancel, fieldRef }: Props) {
  const [text, setText] = useState(draft);
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
  }, [text, fieldRef]);

  const value = text.trim();
  const ready = !!value && value !== editing?.text;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready) return;
    if (!editing) change('');
    onSend(value);
    fieldRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
      <div className="flex items-end gap-2">
        <Textarea ref={fieldRef} rows={1} value={text} maxLength={MAX_MESSAGE_LENGTH} onChange={event => change(event.target.value)} onKeyDown={onKeyDown}
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
