import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';

interface SafeEmailContentProps {
  emailId: string;
  bodyHtml: string | null;
  bodyText: string | null;
}

function htmlHasRemoteContent(html: string) {
  return /\b(?:src|srcset|poster|background)\s*=\s*["'][^"']*https?:\/\//i.test(html)
    || /url\(\s*["']?https?:\/\//i.test(html);
}

export function SafeEmailContent({ emailId, bodyHtml, bodyText }: SafeEmailContentProps) {
  const [allowRemoteContent, setAllowRemoteContent] = useState(false);
  const hasRemoteContent = useMemo(
    () => (bodyHtml ? htmlHasRemoteContent(bodyHtml) : false),
    [bodyHtml]
  );

  if (bodyHtml) {
    const imageSources = allowRemoteContent
      ? "'self' data: blob: http: https:"
      : "'self' data: blob:";
    const iframeCsp = [
      "default-src 'none'",
      `img-src ${imageSources}`,
      "style-src 'unsafe-inline'",
      "font-src data:",
      "media-src 'self' data: blob:",
      "script-src 'none'",
      "connect-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
    const srcDoc = `<!doctype html>
<html>
  <head>
    <base target="_blank" />
    <meta name="referrer" content="no-referrer" />
    <meta http-equiv="Content-Security-Policy" content="${iframeCsp}" />
    <style>
      body { margin: 0; padding: 16px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827; background: #fff; overflow-wrap: anywhere; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; }
      a { color: #2563eb; }
    </style>
  </head>
  <body>${bodyHtml}</body>
</html>`;

    return (
      <div className="space-y-3">
        {hasRemoteContent && !allowRemoteContent && (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Remote images and media are blocked for this email.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => setAllowRemoteContent(true)}
            >
              Load remote content
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
