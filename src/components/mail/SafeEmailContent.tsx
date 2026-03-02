interface SafeEmailContentProps {
  emailId: string;
  bodyHtml: string | null;
  bodyText: string | null;
}

export function SafeEmailContent({ emailId, bodyHtml, bodyText }: SafeEmailContentProps) {
  if (bodyHtml) {
    return (
      <iframe
        title={`email-${emailId}`}
        srcDoc={bodyHtml}
        sandbox=""
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
