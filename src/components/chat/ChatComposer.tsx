import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MutableRefObject, type RefObject } from 'react';
import { Check, FileText, Mic, Paperclip, SendHorizontal, Trash2, X } from 'lucide-react';
import type { ChatFileToSend, ChatMember, ChatThreadMessage } from '@/lib/chat/types';
import { MAX_VOICE_SECONDS, useVoiceCapture } from '@/hooks/use-voice-capture';
import { formatBytes } from '@/lib/recording-format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { pictureType, useObjectUrl } from '@/components/chat/chat-files';
import { MAX_MESSAGE_LENGTH, clock, textParts } from '@/components/chat/chat-state';

// The people a message can name for a notification.
const MAX_MENTIONS = 20;
// What the engine takes in one message, and the largest file any server allows.
const MAX_FILES = 10;
const MAX_FILE_MB = 100;

/** A file about to be sent: a picture small, anything else by name and size, each with its remove button. */
function Attached({ file, onRemove }: { file: ChatFileToSend; onRemove: () => void }) {
  const picture = pictureType(file.blob);
  const src = useObjectUrl(picture ? file.blob : null, picture ?? '');
  return (
    <li className="relative flex h-14 max-w-48 shrink-0 items-center gap-2 overflow-hidden rounded-md border border-border bg-muted/50 pr-9 text-xs">
      {src ? <img src={src} alt="" className="h-14 w-14 object-cover" /> : <FileText aria-hidden="true" className="ml-2.5 h-5 w-5 shrink-0 text-muted-foreground" />}
      <span className="min-w-0">
        <span className="block truncate font-medium">{file.name}</span>
        <span className="block truncate tabular-nums text-muted-foreground">{file.voice_seconds !== undefined ? clock(file.voice_seconds) : formatBytes(file.blob.size)}</span>
      </span>
      <Button type="button" variant="ghost" size="icon-sm" className="absolute right-0.5 top-1/2 -translate-y-1/2" aria-label={`Remove ${file.name}`} onClick={onRemove}><X aria-hidden="true" /></Button>
    </li>
  );
}

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
  /** `mentions`: the people whose "@name" the text has; `files`: what was attached, or a voice message on its own. */
  onSend: (text: string, mentions: string[], files: ChatFileToSend[]) => void;
  /** Leaves reply or edit without sending. */
  onCancel: () => void;
  fieldRef: RefObject<HTMLTextAreaElement>;
  /** Filled with the way to attach files from outside the composer: the thread hands over what is dropped on it. */
  attachRef?: MutableRefObject<(files: File[]) => void>;
}

/**
 * The line a message is written on. It grows with the text up to a few
 * lines. Enter sends with a keyboard; on a touch screen Enter is a new line
 * and the button sends. Escape leaves a reply or an edit. In a group chat
 * "@" opens the people to mention: the arrows choose, Enter, Tab or a tap
 * takes one, Escape closes the list. Files are attached with the button, by
 * pasting or by dropping them on the thread, up to ten, and wait above the
 * field until the message is sent; the microphone records a voice message,
 * which is sent on its own.
 */
export function ChatComposer({ peerName, mode, draft, people, onDraft, onSend, onCancel, fieldRef, attachRef }: Props) {
  const [text, setText] = useState(draft);
  const [caret, setCaret] = useState(draft.length);
  const [chosen, setChosen] = useState(0);
  // Where the "@" stands whose list Escape closed; typing a new "@" opens it again.
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

  // The files that go with the next message, and why one was not taken. An edit cannot change files.
  const [files, setFiles] = useState<ChatFileToSend[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const attach = (added: ChatFileToSend[]) => {
    if (editing || !added.length) return;
    const fit = added.filter(file => file.blob.size <= MAX_FILE_MB * 1024 * 1024);
    setNotice(fit.length < added.length ? `Files in a chat can be at most ${MAX_FILE_MB} MB.` : files.length + fit.length > MAX_FILES ? `A message has at most ${MAX_FILES} files.` : null);
    setFiles([...files, ...fit].slice(0, MAX_FILES));
  };
  if (attachRef) attachRef.current = list => attach(list.map(blob => ({ blob, name: blob.name })));

  // "Send" in the record bar sends the recording at once; one the 10 minutes ended waits among the files.
  const sendVoice = useRef(false);
  const voice = useVoiceCapture(recording => {
    const file = { blob: recording.blob, name: recording.name, voice_seconds: recording.seconds };
    if (sendVoice.current) onSend('', [], [file]);
    else { attach([file]); setNotice(`The recording stopped at ${MAX_VOICE_SECONDS / 60} minutes, the longest a voice message can be.`); }
  });
  const recording = voice.state !== 'idle';
  // The field comes back when a recording ends, and the focus with it.
  const recorded = useRef(false);
  useEffect(() => {
    if (recording) recorded.current = true;
    else if (recorded.current) { recorded.current = false; fieldRef.current?.focus(); }
  }, [recording, fieldRef]);

  const value = text.trim();
  const ready = editing ? !!value && value !== editing.text : !!value || files.length > 0;
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!ready) return;
    if (!editing) { change(''); setFiles([]); setNotice(null); }
    onSend(value, editing || !people ? [] : [...new Set(textParts(value, people).flatMap(part => (part.mention ? [part.mention.user_id] : [])))].slice(0, MAX_MENTIONS), editing ? [] : files);
    fieldRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter stays a new line while the people are offered.
    if (offered.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) && !(event.key === 'Enter' && event.shiftKey) && !event.nativeEvent.isComposing) {
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
            <span className="block truncate text-muted-foreground">{mode.message.text || mode.message.files.map(file => file.name).join(', ')}</span>
          </p>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={editing ? 'Cancel editing' : 'Cancel reply'} onClick={() => { onCancel(); fieldRef.current?.focus(); }}>
            <X aria-hidden="true" />
          </Button>
        </div>
      )}
      {!editing && files.length > 0 && (
        <ul aria-label="Files to send" className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {files.map((file, index) => <Attached key={index} file={file} onRemove={() => { setFiles(files.filter(item => item !== file)); setNotice(null); fieldRef.current?.focus(); }} />)}
        </ul>
      )}
      {!editing && notice && <p role="status" className="mb-2 text-xs text-muted-foreground">{notice}</p>}
      {recording ? (
        <div role="group" aria-label="Voice message" className="flex min-h-10 items-center gap-2 touch:min-h-11">
          <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-label="Discard the recording" onClick={voice.discard}><Trash2 aria-hidden="true" /></Button>
          <p className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-destructive motion-safe:animate-pulse" />
            {voice.state === 'starting' ? <span className="text-muted-foreground">Waiting for the microphone…</span> : <>
              <span role="timer" aria-label="Recorded so far" className="font-medium tabular-nums">{clock(voice.seconds)}</span>
              <span className="truncate text-muted-foreground">of {clock(MAX_VOICE_SECONDS)} at most</span>
            </>}
          </p>
          <Button type="button" size="icon" className="shrink-0" disabled={voice.state !== 'recording'} aria-label="Send the voice message" onClick={() => { sendVoice.current = true; voice.finish(); }}><SendHorizontal aria-hidden="true" /></Button>
        </div>
      ) : (
      <div className="relative flex items-end gap-2">
        {!editing && (
          <div className="flex shrink-0">
            <input ref={picker} type="file" multiple className="hidden" aria-label="Choose files to send" tabIndex={-1}
              onChange={event => { attach([...event.target.files ?? []].map(blob => ({ blob, name: blob.name }))); event.target.value = ''; fieldRef.current?.focus(); }} />
            <Button type="button" variant="ghost" size="icon" aria-label="Attach files" onClick={() => picker.current?.click()}><Paperclip aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" size="icon" aria-label="Record a voice message" onClick={() => { sendVoice.current = false; void voice.start(); }}><Mic aria-hidden="true" /></Button>
          </div>
        )}
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
          onChange={event => { setCaret(event.target.selectionStart); setChosen(0); if (event.target.value[closedAt] !== '@') setClosedAt(-1); change(event.target.value); }} onSelect={event => setCaret(event.currentTarget.selectionStart)}
          // A pasted picture or file is attached. Text copied from a spreadsheet or a document comes with a picture of itself: that stays text.
          onPaste={event => {
            const { files: pasted, types } = event.clipboardData;
            if (!pasted.length || (types.includes('text/html') && event.clipboardData.getData('text/plain'))) return;
            event.preventDefault();
            attach([...pasted].map(blob => ({ blob, name: blob.name })));
          }}
          {...(people && !editing ? { role: 'combobox', 'aria-expanded': offered.length > 0, 'aria-autocomplete': 'list' as const, 'aria-haspopup': 'listbox' as const } : {})}
          aria-controls={offered.length ? 'chat-mention-list' : undefined} aria-activedescendant={offered.length ? `chat-mention-${active}` : undefined}
          aria-label={`Message to ${peerName}`} placeholder="Write a message" className="max-h-40 min-h-10 resize-none touch:min-h-11" />
        <Button type="submit" size="icon" className="shrink-0" disabled={!ready} aria-label={editing ? 'Save change' : 'Send'}>
          {editing ? <Check aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}
        </Button>
      </div>
      )}
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
