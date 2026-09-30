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

/** Disconnect retains local mail. Purge is a separate guarded flow. */
export function MailAccountRemovalDialogs({ removal }: { removal: MailAccountRemoval }) {
  const { accountToDelete, deleteAccount, accountToPurge, purgePreview, purgePreviewError, purgeConfirmation, purgeAccount } = removal;
  return <>
    <AlertDialog open={!!accountToDelete} onOpenChange={(open) => !open && removal.cancelDisconnect()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect mail account?</AlertDialogTitle>
          <AlertDialogDescription>
            Sync and credentials for this account will be disconnected. Your local emails and attachments stay in UniHub. You can reconnect by editing the account and entering credentials.
          </AlertDialogDescription>
        </AlertDialogHeader>
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
          <AlertDialogTitle>Permanently purge local mail?</AlertDialogTitle>
          <AlertDialogDescription>
            Purge is separate from disconnect. This removes the disconnected account and its retained local mail. It does not delete messages at the provider.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {purgePreviewError && <p role="alert" className="text-sm text-destructive">{purgePreviewError}</p>}
        {!purgePreview && !purgePreviewError && <p role="status">Loading purge preview…</p>}
        {purgePreview && <div className="space-y-2 text-sm">
          <p>Account {purgePreview.account_id}: {purgePreview.email_count} emails, {purgePreview.attachment_count} attachments, {purgePreview.raw_count} raw messages; {purgePreview.unresolved_operations} unresolved operations.</p>
          {purgePreview.blocked ? <p role="alert">Purge blocked: {purgePreview.reason || 'Provider effects are unresolved. Keep the journal and check again later.'}</p> : <>
            <Label htmlFor="confirm-mail-purge">Type the account ID to confirm permanent deletion: {accountToPurge}</Label>
            <Input id="confirm-mail-purge" value={purgeConfirmation} onChange={event => removal.setPurgeConfirmation(event.target.value)} autoComplete="off" />
          </>}
        </div>}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep local mail</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={!purgePreview || purgePreview.blocked || purgePreview.account_id !== accountToPurge || purgeConfirmation !== accountToPurge || purgeAccount.isPending}
            onClick={() => accountToPurge && purgeAccount.mutate(accountToPurge)}>Purge local mail</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
