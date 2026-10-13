import type { MouseEvent } from 'react';
import { Download, Paperclip } from 'lucide-react';
import type { EmailAttachment } from '@/lib/mail-api';
import { useAttachmentDownload } from '@/hooks/use-attachment-download';
import { formatAttachmentSize } from '@/components/mail/mail-page-model';
import { Button } from '@/components/ui/button';

/**
 * The attachments of a message. A row opens the attachment (`onOpen`) or, when
 * there is nothing to open it with, downloads it; the icon at the end always
 * downloads.
 */
export function AttachmentList({ attachments, onOpen }: { attachments: EmailAttachment[]; onOpen?: (attachment: EmailAttachment) => void }) {
  const download = useAttachmentDownload();
  if (attachments.length === 0) return null;
  return (
    <section aria-label="Attachments" className="border-t border-border pt-4">
      <div className="mb-3 flex items-center gap-2">
        <Paperclip aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Attachments ({attachments.length})</span>
      </div>
      <ul className="space-y-2">
        {attachments.map(attachment => {
          const save = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); void download(attachment); };
          return (
            <li key={attachment.id} className="flex items-center gap-2 rounded-lg border border-border transition-colors hover:bg-muted/50">
              <button type="button" onClick={onOpen ? () => onOpen(attachment) : save}
                className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <Paperclip aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{attachment.filename}</span>
                  <span className="block text-xs text-muted-foreground">{attachment.content_type} · {formatAttachmentSize(attachment.size_bytes)}</span>
                </span>
              </button>
              <Button type="button" variant="ghost" size="icon" className="mr-1 shrink-0" aria-label={`Download ${attachment.filename}`} title="Download" onClick={save}>
                <Download aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
