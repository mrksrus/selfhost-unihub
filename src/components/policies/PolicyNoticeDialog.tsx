import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { usePolicies } from '@/hooks/use-policies';
import { useSessionMutation } from '@/hooks/use-session-mutation';
import { useToast } from '@/hooks/use-toast';
import { acknowledgePolicies, policiesQueryKey, type EffectivePoliciesResponse } from '@/lib/policies-api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { settingsHref } from '@/components/settings/settings-sections';

// The notice of the data rules (D38). The server keeps a revision of the
// rules and the revision each person confirmed; while the person's is behind,
// the app opens this dialog at start. OK records the revision shown. A person
// who has never confirmed any (created by an administrator, or the first
// start after the upgrade) reads it as the rules of this server rather than
// as a change. Closing it without OK leaves it due for the next start.

/** The rules in force, as a list, or the sentence for none. */
export function RulesList({ rules, className }: { rules: string[]; className?: string }) {
  if (rules.length === 0) return <p className={className}>No rule limits what you can do on this server right now.</p>;
  return (
    <ul aria-label="Rules in force" className={['list-disc space-y-1 pl-5', className].filter(Boolean).join(' ')}>
      {rules.map(rule => <li key={rule}>{rule}</li>)}
    </ul>
  );
}

export function PolicyNoticeDialog() {
  const { rules, revision, acknowledgedRevision, noticeDue } = usePolicies();
  const client = useQueryClient();
  const { toast } = useToast();
  // Closed without OK: not again in this session, due again at the next start.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const acknowledge = useSessionMutation({
    mutationFn: (shown: number) => acknowledgePolicies(shown),
    onSuccess: (answer, shown) => {
      const confirmed = answer?.acknowledged_revision ?? shown;
      client.setQueryData<EffectivePoliciesResponse>(policiesQueryKey, current => (current ? { ...current, acknowledged_revision: Math.max(current.acknowledged_revision, confirmed) } : current));
    },
    onError: (error: Error) => toast({ title: 'Could not record that you read the rules', description: error.message, variant: 'destructive' }),
  });
  const open = noticeDue && dismissed !== revision;
  const firstTime = acknowledgedRevision === 0;
  // OK takes focus when the dialog opens, so Enter confirms after reading.
  const okButton = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !acknowledge.isPending) setDismissed(revision); }}>
      {/* A long list of rules on a small phone: the dialog stays inside the viewport and its safe areas, the list scrolls, title and OK stay in reach. */}
      <DialogContent className="flex max-h-[calc(100dvh-1rem-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] flex-col" onOpenAutoFocus={event => { event.preventDefault(); okButton.current?.focus(); }}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{firstTime ? 'Rules on this server' : 'Your administrator changed the data rules'}</DialogTitle>
          <DialogDescription>
            {firstTime ? 'Your administrator set these rules for everyone on this server.' : 'These rules apply to everyone on this server from now on. Nothing of yours was deleted.'}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain" data-testid="notice-body">
          <RulesList rules={rules} className="text-sm" />
          <p className="text-xs text-muted-foreground">A rule greys out the control it concerns, with its reason. You can read the rules any time under Settings › Profile.</p>
        </div>
        <DialogFooter className="shrink-0 gap-2 sm:gap-0">
          <Button variant="ghost" asChild><Link to={settingsHref('account')} onClick={() => setDismissed(revision)}>Open Settings › Profile</Link></Button>
          <Button ref={okButton} type="button" onClick={() => acknowledge.mutate(revision)} disabled={acknowledge.isPending}>
            {acknowledge.isPending && <Loader2 aria-hidden="true" className="animate-spin" />}OK
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
