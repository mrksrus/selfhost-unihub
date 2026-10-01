import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { MailAccountBackupButton } from '@/components/mail/MailAccountBackupButton';
import { TypedAddressConfirm } from '@/components/mail/MailModeImpactPanel';
import { useToast } from '@/hooks/use-toast';
import { addressMatches, confirmMailSyncPolicy, emailCount, mailQueryKeys, mailSyncWarnings, type MailAccount } from '@/lib/mail-api';
import { isOfflineMode } from '@/lib/offline';
import { cn } from '@/lib/utils';

/** A centered dialog on desktop, a bottom sheet on touch screens. */
function ResponsiveDialog({ open, onOpenChange, touch, title, description, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; touch: boolean; title: string; description: ReactNode; children: ReactNode;
}) {
  if (touch) return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="bottom" className="max-h-[90dvh] space-y-4 overflow-y-auto rounded-t-lg p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
      <div className="space-y-1 pr-8">
        <SheetTitle className="text-base">{title}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
      </div>
      {children}
    </SheetContent>
  </Sheet>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="w-[calc(100vw-1rem)] max-w-md p-4 sm:p-6">
      <div className="space-y-1 pr-6">
        <DialogTitle className="text-base">{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </div>
      {children}
    </DialogContent>
  </Dialog>;
}

/** Typed-address confirmation that lets an existing Sync account follow the server and remove what it no longer has. */
export function MailSyncPolicyConfirmDialog({ account, open, onOpenChange, touch }: {
  account: MailAccount; open: boolean; onOpenChange: (open: boolean) => void; touch: boolean;
}) {
  const client = useQueryClient();
  const { toast } = useToast();
  const [typed, setTyped] = useState('');
  const removals = account.sync_policy_pending_removals ?? 0;
  const matches = addressMatches(typed, account);
  const confirm = useMutation({
    mutationFn: () => confirmMailSyncPolicy(account.id, typed),
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: mailQueryKeys.accounts });
      void client.invalidateQueries({ queryKey: ['mail-accounts-count'] });
      toast({ title: `Mail-client behavior is on for ${account.email_address}`, description: 'UniHub now follows the server for this account.' });
      setTyped('');
      onOpenChange(false);
    },
  });
  const change = (next: boolean) => {
    if (confirm.isPending) return;
    if (!next) { setTyped(''); confirm.reset(); }
    onOpenChange(next);
  };
  return <ResponsiveDialog open={open} onOpenChange={change} touch={touch} title="Turn on mail-client behavior"
    description={<>UniHub will follow the server for <span className="break-all">{account.email_address}</span>. Nothing changes on the server.</>}>
    <form className="space-y-4 text-sm" onSubmit={event => { event.preventDefault(); if (matches && !confirm.isPending) confirm.mutate(); }}>
      <p>
        <span className="font-medium">{emailCount(removals)}</span> that {removals === 1 ? 'is' : 'are'} no longer on the server will be removed from UniHub, including attachments. UniHub can’t bring them back afterwards.
      </p>
      <MailAccountBackupButton accountId={account.id} />
      <TypedAddressConfirm id={`mail-sync-policy-address-${account.id}`} address={account.email_address}
        value={typed} onChange={setTyped} matches={matches} />
      {confirm.isError && <p role="alert" className="text-destructive">{confirm.error.message}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={confirm.isPending} onClick={() => change(false)}>Cancel</Button>
        <Button type="submit" variant="destructive" disabled={!matches || confirm.isPending || isOfflineMode()}>
          {confirm.isPending && <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 motion-safe:animate-spin" />}
          Turn on and remove {emailCount(removals)}
        </Button>
      </div>
    </form>
  </ResponsiveDialog>;
}

/**
 * Upgrade gate for an existing Sync account: nothing is cleaned up until the
 * owner confirms. Compact, so it fits the sync panel and the account dialog.
 */
export function MailSyncPolicyNotice({ account, touch, autoFocus, className }: {
  account: MailAccount; touch: boolean; autoFocus?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const removals = account.sync_policy_pending_removals ?? 0;
  const titleId = `mail-sync-policy-${account.id}`;
  return <div role="group" aria-labelledby={titleId} className={cn('space-y-2 rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs', className)}>
    <p id={titleId} tabIndex={-1} data-autofocus={autoFocus ? '' : undefined}
      className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-2 rounded-full bg-warning" />
      <span className="font-medium">Turn on mail-client behavior for <span className="break-all">{account.email_address}</span>:</span>{' '}
      {emailCount(removals)} that {removals === 1 ? 'is' : 'are'} no longer on the server will be removed from UniHub.
    </p>
    <div className="flex flex-wrap items-start gap-2">
      <MailAccountBackupButton accountId={account.id} label="Back up first" />
      <Button type="button" size="sm" className="h-8 text-xs" disabled={isOfflineMode()} onClick={() => setOpen(true)}>Confirm…</Button>
    </div>
    <MailSyncPolicyConfirmDialog account={account} open={open} onOpenChange={setOpen} touch={touch} />
  </div>;
}

/** Provider setup warnings for one account (for example Gmail hiding All Mail from IMAP). */
export function MailAccountSyncWarnings({ account, className }: { account: MailAccount; className?: string }) {
  const warnings = mailSyncWarnings(account);
  if (!warnings.length) return null;
  return <ul className={cn('space-y-1 text-xs', className)}>
    {warnings.map(warning => <li key={warning.code} className="flex gap-1.5">
      <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-warning" />
      <span>{warning.text}</span>
    </li>)}
  </ul>;
}
