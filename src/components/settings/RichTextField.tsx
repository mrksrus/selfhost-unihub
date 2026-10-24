import { useEffect, useRef, type RefObject } from 'react';
import { Bold, Italic, Link as LinkIcon, List, ListOrdered, Underline } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { sanitizeComposeHtml } from '@/lib/mail-compose';
import { cn } from '@/lib/utils';

/**
 * A short piece of formatted text in Settings (a signature, a template):
 * the composer's editing model in small, with the commands the mail toolbar
 * offers for text. In plain mode it is a text area. The HTML that leaves it
 * went through the same projection as a draft body (sanitizeComposeHtml), so
 * nothing but formatting reaches the stored signature or template.
 */
export function RichTextField({ id, value, onChange, format, placeholder, className, 'aria-label': ariaLabel }: {
  id: string; value: string; onChange: (value: string) => void; format: 'rich' | 'plain'; placeholder?: string; className?: string; 'aria-label'?: string;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  if (format === 'plain') {
    return <Textarea id={id} value={value} placeholder={placeholder} aria-label={ariaLabel} className={cn('min-h-[120px] max-h-[40dvh] font-sans text-sm', className)} onChange={event => onChange(event.target.value)} />;
  }
  return <RichEditor id={id} value={value} onChange={onChange} placeholder={placeholder} className={className} editorRef={editorRef} ariaLabel={ariaLabel} />;
}

const COMMANDS: { command: string; title: string; icon: typeof Bold }[] = [
  { command: 'bold', title: 'Bold', icon: Bold },
  { command: 'italic', title: 'Italic', icon: Italic },
  { command: 'underline', title: 'Underline', icon: Underline },
  { command: 'insertUnorderedList', title: 'Bullet list', icon: List },
  { command: 'insertOrderedList', title: 'Numbered list', icon: ListOrdered },
];

function RichEditor({ id, value, onChange, placeholder, className, editorRef, ariaLabel }: {
  id: string; value: string; onChange: (value: string) => void; placeholder?: string; className?: string; editorRef: RefObject<HTMLDivElement>; ariaLabel?: string;
}) {
  // The state becomes the editor's content only when they differ, so typing
  // (which already updated the state from the DOM) never moves the caret.
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) editorRef.current.innerHTML = value;
  }, [value, editorRef]);
  const read = () => { if (editorRef.current) onChange(sanitizeComposeHtml(editorRef.current.innerHTML)); };
  const apply = (command: string, argument?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, argument);
    read();
  };
  return (
    <div className={cn('overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background', className)}>
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
        {COMMANDS.map(({ command, title, icon: Icon }) => (
          <Button key={command} type="button" variant="ghost" size="icon-sm" title={title} aria-label={title} onMouseDown={event => event.preventDefault()} onClick={() => apply(command)}>
            <Icon className="h-4 w-4" />
          </Button>
        ))}
        <Button type="button" variant="ghost" size="icon-sm" title="Insert link" aria-label="Insert link" onMouseDown={event => event.preventDefault()}
          onClick={() => { const url = window.prompt('Link URL'); if (url?.trim()) apply('createLink', url.trim()); }}>
          <LinkIcon className="h-4 w-4" />
        </Button>
      </div>
      <div
        id={id}
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        className="min-h-[120px] max-h-[40dvh] overflow-y-auto break-words p-3 text-sm outline-none [&:empty:before]:text-muted-foreground [&:empty:before]:content-[attr(data-placeholder)] [&_a]:text-accent [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6"
        onInput={read}
        onBlur={read}
      />
    </div>
  );
}
