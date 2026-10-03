import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MailAccountBackupButton } from '@/components/mail/MailAccountBackupButton';
import type { MailModeImpactReview } from '@/hooks/use-mail-mode-impact';
import { emailCount, type MailAccount } from '@/lib/mail-api';


/** Address typed to confirm a change that removes mail from UniHub. Shared by the account dialog and the upgrade gate. */
export function TypedAddressConfirm({ id, address, value, onChange, matches }: {
  id: string; address: string; value: string; onChange: (value: string) => void; matches: boolean;
}) {
  return <div className="space-y-1.5">
    <Label htmlFor={id}>Type <span className="break-all font-mono text-xs">{address}</span> to confirm</Label>
    <Input id={id} value={value} onChange={event => onChange(event.target.value)} autoComplete="off" autoCapitalize="none"
      spellCheck={false} inputMode="email" placeholder={address} aria-invalid={value.trim() !== '' && !matches}
      aria-describedby={value.trim() !== '' && !matches ? `${id}-mismatch` : undefined} />
    {value.trim() !== '' && !matches && <p id={`${id}-mismatch`} className="text-xs text-muted-foreground">
      This doesn’t match the account address yet.
    </p>}
  </div>;
}

/**
 * The pre-save step for an existing account: what the new mode or windows
 * remove from UniHub (never from the server), an optional backup, and the
 * typed address when anything would be removed.
 */
export function MailModeImpactPanel({ account, review, typedAddress, onTypedAddressChange, saveError }: {
  account: MailAccount;
  review: MailModeImpactReview;
  typedAddress: string;
  onTypedAddressChange: (value: string) => void;
  saveError: string | null;
}) {
  if (!review.visible) return null;
  const impact = review.impact;
  const removals = impact?.total_removals ?? 0;
  const breakdown = impact ? [
    [impact.local_only, 'no longer on the server'],
    [impact.outside_window, 'older than the mail window'],
    [impact.outside_trash_window, 'in trash or spam, older than its window'],
    [impact.gmail_duplicates, 'extra Gmail copies of the same message'],
    [impact.local_duplicates, 'local copies of messages also downloaded from the server'],
  ].filter(([count]) => Number(count) > 0) as [number, string][] : [];

  return <section aria-labelledby="mail-mode-impact-title" aria-live="polite"
    className="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
    <h3 id="mail-mode-impact-title" className="font-medium">Before you save</h3>
    {review.switchingToSync && <p className="text-muted-foreground">
      Sync makes the server the source of truth. Mail that is no longer on the server is removed from UniHub, including its files.
    </p>}
    {review.loading ? <p role="status" className="flex items-center gap-2 text-muted-foreground">
      <Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />Checking what changes in UniHub…
    </p> : review.error ? <div role="alert" className="space-y-2">
      <p className="text-destructive">Couldn’t check how many emails would be removed: {review.error}</p>
      <p className="text-muted-foreground">You can still save after confirming below, or try again.</p>
      <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={review.retry}>Try again</Button>
    </div> : impact && <div className="space-y-2">
      <p data-testid="mail-mode-impact-total" className={removals > 0 ? 'font-medium text-foreground' : 'text-muted-foreground'}>
        {removals > 0 ? `${emailCount(removals)} will be removed from UniHub. They stay on the server.` : 'Nothing will be removed from UniHub.'}
      </p>
      {breakdown.length > 0 && <ul className="space-y-0.5 text-xs text-muted-foreground">
        {breakdown.map(([count, text]) => <li key={text}><span className="tabular-nums">{count.toLocaleString()}</span> {text}</li>)}
      </ul>}
      {impact.notes.length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
        {impact.notes.map(note => <li key={note}>{note}</li>)}
      </ul>}
    </div>}
    {(removals > 0 || review.switchingToSync || review.error) && <MailAccountBackupButton accountId={account.id} />}
    {review.requiresAddress && <TypedAddressConfirm id="mail-mode-confirm-address" address={account.email_address}
      value={typedAddress} onChange={onTypedAddressChange} matches={review.addressOk} />}
    {saveError && <p role="alert" className="text-destructive">{saveError}</p>}
  </section>;
}
