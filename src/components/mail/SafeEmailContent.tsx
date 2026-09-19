import { useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { emailSrcDoc, prepareEmailHtml } from '@/lib/email-privacy';

interface SafeEmailContentProps {
  emailId: string;
  bodyHtml: string | null;
  bodyText: string | null;
}

// A keyed child discards both choices on navigation, including A -> B -> A.
export function SafeEmailContent(props: SafeEmailContentProps) {
  return <MessageContent key={props.emailId} {...props} />;
}

function MessageContent({ emailId, bodyHtml, bodyText }: SafeEmailContentProps) {
  const [allowRemoteContent, setAllowRemoteContent] = useState(false);
  const [blockSuspectedTrackers, setBlockSuspectedTrackers] = useState(true);
  const [original, setOriginal] = useState(false);
  const { resolvedTheme } = useTheme();
  const prepared = useMemo(() => prepareEmailHtml(bodyHtml || '', {
    allowRemoteImages: allowRemoteContent,
    blockSuspectedTrackers,
  }), [bodyHtml, allowRemoteContent, blockSuspectedTrackers]);
  const readableText = useMemo(() => {
    if (bodyText) return bodyText;
    if (!bodyHtml) return '(No content)';
    const template = document.createElement('template');
    template.innerHTML = bodyHtml;
    const content = template.content;
    content.querySelectorAll('script, style, noscript, template').forEach(node => node.remove());
    content.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    content.querySelectorAll('p, div, tr, li, h1, h2, h3').forEach(node => node.append('\n'));
    return content.textContent?.trim() || '(No text content. Open the original email to view it.)';
  }, [bodyText, bodyHtml]);
  if (bodyHtml && resolvedTheme === 'dark' && !original) {
    return <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 p-3">
        <span className="text-sm text-muted-foreground">Dark reading view</span>
        <Button type="button" size="sm" variant="outline" onClick={() => setOriginal(true)}>Original email appearance</Button>
      </div>
      <div className="whitespace-pre-wrap break-words text-foreground">{readableText}</div>
    </div>;
  }
  if (bodyHtml) {
    const srcDoc = emailSrcDoc(prepared.html, allowRemoteContent);

    return (
      <div className="space-y-3">
        {resolvedTheme === 'dark' && <Button type="button" size="sm" variant="outline" onClick={() => setOriginal(false)}>Dark reading view</Button>}
        {prepared.remoteImages > 0 && (
          <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3">
            <p className="text-sm text-muted-foreground">
              {allowRemoteContent ? 'Remote images are allowed for this visit to this message.' : 'Remote images are blocked for this email.'}
              {' '}Loading images can reveal your IP address and open time to their servers.
              {' '}Re-blocking cannot undo requests already sent. These choices reset when you leave this message.
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={blockSuspectedTrackers} onChange={event => setBlockSuspectedTrackers(event.target.checked)} className="mt-1" />
              <span>Block suspected tracking images{prepared.suspectedTrackers > 0 ? ` (${prepared.suspectedTrackers} suspected)` : ''}.
                {' '}Detection can miss trackers or block useful images. Clicked links may still track you.</span>
            </label>
            <Button type="button" variant="secondary" size="sm" onClick={() => setAllowRemoteContent(allowed => !allowed)}>
              {allowRemoteContent ? 'Block remote images again' : 'Load remote images'}
            </Button>
          </div>
        )}
        <iframe
          title={`email-${emailId}`}
          srcDoc={srcDoc}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          className="h-[min(70dvh,720px)] min-h-[320px] w-full border border-border rounded-md bg-background"
        />
      </div>
    );
  }

  return (
    <div className="whitespace-pre-wrap text-foreground break-words">
      {bodyText || '(No content)'}
    </div>
  );
}
