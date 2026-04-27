interface SafeEmailContentProps {
  emailId: string;
  bodyHtml: string | null;
  bodyText: string | null;
}

export function SafeEmailContent({ emailId, bodyHtml, bodyText }: SafeEmailContentProps) {
  if (bodyHtml) {
    const srcDoc = `<!doctype html>
<html>
  <head>
    <base target="_blank" />
    <meta name="referrer" content="no-referrer" />
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
      <iframe
        title={`email-${emailId}`}
        srcDoc={srcDoc}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="w-full min-h-[380px] border border-border rounded-md bg-background"
      />
    );
  }

  return (
    <div className="whitespace-pre-wrap text-foreground break-words">
      {bodyText || '(No content)'}
    </div>
  );
}
