import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { MailAccountRemoval } from '@/hooks/use-mail-account-removal';
import type { MailAccount } from '@/lib/mail-api';
import type { MailPurgePreview } from '@/components/mail/mail-page-model';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function describePreview(preview: MailPurgePreview) {
  const parts = [plural(preview.email_count, 'email'), plural(preview.attachment_count, 'attachment'), plural(preview.raw_count, 'raw message')];
  if (preview.calendar_accounts) parts.push(`${plural(preview.calendar_accounts, 'linked calendar account')} with ${plural(preview.calendar_events ?? 0, 'event')}`);
  return `${parts.join(', ')}; ${preview.unresolved_operations} unresolved operations.`;
}

/** Disconnect keeps local mail by default; deleting it is a guarded, typed confirmation. */
export function MailAccountRemovalDialogs({ removal, accounts }: { removal: MailAccountRemoval; accounts: MailAccount[] }) {
  const { accountToDelete, deleteAccount, accountToPurge, purgeDisconnects, purgePreview, purgePreviewError, purgeConfirmation, purgeAccount } = removal;
  const purgeAddress = accounts.find(account => account.id === accountToPurge)?.email_address ?? '';
  const confirmed = !!purgeAddress && purgeConfirmation.trim().toLowerCase() === purgeAddress.toLowerCase();
  return <>
    <AlertDialog open={!!accountToDelete} onOpenChange={(open) => !open && removal.cancelDisconnect()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect mail account?</AlertDialogTitle>
          <AlertDialogDescription>
            Sync and credentials for this account will be disconnected. Your local emails and attachments stay in UniHub. You can reconnect by editing the account and entering credentials.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">
          To remove this account's mail and linked calendar from UniHub as well,{' '}
          <Button type="button" variant="link" className="h-auto p-0 text-destructive"
            onClick={() => accountToDelete && void removal.openPurgePreview(accountToDelete, { disconnect: true })}>
            delete local data…
          </Button>
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep connected</AlertDialogCancel>
          <AlertDialogAction disabled={deleteAccount.isPending} onClick={() => accountToDelete && deleteAccount.mutate(accountToDelete)}>
            Disconnect and keep mail
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={!!accountToPurge} onOpenChange={open => { if (!open) removal.closePurge(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{purgeDisconnects ? 'Disconnect and delete local data?' : 'Permanently delete local data?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {purgeDisconnects ? 'This disconnects the account and removes it from UniHub' : 'This removes the disconnected account from UniHub'} with its local mail, attachments and linked calendar. Messages and events at the provider are not deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {purgePreviewError && <p role="alert" className="text-sm text-destructive">{purgePreviewError}</p>}
        {!purgePreview && !purgePreviewError && <p role="status">Loading preview…</p>}
        {purgePreview && <div className="space-y-2 text-sm">
          <p>{purgeAddress || 'This account'}: {describePreview(purgePreview)}</p>
          {purgePreview.blocked ? <p role="alert">Delete blocked: {purgePreview.reason || 'Provider effects are unresolved. Keep the journal and check again later.'}</p> : <>
            <Label htmlFor="confirm-mail-purge">Type the account address to confirm permanent deletion: {purgeAddress}</Label>
            <Input id="confirm-mail-purge" value={purgeConfirmation} onChange={event => removal.setPurgeConfirmation(event.target.value)} autoComplete="off" />
          </>}
        </div>}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep local data</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={!purgePreview || purgePreview.blocked || purgePreview.account_id !== accountToPurge || !confirmed || purgeAccount.isPending}
            onClick={() => accountToPurge && purgeAccount.mutate({ id: accountToPurge, disconnect: purgeDisconnects, address: purgeConfirmation })}>
            {purgeDisconnects ? 'Disconnect and delete' : 'Delete local data'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
