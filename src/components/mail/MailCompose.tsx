import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Bold, Check, ChevronDown, Image as ImageIcon, Italic, LayoutTemplate, Link as LinkIcon, List, ListOrdered, ListTodo, Loader2, Palette, Paperclip,
  RemoveFormatting, Send, TriangleAlert, Underline, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DialogFooter } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { fetchMailTemplates, mailTemplatesKey } from '@/lib/mail-essentials-api';
import { formatWhen, sendLaterChoices } from '@/lib/mail-times';
import { WhenDialog, WhenMenuItems } from '@/components/mail/WhenPicker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { MailAccount } from '@/lib/mail-api';
import type { AttachmentUpload, MailCompose } from '@/hooks/use-mail-compose';
import { formatAttachmentSize, getActiveRecipientSearchTerm } from '@/components/mail/mail-page-model';
import { joinRecipients, looksLikeAddress, recipientAddress, recipientChipLabel, splitRecipients } from '@/lib/recipient-chips';
import { visibleHeight } from '@/lib/visible-area';

type RecipientField = 'to' | 'cc' | 'bcc';

/**
 * A field of the phone composer's rows: no box of its own, the row's hairline
 * separates it; 44 px tall (P-11) with the focus ring drawn inside it, a little
 * wider than the text so the ring never covers the first letter.
 */
const INLINE_FIELD = '-mx-1 h-11 w-[calc(100%+0.5rem)] rounded-none border-0 bg-transparent px-1 focus-visible:ring-inset focus-visible:ring-offset-0';
/** The From select of that row; its ring shows on focus, not only on focus-visible. */
const INLINE_SELECT = `${INLINE_FIELD} focus:ring-inset focus:ring-offset-0`;

/**
 * One row of the phone composer: a narrow muted label, the field filling the
 * rest, and anything that ends the row (the Cc and Bcc buttons). The row is the
 * positioning box, so a recipient list opens under the whole row.
 */
function FieldRow({ label, htmlFor, children, trailing }: { label: string; htmlFor?: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="relative flex min-h-11 items-center gap-2 border-b border-border px-4">
      <Label htmlFor={htmlFor} className="w-14 shrink-0 text-sm font-normal text-muted-foreground">{label}</Label>
      <div className="min-w-0 flex-1">{children}</div>
      {trailing}
    </div>
  );
}

/**
 * One completed recipient of the phone composer: a chip showing the name (or
 * the address). Tapping it shows the full address and removes it, as the
 * attachment squares do; Delete or Backspace on a focused chip removes it too.
 */
function RecipientChip({ entry, onRemove }: { entry: string; onRemove: () => void }) {
  const label = recipientChipLabel(entry);
  const address = recipientAddress(entry);
  const valid = looksLikeAddress(entry);
  return (
    <li className="min-w-0 max-w-full">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={valid ? entry : `${entry}, not an email address`}
            className={cn('tap-area inline-flex h-8 max-w-full items-center rounded-full border px-3 text-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              valid ? 'border-border bg-muted/40 text-foreground' : 'border-destructive text-destructive')}
            onKeyDown={(event) => {
              if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onRemove(); }
            }}>
            <span className="truncate">{label}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
          <DropdownMenuLabel className="font-normal">
            <span className="block break-all font-medium">{label}</span>
            {address !== label && <span className="block break-all text-xs text-muted-foreground">{address}</span>}
            {!valid && <span className="block text-xs text-destructive">Not an email address</span>}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onRemove}>Remove recipient</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function RecipientInput({ compose, field, inputId, autoFocus, inline = false, chips = false }: {
  compose: MailCompose; field: RecipientField; inputId: string; autoFocus?: boolean;
  /** Inside a FieldRow: the row positions the list of suggestions. */
  inline?: boolean;
  /**
   * The phone composer: completed entries are chips before the input, which
   * holds the entry being typed; a comma, Enter or leaving the field completes it.
   */
  chips?: boolean;
}) {
  const value = compose.composeForm[field];
  // What the person is typing now. The field's value holds it as its last
  // entry; every other entry is complete (a prefilled draft or reply, a pick
  // from the list), so it is a chip. A value changed from outside no longer
  // ends with the typed text, which then counts as nothing typed.
  const [typed, setTyped] = useState('');
  // The list closes a moment after the field loses focus (so a tap on a
  // suggestion lands first); focus coming back within that moment keeps it.
  const blurTimer = useRef<number | null>(null);
  const all = chips ? (({ entries, draft }) => draft ? [...entries, draft] : entries)(splitRecipients(value)) : [];
  const typing = chips && typed !== '' && all[all.length - 1] === typed ? typed : '';
  const completed = typing ? all.slice(0, -1) : all;
  const searchTerm = chips ? typing.trim().toLowerCase() : getActiveRecipientSearchTerm(value);
  const suggestions = searchTerm
    ? compose.contactEmailSuggestions
      .filter((suggestion) => `${suggestion.name} ${suggestion.email}`.toLowerCase().includes(searchTerm))
      .slice(0, 8)
    : [];
  const showSuggestions = compose.focusedRecipientInput === inputId && suggestions.length > 0;
  const setChips = (entries: string[], text: string) => {
    compose.updateComposeForm({ [field]: joinRecipients(entries, text) });
    setTyped(splitRecipients(text).draft);
  };

  return (
    <div className={inline ? 'static' : 'relative'}>
      <div className={chips ? 'flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1.5 py-1.5' : undefined}>
        {chips && completed.length > 0 && (
          <ul aria-label={`${field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc'} recipients`} className="contents">
            {completed.map((entry, index) => (
              <RecipientChip key={`${index}-${entry}`} entry={entry}
                onRemove={() => setChips(completed.filter((_, at) => at !== index), typing)} />
            ))}
          </ul>
        )}
        <Input
          id={inputId}
          type="text"
          role="combobox"
          className={cn(inline && INLINE_FIELD, chips && 'h-8 min-w-[8rem] flex-1 basis-[8rem]')}
          aria-expanded={showSuggestions}
          aria-autocomplete="list"
          placeholder={completed.length ? '' : 'recipient@example.com'}
          value={chips ? typing : value}
          onChange={(e) => {
            if (chips) setChips(completed, e.target.value);
            else compose.updateComposeForm({ [field]: e.target.value });
            compose.setFocusedRecipientInput(inputId);
          }}
          onFocus={() => {
            if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
            blurTimer.current = null;
            compose.setFocusedRecipientInput(inputId);
          }}
          onBlur={() => {
            if (chips) setTyped('');
            blurTimer.current = window.setTimeout(() => {
              blurTimer.current = null;
              compose.setFocusedRecipientInput((current) => current === inputId ? null : current);
            }, 100);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && showSuggestions) {
              event.preventDefault();
              compose.setFocusedRecipientInput(null);
              return;
            }
            if (!chips) return;
            // Enter completes the entry instead of sending the message; Backspace
            // in an empty input takes the last chip back into the input to edit it.
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!showSuggestions) setTyped('');
            } else if (event.key === 'Backspace' && typing === '' && completed.length > 0) {
              event.preventDefault();
              setChips(completed.slice(0, -1), completed[completed.length - 1]);
            }
          }}
          autoComplete="off"
          autoFocus={autoFocus}
        />
      </div>
      {showSuggestions && (
        <div className="absolute left-0 right-0 top-full z-[80] mt-1 max-h-64 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.key}
              type="button"
              className="flex w-full flex-col rounded-sm px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onMouseDown={(event) => {
                event.preventDefault();
                compose.replaceActiveRecipient(suggestion, field);
                setTyped('');
                compose.setFocusedRecipientInput(inputId);
              }}
            >
              <span className="font-medium truncate">{suggestion.name || suggestion.email}</span>
              {suggestion.name && (
                <span className="text-xs text-muted-foreground truncate">{suggestion.email}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A dialog closes on Escape; when a recipient list is open, Escape only closes that list. */
const keepDialogOpenWhileSuggesting = (event: KeyboardEvent) => {
  if ((event.target as HTMLElement | null)?.getAttribute('aria-expanded') === 'true') event.preventDefault();
};

/**
 * To with quiet Cc and Bcc buttons at its right end; each reveals its own row. A field that
 * already has content (an opened draft) is shown from the start. `idSuffix` keeps ids unique
 * per form; `rowClassName` lets the inline grid keep To next to Subject.
 */
function RecipientRows({ compose, idSuffix = '', rowClassName }: { compose: MailCompose; idSuffix?: string; rowClassName?: string }) {
  const [revealed, setRevealed] = useState<RecipientField[]>([]);
  const optional: RecipientField[] = ['cc', 'bcc'];
  const shown = (field: RecipientField) => revealed.includes(field) || compose.composeForm[field] !== '';
  const label = (field: RecipientField) => field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc';
  const hidden = optional.filter((field) => !shown(field));
  return (
    <>
      <div className="space-y-2">
        <div className="flex h-6 items-center justify-between touch:h-8">
          <Label htmlFor={`compose-to${idSuffix}`}>To</Label>
          {hidden.length > 0 && (
            <div className="-mr-1.5 flex touch:gap-2">
              {hidden.map((field) => (
                <Button
                  key={field}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-xs text-muted-foreground touch:h-8 touch:px-2 touch:text-sm tap-area"
                  onClick={() => setRevealed((current) => [...current, field])}
                >
                  {label(field)}
                </Button>
              ))}
            </div>
          )}
        </div>
        <RecipientInput compose={compose} field="to" inputId={`compose-to${idSuffix}`} />
      </div>
      {optional.filter(shown).map((field) => (
        <div key={field} className={`space-y-2 ${rowClassName ?? ''}`}>
          <Label htmlFor={`compose-${field}${idSuffix}`}>{label(field)}</Label>
          <RecipientInput compose={compose} field={field} inputId={`compose-${field}${idSuffix}`} autoFocus={revealed.includes(field)} />
        </div>
      ))}
    </>
  );
}

/**
 * The phone composer's header (0.25.0, modelled on Apple Mail): To with its
 * recipients as chips; one line "Cc/Bcc, From: <account>" that opens into the
 * Cc, Bcc and From rows on tap (open from the start when the message already
 * has a Cc or Bcc); Subject. The From control itself is the dialog's (P-17).
 */
function PhoneComposeHeader({ compose, from, fromAddress }: { compose: MailCompose; from: ReactNode; fromAddress: string }) {
  const [opened, setOpened] = useState(false);
  const expanded = opened || compose.composeForm.cc !== '' || compose.composeForm.bcc !== '';
  return (
    <>
      <FieldRow label="To" htmlFor="compose-to">
        <RecipientInput compose={compose} field="to" inputId="compose-to" inline chips />
      </FieldRow>
      {expanded ? (
        <>
          <FieldRow label="Cc" htmlFor="compose-cc">
            <RecipientInput compose={compose} field="cc" inputId="compose-cc" inline chips autoFocus={opened} />
          </FieldRow>
          <FieldRow label="Bcc" htmlFor="compose-bcc">
            <RecipientInput compose={compose} field="bcc" inputId="compose-bcc" inline chips />
          </FieldRow>
          <FieldRow label="From">{from}</FieldRow>
        </>
      ) : (
        <button type="button" aria-expanded={false} onClick={() => setOpened(true)}
          className="flex min-h-11 w-full items-center gap-1 border-b border-border px-4 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <span className="shrink-0 text-muted-foreground">Cc/Bcc, From:</span>
          <span className="truncate">{fromAddress || 'Select account'}</span>
        </button>
      )}
      <FieldRow label="Subject" htmlFor="compose-subject">
        <Input id="compose-subject" className={INLINE_FIELD} value={compose.composeForm.subject}
          onChange={(e) => compose.updateComposeForm({ subject: e.target.value })} />
      </FieldRow>
    </>
  );
}

/** Templates (Settings, Mail): insert one, or save the open message as one. */
function TemplatesMenu({ compose }: { compose: MailCompose }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const templates = useQuery({ queryKey: mailTemplatesKey, queryFn: fetchMailTemplates, enabled: open });
  return <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Templates" title="Templates">
          <LayoutTemplate aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      {/* The editor keeps the focus a template was inserted at. */}
      <DropdownMenuContent align="end" className="max-h-[60vh] min-w-[14rem] overflow-y-auto" onCloseAutoFocus={event => event.preventDefault()}>
        <DropdownMenuLabel>Templates</DropdownMenuLabel>
        {templates.isLoading ? <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
          : templates.isError ? <DropdownMenuItem disabled>Could not load the templates</DropdownMenuItem>
          : templates.data?.length === 0 ? <DropdownMenuItem disabled>No templates yet</DropdownMenuItem>
          : templates.data?.map(template => (
            <DropdownMenuItem key={template.id} onSelect={() => compose.applyTemplate(template)}>{template.name}</DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setSaving(true)}>Save as template…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <SaveTemplateDialog open={saving} onOpenChange={setSaving} compose={compose} />
  </>;
}

/** Names the template the open message becomes; a taken name is refused in place. */
function SaveTemplateDialog({ open, onOpenChange, compose }: { open: boolean; onOpenChange: (open: boolean) => void; compose: MailCompose }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(compose.composeForm.subject.trim()); setError(null); } }, [open, compose.composeForm.subject]);
  const save = async () => {
    if (!name.trim()) { setError('Give the template a name.'); return; }
    setBusy(true);
    try {
      await compose.saveAsTemplate(name.trim());
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save the template');
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save as template</DialogTitle>
          <DialogDescription>The subject and the text above the signature are kept; recipients and attachments are not.</DialogDescription>
        </DialogHeader>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void save(); }}>
          <Label htmlFor="template-name">Name</Label>
          <Input id="template-name" value={name} autoFocus maxLength={80} aria-invalid={!!error} aria-describedby={error ? 'template-name-error' : undefined}
            onChange={event => { setName(event.target.value); setError(null); }} />
          {error && <p id="template-name-error" role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 aria-hidden="true" className="animate-spin" />}Save template</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Formatted ↔ plain text for this message; losing the formatting is confirmed first. */
function FormatSwitch({ compose }: { compose: MailCompose }) {
  const [confirm, setConfirm] = useState(false);
  const plain = compose.bodyFormat === 'plain';
  const label = plain ? 'Switch to formatted text' : 'Switch to plain text';
  return <>
    <Button type="button" variant="ghost" size="icon-sm" aria-pressed={plain} aria-label={label} title={label}
      className={plain ? 'bg-muted text-foreground' : undefined}
      onMouseDown={event => event.preventDefault()} onClick={() => plain ? compose.switchBodyFormat('rich') : setConfirm(true)}>
      <RemoveFormatting aria-hidden="true" />
    </Button>
    <AlertDialog open={confirm} onOpenChange={setConfirm}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch to plain text?</AlertDialogTitle>
          <AlertDialogDescription>Bold, lists, links, images and colours are removed from this message. The text stays.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep formatting</AlertDialogCancel>
          <AlertDialogAction onClick={() => compose.switchBodyFormat('plain')}>Switch to plain text</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

// Up to this many optional features share the toolbar row (P-26); more get a
// line of their own above the message.
const FEATURES_IN_TOOLBAR = 3;

/** The optional compose features switched on in Settings (P-26), one button each, where they act on the message. */
function composeFeatureButtons(compose: MailCompose): ReactNode[] {
  const buttons: ReactNode[] = [];
  if (compose.features.templates) buttons.push(<TemplatesMenu key="templates" compose={compose} />);
  if (compose.features.formatSwitch) buttons.push(<FormatSwitch key="format" compose={compose} />);
  return buttons;
}

/** Save draft: a failed save reports itself in a toast, and its rejection ends here. */
function saveDraftNow(compose: MailCompose) {
  compose.saveCurrentDraft({ includeAttachments: true }).catch(() => {});
}

/** Send, and with Send later on (Settings, Mail) a split button whose arrow half offers the times. */
function SendButton({ compose }: { compose: MailCompose }) {
  const busy = compose.isSending || compose.isDraftSaving;
  const [custom, setCustom] = useState(false);
  const main = (
    <Button type="submit" disabled={busy} className={cn(compose.features.scheduledSend && 'rounded-r-none')}>
      {busy ? <><Loader2 aria-hidden="true" className="animate-spin" />Sending...</> : <><Send aria-hidden="true" />Send</>}
    </Button>
  );
  if (!compose.features.scheduledSend) return main;
  return <>
    {/* No gap between the halves; the arrow half is a full touch target of its own. */}
    <div className="inline-flex">
      {main}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" disabled={busy} aria-label="Send later" title="Send later"
            className="min-w-11 rounded-l-none border-l border-primary-foreground/30 px-2">
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[14rem]">
          <DropdownMenuLabel>Send later</DropdownMenuLabel>
          <WhenMenuItems choices={sendLaterChoices()} onPick={at => void compose.scheduleSend(at)} onPickCustom={() => setCustom(true)} />
          {compose.scheduledAt && <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void compose.cancelScheduledSend()}>Cancel scheduled send</DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <WhenDialog open={custom} onOpenChange={setCustom} title="Send later" description="The message is saved as a draft and sent at this time."
      confirmLabel="Schedule" onPick={at => void compose.scheduleSend(at)} />
  </>;
}

// The message body in the message's format: the rich editor with its
// toolbar, or plain text (Settings, Mail: compose format). The optional
// features end the toolbar row; plain text keeps a one-row strip for them;
// four or more get a line of their own above the message (P-26).
function ComposeBodyEditor(props: {
  compose: MailCompose; editorId: string; editorRef: RefObject<HTMLDivElement>; editorClassName?: string;
  /** The box around toolbar and text (the phone composer lets it fill the message's room). */
  boxClassName?: string;
  /** Attach button and file chips in the toolbar row (phones), instead of a section below the message. */
  attachments?: ReactNode;
}) {
  const features = composeFeatureButtons(props.compose);
  const ownLine = features.length > FEATURES_IN_TOOLBAR;
  if (props.compose.bodyFormat === 'rich') return <RichComposeEditor {...props} features={ownLine ? [] : features} strip={ownLine ? features : null} />;
  const { compose, editorId, editorClassName = '', boxClassName = '', attachments } = props;
  const hasStrip = features.length > 0 || !!attachments;
  const textarea = <PlainEditorArea compose={compose} editorId={editorId}
    className={cn(hasStrip ? 'rounded-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0' : boxClassName, editorClassName)} />;
  if (!hasStrip) return textarea;
  return (
    <div className={`rounded-md border border-input bg-background overflow-hidden ${editorClassName.includes('flex-1') ? 'flex flex-col min-h-0' : ''} ${boxClassName}`}>
      <div className="flex items-center justify-end gap-1 border-b border-border bg-muted/30 px-2 py-1">
        {attachments && <div className="mr-auto flex min-w-0 flex-1 items-center">{attachments}</div>}
        {features}
      </div>
      {textarea}
    </div>
  );
}

/** The plain-text message. */
function PlainEditorArea({ compose, editorId, className }: { compose: MailCompose; editorId: string; className?: string }) {
  return (
    <Textarea
      id={editorId}
      value={compose.composeForm.body}
      placeholder="Write your message..."
      className={cn('resize-none overscroll-contain font-sans text-sm', className)}
      onChange={event => compose.updateComposeForm({ body: event.target.value })}
      onSelect={event => compose.rememberPlainSelection(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
      onBlur={event => compose.rememberPlainSelection(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
    />
  );
}

function RichComposeEditor({ compose, editorId, editorRef, editorClassName = '', boxClassName = '', attachments, features, strip }: {
  compose: MailCompose; editorId: string; editorRef: RefObject<HTMLDivElement>; editorClassName?: string; boxClassName?: string;
  attachments?: ReactNode;
  /** Feature buttons ending the toolbar row. */
  features: ReactNode[];
  /** Feature buttons on a line of their own (four or more). */
  strip: ReactNode[] | null;
}) {
  return (
    <div className={`rounded-md border border-input bg-background overflow-hidden ${editorClassName.includes('flex-1') ? 'flex flex-col min-h-0' : ''} ${boxClassName}`}>
      <RichToolbar compose={compose} editorRef={editorRef} attachments={attachments} features={features} className="flex-wrap border-b border-border bg-muted/30 px-2 py-1" />
      {strip && <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">{strip}</div>}
      <RichEditorArea compose={compose} editorId={editorId} editorRef={editorRef} className={`p-3 ${editorClassName}`} />
    </div>
  );
}

/**
 * The formatting buttons; the attachments follow Image URL on phones, and the
 * optional features end the row. `scrolling` is the phone's one-row toolbar:
 * the formatting buttons scroll sideways under a fade, while the attach button
 * and the file squares stay in view at the row's end (P-26).
 */
function RichToolbar({ compose, editorRef, attachments, features, className, scrolling = false }: {
  compose: MailCompose; editorRef: RefObject<HTMLDivElement>; attachments?: ReactNode; features: ReactNode[]; className?: string; scrolling?: boolean;
}) {
  const formatting = (
    <>
      <Button type="button" variant="ghost" size="icon-sm" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'bold')}>
        <Bold className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'italic')}>
        <Italic className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'underline')}>
        <Underline className="h-4 w-4" />
      </Button>
      <div className="h-5 w-px shrink-0 bg-border mx-1" />
      <Button type="button" variant="ghost" size="icon-sm" title="Bullet list" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'insertUnorderedList')}>
        <List className="h-4 w-4" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" title="Numbered list" onMouseDown={(e) => e.preventDefault()} onClick={() => compose.applyComposeCommand(editorRef, 'insertOrderedList')}>
        <ListOrdered className="h-4 w-4" />
      </Button>
      <div className="h-5 w-px shrink-0 bg-border mx-1" />
      <label className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md touch:h-10 touch:w-10 text-muted-foreground hover:bg-accent hover:text-accent-foreground" title="Text color">
        <Palette className="h-4 w-4" />
        <input
          type="color"
          className="sr-only"
          onChange={(event) => compose.applyComposeCommand(editorRef, 'foreColor', event.target.value)}
        />
      </label>
      <select
        aria-label="Text size"
        className="h-8 shrink-0 rounded-md border border-input bg-background px-2 text-xs touch:h-10"
        defaultValue=""
        onChange={(event) => {
          if (event.target.value) compose.applyComposeCommand(editorRef, 'fontSize', event.target.value);
          event.target.value = '';
        }}
      >
        <option value="" disabled>Size</option>
        <option value="2">Small</option>
        <option value="3">Normal</option>
        <option value="5">Large</option>
        <option value="6">Huge</option>
      </select>
      <div className="h-5 w-px shrink-0 bg-border mx-1" />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Insert link"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const url = window.prompt('Link URL');
          if (url?.trim()) compose.applyComposeCommand(editorRef, 'createLink', url.trim());
        }}
      >
        <LinkIcon className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="Insert image URL"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const url = window.prompt('Image URL');
          if (url?.trim()) compose.applyComposeCommand(editorRef, 'insertImage', url.trim());
        }}
      >
        <ImageIcon className="h-4 w-4" />
      </Button>
    </>
  );
  if (scrolling) return (
    <div className={cn('flex items-center gap-1', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 [mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]">
        {formatting}
      </div>
      {attachments && <div className="flex max-w-[55%] shrink-0 items-center">{attachments}</div>}
      {features.length > 0 && <div className="flex shrink-0 items-center gap-1">{features}</div>}
    </div>
  );
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {formatting}
      {attachments}
      {features.length > 0 && <div className="ml-auto flex shrink-0 items-center gap-1">{features}</div>}
    </div>
  );
}

/** The formatted message: a contenteditable area whose HTML follows the compose state. */
function RichEditorArea({ compose, editorId, editorRef, className }: {
  compose: MailCompose; editorId: string; editorRef: RefObject<HTMLDivElement>; className?: string;
}) {
  // The body state becomes the editor's content here, where the editor exists:
  // the dialog's editor is portaled in a commit after the draft set the body,
  // so an effect in the hook ran before the element did. Only sanitized or
  // self-written HTML reaches composeForm.body (see sanitizeComposeHtml).
  const body = compose.composeForm.body;
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== body) editorRef.current.innerHTML = body;
  }, [body, editorRef]);
  return (
    <div
      id={editorId}
      ref={editorRef}
      role="textbox"
      aria-label="Message"
      aria-multiline="true"
      contentEditable
      suppressContentEditableWarning
      data-placeholder="Write your message..."
      className={`text-sm outline-none overflow-y-auto overscroll-contain break-words [&:empty:before]:content-[attr(data-placeholder)] [&:empty:before]:text-muted-foreground [&_a]:text-accent [&_a]:underline [&_img]:max-w-full [&_img]:rounded-md [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 ${className ?? ''}`}
      onInput={() => compose.updateComposeBodyFromEditor(editorRef)}
      onKeyUp={() => compose.rememberRichSelection(editorRef)}
      onMouseUp={() => compose.rememberRichSelection(editorRef)}
      onBlur={() => { compose.rememberRichSelection(editorRef); compose.updateComposeBodyFromEditor(editorRef); }}
    />
  );
}

/**
 * The phone composer's message and its toolbar (P-26, 0.25.0): the message
 * fills the scroller, and the toolbar is one row that scrolls sideways,
 * pinned above the buttons, so it sits above the keyboard while writing. The
 * attach button and file squares are in that row; four or more optional
 * features get a row of their own above it.
 */
function phoneComposeParts({ compose, editorRef, messageRef, onFocusMessage, onInputMessage }: {
  compose: MailCompose; editorRef: RefObject<HTMLDivElement>; messageRef: RefObject<HTMLDivElement>;
  onFocusMessage: (target: EventTarget | null) => void; onInputMessage: () => void;
}) {
  const features = composeFeatureButtons(compose);
  const ownLine = features.length > FEATURES_IN_TOOLBAR;
  const attachments = <ToolbarAttachments compose={compose} inputId="compose-attachments-dialog" />;
  const rich = compose.bodyFormat === 'rich';
  return {
    message: (
      <div
        ref={messageRef}
        className="flex flex-col"
        style={{ minHeight: '100cqh' }}
        onFocus={(event) => onFocusMessage(event.target)}
        onInput={onInputMessage}
      >
        <Label htmlFor="compose-body" className="sr-only">Message</Label>
        {rich
          ? <RichEditorArea compose={compose} editorId="compose-body" editorRef={editorRef} className="flex-1 px-4 py-3 [field-sizing:content]" />
          : <PlainEditorArea compose={compose} editorId="compose-body" className="flex-1 rounded-none border-0 px-4 py-3 [field-sizing:content] focus-visible:ring-0 focus-visible:ring-offset-0" />}
      </div>
    ),
    toolbar: (
      <div className="shrink-0 border-t border-border bg-muted/30">
        {ownLine && <div className="flex items-center gap-1 border-b border-border px-2 py-1">{features}</div>}
        {rich
          ? <RichToolbar compose={compose} editorRef={editorRef} attachments={attachments} features={ownLine ? [] : features} scrolling className="px-2 py-1" />
          : <div className="flex items-center gap-1 px-2 py-1">
            <div className="mr-auto flex min-w-0 flex-1 items-center">{attachments}</div>
            {!ownLine && features}
          </div>}
      </div>
    ),
  };
}

type FileState = AttachmentUpload | 'pending';

const FILE_STATE_TEXT: Record<FileState, string> = {
  pending: 'Not saved with the draft yet',
  uploading: 'Saving with the draft...',
  saved: 'Saved with the draft',
  failed: 'Could not be saved with the draft',
};

/** What a file chip shows: the name's extension (".pdf"), at most four letters. */
const fileTypeLabel = (filename: string) => {
  const extension = /\.([^./\\]+)$/.exec(filename)?.[1];
  return extension ? `.${extension.slice(0, 4).toLowerCase()}` : 'file';
};

/**
 * One attached file in the toolbar row: a small square with its file type and
 * a mark for whether the draft holds it. Tapping it shows the name and size,
 * and removes it.
 */
function AttachmentChip({ name, size, state, onRemove, onRetry }: {
  name: string; size: number; state: FileState; onRemove: () => void; onRetry: () => void;
}) {
  const sizeText = formatAttachmentSize(size);
  return (
    <li className="shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={`${name}, ${sizeText}, ${FILE_STATE_TEXT[state]}`} title={name}
            className={cn('relative flex h-8 w-8 items-center justify-center rounded-md border bg-background pb-1 font-mono text-[10px] font-medium leading-none touch:h-10 touch:w-10',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
              state === 'failed' ? 'border-destructive text-destructive' : 'border-border text-muted-foreground hover:text-foreground')}>
            {fileTypeLabel(name)}
            {state !== 'pending' && (
              <span aria-hidden="true" className={cn('absolute bottom-0.5 right-0.5 flex h-3 w-3 items-center justify-center rounded-full',
                state === 'saved' && 'bg-success text-success-foreground',
                state === 'failed' && 'bg-destructive text-destructive-foreground',
                state === 'uploading' && 'text-muted-foreground')}>
                {state === 'saved' && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                {state === 'failed' && <TriangleAlert className="h-2 w-2" strokeWidth={3} />}
                {state === 'uploading' && <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
          <DropdownMenuLabel className="font-normal">
            <span className="block break-all font-medium">{name}</span>
            <span className={cn('block text-xs', state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
              {sizeText} · {FILE_STATE_TEXT[state]}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {state === 'failed' && <DropdownMenuItem onSelect={onRetry}>Try again</DropdownMenuItem>}
          <DropdownMenuItem onSelect={onRemove}>Remove attachment</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/**
 * Phones (P-26): the attach button and one small chip per file end the
 * message's toolbar row, so they stay on screen with the keyboard open. The
 * chips scroll sideways when they do not fit.
 */
function ToolbarAttachments({ compose, inputId }: { compose: MailCompose; inputId: string }) {
  const retry = () => { compose.saveCurrentDraft({ includeAttachments: true }).catch(() => {}); };
  const files = [
    ...compose.existingDraftAttachments.map(attachment => ({
      key: attachment.id, name: attachment.filename, size: attachment.size_bytes, state: 'saved' as FileState,
      remove: () => compose.removeExistingDraftAttachment(attachment.id),
    })),
    ...compose.composeAttachments.map(({ id, file }) => ({
      key: id, name: file.name, size: file.size, state: (compose.attachmentUploads[id] ?? 'pending') as FileState,
      remove: () => compose.removeComposeAttachment(id),
    })),
  ];
  return (
    <div className={cn('flex items-center gap-1', files.length > 0 && 'min-w-[7.5rem] flex-1')}>
      <input id={inputId} type="file" multiple className="hidden" onChange={compose.handleComposeAttachmentInput} />
      <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" title="Attach files" aria-label="Attach files"
        onClick={() => (document.getElementById(inputId) as HTMLInputElement | null)?.click()}>
        <Paperclip className="h-4 w-4" />
      </Button>
      {files.length > 0 && (
        <ul aria-label="Attachments" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain">
          {files.map(file => (
            <AttachmentChip key={file.key} name={file.name} size={file.size} state={file.state} onRemove={file.remove} onRetry={retry} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ComposeAttachmentsSection({ compose, inputId, className }: { compose: MailCompose; inputId: string; className?: string }) {
  // Files just added may land below the scroller's visible part: bring the
  // last one into view (not on opening a draft, whose files are already saved).
  const listRef = useRef<HTMLDivElement>(null);
  const added = compose.composeAttachments.length;
  const addedBefore = useRef(added);
  useEffect(() => {
    if (added > addedBefore.current) listRef.current?.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
    addedBefore.current = added;
  }, [added]);
  return (
    <div className={cn('space-y-2', className)}>
      <Label>Attachments</Label>
      <input
        id={inputId}
        type="file"
        multiple
        className="hidden"
        onChange={compose.handleComposeAttachmentInput}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          compose.setIsAttachmentDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          compose.setIsAttachmentDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          compose.setIsAttachmentDragOver(false);
          if (e.dataTransfer?.files?.length) {
            compose.addComposeFiles(e.dataTransfer.files);
          }
        }}
        className={`rounded-lg border border-dashed p-3 transition-colors ${
          compose.isAttachmentDragOver ? 'border-accent bg-accent/5' : 'border-border'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Drag and drop files here, or</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              const input = document.getElementById(inputId) as HTMLInputElement | null;
              input?.click();
            }}
          >
            <Paperclip className="h-4 w-4 mr-2" />
            Add attachments
          </Button>
        </div>
      </div>

      {(compose.existingDraftAttachments.length > 0 || compose.composeAttachments.length > 0) && (
        <div ref={listRef} className="space-y-2">
          {compose.existingDraftAttachments.map((attachment) => (
            <div key={attachment.id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{attachment.filename}</p>
                <p className="text-xs text-muted-foreground">{formatAttachmentSize(attachment.size_bytes)}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => compose.removeExistingDraftAttachment(attachment.id)}
                title="Remove attachment"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {compose.composeAttachments.map(({ id, file }) => (
            <div key={id} className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{formatAttachmentSize(file.size)}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => compose.removeComposeAttachment(id)}
                title="Remove attachment"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Add task" for the draft being written; the draft is saved first so the task can point at it. An icon on phones, where the footer is one row. */
function AddTaskFromDraft({ compose, onAddTask, icon = false }: { compose: MailCompose; onAddTask?: () => void; icon?: boolean }) {
  if (!onAddTask) return null;
  if (icon) return (
    <Button type="button" variant="ghost" size="icon" className="mr-auto" aria-label="Add task" title="Add task" onClick={onAddTask} disabled={compose.isDraftSaving || compose.isSending}>
      <ListTodo aria-hidden="true" />
    </Button>
  );
  return (
    <Button type="button" variant="ghost" size="sm" className="mr-auto" onClick={onAddTask} disabled={compose.isDraftSaving || compose.isSending}>
      <ListTodo aria-hidden="true" />Add task
    </Button>
  );
}

/**
 * Reply editor under a message. `fill` lets it take the whole column (the peek
 * on phones) instead of the lower half; its footer is then one row, as the
 * phone composer's (P-26): no Cancel (the close control does the same).
 */
export function MailInlineCompose({ compose, onAddTask, fill = false }: { compose: MailCompose; onAddTask?: () => void; fill?: boolean }) {
  return (
    <div className={fill ? 'min-h-0 flex-1 bg-card' : 'max-h-[52vh] shrink-0 border-t border-border bg-card'}>
      <div className="mx-auto flex h-full max-w-4xl flex-col p-4">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <h2 className="text-lg font-semibold">
            {compose.composeMode === 'reply' ? 'Reply' : compose.composeMode === 'forward' ? 'Forward' : 'Compose'}
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              compose.closeComposeFlow();
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <form onSubmit={compose.handleSendEmail} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="grid shrink-0 gap-3 md:grid-cols-2">
            <RecipientRows compose={compose} idSuffix="-inline" rowClassName="md:order-last md:col-span-2" />
            <div className="space-y-2">
              <Label htmlFor="compose-subject-inline">Subject</Label>
              <Input
                id="compose-subject-inline"
                placeholder="Enter subject"
                value={compose.composeForm.subject}
                onChange={(e) => compose.updateComposeForm({ subject: e.target.value })}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-3">
            <div className="space-y-2">
              <Label htmlFor="compose-body-inline">Message</Label>
              <ComposeBodyEditor compose={compose} editorId="compose-body-inline" editorRef={compose.inlineComposeEditorRef} editorClassName="h-[220px] min-h-[180px]"
                attachments={fill ? <ToolbarAttachments compose={compose} inputId="compose-attachments-inline" /> : undefined} />
            </div>
            {!fill && <ComposeAttachmentsSection compose={compose} inputId="compose-attachments-inline" />}
          </div>
          <div className={cn('flex shrink-0 items-center justify-end gap-3 border-t border-border pt-3', !fill && 'flex-wrap')}>
            <AddTaskFromDraft compose={compose} onAddTask={onAddTask} icon={fill} />
            <Button type="button" variant="secondary" onClick={() => saveDraftNow(compose)} disabled={compose.isDraftSaving || compose.isSending}>
              {compose.isDraftSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save draft
            </Button>
            {!fill && (
              <Button type="button" variant="outline" onClick={() => { compose.closeComposeFlow(); }}>
                Cancel
              </Button>
            )}
            <SendButton compose={compose} />
          </div>
        </form>
      </div>
    </div>
  );
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMessageField = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement);

/** New message dialog, and reply/forward on phones. */
export function MailComposeDialog({ compose, accounts, isMobile, onAddTask }: {
  compose: MailCompose; accounts: MailAccount[]; isMobile: boolean; onAddTask?: () => void;
}) {
  const senders = accounts.filter(account => account.is_active && !account.disconnected_at);
  const title = compose.composeMode === 'reply' ? 'Reply' : compose.composeMode === 'forward' ? 'Forward' : 'New message';
  const status = compose.scheduledAt ? `Scheduled for ${formatWhen(compose.scheduledAt)}. It can be edited until it is sent.`
    : compose.isDraftSaving ? 'Saving draft...' : compose.draftSavedAt ? `Draft saved ${format(new Date(compose.draftSavedAt), 'HH:mm')}` : null;
  const hasStatus = !!(compose.activeDraftId || compose.isDraftSaving || compose.draftSavedAt);

  // On a phone the header rows and the message scroll together in one
  // scroller, and the message is at least as tall as that scroller. When the
  // message gets focus, the scroller moves so the message starts at its top:
  // the header rows scroll away and the message keeps the whole room between
  // the title bar and the toolbar above the keyboard. Later the person's own
  // scrolling is left alone, unless the caret would be hidden.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const giveMessageTheRoom = useCallback(() => {
    const scroller = scrollerRef.current;
    const message = messageRef.current;
    if (!scroller || !message) return;
    const top = message.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, []);
  const caretHidden = () => {
    const scroller = scrollerRef.current;
    const selection = window.getSelection();
    const active = document.activeElement;
    if (!scroller || !selection?.rangeCount || !(active instanceof HTMLElement && active.isContentEditable)) return false;
    const caret = selection.getRangeAt(0).getBoundingClientRect();
    const room = scroller.getBoundingClientRect();
    return caret.height > 0 && (caret.top < room.top || caret.bottom > room.bottom);
  };
  useEffect(() => {
    if (!isMobile || !compose.isComposeOpen) return;
    // The keyboard opens after the focus: the visible area shrinks, so align again.
    const onResize = () => {
      if (messageRef.current?.contains(document.activeElement) && visibleHeight() < 704) giveMessageTheRoom();
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [isMobile, compose.isComposeOpen, giveMessageTheRoom]);

  const subject = (id: string, className?: string) => (
    <Input
      id={id}
      className={className}
      placeholder="Enter subject"
      value={compose.composeForm.subject}
      onChange={(e) => compose.updateComposeForm({ subject: e.target.value })}
    />
  );
  const from = (className?: string) => (
    <Select value={compose.fromAccountId || ''} onValueChange={value => compose.setFromAccount(value)}>
      <SelectTrigger aria-label="From" className={className}>
        <SelectValue placeholder="Select account" />
      </SelectTrigger>
      <SelectContent>
        {senders.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.email_address}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const footer = (
    // One row on phones (P-26): Add task as an icon, no Cancel (the close control does the same).
    <div className={cn('flex shrink-0 items-center justify-end gap-3 border-t border-border bg-background',
      isMobile ? 'px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]' : 'flex-wrap px-4 py-3')}>
      <AddTaskFromDraft compose={compose} onAddTask={onAddTask} icon={isMobile} />
      <Button type="button" variant="secondary" onClick={() => saveDraftNow(compose)} disabled={compose.isDraftSaving || compose.isSending}>
        {compose.isDraftSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        Save draft
      </Button>
      {!isMobile && (
        <Button type="button" variant="outline" onClick={() => {
          compose.closeComposeFlow();
        }}>
          Cancel
        </Button>
      )}
      <SendButton compose={compose} />
    </div>
  );

  const phone = isMobile ? phoneComposeParts({
    compose, editorRef: compose.dialogComposeEditorRef, messageRef,
    onFocusMessage: (target) => { if (isMessageField(target)) giveMessageTheRoom(); },
    onInputMessage: () => { if (caretHidden()) giveMessageTheRoom(); },
  }) : null;

  return (
    <Dialog open={compose.isComposeOpen} onOpenChange={(open) => {
      if (open) compose.openCompose();
      else compose.closeComposeFlow();
    }}>
      {isMobile ? (
        // The whole visible area, from the status bar down to the keyboard or the
        // home indicator (lib/visible-area.ts); the page's header and bottom bar are behind it.
        <DialogContent hideClose onEscapeKeyDown={keepDialogOpenWhileSuggesting}
          className="inset-x-0 !flex w-full max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-0 p-0 pt-[env(safe-area-inset-top,0px)] sm:rounded-none"
          style={{ top: 'var(--visible-top, 0px)', height: 'var(--visible-height, 100dvh)', maxHeight: 'var(--visible-height, 100dvh)' }}>
          <DialogHeader className="flex h-12 shrink-0 flex-row items-center gap-1 space-y-0 border-b border-border pl-1 pr-3 text-left">
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="icon" aria-label="Close" title="Close">
                <X aria-hidden="true" />
              </Button>
            </DialogClose>
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base leading-tight">{title}</DialogTitle>
              <DialogDescription className={hasStatus ? 'truncate text-xs leading-tight' : 'sr-only'}>
                {status ?? 'Compose email message'}
              </DialogDescription>
            </div>
          </DialogHeader>
          <form onSubmit={compose.handleSendEmail} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* The scroller is a size container, so the message can be as tall as it (100cqh). */}
            <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [container-type:size]">
              <PhoneComposeHeader compose={compose} from={from(INLINE_SELECT)}
                fromAddress={senders.find(account => account.id === compose.fromAccountId)?.email_address ?? ''} />
              {phone?.message}
            </div>
            {phone?.toolbar}
            {footer}
          </form>
        </DialogContent>
      ) : (
        <DialogContent className="sm:max-w-3xl max-h-[90dvh] !flex flex-col overflow-hidden p-0" onEscapeKeyDown={keepDialogOpenWhileSuggesting}>
          <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-10">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className={hasStatus ? undefined : 'sr-only'}>
              {status ?? 'Compose email message'}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={compose.handleSendEmail} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 space-y-4 px-4 py-3">
              <div className="space-y-2">
                <Label>From</Label>
                {from()}
              </div>
              <RecipientRows compose={compose} />
              <div className="space-y-2">
                <Label htmlFor="compose-subject">Subject</Label>
                {subject('compose-subject')}
              </div>
            </div>
            {/* The message is as tall as min(44vh, 420px) when the dialog has the room, and
                gives way (down to its minimum) so the Attachments section stays in view. */}
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
              <div className="flex min-h-[15rem] flex-col gap-2">
                <Label htmlFor="compose-body">Message</Label>
                <ComposeBodyEditor
                  compose={compose}
                  editorId="compose-body"
                  editorRef={compose.dialogComposeEditorRef}
                  editorClassName="flex-1 basis-[min(44vh,420px)] min-h-0"
                />
              </div>
              <ComposeAttachmentsSection compose={compose} inputId="compose-attachments-dialog" className="shrink-0" />
            </div>
            {footer}
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Unsaved-changes prompt and draft deletion confirmation. */
export function MailComposeDialogs({ compose }: { compose: MailCompose }) {
  return <>
    <AlertDialog open={compose.composeClosePromptOpen} onOpenChange={compose.setComposeClosePromptOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save this draft?</AlertDialogTitle>
          <AlertDialogDescription>
            This message has unsaved changes. Save it as a draft, discard it, or keep editing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(event) => {
              event.preventDefault();
              void compose.discardCurrentCompose();
            }}
          >
            Discard
          </AlertDialogAction>
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              compose.saveAndClose();
            }}
          >
            {compose.isDraftSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={!!compose.draftToDelete} onOpenChange={(open) => !open && compose.setDraftToDelete(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete draft?</AlertDialogTitle>
          <AlertDialogDescription>
            This draft and its attachments will be removed from UniHub.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={compose.confirmDeleteDraft}
          >
            Delete draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
