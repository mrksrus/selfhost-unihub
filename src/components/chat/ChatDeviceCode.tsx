import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ChatEngine, ChatReadiness } from '@/lib/chat/types';
import { useSessionScope } from '@/lib/session-scope';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { deviceNames } from '@/components/chat/chat-state';

/** The code a waiting device and the approving one both show, drawn the same on both; a screen reader says it digit by digit. */
export function ChatDeviceCode({ code, className }: { code: string; className?: string }) {
  return (
    <p className={cn('font-mono text-4xl font-semibold tabular-nums tracking-wider', className)}>
      <span aria-hidden="true" className="inline-flex gap-[0.4em]"><span>{code.slice(0, 3)}</span><span>{code.slice(3)}</span></span>
      <span className="sr-only">Code: {[...code].join(' ')}</span>
    </p>
  );
}

/** A waiting device's way in without the passphrase: it asks, shows the code, and the person approves on a device that is in Chat. */
export function AskForApproval({ engine, readiness: { approvers, code, code_expires_at } }: { engine: ChatEngine; readiness: Extract<ChatReadiness, { state: 'waiting' }> }) {
  const scope = useSessionScope();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const minutes = code_expires_at ? Math.max(1, Math.ceil((Date.parse(code_expires_at) - now) / 60_000)) : 0;

  const ask = async () => {
    setPending(true);
    setError(null);
    try {
      await engine.askApproval();
    } catch (failure) {
      if (!scope.ended) setError(failure instanceof Error && failure.message ? failure.message : 'The request was not made.');
    } finally {
      setPending(false);
    }
  };

  if (!approvers.length && !code) return <p className="text-sm text-muted-foreground">No other device of yours is in Chat, so none can approve this one.</p>;
  return (
    <div className="space-y-3 text-sm">
      <div aria-live="polite" className="space-y-3">
        {code ? <>
          <ChatDeviceCode code={code} />
          <p>Check that your other device shows the same code, then approve there.</p>
        </> : <p>Ask here, then open UniHub on one of your devices that are in Chat. Both show a code to compare. Your earlier messages come with the approval.</p>}
      </div>
      {approvers.length > 0 && <p className="text-muted-foreground">Your devices in Chat: {deviceNames(approvers)}. One that shows your earlier messages can approve.</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Greyed out while it asks: a second request would replace the first one's code. */}
        <Button type="button" variant="outline" size={code ? 'sm' : 'default'} disabled={pending} onClick={() => void ask()}>
          {pending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}{code ? 'Ask again' : 'Ask for approval'}
        </Button>
        {code && <p className="text-muted-foreground">The code works for {minutes} more {minutes === 1 ? 'minute' : 'minutes'}.</p>}
      </div>
      <p role="alert" className="text-destructive empty:hidden">{error}</p>
    </div>
  );
}
