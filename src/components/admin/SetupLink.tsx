import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { SetupLink } from '@/lib/admin-api';
import { copyText } from '@/lib/platform';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatDayTime } from '@/components/admin/person-words';

/**
 * A setup link, shown once: the server keeps only its hash, so the page
 * that created it is the only place to copy it. The administrator sends it
 * themselves; UniHub sends no mail of its own.
 */
export function SetupLinkBlock({ link }: { link: SetupLink }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  // The server gives a path alone when it knows no origin for the request; this page's origin completes it.
  const url = new URL(link.url, window.location.origin).href;
  return (
    <div className="space-y-3">
      <div className="flex items-stretch gap-2">
        {/* Selected whole on focus, so it can be copied by hand where the clipboard is refused. */}
        <input readOnly aria-label="Setup link" value={url} onFocus={event => event.currentTarget.select()}
          className="h-10 min-w-0 flex-1 rounded-md border border-input bg-muted/40 px-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        <Button type="button" variant="outline" onClick={() => void copyText(url).then(setCopied)}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <p role="status" className="text-sm text-destructive empty:hidden">{copied === false ? 'Could not copy. Select the link and copy it by hand.' : ''}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>It works once, until {formatDayTime(link.expires_at)}.</li>
        <li>Send it yourself, in a way only they can read: whoever opens it first sets the password.</li>
        <li>It is not shown again. A new link from the person's page replaces it.</li>
      </ul>
    </div>
  );
}

/** The link after "Add person" or "New setup link", until the administrator closes it. */
export function SetupLinkDialog({ link, name, onClose }: { link: SetupLink | null; name: string; onClose: () => void }) {
  return (
    <Dialog open={!!link} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Setup link for {name}</DialogTitle>
          <DialogDescription>With this link they choose their own password and are signed in. You never know it.</DialogDescription>
        </DialogHeader>
        {link && <SetupLinkBlock link={link} />}
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
