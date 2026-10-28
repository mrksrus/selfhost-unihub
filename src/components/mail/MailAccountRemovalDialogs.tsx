import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
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

/**
 * One of the two ways to remove a connected account (D27): a row with the
 * choice as its title and what it does beneath, the whole row the button.
 */
function RemovalChoice({ title, children, destructive = false, disabled, onClick }: {
  title: string; children: string; destructive?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className="flex w-full flex-col items-start gap-0.5 rounded-md border border-border px-3 py-2.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
      <span className={destructive ? 'text-sm font-medium text-destructive' : 'text-sm font-medium'}>{title}</span>
      <span className="text-sm text-muted-foreground">{children}</span>
    </button>
  );
}

/**
 * Removing a connected account offers two choices: disconnect and keep the
 * mail, or remove the account with UniHub's copy of its mail (D27). The second
 * continues in a guarded, typed confirmation that shows what is removed. The
 * provider keeps its mail either way.
 */
export function MailAccountRemovalDialogs({ removal, accounts }: { removal: MailAccountRemoval; accounts: MailAccount[] }) {
  const { accountToDelete, deleteAccount, accountToPurge, purgeDisconnects, purgePreview, purgePreviewError, purgeConfirmation, purgeAccount } = removal;
  const deleteAddress = accounts.find(account => account.id === accountToDelete)?.email_address ?? 'this account';
  const purgeAddress = accounts.find(account => account.id === accountToPurge)?.email_address ?? '';
  const confirmed = !!purgeAddress && purgeConfirmation.trim().toLowerCase() === purgeAddress.toLowerCase();
  return <>
    <AlertDialog open={!!accountToDelete} onOpenChange={(open) => !open && removal.cancelDisconnect()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect mail account?</AlertDialogTitle>
          <AlertDialogDescription>
            Choose what happens to {deleteAddress} in UniHub. Your mail at the provider stays either way.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <RemovalChoice title="Disconnect and keep mail" disabled={deleteAccount.isPending}
            onClick={() => accountToDelete && deleteAccount.mutate(accountToDelete)}>
            Sync stops and the saved password is removed. Your mail, attachments and linked calendar stay in UniHub. Reconnect any time by editing the account.
          </RemovalChoice>
          <RemovalChoice title="Remove the account with its mail" destructive disabled={deleteAccount.isPending}
            onClick={() => accountToDelete && void removal.openPurgePreview(accountToDelete, { disconnect: true })}>
            Deletes UniHub's copy of the account, its mail, attachments and linked calendar. You confirm next by typing the address.
          </RemovalChoice>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep connected</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <AlertDialog open={!!accountToPurge} onOpenChange={open => { if (!open) removal.closePurge(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{purgeDisconnects ? 'Remove the account with its mail?' : 'Permanently delete local data?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {purgeDisconnects
              ? 'This removes the account from UniHub with its local mail, attachments and linked calendar. Only UniHub\'s copy is deleted: the messages and events stay at the provider.'
              : 'This removes the disconnected account from UniHub with its local mail, attachments and linked calendar. Messages and events at the provider are not deleted.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {purgePreviewError && <p role="alert" className="text-sm text-destructive">{purgePreviewError}</p>}
        {!purgePreview && !purgePreviewError && <p role="status">Loading preview…</p>}
        {purgePreview && <div className="space-y-2 text-sm">
          <p>{purgeAddress || 'This account'}: {describePreview(purgePreview)}</p>
          {purgePreview.blocked ? <p role="alert">{purgeDisconnects ? 'Removal' : 'Delete'} blocked: {purgePreview.reason || 'Provider effects are unresolved. Keep the journal and check again later.'}</p> : <>
            <Label htmlFor="confirm-mail-purge">Type the account address to confirm permanent deletion: {purgeAddress}</Label>
            <Input id="confirm-mail-purge" value={purgeConfirmation} onChange={event => removal.setPurgeConfirmation(event.target.value)} autoComplete="off" />
          </>}
        </div>}
        <AlertDialogFooter>
          <AlertDialogCancel>{purgeDisconnects ? 'Keep the account' : 'Keep local data'}</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={!purgePreview || purgePreview.blocked || purgePreview.account_id !== accountToPurge || !confirmed || purgeAccount.isPending}
            onClick={() => accountToPurge && purgeAccount.mutate({ id: accountToPurge, disconnect: purgeDisconnects, address: purgeConfirmation })}>
            {purgeDisconnects ? 'Remove account and mail' : 'Delete local data'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
